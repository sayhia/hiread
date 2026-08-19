package ai

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"hiread/internal/db"
)

// collect feeds each line through handleSSELine for the given provider and
// returns the deltas emitted plus the first error raised (nil if none).
func collect(t *testing.T, prov provider, lines []string) ([]string, error) {
	t.Helper()
	var got []string
	emit := func(e Event) {
		if e.Type == EventDelta {
			got = append(got, e.Data)
		}
	}
	for _, line := range lines {
		if err := handleSSELine(line, prov, emit); err != nil {
			return got, err
		}
	}
	return got, nil
}

func TestSSEDeltaOpenAI(t *testing.T) {
	lines := []string{
		`: keep-alive comment`,
		`data: {"choices":[{"delta":{"content":"Hello"}}]}`,
		`data: {"choices":[{"delta":{"content":", world"}}]}`,
		`data: {"choices":[{"delta":{}}]}`, // role-only chunk, no content
		`data: [DONE]`,
		``, // blank line
	}
	got, err := collect(t, providerOpenAI, lines)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Join(got, "") != "Hello, world" {
		t.Fatalf("deltas = %q, want %q", got, []string{"Hello", ", world"})
	}
}

func TestSSEDeltaAnthropic(t *testing.T) {
	lines := []string{
		`data: {"type":"message_start","message":{}}`,
		`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}`,
		`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}`,
		`data: {"type":"content_block_stop"}`,
		`data: {"type":"message_stop"}`,
	}
	got, err := collect(t, providerAnthropic, lines)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Join(got, "") != "Hello there" {
		t.Fatalf("deltas = %q, want %q", got, []string{"Hello", " there"})
	}
}

// A trailing data: line with no newline is fed verbatim (as consumeSSE's
// scanner yields it at EOF) — its delta must still be parsed.
func TestSSEFinalFrameNoNewline(t *testing.T) {
	got, err := collect(t, providerOpenAI, []string{
		`data: {"choices":[{"delta":{"content":"!"}}]}`,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0] != "!" {
		t.Fatalf("deltas = %q, want [\"!\"]", got)
	}
}

// OpenRouter-style "error": null inside a successful chunk must not abort.
func TestSSEOpenAINullErrorIsNotAnError(t *testing.T) {
	got, err := collect(t, providerOpenAI, []string{
		`data: {"choices":[{"delta":{"content":"ok"}}],"error":null}`,
	})
	if err != nil {
		t.Fatalf("null error must not abort: %v", err)
	}
	if len(got) != 1 || got[0] != "ok" {
		t.Fatalf("deltas = %q, want [\"ok\"]", got)
	}
}

func TestSSEOpenAIErrorObjectSurfaced(t *testing.T) {
	_, err := collect(t, providerOpenAI, []string{
		`data: {"error":{"message":"rate limit exceeded"}}`,
	})
	if err == nil || !strings.Contains(err.Error(), "rate limit exceeded") {
		t.Fatalf("err = %v, want it to contain \"rate limit exceeded\"", err)
	}
}

func TestSSEOpenAIErrorWithoutMessageFallsBack(t *testing.T) {
	_, err := collect(t, providerOpenAI, []string{
		`data: {"error":{"code":500}}`,
	})
	if err == nil || !strings.Contains(err.Error(), "stream error") {
		t.Fatalf("err = %v, want it to contain \"stream error\"", err)
	}
}

func TestSSEAnthropicErrorEventSurfaced(t *testing.T) {
	_, err := collect(t, providerAnthropic, []string{
		`data: {"type":"error","error":{"message":"overloaded"}}`,
	})
	if err == nil || !strings.Contains(err.Error(), "overloaded") {
		t.Fatalf("err = %v, want it to contain \"overloaded\"", err)
	}
}

// An Anthropic content delta is not an error and must not be misread as one.
func TestSSEAnthropicDeltaIsNotAnError(t *testing.T) {
	got, err := collect(t, providerAnthropic, []string{
		`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}`,
	})
	if err != nil {
		t.Fatalf("content delta surfaced as error: %v", err)
	}
	if len(got) != 1 || got[0] != "world" {
		t.Fatalf("deltas = %q, want [\"world\"]", got)
	}
}

// --- newConfig: credential normalisation and per-provider defaults. ---

func ptr(s string) *string { return &s }

func TestConfigTrimsAPIKey(t *testing.T) {
	cfg, err := newConfig(ptr("openai"), ptr("  sk-abc123\n"), nil, nil)
	if err != nil {
		t.Fatalf("a key with surrounding whitespace is still usable: %v", err)
	}
	if cfg.apiKey != "sk-abc123" {
		t.Fatalf("apiKey = %q, want %q", cfg.apiKey, "sk-abc123")
	}
}

func TestConfigRejectsWhitespaceOnlyKey(t *testing.T) {
	_, err := newConfig(ptr("openai"), ptr("   \n"), nil, nil)
	if err == nil || !strings.Contains(err.Error(), "noAiKey") {
		t.Fatalf("err = %v, want noAiKey", err)
	}
}

func TestConfigRejectsMissingKey(t *testing.T) {
	_, err := newConfig(ptr("openai"), nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "noAiKey") {
		t.Fatalf("err = %v, want noAiKey", err)
	}
}

func TestConfigDefaultsAnthropic(t *testing.T) {
	cfg, err := newConfig(nil, ptr("sk-key"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.provider != providerAnthropic {
		t.Fatalf("provider = %v, want anthropic", cfg.provider)
	}
	if cfg.model != defaultAnthropicModel {
		t.Fatalf("model = %q, want %q", cfg.model, defaultAnthropicModel)
	}
	if cfg.baseURL != defaultAnthropicBaseURL {
		t.Fatalf("baseURL = %q, want %q", cfg.baseURL, defaultAnthropicBaseURL)
	}
	if cfg.maxTokens != MaxTokens {
		t.Fatalf("maxTokens = %d, want %d", cfg.maxTokens, MaxTokens)
	}
}

func TestConfigDefaultsOpenAIAndTrimsModel(t *testing.T) {
	cfg, err := newConfig(ptr("openai"), ptr("sk-key"), ptr(" "), nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.provider != providerOpenAI {
		t.Fatalf("provider = %v, want openai", cfg.provider)
	}
	// A whitespace-only model trims to empty and must yield the provider
	// default, not an empty string in the request body.
	if cfg.model != defaultOpenAIModel {
		t.Fatalf("model = %q, want %q", cfg.model, defaultOpenAIModel)
	}
}

func TestConfigTrimsBaseURLTrailingSlash(t *testing.T) {
	cfg, err := newConfig(ptr("openai"), ptr("sk-key"), nil, ptr("  https://example.com/v1/  "))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.baseURL != "https://example.com/v1" {
		t.Fatalf("baseURL = %q, want %q", cfg.baseURL, "https://example.com/v1")
	}
}

func TestResponseLanguage(t *testing.T) {
	if d := ResponseLanguage("zh"); !strings.Contains(d, "Simplified Chinese") {
		t.Fatalf("zh directive = %q", d)
	}
	if d := ResponseLanguage("ja"); !strings.Contains(d, "Japanese") {
		t.Fatalf("ja directive = %q", d)
	}
	if d := ResponseLanguage("xx"); !strings.Contains(d, "English") {
		t.Fatalf("fallback directive = %q", d)
	}
}

// LanguageFromSettings must return a ready-to-use prompt directive, not a bare
// language code: the service appends its result to the system prompt as-is.
// Wrapping it in ResponseLanguage a second time (the bug that gave zh/ja users
// English summaries) falls through to the English default, since a directive
// string matches no language code. This locks that contract.
func TestLanguageFromSettingsReturnsReadyDirective(t *testing.T) {
	ctx := context.Background()
	d, err := db.Open(filepath.Join(t.TempDir(), "hiread_test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })

	// No setting → the documented English default.
	if got := LanguageFromSettings(ctx, d.R); !strings.Contains(got, "English") {
		t.Fatalf("default directive = %q, want English", got)
	}

	if err := db.SetSetting(ctx, d.W, "language", "zh"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	got := LanguageFromSettings(ctx, d.R)
	if !strings.Contains(got, "Simplified Chinese") {
		t.Fatalf("zh directive = %q, want Simplified Chinese", got)
	}
	// Guard against re-introducing the double-wrap: a directive is not a valid
	// ResponseLanguage input, so re-mapping it lands on the English default.
	if rewrapped := ResponseLanguage(got); !strings.Contains(rewrapped, "English") {
		t.Fatalf("re-wrapping a directive should fall through to English, got %q", rewrapped)
	}
}

// streamChat must emit a terminal error event and return the error when the
// transport fails — no real network call is made (the request is cancelled
// before it goes out). This locks the {error,return} contract without hitting
// the network.
func TestStreamChatEmitsTerminalError(t *testing.T) {
	cfg, err := newConfig(ptr("openai"), ptr("sk-key"), nil, ptr("http://127.0.0.1:0"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // ensure the request fails immediately, offline.

	var events []Event
	emit := func(e Event) { events = append(events, e) }
	err = streamChat(ctx, http.DefaultClient, cfg, "sys", []Message{{Role: "user", Content: "usr"}}, emit)
	if err == nil {
		t.Fatal("expected an error from a cancelled request")
	}
	if len(events) != 1 || events[0].Type != EventError {
		t.Fatalf("events = %+v, want a single error event", events)
	}
}

// trimHistory must keep the most recent N exchanges as whole user/assistant
// pairs so a long conversation stays bounded and still starts with a user turn.
func TestTrimHistoryKeepsRecentPairs(t *testing.T) {
	mk := func(n int) []Message {
		h := make([]Message, 0, n*2)
		for i := 0; i < n; i++ {
			d := string(rune('0' + i))
			h = append(h, Message{Role: "user", Content: "q" + d})
			h = append(h, Message{Role: "assistant", Content: "a" + d})
		}
		return h
	}
	// Under the cap: returned unchanged.
	if got := trimHistory(mk(3), 6); len(got) != 6 {
		t.Fatalf("3 turns under cap: got %d msgs, want 6", len(got))
	}
	// Over the cap: keep the last maxTurns pairs, still starting with a user msg.
	got := trimHistory(mk(10), 6)
	if len(got) != 12 {
		t.Fatalf("10 turns capped at 6: got %d msgs, want 12", len(got))
	}
	if got[0].Role != "user" || got[0].Content != "q4" {
		t.Fatalf("first kept = %+v, want user/q4 (last 6 of 10)", got[0])
	}
	if got[11].Role != "assistant" || got[11].Content != "a9" {
		t.Fatalf("last kept = %+v, want assistant/a9", got[11])
	}
	// Non-positive cap drops history entirely.
	if got := trimHistory(mk(2), 0); got != nil {
		t.Fatalf("maxTurns=0: got %v, want nil", got)
	}
}

// ConfigFromSettings must resolve the active profile from the ai_providers list,
// preferring it over the legacy single-provider keys, and default to the first
// profile when the active id is unset or dangling.
func TestConfigFromSettingsPrefersActiveProfile(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "hiread_test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	ctx := context.Background()
	// Legacy keys present — the profile list must override them.
	_ = db.SetSetting(ctx, d.W, "ai_provider", "anthropic")
	_ = db.SetSetting(ctx, d.W, "ai_api_key", "legacy-key")
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

	cfg, err := ConfigFromSettings(ctx, d.R)
	if err != nil {
		t.Fatalf("ConfigFromSettings: %v", err)
	}
	if cfg.provider != providerOpenAI || cfg.apiKey != "key-b" ||
		cfg.model != "llama" || cfg.baseURL != "http://localhost:1234/v1" {
		t.Errorf("active profile b: got %v/%q/%q/%q, want openai/key-b/llama/localhost",
			cfg.provider, cfg.apiKey, cfg.model, cfg.baseURL)
	}

	// Dangling active id → default to the first profile.
	if err := db.SetSetting(ctx, d.W, "ai_active_provider", "gone"); err != nil {
		t.Fatalf("SetSetting active: %v", err)
	}
	cfg, err = ConfigFromSettings(ctx, d.R)
	if err != nil {
		t.Fatalf("ConfigFromSettings (dangling): %v", err)
	}
	if cfg.provider != providerAnthropic || cfg.apiKey != "key-a" {
		t.Errorf("dangling active: got %v/%q, want anthropic/key-a (first profile)", cfg.provider, cfg.apiKey)
	}
}

// A "custom" provider profile uses the OpenAI request/SSE dialect (its own base
// URL makes it point anywhere OpenAI-compatible).
func TestNewConfigCustomUsesOpenAIDialect(t *testing.T) {
	prov, key := "custom", "k"
	cfg, err := newConfig(&prov, &key, nil, nil)
	if err != nil {
		t.Fatalf("newConfig: %v", err)
	}
	if cfg.provider != providerOpenAI {
		t.Errorf("custom dialect = %v, want providerOpenAI", cfg.provider)
	}
}

// With no ai_providers list, ConfigFromSettings must use the legacy keys.
func TestConfigFromSettingsFallsBackToLegacyKeys(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "hiread_test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	ctx := context.Background()
	_ = db.SetSetting(ctx, d.W, "ai_provider", "deepseek")
	_ = db.SetSetting(ctx, d.W, "ai_api_key", "legacy-key")
	cfg, err := ConfigFromSettings(ctx, d.R)
	if err != nil {
		t.Fatalf("ConfigFromSettings: %v", err)
	}
	if cfg.provider != providerDeepSeek || cfg.apiKey != "legacy-key" {
		t.Errorf("no profile list: got %v/%q, want deepseek/legacy-key", cfg.provider, cfg.apiKey)
	}
}
