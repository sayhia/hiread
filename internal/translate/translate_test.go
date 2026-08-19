package translate

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"hiread/internal/db"
)

// ── chunkBlocks ──────────────────────────────────────────────────────────────

func TestGroupsMultipleBlocksIntoOneBatchUnderBudget(t *testing.T) {
	out := chunkBlocks("<p>a</p><p>b</p><p>c</p>", 1000)
	want := []string{"<p>a</p><p>b</p><p>c</p>"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %#v, want %#v", out, want)
	}
}

func TestSplitsIntoBatchesWhenOverBudget(t *testing.T) {
	// Each `<p>x</p>` is 8 bytes; a budget of 8 forces one block per batch.
	out := chunkBlocks("<p>a</p><p>b</p><p>c</p>", 8)
	want := []string{"<p>a</p>", "<p>b</p>", "<p>c</p>"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %#v, want %#v", out, want)
	}
	// Reassembly reproduces the source block sequence.
	if got := strings.Join(out, ""); got != "<p>a</p><p>b</p><p>c</p>" {
		t.Fatalf("reassembly = %q", got)
	}
}

func TestNeverSplitsASingleOversizedBlock(t *testing.T) {
	big := "<p>" + strings.Repeat("x", 100) + "</p>"
	out := chunkBlocks(big, 8)
	want := []string{big}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %#v, want %#v", out, want)
	}
}

func TestUnwrapsASingleGenericContainer(t *testing.T) {
	// The wrapping <div> is dropped so its children can be batched.
	out := chunkBlocks("<div><p>a</p><p>b</p></div>", 8)
	want := []string{"<p>a</p>", "<p>b</p>"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %#v, want %#v", out, want)
	}
}

func TestUnwrapsNestedGenericContainers(t *testing.T) {
	out := chunkBlocks("<div><section><p>a</p><p>b</p></section></div>", 8)
	want := []string{"<p>a</p>", "<p>b</p>"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %#v, want %#v", out, want)
	}
}

func TestDoesNotUnwrapStructuralContainers(t *testing.T) {
	// A <ul> carries list structure; its <li> children must stay wrapped.
	out := chunkBlocks("<ul><li>a</li><li>b</li></ul>", 1000)
	want := []string{"<ul><li>a</li><li>b</li></ul>"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %#v, want %#v", out, want)
	}
}

func TestKeepsImagesInsideTheirBlock(t *testing.T) {
	html := `<p>intro</p><figure><img src="https://e.com/a.png"></figure>`
	out := chunkBlocks(html, 8)
	if len(out) != 2 {
		t.Fatalf("got %d batches, want 2: %#v", len(out), out)
	}
	if !strings.Contains(out[1], "https://e.com/a.png") {
		t.Fatalf("image URL missing from batch: %q", out[1])
	}
}

func TestEmptyOrWhitespaceInputYieldsNoBatches(t *testing.T) {
	if got := chunkBlocks("", 1000); len(got) != 0 {
		t.Fatalf("empty: got %#v", got)
	}
	if got := chunkBlocks("   \n  ", 1000); len(got) != 0 {
		t.Fatalf("whitespace: got %#v", got)
	}
}

func TestBareTextIsASingleBatch(t *testing.T) {
	out := chunkBlocks("just text", 1000)
	want := []string{"just text"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %#v, want %#v", out, want)
	}
}

func TestGreedyBatchingPacksUntilBudgetThenBreaks(t *testing.T) {
	// Two 8-byte blocks fit in a 16-byte budget; the third forces a new batch.
	out := chunkBlocks("<p>a</p><p>b</p><p>c</p>", 16)
	want := []string{"<p>a</p><p>b</p>", "<p>c</p>"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %#v, want %#v", out, want)
	}
	if got := strings.Join(out, ""); got != "<p>a</p><p>b</p><p>c</p>" {
		t.Fatalf("reassembly = %q", got)
	}
}

// ── translateSystemPrompt ────────────────────────────────────────────────────

func TestPromptNamesTheTargetLanguage(t *testing.T) {
	p := translateSystemPrompt("Simplified Chinese")
	if !strings.Contains(p, "Simplified Chinese") {
		t.Fatalf("missing language: %s", p)
	}
}

func TestPromptDemandsHTMLBePreserved(t *testing.T) {
	p := strings.ToLower(translateSystemPrompt("Japanese"))
	if !strings.Contains(p, "html") {
		t.Fatalf("no HTML mention: %s", p)
	}
	if !strings.Contains(p, "preserve") && !strings.Contains(p, "keep") {
		t.Fatalf("no preserve directive: %s", p)
	}
}

// ── stripCodeFence ───────────────────────────────────────────────────────────

func TestStripsLanguageTaggedFence(t *testing.T) {
	if got := stripCodeFence("```html\n<p>x</p>\n```"); got != "<p>x</p>" {
		t.Fatalf("got %q", got)
	}
}

func TestStripsBareFence(t *testing.T) {
	if got := stripCodeFence("```\n<p>x</p>\n```"); got != "<p>x</p>" {
		t.Fatalf("got %q", got)
	}
}

func TestLeavesUnfencedContentUntouched(t *testing.T) {
	if got := stripCodeFence("<p>x</p>"); got != "<p>x</p>" {
		t.Fatalf("got %q", got)
	}
	if got := stripCodeFence("  <p>x</p>  "); got != "<p>x</p>" {
		t.Fatalf("got %q", got)
	}
}

// ── languageName ─────────────────────────────────────────────────────────────

func TestLanguageNameMapsCodesWithEnglishFallback(t *testing.T) {
	cases := map[string]string{
		"zh": "Simplified Chinese",
		"ja": "Japanese",
		"en": "English",
		"xx": "English",
	}
	for code, want := range cases {
		if got := languageName(code); got != want {
			t.Fatalf("languageName(%q) = %q, want %q", code, got, want)
		}
	}
}

// ── text-node extraction / rewrite (the machine-translation path) ─────────────
//
// The network call sits between collecting the source text and writing the
// result back; rewriteWith stands in for it with a synchronous mapper so the
// structure-preserving collect → apply → serialize round-trip can be tested.

func rewriteWith(html string, f func([]string) []string) string {
	nodes := parseFragmentChildren(html)
	slots, cores := collectText(nodes)
	translated := f(cores)
	apply(slots, translated)
	return serializeFragment(nodes)
}

func upper(cores []string) []string {
	out := make([]string, len(cores))
	for i, c := range cores {
		out[i] = strings.ToUpper(c)
	}
	return out
}

func TestRewritePreservesInlineTagsAndAttributes(t *testing.T) {
	out := rewriteWith(`<p>Hello <a href="/x">world</a></p>`, upper)
	if out != `<p>HELLO <a href="/x">WORLD</a></p>` {
		t.Fatalf("got %q", out)
	}
}

func TestRewritePreservesWhitespaceBetweenInlineWords(t *testing.T) {
	// The trailing space on "a " must survive so the words stay separated.
	out := rewriteWith("<p>a <b>b</b></p>", upper)
	if out != "<p>A <b>B</b></p>" {
		t.Fatalf("got %q", out)
	}
}

func TestRewriteSkipsCodeAndPreText(t *testing.T) {
	out := rewriteWith("<p>run</p><pre>let x = 1;</pre>", upper)
	if out != "<p>RUN</p><pre>let x = 1;</pre>" {
		t.Fatalf("got %q", out)
	}
}

func TestRewriteKeepsImagesAndBlocksWithNoText(t *testing.T) {
	// No translatable text nodes: collectText returns nothing, and the fragment
	// serializes back unchanged (Go renders the void <img> self-closed).
	html := `<figure><img src="https://e.com/a.png"></figure>`
	want := `<figure><img src="https://e.com/a.png"/></figure>`
	if out := rewriteWith(html, upper); out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestRewriteToleratesAShortTranslationCount(t *testing.T) {
	// An engine returning too few segments must not panic or misalign: the
	// unmatched node keeps its source text.
	out := rewriteWith("<p>one</p><p>two</p>", func([]string) []string {
		return []string{"UNO"}
	})
	if out != "<p>UNO</p><p>two</p>" {
		t.Fatalf("got %q", out)
	}
}

func TestRewriteToleratesAnOverlongTranslationCount(t *testing.T) {
	// Extra segments are dropped rather than misaligned (apply stops at the
	// shorter side).
	out := rewriteWith("<p>one</p>", func([]string) []string {
		return []string{"UNO", "DOS", "TRES"}
	})
	if out != "<p>UNO</p>" {
		t.Fatalf("got %q", out)
	}
}

// ── per-engine budgets / language codes ──────────────────────────────────────

func TestChunkBudgetIsTunedPerEngine(t *testing.T) {
	// Google carries the text in a GET query, so it gets the smallest request;
	// DeepL and Bing take large POST bodies.
	cases := map[string]int{
		"google": 1500,
		"deepl":  8000,
		"bing":   8000,
	}
	for engine, want := range cases {
		if got := chunkBudget(engine); got != want {
			t.Fatalf("chunkBudget(%q) = %d, want %d", engine, got, want)
		}
	}
}

func TestEngineCodesMapTargetsWithEnglishFallback(t *testing.T) {
	if googleCode("zh") != "zh-CN" {
		t.Fatalf("googleCode(zh) = %q", googleCode("zh"))
	}
	if googleCode("ja") != "ja" {
		t.Fatalf("googleCode(ja) = %q", googleCode("ja"))
	}
	if deeplCode("ja") != "JA" {
		t.Fatalf("deeplCode(ja) = %q", deeplCode("ja"))
	}
	if deeplCode("zh") != "ZH" {
		t.Fatalf("deeplCode(zh) = %q", deeplCode("zh"))
	}
	if deeplCode("xx") != "EN" {
		t.Fatalf("deeplCode(xx) = %q", deeplCode("xx"))
	}
	if bingCode("zh") != "zh-Hans" {
		t.Fatalf("bingCode(zh) = %q", bingCode("zh"))
	}
	if bingCode("xx") != "en" {
		t.Fatalf("bingCode(xx) = %q", bingCode("xx"))
	}
}

// ── DeepL timestamp derivation ───────────────────────────────────────────────
//
// The endpoint validates that the timestamp is a multiple of (1 + i-count),
// offset by that amount; the web client computes it from the count of the
// letter `i` across the texts. With no `i`s the raw clock is used verbatim.

func TestDeeplTimestampWithoutAnyIReturnsRawClock(t *testing.T) {
	const ts = 1_700_000_000_123
	if got := deeplTimestamp(0, ts); got != ts {
		t.Fatalf("got %d, want %d", got, ts)
	}
}

func TestDeeplTimestampIsAMultipleOfICountPlusOneOffsetByIt(t *testing.T) {
	// For each i-count, the result must satisfy result % (i+1) == 0 and be the
	// next such multiple strictly above ts (ts - ts%n + n).
	for iCount := int64(1); iCount <= 20; iCount++ {
		const ts = 1_700_000_000_123
		n := iCount + 1
		got := deeplTimestamp(iCount, ts)
		if got%n != 0 {
			t.Fatalf("iCount=%d: %d is not a multiple of %d", iCount, got, n)
		}
		want := ts - (ts % n) + n
		if got != want {
			t.Fatalf("iCount=%d: got %d, want %d", iCount, got, want)
		}
		// It is the first valid timestamp strictly greater than ts.
		if got <= ts || got-ts > n {
			t.Fatalf("iCount=%d: %d is not the next multiple above %d", iCount, got, ts)
		}
	}
}

func TestDeeplTimestampAlreadyOnAMultipleStillAdvances(t *testing.T) {
	// When ts is itself a multiple of n, the web client still advances by n
	// (ts - 0 + n), so the timestamp is never equal to a bare multiple of n.
	const n = int64(5)     // i-count of 4
	ts := int64(1_000_000) // divisible by 5
	got := deeplTimestamp(4, ts)
	if got != ts+n {
		t.Fatalf("got %d, want %d", got, ts+n)
	}
}

// ── generic-wrapper unwrapping (focused, beyond the chunkBlocks cases) ────────

func TestUnwrapAllFourGenericTags(t *testing.T) {
	for _, tag := range []string{"div", "article", "section", "main"} {
		html := "<" + tag + "><p>a</p><p>b</p></" + tag + ">"
		out := chunkBlocks(html, 8)
		want := []string{"<p>a</p>", "<p>b</p>"}
		if !reflect.DeepEqual(out, want) {
			t.Fatalf("tag %q: got %#v, want %#v", tag, out, want)
		}
	}
}

func TestDoesNotUnwrapWhenWrapperHasSiblingBlocks(t *testing.T) {
	// Two top-level elements: not a single wrapper, so nothing is unwrapped and
	// the <div> is serialized as its own block.
	out := chunkBlocks("<div><p>a</p></div><p>b</p>", 1000)
	want := []string{"<div><p>a</p></div><p>b</p>"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %#v, want %#v", out, want)
	}
}

func TestUnwrapStopsAtFirstStructuralChild(t *testing.T) {
	// <div> unwraps to a single <ul>; the <ul> is structural, so unwrapping
	// stops there and the list is kept whole rather than exploded into <li>s.
	out := chunkBlocks("<div><ul><li>a</li><li>b</li></ul></div>", 1000)
	want := []string{"<ul><li>a</li><li>b</li></ul>"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %#v, want %#v", out, want)
	}
}

// ── SSE delta/error extraction (pure, no network) ────────────────────────────

func TestOpenAINullErrorFieldIsNotAnError(t *testing.T) {
	// OpenRouter and other OpenAI-compatible servers ship `"error": null` inside
	// ordinary successful chunks — it must not abort the stream.
	var full strings.Builder
	line := `data: {"choices":[{"delta":{"content":"hello"}}],"error":null}` + "\n"
	if err := handleSSELine(line, providerOpenAI, &full); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if full.String() != "hello" {
		t.Fatalf("delta = %q", full.String())
	}
}

func TestOpenAIRealErrorObjectIsSurfaced(t *testing.T) {
	var full strings.Builder
	line := `data: {"error":{"message":"rate limit exceeded"}}` + "\n"
	err := handleSSELine(line, providerOpenAI, &full)
	if err == nil || !strings.Contains(err.Error(), "rate limit exceeded") {
		t.Fatalf("err = %v", err)
	}
}

func TestOpenAIErrorObjectWithoutMessageFallsBack(t *testing.T) {
	var full strings.Builder
	line := `data: {"error":{"code":500}}` + "\n"
	err := handleSSELine(line, providerOpenAI, &full)
	if err == nil || !strings.Contains(err.Error(), "stream error") {
		t.Fatalf("err = %v", err)
	}
}

func TestAnthropicErrorEventIsSurfaced(t *testing.T) {
	var full strings.Builder
	line := `data: {"type":"error","error":{"message":"overloaded"}}` + "\n"
	err := handleSSELine(line, providerAnthropic, &full)
	if err == nil || !strings.Contains(err.Error(), "overloaded") {
		t.Fatalf("err = %v", err)
	}
}

func TestAnthropicContentDeltaForwardsText(t *testing.T) {
	var full strings.Builder
	line := `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}` + "\n"
	if err := handleSSELine(line, providerAnthropic, &full); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if full.String() != "world" {
		t.Fatalf("delta = %q", full.String())
	}
}

func TestSSEIgnoresNonDataAndDoneLines(t *testing.T) {
	var full strings.Builder
	for _, line := range []string{": keep-alive comment\n", "data: [DONE]\n", "\n"} {
		if err := handleSSELine(line, providerOpenAI, &full); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if full.String() != "" {
		t.Fatalf("accumulated %q", full.String())
	}
}

func TestConsumeSSEAccumulatesAcrossLinesAndFinalUnterminatedFrame(t *testing.T) {
	// Three OpenAI deltas; the last frame is closed without a trailing newline,
	// as a non-compliant local endpoint may do — it must still be parsed.
	body := `data: {"choices":[{"delta":{"content":"a"}}]}` + "\n" +
		`data: {"choices":[{"delta":{"content":"b"}}]}` + "\n" +
		`data: {"choices":[{"delta":{"content":"c"}}]}`
	var seen []string
	got, err := consumeSSE(strings.NewReader(body), providerOpenAI, func(sofar string) {
		seen = append(seen, sofar)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "abc" {
		t.Fatalf("got %q, want %q", got, "abc")
	}
	// The progress hook sees the text so far, growing — that is what lets a
	// batch be shown while it is still being written.
	if len(seen) == 0 || seen[len(seen)-1] != "ab" {
		t.Errorf("progress = %v, want it to report up to the last terminated frame", seen)
	}
}

func TestConsumeSSESurfacesMidStreamError(t *testing.T) {
	body := `data: {"choices":[{"delta":{"content":"a"}}]}` + "\n" +
		`data: {"error":{"message":"boom"}}` + "\n"
	_, err := consumeSSE(strings.NewReader(body), providerOpenAI, nil)
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v", err)
	}
}

// ── Event shape (start → batch* → done) ──────────────────────────────────────

func TestEventTypesMatchTheTranslateEventContract(t *testing.T) {
	// A compile-time + runtime check that the emitted shape carries the fields
	// the frontend expects on each event variant.
	start := Event{Type: "start", Data: EventData{Total: 3}}
	batch := Event{Type: "batch", Data: EventData{HTML: "<p>x</p>", Done: 1}}
	done := Event{Type: "done", Data: EventData{HTML: "<p>x</p>"}}
	if start.Data.Total != 3 || batch.Data.Done != 1 || done.Data.HTML == "" {
		t.Fatalf("event fields not wired: %+v %+v %+v", start, batch, done)
	}
}

// ── LLM provider resolution ──────────────────────────────────────────────────

// The regression this guards: Settings stores providers as a profile list
// (ai_providers + ai_active_provider), and this package used to read the legacy
// flat ai_api_key. A user who had configured a provider — and whose AI panel
// worked — got "no key" from every translation.
func TestLoadAiConfigResolvesTheActiveProviderProfile(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "hiread_test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	ctx := context.Background()

	if _, err := loadAiConfig(ctx, d.R); !strings.Contains(err.Error(), "noAiKey") {
		t.Fatalf("unconfigured: err = %v, want noAiKey", err)
	}

	profiles := `[
	  {"id":"a","name":"Anthropic","provider":"anthropic","apiKey":"key-a","model":"","baseUrl":""},
	  {"id":"b","name":"Local","provider":"openai","apiKey":"key-b","model":"llama","baseUrl":"http://localhost:1234/v1"}
	]`
	if err := db.SetSetting(ctx, d.W, "ai_providers", profiles); err != nil {
		t.Fatalf("SetSetting providers: %v", err)
	}
	if err := db.SetSetting(ctx, d.W, "ai_active_provider", "b"); err != nil {
		t.Fatalf("SetSetting active: %v", err)
	}

	cfg, err := loadAiConfig(ctx, d.R)
	if err != nil {
		t.Fatalf("loadAiConfig: %v", err)
	}
	if cfg.apiKey != "key-b" || cfg.provider != providerOpenAI ||
		cfg.model != "llama" || cfg.baseURL != "http://localhost:1234/v1" {
		t.Errorf("got %+v, want the active openai profile", cfg)
	}

	// A custom OpenAI-compatible endpoint is stored as provider "custom"; it
	// used to fall through this package's switch and be sent Anthropic-shaped
	// requests.
	custom := `[{"id":"c","name":"OpenRouter","provider":"custom","apiKey":"key-c","model":"","baseUrl":"https://openrouter.ai/api/v1"}]`
	if err := db.SetSetting(ctx, d.W, "ai_providers", custom); err != nil {
		t.Fatalf("SetSetting custom: %v", err)
	}
	if err := db.SetSetting(ctx, d.W, "ai_active_provider", "c"); err != nil {
		t.Fatalf("SetSetting active: %v", err)
	}
	cfg, err = loadAiConfig(ctx, d.R)
	if err != nil {
		t.Fatalf("loadAiConfig custom: %v", err)
	}
	if cfg.provider != providerOpenAI || cfg.apiKey != "key-c" {
		t.Errorf("custom endpoint = %+v, want the openai dialect", cfg)
	}
}

// ── batch pipeline ───────────────────────────────────────────────────────────

// blockHTML builds a body of n paragraphs, each over the per-batch budget so
// that batch i is paragraph i — the pipeline's ordering is what these tests are
// about, not its packing (that is covered above).
func blockHTML(n int) string {
	var sb strings.Builder
	for i := 0; i < n; i++ {
		sb.WriteString("<p>")
		sb.WriteString(fmt.Sprintf("%03d", i))
		sb.WriteString(strings.Repeat("x", (maxBatchTokens+200)*4)) // over any per-batch budget
		sb.WriteString("</p>")
	}
	return sb.String()
}

// slowLLM answers every batch after a delay, recording how many requests were
// in flight at once and echoing back a marker the caller can order by.
type slowLLM struct {
	*httptest.Server
	delay time.Duration

	mu       sync.Mutex
	inFlight int
	peak     int
}

func newSlowLLM(t *testing.T, delay time.Duration) *slowLLM {
	t.Helper()
	s := &slowLLM{delay: delay}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.inFlight++
		if s.inFlight > s.peak {
			s.peak = s.inFlight
		}
		s.mu.Unlock()
		time.Sleep(s.delay)
		s.mu.Lock()
		s.inFlight--
		s.mu.Unlock()

		// Echo the first paragraph's 3-digit marker so the caller can tell which
		// batch this answer belongs to. The fragment arrives inside a JSON
		// message body, where `<` is escaped — decode before looking for it.
		marker := "???"
		var body struct {
			Messages []struct{ Content string } `json:"messages"`
		}
		if json.Unmarshal(raw, &body) == nil {
			for _, m := range body.Messages {
				if i := strings.Index(m.Content, "<p>"); i >= 0 && len(m.Content) >= i+6 {
					marker = m.Content[i+3 : i+6]
					break
				}
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		payload, _ := json.Marshal(map[string]any{
			"choices": []any{map[string]any{"delta": map[string]any{"content": "<p>" + marker + "</p>"}}},
		})
		_, _ = w.Write([]byte("data: " + string(payload) + "\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *slowLLM) peakInFlight() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.peak
}

func testBackend(url string) backend {
	return backend{engine: "llm", cfg: aiConfig{
		provider: providerOpenAI, apiKey: "k", model: "m", baseURL: url,
	}}
}

// A chapter is many batches where an article was one or two. Serially that is a
// round-trip each, end to end; the batches are independent, so they overlap.
func TestBatchesTranslateConcurrently(t *testing.T) {
	llm := newSlowLLM(t, 60*time.Millisecond)
	const batches = 8

	start := time.Now()
	out, _, err := translateWith(context.Background(), testBackend(llm.URL), llm.Client(),
		blockHTML(batches), "", "en", "llm", nil)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}

	if peak, want := llm.peakInFlight(), translateConcurrency("llm"); peak < want {
		t.Errorf("peak in-flight requests = %d, want the batches to overlap %d deep", peak, want)
	}
	if peak := llm.peakInFlight(); peak > translateConcurrency("llm") {
		t.Errorf("peak in-flight requests = %d, over the %d cap", peak, translateConcurrency("llm"))
	}
	// Serial would be 8×60ms; four at a time is ~2 rounds. A generous bound so
	// the test is about the shape, not the machine.
	if serial := batches * 60 * time.Millisecond; elapsed > serial*3/4 {
		t.Errorf("took %v, want well under the serial %v", elapsed, serial)
	}
	if !strings.Contains(out, "000") || !strings.Contains(out, fmt.Sprintf("%03d", batches-1)) {
		t.Errorf("output is missing batches:\n%s", out)
	}
}

// Out-of-order completion must not reach the frontend, which appends each batch
// to what it already has.
func TestBatchesAreEmittedInOrder(t *testing.T) {
	llm := newSlowLLM(t, 30*time.Millisecond)
	const batches = 6

	var order []int
	var seen []string
	out, _, err := translateWith(context.Background(), testBackend(llm.URL), llm.Client(),
		blockHTML(batches), "", "en", "llm", func(e Event) {
			if e.Type != "batch" {
				return
			}
			order = append(order, e.Data.Done)
			if e.Data.HTML != "" {
				seen = append(seen, e.Data.HTML)
			}
		})
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	// A batch reports progress while it is being written and again when it is
	// finished, so the count climbs to the total without ever going backwards.
	for i := 1; i < len(order); i++ {
		if order[i] < order[i-1] {
			t.Fatalf("progress went %v, want it never to go backwards", order)
		}
	}
	if len(order) == 0 || order[len(order)-1] != batches {
		t.Fatalf("progress ended at %v, want %d", order, batches)
	}
	// Whatever arrived, arrived in source order.
	for i, html := range seen {
		if want := fmt.Sprintf("%03d", i); !strings.Contains(html, want) {
			t.Errorf("piece %d carried %q, want the %s block", i, html, want)
		}
	}
	// The reassembled document is in source order too.
	if idx := strings.Index(out, "005"); idx < strings.Index(out, "000") {
		t.Errorf("reassembled out of order:\n%s", out)
	}
}

// Eight requests at once is a burst of our own making, so the provider pushing
// back is expected. It used to throw away every batch already generated.
func TestARateLimitedBatchIsRetried(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Fail the first request outright; answer everything after it.
		if atomic.AddInt32(&hits, 1) == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"message":"slow down"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		payload, _ := json.Marshal(map[string]any{
			"choices": []any{map[string]any{"delta": map[string]any{"content": "<p>ok</p>"}}},
		})
		_, _ = w.Write([]byte("data: " + string(payload) + "\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer srv.Close()

	out, _, err := translateWith(context.Background(), testBackend(srv.URL), srv.Client(),
		blockHTML(2), "", "en", "llm", nil)
	if err != nil {
		t.Fatalf("a 429 on one batch should not fail the chapter: %v", err)
	}
	if strings.Count(out, "<p>ok</p>") != 2 {
		t.Errorf("out = %q, want both batches present", out)
	}
}

// A refusal the provider will repeat is not worth waiting through three times.
func TestAnUnretryableFailureIsNotRetried(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("bad key"))
	}))
	defer srv.Close()

	_, _, err := translateWith(context.Background(), testBackend(srv.URL), srv.Client(),
		blockHTML(1), "", "en", "llm", nil)
	if err == nil {
		t.Fatal("want the 401 to fail the run")
	}
	// One body batch and the title, each attempted exactly once.
	if n := atomic.LoadInt32(&hits); n > 2 {
		t.Errorf("made %d requests, want no retries on a 401", n)
	}
}

// A failing batch aborts the run, and nothing keeps running behind it.
func TestABatchFailureStopsTheRest(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&hits, 1) == 1 {
			time.Sleep(20 * time.Millisecond) // let siblings start
		}
		// A refusal, not a rate limit: this one is final on the first try.
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("no such model"))
	}))
	defer srv.Close()

	_, _, err := translateWith(context.Background(), testBackend(srv.URL), srv.Client(),
		blockHTML(6), "", "en", "llm", nil)
	if err == nil {
		t.Fatal("want an error when a batch fails")
	}
	if !strings.Contains(err.Error(), "400") {
		t.Errorf("err = %v, want the provider's status", err)
	}
}

// The point of streaming: text reaches the reader while the model is still
// writing the batch, and it is always renderable markup — never a half-written
// tag, never an unclosed element.
func TestABatchIsShownWhileItIsStillBeingWritten(t *testing.T) {
	// One batch, delivered as a token stream: a complete paragraph, then a
	// second one dribbling out a fragment at a time.
	chunks := []string{
		"```html\n", "<p>", "今夜", "甚美。", "</p>",
		"<blockquote>", "<p>引", "文</p>", "</blockq", "uote>",
		"\n```",
	}
	released := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		for i, c := range chunks {
			payload, _ := json.Marshal(map[string]any{
				"choices": []any{map[string]any{"delta": map[string]any{"content": c}}},
			})
			_, _ = w.Write([]byte("data: " + string(payload) + "\n\n"))
			flusher.Flush()
			if i == len(chunks)/2 {
				<-released // hold the tail back so the head must have gone out alone
			}
			time.Sleep(2 * time.Millisecond)
		}
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer srv.Close()

	var mu sync.Mutex
	var pieces []string
	seen := make(chan struct{}, 16)
	go func() {
		// Let the tail go once something has already been handed over.
		<-seen
		close(released)
	}()

	out, _, err := translateWith(context.Background(), testBackend(srv.URL), srv.Client(),
		"<p>x</p>", "", "en", "llm", func(e Event) {
			if e.Type == "batch" && e.Data.HTML != "" {
				mu.Lock()
				pieces = append(pieces, e.Data.HTML)
				mu.Unlock()
				select {
				case seen <- struct{}{}:
				default:
				}
			}
		})
	if err != nil {
		t.Fatalf("translate: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(pieces) < 2 {
		t.Fatalf("got %d pieces (%q), want the finished paragraph before the rest", len(pieces), pieces)
	}
	if pieces[0] != "<p>今夜甚美。</p>" {
		t.Errorf("first piece = %q, want the one closed paragraph", pieces[0])
	}
	// Nothing handed over is ever half-written, and no fence leaks out.
	for _, p := range pieces {
		if done, rest := splitCompleteBlocks(p); rest != "" || done != p {
			t.Errorf("piece %q is not whole blocks", p)
		}
		if strings.Contains(p, "```") {
			t.Errorf("piece %q carries the code fence", p)
		}
	}
	// The pieces reassemble into exactly the batch's final text.
	if joined := strings.Join(pieces, ""); joined != strings.TrimSpace(out) {
		t.Errorf("pieces joined to %q, want the final %q", joined, strings.TrimSpace(out))
	}
}

// A batch the provider cut off at the output cap is text silently lost — it
// would be stored, and read, as if the model had finished it. The retry asks
// for the full cap.
func TestATruncatedBatchIsNotAcceptedAsFinished(t *testing.T) {
	var hits int32
	var mu sync.Mutex
	var askedFor []float64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&hits, 1)
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		askedFor = append(askedFor, body["max_tokens"].(float64))
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		write := func(v map[string]any) {
			payload, _ := json.Marshal(v)
			_, _ = w.Write([]byte("data: " + string(payload) + "\n\n"))
		}
		write(map[string]any{
			"choices": []any{map[string]any{"delta": map[string]any{"content": "<p>half a "}}},
		})
		if n == 1 {
			// Cut short: the answer stops at the cap mid-sentence.
			write(map[string]any{"choices": []any{map[string]any{"finish_reason": "length"}}})
			return
		}
		write(map[string]any{
			"choices": []any{map[string]any{"delta": map[string]any{"content": "paragraph</p>"}}},
		})
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer srv.Close()

	out, _, err := translateWith(context.Background(), testBackend(srv.URL), srv.Client(),
		"<p>x</p>", "", "en", "llm", nil)
	if err != nil {
		t.Fatalf("the retry should have finished it: %v", err)
	}
	if !strings.Contains(out, "<p>half a paragraph</p>") {
		t.Errorf("out = %q, want the complete second attempt", out)
	}
	if strings.Count(out, "half a") != 1 {
		t.Errorf("out = %q, want the truncated attempt discarded, not appended", out)
	}
	// Asking again for the room that just proved too small would truncate again.
	mu.Lock()
	defer mu.Unlock()
	if len(askedFor) != 2 {
		t.Fatalf("made %d requests, want the first and its retry", len(askedFor))
	}
	if askedFor[0] >= translateMaxTokens {
		t.Errorf("first attempt asked for %v, want it sized to the batch", askedFor[0])
	}
	if int(askedFor[1]) != translateMaxTokens {
		t.Errorf("retry asked for %v, want the full %d cap", askedFor[1], translateMaxTokens)
	}
}

// Anthropic spells the same thing differently.
func TestTruncationIsRecognisedInBothProviderShapes(t *testing.T) {
	openai := sseFrame{}
	openai.Choices = append(openai.Choices, struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	}{FinishReason: "length"})
	if !truncated(&openai, providerOpenAI) {
		t.Error(`finish_reason "length" must read as truncated`)
	}

	var anthropic sseFrame
	anthropic.Delta.StopReason = "max_tokens"
	if !truncated(&anthropic, providerAnthropic) {
		t.Error(`stop_reason "max_tokens" must read as truncated`)
	}

	var normal sseFrame
	normal.Delta.StopReason = "end_turn"
	if truncated(&normal, providerAnthropic) {
		t.Error("a normal stop must not read as truncated")
	}
}
