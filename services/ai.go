package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"hiread/internal/ai"
	"hiread/internal/apperr"
	"hiread/internal/appstate"
	"hiread/internal/db"
	"hiread/internal/events"
	"hiread/internal/models"
	"hiread/internal/sanitize"
	"hiread/internal/translate"
)

// AIService exposes the streaming AI commands. Wails streams over named
// events: each call carries a streamID and tokens are
// emitted on the event "ai:<streamID>" (the frontend subscribes before calling
// and unsubscribes on the terminal {type:"done"} / {type:"error"}). The first
// parameter is context.Context so the frontend can cancel a stream (it is not
// part of the generated TS signature).
type AIService struct {
	app *appstate.State
}

// aiEmitter forwards AI events to the per-request Wails event and accumulates
// the delta text so the caller can persist a completed result.
type aiEmitter struct {
	seq *events.Sequencer
	acc strings.Builder
}

func (e *aiEmitter) emit(ev ai.Event) {
	if ev.Type == ai.EventDelta {
		e.acc.WriteString(ev.Data)
	}
	// Sequenced so the frontend can restore emit order: Wails dispatches each
	// event on its own goroutine, which otherwise lets rapid tokens race and
	// arrive shuffled. See events.Sequencer.
	e.seq.Emit(ev)
}

// Summarize streams an AI summary of one chapter; a completed summary is
// cached on the chapter so the next open is instant.
func (s *AIService) Summarize(ctx context.Context, bookID, chapterIndex int64, streamID string) error {
	title, text, err := db.ChapterTitleText(ctx, s.app.DB.R, bookID, chapterIndex)
	if err != nil {
		return err
	}
	// An empty chapter (a plate page, a section divider) gives the model nothing
	// to summarize — bail rather than let it fabricate one from the title.
	if strings.TrimSpace(text) == "" {
		return apperr.Code("noChapterText")
	}
	cfg, err := ai.ConfigFromSettings(ctx, s.app.DB.R)
	if err != nil {
		return err
	}
	// LanguageFromSettings already maps the setting to a prompt directive; do
	// not wrap it in ResponseLanguage again — the directive string matches no
	// language code, so the second mapping always fell through to English and a
	// zh/ja user got English summaries.
	lang := ai.LanguageFromSettings(ctx, s.app.DB.R)
	em := &aiEmitter{seq: events.NewSequencer("ai:" + streamID)}
	if err := ai.Summarize(ctx, s.app.HTTP(), cfg, title, text, lang, em.emit); err != nil {
		return err
	}
	// Cache only a summary that streamed to completion (the panel wasn't closed
	// mid-stream) — storing a truncated fragment would show a broken half
	// summary with no obvious way to regenerate it.
	if ctx.Err() == nil && strings.TrimSpace(em.acc.String()) != "" {
		_ = db.SetChapterAISummary(ctx, s.app.DB.W, bookID, chapterIndex, strings.TrimSpace(em.acc.String()))
	}
	return nil
}

// Runtime-tunable AI knobs. Each has a compiled-in default and a settings-table
// key; the AI settings section writes the keys and Ask reads them per request
// (clamped in intSetting), so they can be tuned without a rebuild.
const (
	defaultRAGLimit     = 20  // FTS-relevance hits for a keyword question
	defaultRecentLimit  = 40  // recently-read chapters when FTS finds nothing
	defaultSummaryChars = 500 // per-chapter excerpt length fed to Ask
	defaultHistoryTurns = 6   // prior exchanges kept as conversation context

	settingRAGLimit     = "ai_rag_limit"
	settingRecentLimit  = "ai_recent_limit"
	settingSummaryChars = "ai_summary_chars"
	settingHistoryTurns = "ai_history_turns"
)

// intSetting reads an integer AI knob from the settings table, falling back to
// def when unset or unparseable, and clamps the result to [lo, hi]. The AI
// settings section writes these keys; Ask resolves them per request so a change
// takes effect without restarting.
func intSetting(ctx context.Context, q db.Querier, key string, def, lo, hi int) int {
	v, err := db.GetSetting(ctx, q, key)
	if err != nil || v == nil {
		return def
	}
	n, err := strconv.Atoi(strings.TrimSpace(*v))
	if err != nil {
		return def
	}
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

// intSettingFrom is intSetting over a batch already fetched by db.GetSettings,
// so a request that resolves several knobs pays one query for all of them.
func intSettingFrom(vals map[string]string, key string, def, lo, hi int) int {
	v, ok := vals[key]
	if !ok {
		return def
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return def
	}
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

// aiSource is one retrieved chapter surfaced to the UI as a clickable citation.
// Emitted (JSON-encoded) as the sources event ahead of the streamed answer.
type aiSource struct {
	BookID       int64  `json:"bookId"`
	BookTitle    string `json:"bookTitle"`
	ChapterIndex int64  `json:"chapterIndex"`
	ChapterTitle string `json:"chapterTitle"`
}

// Ask answers a question using the library as RAG context (FTS5 keyword
// retrieval over chapter text), streaming the answer. Passing a bookID scopes
// retrieval to that book — "ask this book" rather than "ask my library". Each
// chapter contributes a bounded excerpt (its cached AI summary when it has one)
// rather than its full text, so many chapters fit in one context window.
// `history` is the prior conversation so a follow-up keeps its thread.
func (s *AIService) Ask(ctx context.Context, question string, bookID *int64, history []ai.Message, streamID string) error {
	cfg, err := ai.ConfigFromSettings(ctx, s.app.DB.R)
	if err != nil {
		return err
	}
	q := s.app.DB.R
	settings, err := db.GetSettings(ctx, q, []string{
		settingRAGLimit, settingRecentLimit, settingSummaryChars, settingHistoryTurns,
	})
	if err != nil {
		return err
	}
	ragLimit := intSettingFrom(settings, settingRAGLimit, defaultRAGLimit, 1, 200)
	recentLimit := intSettingFrom(settings, settingRecentLimit, defaultRecentLimit, 1, 200)
	summaryChars := intSettingFrom(settings, settingSummaryChars, defaultSummaryChars, 100, 4000)
	historyTurns := intSettingFrom(settings, settingHistoryTurns, defaultHistoryTurns, 0, 50)

	hits, err := db.SearchChaptersForRAG(ctx, q, question, bookID, int64(ragLimit), int64(summaryChars))
	if err != nil {
		return err
	}
	// Keyword retrieval finds nothing for questions carrying no content terms —
	// "what should I read next?", "summarize where I am". Rather than answer
	// "no text was provided", fall back to the most recently opened chapters so
	// overview questions still get a real answer. `recent` lets Ask frame that
	// fallback as a recent selection, so the model does not report those
	// chapters as the user's entire library.
	recent := false
	if len(hits) == 0 {
		recent = true
		hits, err = db.RecentChaptersForRAG(ctx, q, bookID, int64(recentLimit), int64(summaryChars))
		if err != nil {
			return err
		}
	}
	var contextBuf strings.Builder
	for _, h := range hits {
		excerpt := strings.TrimSpace(h.Excerpt)
		if excerpt == "" {
			continue
		}
		fmt.Fprintf(&contextBuf, "## %s — %s\n%s\n\n", h.BookTitle, h.ChapterTitle, excerpt)
	}
	lang := ai.LanguageFromSettings(ctx, s.app.DB.R)
	em := &aiEmitter{seq: events.NewSequencer("ai:" + streamID)}
	// Emit the retrieved chapters first — sequenced ahead of the answer tokens,
	// so the frontend has its citations before the first delta and a click can
	// jump straight to the passage.
	if len(hits) > 0 {
		srcs := make([]aiSource, 0, len(hits))
		for _, h := range hits {
			srcs = append(srcs, aiSource{
				BookID: h.BookID, BookTitle: h.BookTitle,
				ChapterIndex: h.ChapterIndex, ChapterTitle: h.ChapterTitle,
			})
		}
		if b, err := json.Marshal(srcs); err == nil {
			em.emit(ai.Event{Type: ai.EventSources, Data: string(b)})
		}
	}
	return ai.Ask(ctx, s.app.HTTP(), cfg, question, contextBuf.String(), lang, history, recent, historyTurns, em.emit)
}

// Chat streams a plain assistant reply with no library context (pure chat),
// keeping the recent conversation for follow-ups.
func (s *AIService) Chat(ctx context.Context, question string, history []ai.Message, streamID string) error {
	cfg, err := ai.ConfigFromSettings(ctx, s.app.DB.R)
	if err != nil {
		return err
	}
	historyTurns := intSetting(ctx, s.app.DB.R, settingHistoryTurns, defaultHistoryTurns, 0, 50)
	lang := ai.LanguageFromSettings(ctx, s.app.DB.R)
	em := &aiEmitter{seq: events.NewSequencer("ai:" + streamID)}
	return ai.Chat(ctx, s.app.HTTP(), cfg, question, lang, history, historyTurns, em.emit)
}

// Configured reports whether an LLM provider is usable right now. The UI needs
// this to warn before a request is made ("this engine needs a key"), and asking
// the backend is the only way to keep that warning honest: a provider can be
// stored as a profile in the ai_providers list or in the older flat settings,
// and only internal/ai knows the whole resolution. Reading one setting from the
// frontend guessed at it, and guessed wrong for every profile-based config.
func (s *AIService) Configured() (bool, error) {
	_, err := ai.ConfigFromSettings(bg(), s.app.DB.R)
	if err == nil {
		return true, nil
	}
	if apperr.CodeOf(err) == "noAiKey" {
		return false, nil // unconfigured is an answer, not a failure
	}
	return false, err
}

// GetTranslation returns a cached chapter translation, or null when this
// chapter has not been translated into this language by this engine.
func (s *AIService) GetTranslation(bookID, chapterIndex int64, lang, engine string) (*models.ChapterTranslation, error) {
	ctx := bg()
	return db.GetChapterTranslation(ctx, s.app.DB.R, bookID, chapterIndex, resolveTargetLang(ctx, s.app.DB.R, lang), normalizeEngine(engine))
}

// Translate translates one chapter into lang using engine ("llm" / "google" /
// "deepl" / "bing"), streaming progress per batch over the event
// "translate:<streamID>". The reassembled, sanitized result is cached and
// reused on the next open — a chapter is long, and translation is billed by the
// token. Each batch is re-sanitized here since engine output is untrusted.
func (s *AIService) Translate(ctx context.Context, bookID, chapterIndex int64, lang, engine, streamID string) error {
	chapter, err := db.GetChapter(ctx, s.app.DB.R, bookID, chapterIndex)
	if err != nil {
		return err
	}
	if strings.TrimSpace(sanitize.HTMLToText(chapter.HTML)) == "" {
		return apperr.Code("noChapterText")
	}
	target := resolveTargetLang(ctx, s.app.DB.R, lang)
	engine = normalizeEngine(engine)

	// Sequenced like the AI stream so reordered Wails delivery can't shuffle the
	// translated batches (see events.Sequencer).
	seq := events.NewSequencer("translate:" + streamID)
	emit := func(e translate.Event) {
		if e.Data.HTML != "" {
			e.Data.HTML = sanitize.Chapter(e.Data.HTML)
		}
		seq.Emit(e)
	}
	result, title, err := translate.Translate(ctx, s.app.HTTP(), s.app.DB.R, chapter.HTML, chapter.Title, target, engine, emit)
	if err != nil {
		return err
	}
	final := strings.TrimSpace(sanitize.Chapter(result))
	if final != "" && ctx.Err() == nil {
		var titlePtr *string
		if t := strings.TrimSpace(title); t != "" {
			titlePtr = &t
		}
		_ = db.UpsertChapterTranslation(ctx, s.app.DB.W, bookID, chapterIndex, target, engine, titlePtr, final)
	}
	return nil
}

// normalizeEngine folds any unrecognized engine onto the LLM path, so the cache
// key always matches what the reader later queries with (translate.Translate
// makes the same fallback internally).
func normalizeEngine(engine string) string {
	switch engine {
	case "google", "deepl", "bing":
		return engine
	default:
		return "llm"
	}
}

// resolveTargetLang picks the translation target: an explicit request first,
// then the dedicated translate_target_lang setting, then the UI language, then
// English.
func resolveTargetLang(ctx context.Context, q db.Querier, requested string) string {
	if t := strings.TrimSpace(requested); t != "" {
		return t
	}
	for _, key := range []string{"translate_target_lang", "language"} {
		if v, _ := db.GetSetting(ctx, q, key); v != nil && strings.TrimSpace(*v) != "" {
			return *v
		}
	}
	return "en"
}
