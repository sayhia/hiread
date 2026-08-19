// Package ai provides cloud LLM streaming for article summaries and RAG Q&A.
// Provider-agnostic (Anthropic / OpenAI); a local OpenAI-compatible backend
// works via the base-URL override.
//
// Streaming functions take an `emit` callback so the package stays
// network-and-UI-agnostic and the service layer adapts it to Wails events.
// The retrieval / digest text is assembled by the caller
// (db.SearchArticlesForRAG / db.DigestSource) and passed in — this package
// owns the prompts wrapped around that text, not the SQL.
package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"hiread/internal/apperr"
	"hiread/internal/db"
)

// requestTimeout is the per-request cap for AI streaming. The shared HTTP client
// carries the feed-fetch timeout (~30s), which would truncate a long
// generation — so AI requests override it with a generous bound. Mirrors
// ai.rs AI_REQUEST_TIMEOUT (300s).
const requestTimeout = 300 * time.Second

// MaxTokens is the output token cap for summaries / Q&A / digests, applied to
// every provider so a response stays bounded in length and cost. Mirrors
// ai.rs MAX_TOKENS.
const MaxTokens = 1024

// maxSSEBuffer is a hard cap on the SSE line buffer. A well-behaved provider
// delimits every event with a newline, so the buffer never holds more than a
// single frame. A misbehaving or non-SSE endpoint (the base URL can point at
// any OpenAI-compatible server, including a local one) could instead stream
// bytes with no newline at all — without this cap that response would
// accumulate in memory unbounded. 8 MiB is far larger than any genuine SSE
// frame while still stopping a runaway stream. Mirrors ai.rs MAX_SSE_BUFFER.
const maxSSEBuffer = 8 * 1024 * 1024

// Settings keys read from the settings table — same keys ai.rs / commands.rs
// read via load_ai_config and response_language.
const (
	settingProvider = "ai_provider"
	settingAPIKey   = "ai_api_key"
	settingModel    = "ai_model"
	settingBaseURL  = "ai_base_url"
	settingLanguage = "language"

	// Multi-provider: a JSON array of saved provider profiles and the id of the
	// active one. When set, they take precedence over the four single-provider
	// keys above (which stay as the pre-multi-provider fallback).
	settingProviders      = "ai_providers"
	settingActiveProvider = "ai_active_provider"
)

// Default models and API roots per provider, mirroring ai.rs.
const (
	defaultAnthropicModel = "claude-sonnet-4-6"
	defaultOpenAIModel    = "gpt-4.1-mini"
	defaultDeepSeekModel  = "deepseek-chat"

	defaultAnthropicBaseURL = "https://api.anthropic.com/v1"
	defaultOpenAIBaseURL    = "https://api.openai.com/v1"
	// DeepSeek serves the OpenAI-compatible API at this root; the request path
	// (/chat/completions) is appended like any OpenAI-compatible provider.
	defaultDeepSeekBaseURL = "https://api.deepseek.com"
)

// provider identifies the LLM API dialect. Anthropic uses /messages +
// x-api-key; OpenAI uses /chat/completions + bearer auth. They differ in
// request shape and in how a streamed delta / error is extracted.
type provider int

const (
	providerAnthropic provider = iota
	providerOpenAI
	// providerDeepSeek exposes an OpenAI-compatible API (same /chat/completions
	// endpoint, request body and SSE shape), so it reuses the OpenAI request and
	// parsing paths; only the default base URL and model differ.
	providerDeepSeek
)

// Event is a token-level event passed to the streaming callback. Type is one of
// "delta", "done", or "error"; Data carries the token text or the error
// message. Mirrors types.ts AiEvent (and ai.rs AiEvent).
type Event struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
}

// Event type constants for the values Event.Type takes. EventSources is emitted
// once, before the answer, by the RAG Q&A path (Ask): its Data is a JSON array of
// the retrieved articles so the UI can show clickable sources under the answer.
const (
	EventDelta   = "delta"
	EventDone    = "done"
	EventError   = "error"
	EventSources = "sources"
)

// Message is one turn in a chat conversation. Role is "user" or "assistant".
// Ask threads prior turns through so a follow-up question keeps its context;
// single-turn callers (Summarize, Digest) pass exactly one user Message.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Config is the resolved AI configuration read from the settings table.
type Config struct {
	provider provider
	apiKey   string
	model    string
	// baseURL is the API root, without a trailing slash — the per-provider
	// request path (/messages, /chat/completions) is appended to it. Defaults
	// to the official endpoint; an override points at any compatible provider
	// (OpenRouter, Groq, DeepSeek, a local server, …).
	baseURL string
	// maxTokens is the output token cap sent with each request.
	maxTokens int
	// timeout is the per-request cap for a streamed generation.
	timeout time.Duration
}

// LLMSettings is a resolved provider configuration in plain strings, for a
// caller that makes its own request instead of going through this package —
// internal/translate has its own non-streaming batch call. Sharing the
// *resolution* is the point: a provider configured in Settings has to mean the
// same thing everywhere, and it stopped meaning the same thing once provider
// profiles arrived and only this package learned to read them.
type LLMSettings struct {
	// Provider is the API dialect: "anthropic", "openai" or "deepseek".
	Provider string
	APIKey   string
	Model    string
	BaseURL  string
}

// Settings exposes the resolved configuration.
func (c Config) Settings() LLMSettings {
	prov := "anthropic"
	switch c.provider {
	case providerOpenAI:
		prov = "openai"
	case providerDeepSeek:
		prov = "deepseek"
	}
	return LLMSettings{Provider: prov, APIKey: c.apiKey, Model: c.model, BaseURL: c.baseURL}
}

// ConfigFromSettings builds a Config from the settings table, applying the same
// per-provider defaults as ai.rs AiConfig::new. It reads ai_provider /
// ai_api_key / ai_model / ai_base_url. Returns a "noAiKey" coded error when no
// usable API key is set.
func ConfigFromSettings(ctx context.Context, q db.Querier) (Config, error) {
	// Prefer the multi-provider list + active id. ok=false means no usable list
	// is stored, so fall back to the legacy single-provider keys (older configs,
	// or before the frontend migrates them into a profile).
	if cfg, ok, err := configFromProfiles(ctx, q); ok || err != nil {
		return cfg, err
	}
	// Batched read: four single-key GetSetting round-trips collapsed into one
	// GetSettings query. GetSettings returns only stored keys and the map
	// reads a missing key as "", and newConfig treats nil and "" identically
	// (it derefs), so this is behaviour-identical to the four calls.
	vals, err := db.GetSettings(ctx, q, []string{settingProvider, settingAPIKey, settingModel, settingBaseURL})
	if err != nil {
		return Config{}, err
	}
	str := func(v string) *string { return &v }
	return newConfig(str(vals[settingProvider]), str(vals[settingAPIKey]), str(vals[settingModel]), str(vals[settingBaseURL]))
}

// providerProfile is one saved AI provider. It mirrors the JSON the frontend
// AiProvidersGroup stores in the ai_providers setting; Provider is the API
// dialect ("anthropic" / "openai" / "deepseek"), and a custom endpoint is just a
// profile with its own Name + BaseURL.
type providerProfile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	APIKey   string `json:"apiKey"`
	Model    string `json:"model"`
	BaseURL  string `json:"baseUrl"`
}

// configFromProfiles resolves the active profile from the ai_providers list.
// ok=false means no usable list is stored (the caller falls back to the legacy
// single-provider keys). A stored-but-keyless active profile yields ok=true with
// newConfig's noAiKey error, so the UI's "no key" guidance still fires rather
// than silently reverting to the legacy keys.
func configFromProfiles(ctx context.Context, q db.Querier) (Config, bool, error) {
	raw, err := db.GetSetting(ctx, q, settingProviders)
	if err != nil {
		return Config{}, false, err
	}
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return Config{}, false, nil
	}
	var profiles []providerProfile
	if json.Unmarshal([]byte(*raw), &profiles) != nil || len(profiles) == 0 {
		return Config{}, false, nil // malformed or empty → use the legacy keys
	}
	activeRaw, err := db.GetSetting(ctx, q, settingActiveProvider)
	if err != nil {
		return Config{}, false, err
	}
	active := ""
	if activeRaw != nil {
		active = strings.TrimSpace(*activeRaw)
	}
	// Default to the first profile when the active id is unset or dangling.
	p := profiles[0]
	for i := range profiles {
		if profiles[i].ID == active {
			p = profiles[i]
			break
		}
	}
	cfg, err := newConfig(&p.Provider, &p.APIKey, &p.Model, &p.BaseURL)
	return cfg, true, err
}

// newConfig resolves raw settings into a Config, applying per-provider defaults.
// Split out from ConfigFromSettings so it is unit-testable without a database.
// Mirrors ai.rs AiConfig::new, including the credential trimming.
func newConfig(rawProvider, rawKey, rawModel, rawBaseURL *string) (Config, error) {
	// Trim the key: it lands verbatim in an auth header (x-api-key /
	// Authorization). A pasted key routinely carries a trailing newline or
	// space from the clipboard — left in, that either trips header-value
	// validation or earns a 401 from the provider. Trim so the stored value
	// is normalised at the one chokepoint, independent of any frontend
	// trimming.
	apiKey := strings.TrimSpace(deref(rawKey))
	if apiKey == "" {
		return Config{}, apperr.Code("noAiKey")
	}

	prov := providerAnthropic
	switch deref(rawProvider) {
	case "openai", "custom":
		// "custom" is a user-named OpenAI-compatible endpoint (OpenRouter, Groq,
		// a local server, …): same request/SSE shape as OpenAI, distinguished
		// only by the base URL the profile carries.
		prov = providerOpenAI
	case "deepseek":
		prov = providerDeepSeek
	}

	// Likewise trim the model name — it is JSON-serialised into the request
	// body, and a stray space/newline yields a "model not found".
	model := strings.TrimSpace(deref(rawModel))
	if model == "" {
		switch prov {
		case providerAnthropic:
			model = defaultAnthropicModel
		case providerOpenAI:
			model = defaultOpenAIModel
		case providerDeepSeek:
			model = defaultDeepSeekModel
		}
	}

	baseURL := strings.TrimRight(strings.TrimSpace(deref(rawBaseURL)), "/")
	if baseURL == "" {
		baseURL = defaultBaseURL(prov)
	}

	return Config{
		provider:  prov,
		apiKey:    apiKey,
		model:     model,
		baseURL:   baseURL,
		maxTokens: MaxTokens,
		timeout:   requestTimeout,
	}, nil
}

// defaultBaseURL is the official API root for a provider, used when the user has
// not set a custom base URL.
func defaultBaseURL(p provider) string {
	switch p {
	case providerOpenAI:
		return defaultOpenAIBaseURL
	case providerDeepSeek:
		return defaultDeepSeekBaseURL
	default:
		return defaultAnthropicBaseURL
	}
}

// deref returns the pointed-to string, or "" for a nil pointer.
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// truncate returns at most max runes of s without splitting a UTF-8 boundary.
// Mirrors commands.rs truncate (chars().take(max)).
func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

// ResponseLanguage maps a UI language code to a system-prompt directive so AI
// output matches the UI language rather than defaulting to whatever language the
// source article happens to be in. Mirrors commands.rs response_language. The
// service reads the "language" setting and passes the code; the streaming funcs
// append the returned directive to their system prompt.
func ResponseLanguage(lang string) string {
	switch lang {
	case "zh":
		return "\n\nAlways write your response in Simplified Chinese."
	case "ja":
		return "\n\nAlways write your response in Japanese."
	default:
		return "\n\nAlways write your response in English."
	}
}

// LanguageFromSettings reads the "language" setting and returns the matching
// response-language directive, defaulting to English. Convenience for the
// service so it doesn't have to know the setting key or the mapping.
func LanguageFromSettings(ctx context.Context, q db.Querier) string {
	v, err := db.GetSetting(ctx, q, settingLanguage)
	if err != nil || v == nil {
		return ResponseLanguage("")
	}
	return ResponseLanguage(*v)
}

// Summarize streams an AI summary of one article, forwarding each token via
// emit. `title` and `text` are the article's title and body; `langDirective`
// is the ResponseLanguage suffix (the service passes LanguageFromSettings).
// Mirrors commands.rs ai_summarize's prompt. The body is truncated to 8000
// chars before going in the request.
//
// The caller is responsible for the empty-body guard (commands.rs returns
// "noArticleBody" before calling) — but a blank body is harmless here.
func Summarize(ctx context.Context, client *http.Client, cfg Config, title, text, langDirective string, emit func(Event)) error {
	// The drawer renders the response as markdown, so we ask for structured
	// output instead of a single dense paragraph — the reader can scan a
	// TL;DR + bullets far faster.
	system := "You are a sharp news editor. Summarize the article so a reader can " +
		"decide whether to read it in full.\n\n" +
		"Format the response in markdown using exactly this shape:\n" +
		"**TL;DR** — One sentence capturing the single most important point.\n\n" +
		"- Key fact, finding, or claim (under ~20 words)\n" +
		"- Another key point\n" +
		"- 3 to 5 bullets total, one idea each, no nested bullets\n\n" +
		"Output only this structure. No preamble, no closing remarks, no " +
		"section headers, no extra prose." + langDirective
	user := fmt.Sprintf("Title: %s\n\n%s", title, truncate(text, 8000))
	return streamChat(ctx, client, cfg, system, []Message{{Role: "user", Content: user}}, emit)
}

// Ask answers a question using the user's subscribed articles as RAG context,
// streaming each token via emit. `contextText` is the already-assembled
// retrieval context (the service builds it from db.SearchArticlesForRAG +
// article bodies); `langDirective` is the ResponseLanguage suffix. `history` is
// the prior conversation (alternating user/assistant turns, may be empty) so a
// follow-up keeps its context. Mirrors commands.rs ai_ask's prompt, including
// the empty-context branch.
//
// Only the current turn carries the retrieved articles; prior turns are the raw
// question/answer text, which keeps the token budget bounded across a
// conversation while still giving the model conversational continuity.
//
// `recent` marks the zero-hit fallback context (the service's most-recent
// articles rather than keyword matches), so the prompt frames it as a recent
// selection and an "any headlines?" question is answered from it without the
// model treating those N articles as the user's entire library.
func Ask(ctx context.Context, client *http.Client, cfg Config, question, contextText, langDirective string, history []Message, recent bool, historyTurns int, emit func(Event)) error {
	// The completeness caveat matters because the context is always a bounded
	// selection (top-K FTS hits or the most-recent N) — without it the model
	// counts what it was given and confidently reports totals ("8 articles this
	// week, no more"), which is wrong.
	system := "You answer the user's question using only the provided " +
		"articles from their RSS subscriptions. Cite the article " +
		"titles you draw from. If the articles do not contain the " +
		"answer, say so plainly. When the user asks a follow-up, use the " +
		"earlier turns for context. The provided articles are a selection " +
		"retrieved for this question, not the user's complete library — never " +
		"claim they are all the user's articles, give an exhaustive count, or " +
		"say there are no more." + langDirective
	var user string
	switch {
	case strings.TrimSpace(contextText) == "":
		user = fmt.Sprintf("No relevant articles were found.\n\nQuestion: %s", question)
	case recent:
		user = fmt.Sprintf("Here are the user's most recent articles (newest first, a recent selection — not their whole library):\n\n%s---\n\nQuestion: %s", contextText, question)
	default:
		user = fmt.Sprintf("Articles from the user's feeds relevant to the question:\n\n%s---\n\nQuestion: %s", contextText, question)
	}
	// Keep only the most recent exchanges so a long conversation can't grow the
	// request unbounded. historyTurns is settings-backed (resolved by the
	// service); the frontend trims too, this is the backstop for any caller.
	history = trimHistory(history, historyTurns)
	messages := make([]Message, 0, len(history)+1)
	messages = append(messages, history...)
	messages = append(messages, Message{Role: "user", Content: user})
	return streamChat(ctx, client, cfg, system, messages, emit)
}

// Chat streams a plain, general-purpose assistant reply — no RAG, no article
// context. `history` is the prior conversation (trimmed to historyTurns) so a
// follow-up keeps context; `langDirective` is the ResponseLanguage suffix.
func Chat(ctx context.Context, client *http.Client, cfg Config, question, langDirective string, history []Message, historyTurns int, emit func(Event)) error {
	system := "You are a helpful, knowledgeable assistant. Answer clearly and directly." + langDirective
	history = trimHistory(history, historyTurns)
	messages := make([]Message, 0, len(history)+1)
	messages = append(messages, history...)
	messages = append(messages, Message{Role: "user", Content: question})
	return streamChat(ctx, client, cfg, system, messages, emit)
}

// Digest streams an AI briefing synthesizing the most recent articles by theme,
// forwarding each token via emit. `items` is the already-assembled corpus (the
// service builds it from db.DigestSource); `langDirective` is the
// ResponseLanguage suffix. Mirrors commands.rs ai_digest's prompt.
//
// The caller is responsible for the empty-corpus guard (commands.rs returns
// "noArticles" before calling).
func Digest(ctx context.Context, client *http.Client, cfg Config, items, langDirective string, emit func(Event)) error {
	system := "You are the user's personal news briefer. From the recent " +
		"articles, write a crisp briefing: group related items into " +
		"2-4 themed sections with short headers, lead with what " +
		"matters most, and keep it skimmable. Plain prose, no preamble." + langDirective
	user := fmt.Sprintf("Recent articles from my feeds:\n\n%s", items)
	return streamChat(ctx, client, cfg, system, []Message{{Role: "user", Content: user}}, emit)
}

// streamChat streams a single-turn chat completion, forwarding each token via
// emit. On success it emits a final {Type:"done"}; on failure it emits
// {Type:"error", Data:msg} and returns the error. Mirrors ai.rs stream_chat:
// it dispatches per provider, then sends the terminal Done / Error event.
func streamChat(ctx context.Context, client *http.Client, cfg Config, system string, messages []Message, emit func(Event)) error {
	// Per-request timeout override, layered on the caller's ctx so a cancelled
	// parent (the user closed the AI panel) still stops the stream promptly.
	reqCtx, cancel := context.WithTimeout(ctx, cfg.timeout)
	defer cancel()

	// http.Client.Timeout caps the *entire* request including the streamed SSE
	// body read, so the shared feed client's ~30s would silently truncate a long
	// generation regardless of reqCtx. Use a copy with no overall timeout and let
	// reqCtx (cfg.timeout) + the Transport's connect/header sub-timeouts bound it.
	if client != nil && client.Timeout != 0 {
		c := *client
		c.Timeout = 0
		client = &c
	}

	var err error
	switch cfg.provider {
	case providerAnthropic:
		err = streamAnthropic(reqCtx, client, cfg, system, messages, emit)
	case providerOpenAI, providerDeepSeek:
		// DeepSeek is OpenAI-compatible — same request body, endpoint and SSE
		// shape — so it streams through the OpenAI path (which tags the SSE as
		// providerOpenAI for delta/error extraction).
		err = streamOpenAI(reqCtx, client, cfg, system, messages, emit)
	}
	if err != nil {
		emit(Event{Type: EventError, Data: err.Error()})
		return err
	}
	emit(Event{Type: EventDone})
	return nil
}

// streamAnthropic posts an Anthropic Messages streaming request and consumes its
// SSE response. Mirrors ai.rs stream_anthropic.
func streamAnthropic(ctx context.Context, client *http.Client, cfg Config, system string, messages []Message, emit func(Event)) error {
	body := map[string]any{
		"model":      cfg.model,
		"max_tokens": cfg.maxTokens,
		"system":     system,
		"stream":     true,
		"messages":   toWireMessages(messages),
	}
	req, err := newJSONRequest(ctx, cfg.baseURL+"/messages", body)
	if err != nil {
		return err
	}
	req.Header.Set("x-api-key", cfg.apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := client.Do(req)
	if err != nil {
		return apperr.Wrap("network", err)
	}
	defer resp.Body.Close()
	return consumeSSE(ctx, resp, providerAnthropic, emit)
}

// streamOpenAI posts an OpenAI Chat Completions streaming request and consumes
// its SSE response. Mirrors ai.rs stream_openai.
func streamOpenAI(ctx context.Context, client *http.Client, cfg Config, system string, messages []Message, emit func(Event)) error {
	// OpenAI carries the system prompt as the first message; Anthropic takes it
	// as a top-level field. Prepend it here, then the shared conversation.
	wire := make([]map[string]string, 0, len(messages)+1)
	wire = append(wire, map[string]string{"role": "system", "content": system})
	wire = append(wire, toWireMessages(messages)...)
	body := map[string]any{
		"model":      cfg.model,
		"max_tokens": cfg.maxTokens,
		"stream":     true,
		"messages":   wire,
	}
	req, err := newJSONRequest(ctx, cfg.baseURL+"/chat/completions", body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.apiKey)

	resp, err := client.Do(req)
	if err != nil {
		return apperr.Wrap("network", err)
	}
	defer resp.Body.Close()
	return consumeSSE(ctx, resp, providerOpenAI, emit)
}

// trimHistory keeps only the most recent maxTurns exchanges (user+assistant
// pairs) from an alternating history so a long conversation stays bounded.
// Trimming in whole pairs from the front preserves the required user-first
// alternation. maxTurns <= 0 drops history entirely.
func trimHistory(history []Message, maxTurns int) []Message {
	if maxTurns <= 0 {
		return nil
	}
	if len(history) > maxTurns*2 {
		return history[len(history)-maxTurns*2:]
	}
	return history
}

// toWireMessages converts the typed conversation into the {role, content} maps
// both provider request bodies serialise.
func toWireMessages(messages []Message) []map[string]string {
	wire := make([]map[string]string, 0, len(messages))
	for _, m := range messages {
		wire = append(wire, map[string]string{"role": m.Role, "content": m.Content})
	}
	return wire
}

// newJSONRequest builds a POST request with a JSON body and content-type set.
func newJSONRequest(ctx context.Context, url string, body any) (*http.Request, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, apperr.Wrap("ai", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return nil, apperr.Wrap("network", err)
	}
	req.Header.Set("content-type", "application/json")
	return req, nil
}

// ensureSuccess maps a non-2xx response to an AppError naming the service and
// carrying the (capped) response body. Mirrors ai.rs ensure_success.
func ensureSuccess(resp *http.Response, service string) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	// Read a bounded slice of the error body so a hostile endpoint can't
	// balloon memory on the failure path.
	detail, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	return apperr.Codef("ai", "%s error %d: %s", service, resp.StatusCode, strings.TrimSpace(string(detail)))
}

// consumeSSE drives the Server-Sent-Events response, extracting text deltas per
// provider and forwarding them via emit. It stops early (without error) if ctx
// is cancelled — mirroring ai.rs, where a dropped channel aborts the stream so
// the rest of the response is not downloaded into a void. Mirrors ai.rs
// consume_sse.
func consumeSSE(ctx context.Context, resp *http.Response, prov provider, emit func(Event)) error {
	if err := ensureSuccess(resp, "AI API"); err != nil {
		return err
	}

	scanner := bufio.NewScanner(resp.Body)
	// Cap the line buffer at 8 MiB: a frame larger than that is not genuine
	// SSE, so the scan fails rather than growing memory without bound. The
	// initial buffer is small; bufio grows it up to the cap as needed.
	scanner.Buffer(make([]byte, 0, 64*1024), maxSSEBuffer)
	// Split on '\n', mirroring the Rust byte-position scan. bufio's default
	// ScanLines also strips a trailing '\r'; a non-compliant endpoint that
	// closes the stream right after the final data: line with no trailing
	// newline still yields that last frame as the scanner's final token, so
	// its closing token is not dropped (ai.rs handles this with an explicit
	// post-loop check on the leftover buffer).
	scanner.Split(scanLinesLF)

	for scanner.Scan() {
		// Stop if the caller cancelled (panel closed / parent timeout): don't
		// keep pulling the rest of the response.
		if ctx.Err() != nil {
			return nil
		}
		if err := handleSSELine(scanner.Text(), prov, emit); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		// A buffer overflow surfaces as bufio.ErrTooLong — map it to the same
		// "not server-sent events" failure ai.rs raises on the 8 MiB cap.
		if err == bufio.ErrTooLong {
			return apperr.Code("aiStreamNotSSE")
		}
		// A context cancellation mid-read is an expected stop, not a failure.
		if ctx.Err() != nil {
			return nil
		}
		return apperr.Wrap("network", err)
	}
	return nil
}

// scanLinesLF is a bufio.SplitFunc that splits on '\n' and trims a trailing
// '\r', returning the final unterminated chunk at EOF (so a stream closed
// without a trailing newline still yields its last frame). Equivalent to
// bufio.ScanLines but explicit so the EOF-flush behaviour is obvious.
func scanLinesLF(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		return i + 1, dropCR(data[:i]), nil
	}
	if atEOF {
		return len(data), dropCR(data), nil
	}
	return 0, nil, nil
}

// dropCR removes a trailing carriage return from a line.
func dropCR(data []byte) []byte {
	if len(data) > 0 && data[len(data)-1] == '\r' {
		return data[:len(data)-1]
	}
	return data
}

// handleSSELine processes a single SSE line: pull the data: payload, surface any
// provider error, and forward a text delta via emit. Returns an error to abort
// the stream when the provider reports a mid-stream fault. Mirrors ai.rs
// handle_sse_line (minus the channel-closed path, which here is handled by the
// ctx check in consumeSSE).
func handleSSELine(line string, prov provider, emit func(Event)) error {
	trimmed := strings.TrimSpace(line)
	data, ok := strings.CutPrefix(trimmed, "data:")
	if !ok {
		return nil
	}
	data = strings.TrimSpace(data)
	if data == "" || data == "[DONE]" {
		return nil
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal([]byte(data), &value); err != nil {
		// Not JSON (a keep-alive comment or partial frame) — skip it, exactly
		// as the Rust does when serde_json fails to parse the data payload.
		return nil
	}
	// Both providers can deliver an error mid-stream after a 200 OK (rate
	// limit, overload, content filter). Surface it instead of ending the
	// generation silently with a truncated result.
	if msg, ok := extractError(value, prov); ok {
		return apperr.Codef("aiStreamError", "AI stream error: %s", msg)
	}
	if text, ok := extractDelta(value, prov); ok && text != "" {
		emit(Event{Type: EventDelta, Data: text})
	}
	return nil
}

// extractError detects a provider error object carried inside an SSE data frame.
//
// For the OpenAI-compatible path the error must be a non-null object: many
// compatible servers (OpenRouter and others) include a literal "error": null
// alongside choices in their *successful* chunks. Treating that as a fault would
// abort an otherwise-fine generation with a bogus "stream error". Mirrors ai.rs
// extract_error.
func extractError(v map[string]json.RawMessage, prov provider) (string, bool) {
	var errBlock json.RawMessage
	switch prov {
	case providerAnthropic:
		// Anthropic: only when the event type is exactly "error".
		var typ string
		if raw, ok := v["type"]; ok {
			_ = json.Unmarshal(raw, &typ)
		}
		if typ != "error" {
			return "", false
		}
		raw, ok := v["error"]
		if !ok {
			return "", false
		}
		errBlock = raw
	case providerOpenAI:
		// OpenAI: only when "error" is a non-null JSON object. Many
		// compatible servers ship a literal "error": null in successful
		// chunks — unmarshaling null into a map succeeds and yields a nil
		// map (no error), so probe == nil rules it out; a JSON array/string
		// fails to unmarshal into a map and is likewise ruled out. Mirrors
		// the Rust filter(|e| e.is_object()).
		raw, ok := v["error"]
		if !ok {
			return "", false
		}
		var probe map[string]json.RawMessage
		if json.Unmarshal(raw, &probe) != nil || probe == nil {
			return "", false
		}
		errBlock = raw
	}

	// Pull error.message; fall back to "stream error" when absent / empty.
	var obj struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(errBlock, &obj)
	if obj.Message == "" {
		return "stream error", true
	}
	return obj.Message, true
}

// extractDelta pulls a text delta out of an SSE data frame, per provider.
// Anthropic deltas live in content_block_delta events at delta.text; OpenAI
// deltas live at choices[0].delta.content. Mirrors ai.rs extract_delta.
func extractDelta(v map[string]json.RawMessage, prov provider) (string, bool) {
	switch prov {
	case providerAnthropic:
		var typ string
		if raw, ok := v["type"]; ok {
			_ = json.Unmarshal(raw, &typ)
		}
		if typ != "content_block_delta" {
			return "", false
		}
		raw, ok := v["delta"]
		if !ok {
			return "", false
		}
		var delta struct {
			Text *string `json:"text"`
		}
		if json.Unmarshal(raw, &delta) != nil || delta.Text == nil {
			return "", false
		}
		return *delta.Text, true
	case providerOpenAI:
		raw, ok := v["choices"]
		if !ok {
			return "", false
		}
		var choices []struct {
			Delta struct {
				Content *string `json:"content"`
			} `json:"delta"`
		}
		if json.Unmarshal(raw, &choices) != nil || len(choices) == 0 {
			return "", false
		}
		if choices[0].Delta.Content == nil {
			return "", false
		}
		return *choices[0].Delta.Content, true
	}
	return "", false
}
