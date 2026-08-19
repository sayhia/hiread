package services

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"hiread/internal/appstate"
	"hiread/internal/books"
	"hiread/internal/db"
)

type appStateAlias = appstate.State

// The AI features talk to an OpenAI-compatible endpoint, so everything except
// the vendor itself can be exercised against a local one: the settings that
// resolve a provider, the prompt the chapter turns into, the SSE stream coming
// back, and what is kept once it finishes. No API key is involved — the fake
// endpoint accepts whatever it is handed.

// fakeLLM is an OpenAI-compatible endpoint that streams `chunks` back as SSE
// and records the request it was given.
type fakeLLM struct {
	*httptest.Server
	// Every request, not just the last: a chapter's title and its body are
	// translated at the same time now, so which one lands last is a race.
	mu     sync.Mutex
	bodies []map[string]any
	paths  []string
}

func newFakeLLM(t *testing.T, chunks ...string) *fakeLLM {
	t.Helper()
	f := &fakeLLM{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body := map[string]any{}
		_ = json.Unmarshal(raw, &body)
		f.mu.Lock()
		f.paths = append(f.paths, r.URL.Path)
		f.bodies = append(f.bodies, body)
		f.mu.Unlock()

		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		for _, c := range chunks {
			payload, _ := json.Marshal(map[string]any{
				"choices": []any{map[string]any{"delta": map[string]any{"content": c}}},
			})
			_, _ = w.Write([]byte("data: " + string(payload) + "\n\n"))
			if flusher != nil {
				flusher.Flush()
			}
		}
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	t.Cleanup(f.Close)
	return f
}

// requestPaths is every path the fake was called on, in order.
func (f *fakeLLM) requestPaths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.paths...)
}

// prompt is every message every request carried, flattened — the context a
// prompt-assembly change would show up in.
func (f *fakeLLM) prompt(t *testing.T) string {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	var sb strings.Builder
	for _, body := range f.bodies {
		if sys, ok := body["system"].(string); ok {
			sb.WriteString(sys)
		}
		msgs, _ := body["messages"].([]any)
		for _, m := range msgs {
			msg, _ := m.(map[string]any)
			if c, ok := msg["content"].(string); ok {
				sb.WriteString("\n")
				sb.WriteString(c)
			}
		}
	}
	return sb.String()
}

// pointAt makes the fake endpoint the active provider, the way the settings UI
// would.
func pointAt(t *testing.T, s *appServices, f *fakeLLM) {
	t.Helper()
	ctx := context.Background()
	for k, v := range map[string]string{
		"ai_provider": "custom", // an OpenAI-compatible endpoint of our own
		"ai_api_key":  "test-key",
		"ai_model":    "test-model",
		"ai_base_url": f.URL,
	} {
		if err := db.SetSetting(ctx, s.state.DB.W, k, v); err != nil {
			t.Fatalf("SetSetting(%s): %v", k, err)
		}
	}
}

// appServices bundles a library and an AI service over one database.
type appServices struct {
	state   *appStateAlias
	library *LibraryService
	ai      *AIService
}

func newServices(t *testing.T) *appServices {
	t.Helper()
	lib := newLibrary(t)
	return &appServices{state: lib.app, library: lib, ai: &AIService{app: lib.app}}
}

func TestSummarizeStreamsAndCachesTheResult(t *testing.T) {
	s := newServices(t)
	llm := newFakeLLM(t, "**TL;DR** — ", "Thoreau went to the woods.")
	pointAt(t, s, llm)

	imported, err := s.library.ImportBytes("walden.epub", sampleEPUB(t))
	if err != nil || imported.Error != "" {
		t.Fatalf("import: %v / %q", err, imported.Error)
	}

	if err := s.ai.Summarize(context.Background(), imported.BookID, 0, "stream-1"); err != nil {
		t.Fatalf("Summarize: %v", err)
	}

	// The request went to the OpenAI-compatible path on our endpoint, carrying
	// the chapter's own text rather than just its title.
	if got := llm.requestPaths(); len(got) != 1 || got[0] != "/chat/completions" {
		t.Errorf("request paths = %q", got)
	}
	if p := llm.prompt(t); !strings.Contains(p, "lived alone, in the woods") {
		t.Errorf("the chapter text never reached the model:\n%s", p)
	}

	// A completed summary is cached on the chapter, so reopening costs nothing.
	chapter, err := db.GetChapter(context.Background(), s.state.DB.R, imported.BookID, 0)
	if err != nil {
		t.Fatalf("GetChapter: %v", err)
	}
	if chapter.AiSummary == nil {
		t.Fatal("no summary was cached")
	}
	if got := *chapter.AiSummary; got != "**TL;DR** — Thoreau went to the woods." {
		t.Errorf("cached summary = %q", got)
	}
}

// A chapter with no text gives the model nothing to work with; asking anyway
// would bill for a summary invented out of a heading.
func TestSummarizeRefusesAnEmptyChapter(t *testing.T) {
	s := newServices(t)
	llm := newFakeLLM(t, "nonsense")
	pointAt(t, s, llm)

	// A plate page: one full-bleed image and not a word of text. The EPUB parser
	// keeps it as a chapter (the picture is the content), so the reader can turn
	// to it — and the summary button is right there in the toolbar when they do.
	bookID, _, err := db.ImportBook(context.Background(), s.state.DB, &books.Book{
		Format:   books.FormatEPUB,
		Metadata: books.Metadata{Title: "Plates"},
		Chapters: []books.Chapter{{
			Index: 0, Title: "Frontispiece",
			HTML: `<img data-res="i/plate.jpg">`, Text: "",
		}},
		Resources: []books.Resource{{Path: "i/plate.jpg", Mime: "image/jpeg", Data: []byte("jpegbytes")}},
	}, "plates.epub", "hash-plates", 10, nil)
	if err != nil {
		t.Fatalf("ImportBook: %v", err)
	}

	err = s.ai.Summarize(context.Background(), bookID, 0, "stream-2")
	if err == nil {
		t.Fatal("expected an error for a chapter with no text")
	}
	if !strings.Contains(err.Error(), "noChapterText") {
		t.Errorf("error = %v, want noChapterText", err)
	}
	if llm.prompt(t) != "" {
		t.Error("the model should not have been called at all")
	}
}

// Ask retrieves from the library and puts what it found in the prompt. Without
// that, the answer is the model's own recollection rather than the user's books.
func TestAskPutsRetrievedChaptersInThePrompt(t *testing.T) {
	s := newServices(t)
	llm := newFakeLLM(t, "He built it himself.")
	pointAt(t, s, llm)

	imported, err := s.library.ImportBytes("walden.epub", sampleEPUB(t))
	if err != nil || imported.Error != "" {
		t.Fatalf("import: %v / %q", err, imported.Error)
	}

	if err := s.ai.Ask(context.Background(), "who built the house?", nil, nil, "stream-3"); err != nil {
		t.Fatalf("Ask: %v", err)
	}

	p := llm.prompt(t)
	if !strings.Contains(p, "who built the house?") {
		t.Errorf("the question is missing from the prompt:\n%s", p)
	}
	if !strings.Contains(p, "Walden") || !strings.Contains(p, "Economy") {
		t.Errorf("the retrieved book and chapter are missing:\n%s", p)
	}
	if !strings.Contains(p, "lived alone, in the woods") {
		t.Errorf("the retrieved chapter text is missing:\n%s", p)
	}
}

// Scoping a question to one book must not drag in another.
func TestAskScopedToABookIgnoresTheRest(t *testing.T) {
	s := newServices(t)
	llm := newFakeLLM(t, "ok")
	pointAt(t, s, llm)

	walden, err := s.library.ImportBytes("walden.epub", sampleEPUB(t))
	if err != nil || walden.Error != "" {
		t.Fatalf("import: %v / %q", err, walden.Error)
	}
	other, err := s.library.ImportBytes("other.epub", sampleEPUBTitled(t, "Moby-Dick", "Call me Ishmael."))
	if err != nil || other.Error != "" {
		t.Fatalf("import: %v / %q", err, other.Error)
	}

	if err := s.ai.Ask(context.Background(), "woods", &walden.BookID, nil, "stream-4"); err != nil {
		t.Fatalf("Ask: %v", err)
	}
	p := llm.prompt(t)
	if !strings.Contains(p, "Walden") {
		t.Errorf("the scoped book is missing:\n%s", p)
	}
	if strings.Contains(p, "Ishmael") {
		t.Errorf("a book outside the scope leaked into the prompt:\n%s", p)
	}
}

// pointAtProfile configures the fake endpoint the way the settings UI actually
// stores a provider today: a JSON profile list plus the active id, with none of
// the legacy flat keys set.
func pointAtProfile(t *testing.T, s *appServices, f *fakeLLM) {
	t.Helper()
	ctx := context.Background()
	profiles, err := json.Marshal([]map[string]string{{
		"id": "p1", "name": "Local", "provider": "custom",
		"apiKey": "test-key", "model": "test-model", "baseUrl": f.URL,
	}})
	if err != nil {
		t.Fatalf("marshal profiles: %v", err)
	}
	for k, v := range map[string]string{
		"ai_providers":       string(profiles),
		"ai_active_provider": "p1",
	} {
		if err := db.SetSetting(ctx, s.state.DB.W, k, v); err != nil {
			t.Fatalf("SetSetting(%s): %v", k, err)
		}
	}
}

// The user's report: AI is configured in Settings, and translation still says
// "no key". Settings stores a provider profile; the translation layer read the
// legacy ai_api_key and found nothing.
func TestTranslateUsesAProviderProfile(t *testing.T) {
	s := newServices(t)
	llm := newFakeLLM(t, "<p>He built it himself.</p>")

	ready, err := s.ai.Configured()
	if err != nil || ready {
		t.Fatalf("before configuring: %v / %v, want false", ready, err)
	}

	pointAtProfile(t, s, llm)

	ready, err = s.ai.Configured()
	if err != nil || !ready {
		t.Fatalf("after configuring a profile: %v / %v, want true", ready, err)
	}

	imported, err := s.library.ImportBytes("walden.epub", sampleEPUB(t))
	if err != nil || imported.Error != "" {
		t.Fatalf("import: %v / %q", err, imported.Error)
	}

	if err := s.ai.Translate(context.Background(), imported.BookID, 0, "en", "llm", "stream-t1"); err != nil {
		t.Fatalf("Translate: %v", err)
	}
	if p := llm.prompt(t); !strings.Contains(p, "lived alone, in the woods") {
		t.Errorf("the chapter never reached the endpoint:\n%s", p)
	}

	// And it is cached under the language and engine that produced it.
	got, err := s.ai.GetTranslation(imported.BookID, 0, "en", "llm")
	if err != nil {
		t.Fatalf("GetTranslation: %v", err)
	}
	if got == nil || !strings.Contains(got.HTML, "He built it himself") {
		t.Errorf("translation not cached: %+v", got)
	}
}
