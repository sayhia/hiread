// Package translate is hiread's full-text article translation layer. It splits an
// article body into batches of whole top-level blocks, each translated with the
// HTML structure preserved, then reassembles them — reporting progress per
// batch over a callback so the service layer can adapt it to Wails events and
// persist the result via db.SetTranslation.
//
// The LLM engine is handed an HTML fragment and returns the translated
// fragment; the traditional machine-translation engines (Google, DeepL, Bing)
// take a different path — the fragment's text nodes are extracted, translated
// as plain strings, and written back into the same DOM, so every tag,
// attribute, link and image is preserved exactly. The pure helpers here —
// block chunking, prompt building, code-fence stripping, the DeepL timestamp
// derivation — carry the logic worth testing; no network is reached in tests.
package translate

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"hiread/internal/ai"
	"hiread/internal/apperr"
	"hiread/internal/db"
)

// Event mirrors the frontend's TranslateEvent (types.ts): a start{total},
// repeated batch{html,done}, and a final done{html}. The service layer relays
// these to the webview over a Wails event.
type Event struct {
	Type string    `json:"type"`
	Data EventData `json:"data"`
}

// EventData carries the per-event payload. Total + Title are set on start; HTML
// and Done on each batch; HTML alone on done.
type EventData struct {
	Total int    `json:"total,omitempty"`
	HTML  string `json:"html,omitempty"`
	Done  int    `json:"done,omitempty"`
	// Title is the translated article title, sent once on the start event so the
	// reader can show a translated heading before the body finishes.
	Title string `json:"title,omitempty"`
}

// unwrapTags are generic wrapper tags that carry no readable text of their own.
// A body that is a single such container (the common "everything inside one
// <div>" feed shape) is unwrapped so its children can be batched rather than
// translated as one oversized block. Unwrapping is repeated for nested wrappers.
var unwrapTags = map[string]bool{
	"div": true, "article": true, "section": true, "main": true,
}

// skipTextTags name elements whose text nodes are code/markup, not prose, so
// they are left untranslated (the LLM prompt makes the same exclusion for its
// path).
var skipTextTags = map[string]bool{
	"script": true, "style": true, "code": true, "pre": true, "kbd": true, "samp": true,
}

// ─────────────────────────── tunables ───────────────────────────

// translateMaxTokens is the ceiling on a translation batch's output. A batch's
// translated HTML tracks its input length — the tags are echoed too — so it
// needs far more room than a summary. What any one request actually asks for is
// sized to its batch by batchMaxTokens; this is only the upper bound, and it is
// paired with maxBatchTokens so a full batch's answer fits with headroom.
const translateMaxTokens = 8192

// aiRequestTimeout is the per-request cap for the LLM chat call. The shared HTTP
// client carries the feed-fetch timeout (~30s), which would truncate a long
// generation — so the LLM request overrides it with a generous bound. (ai.rs
// AI_REQUEST_TIMEOUT)
const aiRequestTimeout = 300 * time.Second

// mtTimeout is the per-request timeout for a machine-translation call. Each call
// carries at most one batch (a few KB of text), so a generous but bounded
// timeout is plenty — unlike the LLM path it does not stream for minutes.
const mtTimeout = 30 * time.Second

// bingUA is a desktop-browser User-Agent for the Bing token endpoint, which
// rejects requests without a plausible one.
const bingUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"

// translateConcurrency is how many batches are translated at once.
//
// This layer was written for RSS articles, which are one or two batches; a book
// chapter is routinely four to nine, and some are dozens. Run serially that is
// a round-trip per batch end to end — a minute or more of watching a spinner
// for one chapter. The batches are independent (each is a whole set of top-level
// blocks, translated against the same system prompt), so the only reason to
// serialize them is politeness to the provider.
//
// The wall clock for a chapter is (total tokens the model must write) / (its
// throughput × this number), so this is the one number that moves it. Eight is
// well inside the per-minute limits of a personal API key and keeps a typical
// chapter to a single wave. The scraped free endpoints are held to two: they
// are already fast per call, and they are the ones that rate-limit a burst.
func translateConcurrency(engine string) int {
	if engine == "llm" {
		return 8
	}
	return 2
}

// chunkBudget is the per-batch request-size budget, in bytes of source HTML,
// for the machine-translation engines: Google's free endpoint carries the text
// in a GET query, so its URL must stay short, while DeepL and Bing accept large
// POST bodies and a bigger batch means fewer round-trips. The LLM path does not
// come through here — what bounds it is tokens, not bytes (see batching.go).
func chunkBudget(engine string) int {
	switch engine {
	case "google":
		return 1500
	default:
		return 8000
	}
}

// languageName is the human-readable name for a UI/target language code, as used
// in the translation instruction. Anything unrecognised falls back to English.
func languageName(code string) string {
	switch code {
	case "zh":
		return "Simplified Chinese"
	case "ja":
		return "Japanese"
	default:
		return "English"
	}
}

// translateSystemPrompt builds the system prompt instructing the model to
// translate one batch of HTML into target while leaving the markup intact.
func translateSystemPrompt(target string) string {
	return "You are a professional translator. Translate the text content of the " +
		"HTML fragment into " + target + ".\n\n" +
		"Rules:\n" +
		"- Preserve every HTML tag, attribute, and the overall structure exactly.\n" +
		"- Translate only human-readable text; do not translate code or URLs.\n" +
		"- Keep images, links, and all other markup intact.\n" +
		"- Output only the translated HTML fragment: no preamble, no code fences."
}

// titleSystemPrompt instructs the model to translate a bare article title,
// returning only the translated string (no quotes, preamble, or markup).
func titleSystemPrompt(target string) string {
	return "Translate the following article title into " + target +
		". Output only the translated title — no quotes, preamble, or markup."
}

// translateTitle translates a single plain-text title with the chosen engine,
// returning the translated string. Best-effort: an empty title returns empty;
// the caller treats any error as "leave the title untranslated" since the title
// is secondary to the body.
func (b backend) translateTitle(ctx context.Context, client *http.Client, title, target string) (string, error) {
	if strings.TrimSpace(title) == "" {
		return "", nil
	}
	if b.engine == "llm" {
		out, err := completeChat(ctx, client, b.cfg, titleSystemPrompt(languageName(target)), title, 256, nil)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(stripCodeFence(out)), nil
	}
	segs, err := b.translateSegments(ctx, client, []string{title}, target)
	if err != nil {
		return "", err
	}
	if len(segs) > 0 {
		return strings.TrimSpace(segs[0]), nil
	}
	return "", nil
}

// ─────────────────────────── block chunking ───────────────────────────

// chunkBlocks splits source body HTML into batches of whole top-level blocks,
// each at most budget bytes where possible. Whole elements are never split
// across batches; a single block larger than budget becomes its own batch. A
// body that is a single generic wrapper (div/article/section/main, possibly
// nested) is unwrapped so its children are batched. Concatenating the returned
// batches reproduces the source's block sequence (minus any unwrapped wrappers).
func chunkBlocks(htmlStr string, budget int) []string {
	return chunkBlocksBudgeted(htmlStr, budget, budget, byteCost)
}

// firstChunkBudget caps the FIRST translation batch so the top of a long article
// renders after one short round-trip (⑥ fast first paint) before the remaining
// blocks stream in at the full per-batch budget.
const firstChunkBudget = 700

// chunkBlocksBudgeted is chunkBlocks with a distinct budget for the first batch
// and a caller-chosen way to measure a piece: firstBudget bounds batch 1,
// budget bounds the rest, and cost says what a budget counts — bytes for the
// engines bounded by request size, estimated tokens for the LLM.
func chunkBlocksBudgeted(htmlStr string, budget, firstBudget int, cost func(string) int) []string {
	return packPieces(topLevelPieces(htmlStr), budget, firstBudget, cost)
}

// topLevelPieces parses a chapter into the blocks a batch is built from: one
// string per top-level node, in document order.
func topLevelPieces(htmlStr string) []string {
	nodes := parseFragmentChildren(htmlStr)

	// Unwrap nested single generic containers so their children can be batched.
	for {
		var elems []*html.Node
		for _, n := range nodes {
			if n.Type == html.ElementNode {
				elems = append(elems, n)
			}
		}
		if len(elems) == 1 && unwrapTags[elems[0].Data] {
			nodes = childNodes(elems[0])
			continue
		}
		break
	}

	// Serialize each top-level node, dropping whitespace-only text between blocks.
	var pieces []string
	for _, node := range nodes {
		switch node.Type {
		case html.ElementNode:
			pieces = append(pieces, renderNode(node))
		case html.TextNode:
			if strings.TrimSpace(node.Data) != "" {
				pieces = append(pieces, node.Data)
			}
		}
	}

	return pieces
}

// packPieces greedily groups whole pieces under the budget (the smaller
// firstBudget for batch 1). A piece over the budget sits alone rather than
// being split: a block is the unit the model is asked to translate.
func packPieces(pieces []string, budget, firstBudget int, cost func(string) int) []string {
	var batches []string
	var cur strings.Builder
	curCost := 0
	for _, piece := range pieces {
		cap := budget
		if len(batches) == 0 {
			cap = firstBudget
		}
		pieceCost := cost(piece)
		if cur.Len() > 0 && curCost+pieceCost > cap {
			batches = append(batches, cur.String())
			cur.Reset()
			curCost = 0
		}
		cur.WriteString(piece)
		curCost += pieceCost
	}
	if cur.Len() > 0 {
		batches = append(batches, cur.String())
	}
	return batches
}

// stripCodeFence strips a surrounding ```/```html markdown code fence a model
// may wrap its HTML output in, returning the inner content trimmed. Unfenced
// input is returned trimmed but otherwise unchanged.
func stripCodeFence(s string) string {
	trimmed := strings.TrimSpace(s)
	rest, ok := strings.CutPrefix(trimmed, "```")
	if !ok {
		return trimmed
	}
	rest = strings.TrimSuffix(rest, "```")
	// Drop the opening fence's optional language tag line (`html`, ``, …).
	if i := strings.IndexByte(rest, '\n'); i >= 0 {
		rest = rest[i+1:]
	}
	return strings.TrimSpace(rest)
}

// ─────────────────────────── HTML fragment parsing ───────────────────────────
//
// golang.org/x/net/html only parses whole documents, so a fragment is parsed in
// the context of a <body> and the children of that synthesized <body> are the
// fragment's top-level nodes — mirroring how the Rust scraper code reads
// `Html::parse_fragment(...).root_element().children()`.

// bodyContext is the parse context for fragment parsing.
var bodyContext = &html.Node{Type: html.ElementNode, Data: "body", DataAtom: atom.Body}

// parseFragmentChildren parses htmlStr as a body-context fragment and returns
// its top-level nodes (detached from any parent so they can be re-serialized
// individually). On a parse error it returns nil.
func parseFragmentChildren(htmlStr string) []*html.Node {
	nodes, err := html.ParseFragment(strings.NewReader(htmlStr), bodyContext)
	if err != nil {
		return nil
	}
	for _, n := range nodes {
		n.Parent = nil
		n.PrevSibling = nil
		n.NextSibling = nil
	}
	return nodes
}

// childNodes returns a node's child nodes as a detached slice (their sibling
// links are cleared so each can be serialized on its own).
func childNodes(n *html.Node) []*html.Node {
	var out []*html.Node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		out = append(out, c)
	}
	for _, c := range out {
		c.Parent = nil
		c.PrevSibling = nil
		c.NextSibling = nil
	}
	return out
}

// renderNode serializes a single node (and its subtree) to HTML.
func renderNode(n *html.Node) string {
	var b strings.Builder
	// html.Render needs the node detached from siblings or it renders them too.
	saved := n.NextSibling
	n.NextSibling = nil
	_ = html.Render(&b, n)
	n.NextSibling = saved
	return b.String()
}

// ─────────────────────────── translation engines ───────────────────────────
//
// To let a user pick a non-LLM engine without losing structure, every engine
// receives one batch of body HTML and returns the translated HTML fragment
// (unsanitized — the caller sanitizes uniformly). The LLM is handed the HTML
// directly; the machine-translation engines translate only the text nodes.

// backend is the chosen engine plus the credentials/handles it needs at request
// time. For Bing the auth token is fetched once up front and reused across every
// batch.
type backend struct {
	engine    string   // "llm" | "google" | "deepl" | "bing"
	cfg       aiConfig // LLM only
	bingToken string   // Bing only
}

// ready turns the resolved engine into a request-ready backend, performing any
// one-off network setup (Bing's auth token). Run once before the per-batch loop
// so a credential or network failure surfaces before any progress is reported.
func ready(ctx context.Context, client *http.Client, engine string, cfg aiConfig) (backend, error) {
	b := backend{engine: engine, cfg: cfg}
	if engine == "bing" {
		tok, err := bingTokenFetch(ctx, client)
		if err != nil {
			return backend{}, err
		}
		b.bingToken = tok
	}
	return b, nil
}

// translateBatch translates one batch of body HTML into target, returning the
// translated HTML fragment (unsanitized). system is the LLM instruction prompt,
// ignored by the machine-translation engines.
// onProgress, when set, is called with everything the model has written so far,
// so a long batch can be shown as it is produced rather than at the end. Only
// the LLM path streams; a machine-translation call is one short request that
// answers all at once.
func (b backend) translateBatch(ctx context.Context, client *http.Client, system, batch, target string, maxTokens int, onProgress func(string)) (string, error) {
	if b.engine == "llm" {
		text, err := completeChat(ctx, client, b.cfg, system, batch, maxTokens, onProgress)
		if err != nil {
			return "", err
		}
		return stripCodeFence(text), nil
	}
	return b.translateFragment(ctx, client, batch, target)
}

// textSlot is one translatable text node: a pointer to it plus the surrounding
// whitespace to restore after translation. The whitespace is preserved
// separately because machine-translation engines routinely trim it, which would
// weld inline words together (`Hello <b>world</b>` → `Helloworld`).
type textSlot struct {
	node   *html.Node
	prefix string
	suffix string
}

// collectText walks an HTML fragment and collects every translatable text node
// in document order: the trimmed core strings (to send to the engine) and a
// textSlot each (to write the result back). Whitespace-only nodes and text
// inside code/markup elements are skipped.
func collectText(nodes []*html.Node) ([]textSlot, []string) {
	var slots []textSlot
	var cores []string
	var walk func(n *html.Node, inCode bool)
	walk = func(n *html.Node, inCode bool) {
		switch n.Type {
		case html.TextNode:
			if inCode || strings.TrimSpace(n.Data) == "" {
				return
			}
			s := n.Data
			// Whitespace is ASCII, so these byte slices never split a UTF-8 char.
			prefix := s[:len(s)-len(strings.TrimLeft(s, " \t\r\n\f"))]
			suffix := s[len(strings.TrimRight(s, " \t\r\n\f")):]
			slots = append(slots, textSlot{node: n, prefix: prefix, suffix: suffix})
			cores = append(cores, strings.TrimSpace(s))
		case html.ElementNode:
			if skipTextTags[n.Data] {
				inCode = true
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, inCode)
		}
	}
	for _, n := range nodes {
		walk(n, false)
	}
	return slots, cores
}

// apply writes translated strings back into their text nodes, restoring each
// node's original surrounding whitespace. Extra or missing translations (an
// engine that returned the wrong count) are ignored rather than misaligned: the
// loop stops at the shorter side, leaving any unmatched node as its source text.
func apply(slots []textSlot, translated []string) {
	n := len(slots)
	if len(translated) < n {
		n = len(translated)
	}
	for i := 0; i < n; i++ {
		slots[i].node.Data = slots[i].prefix + translated[i] + slots[i].suffix
	}
}

// serializeFragment serializes top-level nodes back to an HTML string, mirroring
// how chunkBlocks reads the fragment (the parse wrapper is dropped).
func serializeFragment(nodes []*html.Node) string {
	var out strings.Builder
	for _, n := range nodes {
		switch n.Type {
		case html.ElementNode:
			out.WriteString(renderNode(n))
		case html.TextNode:
			out.WriteString(n.Data)
		}
	}
	return out.String()
}

// translateFragment translates one HTML batch with a machine-translation engine,
// preserving markup by translating only its text nodes. A batch with no
// translatable text (e.g. a lone image) is returned unchanged.
//
// Unlike the Rust version — which re-parses the fragment because scraper::Html
// is not Send and cannot be held across the network await — Go has no such
// constraint, so the parsed tree is held across the call and written back in
// place.
func (b backend) translateFragment(ctx context.Context, client *http.Client, htmlStr, target string) (string, error) {
	nodes := parseFragmentChildren(htmlStr)
	slots, cores := collectText(nodes)
	if len(cores) == 0 {
		return htmlStr, nil
	}
	translated, err := b.translateSegments(ctx, client, cores, target)
	if err != nil {
		return "", err
	}
	apply(slots, translated)
	return serializeFragment(nodes), nil
}

// translateSegments dispatches a list of plain-text segments to the selected
// engine. The returned slice is positionally aligned with cores (DeepL and Bing
// align by their array APIs; Google reconstructs alignment from line breaks with
// a per-segment fallback).
func (b backend) translateSegments(ctx context.Context, client *http.Client, cores []string, target string) ([]string, error) {
	switch b.engine {
	case "google":
		return googleSegments(ctx, client, cores, target)
	case "deepl":
		return deeplSegments(ctx, client, cores, target)
	case "bing":
		return bingSegments(ctx, client, b.bingToken, cores, target)
	default:
		// LLM batches are translated as whole HTML, not segments.
		return nil, apperr.Code("translateFailed")
	}
}

// ── per-engine target language codes ─────────────────────────────────────────
// The target is stored as `zh` / `ja` / `en`; each engine names them its own way.

func googleCode(target string) string {
	switch target {
	case "zh":
		return "zh-CN"
	case "ja":
		return "ja"
	default:
		return "en"
	}
}

func deeplCode(target string) string {
	switch target {
	case "zh":
		return "ZH"
	case "ja":
		return "JA"
	default:
		return "EN"
	}
}

func bingCode(target string) string {
	switch target {
	case "zh":
		return "zh-Hans"
	case "ja":
		return "ja"
	default:
		return "en"
	}
}

// httpError maps a non-success HTTP response to an apperr naming the engine and
// carrying the response body.
func httpError(resp *http.Response, engine string) error {
	detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return markRetryable(resp.StatusCode,
		apperr.Codef("translateFailed", "%s translate error %d: %s", engine, resp.StatusCode, string(detail)))
}

// doRequest issues req with a per-call timeout and returns the response. The
// caller closes the body.
func doRequest(ctx context.Context, client *http.Client, req *http.Request, timeout time.Duration) (*http.Response, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	// The cancel must outlive the response body read, so it is deferred by the
	// caller-facing wrapper rather than here; instead we tie it to the request.
	req = req.WithContext(cctx)
	// http.Client.Timeout caps the whole call (incl. the body read) at the shared
	// feed client's ~30s, which would override this per-call timeout. Drop it on a
	// copy so cctx is authoritative (a slow LLM batch gets its full budget).
	if client != nil && client.Timeout != 0 {
		c := *client
		c.Timeout = 0
		client = &c
	}
	resp, err := client.Do(req)
	if err != nil {
		cancel()
		return nil, apperr.Wrap("network", err)
	}
	// Wrap the body so the timeout context is cancelled once the body closes.
	resp.Body = &cancelBody{ReadCloser: resp.Body, cancel: cancel}
	return resp, nil
}

// cancelBody cancels a context when the response body is closed, so a per-call
// timeout context is released exactly when the read finishes.
type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelBody) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}

// ── Google (free, keyless) ───────────────────────────────────────────────────

// googleCall translates one plain-text blob via Google's free
// translate_a/single endpoint, concatenating the per-sentence pieces it returns.
func googleCall(ctx context.Context, client *http.Client, text, target string) (string, error) {
	q := url.Values{}
	q.Set("client", "gtx")
	q.Set("sl", "auto")
	q.Set("tl", googleCode(target))
	q.Set("dt", "t")
	q.Set("q", text)
	u := "https://translate.googleapis.com/translate_a/single?" + q.Encode()
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return "", apperr.Wrap("network", err)
	}
	resp, err := doRequest(ctx, client, req, mtTimeout)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", httpError(resp, "Google")
	}
	// The response is a nested array; the first element holds the per-sentence
	// segments, each a [translated, original, …] tuple.
	var v []json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		return "", apperr.Wrap("translateFailed", err)
	}
	var out strings.Builder
	if len(v) > 0 {
		var arr []json.RawMessage
		if json.Unmarshal(v[0], &arr) == nil {
			for _, seg := range arr {
				var tuple []json.RawMessage
				if json.Unmarshal(seg, &tuple) == nil && len(tuple) > 0 {
					var s string
					if json.Unmarshal(tuple[0], &s) == nil {
						out.WriteString(s)
					}
				}
			}
		}
	}
	return out.String(), nil
}

// googleSegments translates segments with Google. The segments are joined by
// newlines into one request — Google preserves the newlines, so the response
// splits back into the same count. If it doesn't (Google merged or split a
// line), fall back to one request per segment so alignment is exact.
func googleSegments(ctx context.Context, client *http.Client, cores []string, target string) ([]string, error) {
	joined := strings.Join(cores, "\n")
	out, err := googleCall(ctx, client, joined, target)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(out, "\n")
	if len(lines) == len(cores) {
		return lines, nil
	}
	result := make([]string, 0, len(cores))
	for _, core := range cores {
		s, err := googleCall(ctx, client, core, target)
		if err != nil {
			return nil, err
		}
		result = append(result, s)
	}
	return result, nil
}

// ── DeepL (free web endpoint, keyless) ───────────────────────────────────────
//
// This is the unofficial JSON-RPC endpoint the DeepL web client itself calls —
// no API key required. It mimics the web client's anti-abuse quirks: a random
// request id, a timestamp derived from the count of the letter `i` in the text,
// and a one-space/no-space tweak to the serialized `method` field keyed off the
// id. The `texts` array returns translations positionally, so no reconstruction
// is needed; requests are chunked to stay well within the endpoint's limits.

// nowMillis is milliseconds since the Unix epoch — used for DeepL's request
// timestamp / id.
func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// deeplTimestamp returns the request timestamp DeepL validates: a multiple of
// (1 + number of `i`s across the texts), offset by that amount — the web client
// computes it this way and the endpoint validates it.
func deeplTimestamp(iCount, ts int64) int64 {
	if iCount == 0 {
		return ts
	}
	n := iCount + 1
	return ts - (ts % n) + n
}

func deeplSegments(ctx context.Context, client *http.Client, cores []string, target string) ([]string, error) {
	out := make([]string, 0, len(cores))
	for i := 0; i < len(cores); i += 50 {
		end := i + 50
		if end > len(cores) {
			end = len(cores)
		}
		part, err := deeplFreeCall(ctx, client, cores[i:end], target)
		if err != nil {
			return nil, err
		}
		out = append(out, part...)
	}
	return out, nil
}

// deeplFreeCall issues one JSON-RPC LMT_handle_texts call against DeepL's free
// web endpoint.
func deeplFreeCall(ctx context.Context, client *http.Client, cores []string, target string) ([]string, error) {
	// A pseudo-random request id in the same range the web client uses; the
	// sub-millisecond clock is enough entropy here (no rand dependency).
	id := (nowMillis()%99_999 + 100_000) * 1000
	var iCount int64
	for _, t := range cores {
		iCount += int64(strings.Count(t, "i"))
	}
	texts := make([]map[string]any, len(cores))
	for i, t := range cores {
		texts[i] = map[string]any{"text": t, "requestAlternatives": 0}
	}
	body := map[string]any{
		"jsonrpc": "2.0",
		"method":  "LMT_handle_texts",
		"params": map[string]any{
			"splitting": "newlines",
			"lang": map[string]any{
				"source_lang_user_selected": "auto",
				"target_lang":               deeplCode(target),
			},
			"texts":     texts,
			"timestamp": deeplTimestamp(iCount, nowMillis()),
		},
		"id": id,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, apperr.Codef("translateFailed", "DeepL request encode error: %v", err)
	}
	bodyStr := string(raw)
	// The web client varies the spacing around the `method` value based on the
	// id; the endpoint expects that exact shape.
	if (id+5)%29 == 0 || (id+3)%13 == 0 {
		bodyStr = strings.Replace(bodyStr, `"method":"`, `"method" : "`, 1)
	} else {
		bodyStr = strings.Replace(bodyStr, `"method":"`, `"method": "`, 1)
	}
	req, err := http.NewRequest(http.MethodPost, "https://www2.deepl.com/jsonrpc", strings.NewReader(bodyStr))
	if err != nil {
		return nil, apperr.Wrap("network", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := doRequest(ctx, client, req, mtTimeout)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, httpError(resp, "DeepL")
	}
	var parsed struct {
		Result struct {
			Texts []struct {
				Text string `json:"text"`
			} `json:"texts"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, apperr.Code("translateFailed")
	}
	if parsed.Result.Texts == nil {
		return nil, apperr.Codef("translateFailed", "DeepL translate error: malformed response")
	}
	out := make([]string, len(parsed.Result.Texts))
	for i, t := range parsed.Result.Texts {
		out[i] = t.Text
	}
	return out, nil
}

// ── Bing / Edge translator (keyless via short-lived token) ───────────────────

// bingTokenFetch fetches a short-lived bearer token from Microsoft Edge's public
// auth endpoint, used to call the Edge translator without an API key.
func bingTokenFetch(ctx context.Context, client *http.Client) (string, error) {
	req, err := http.NewRequest(http.MethodGet, "https://edge.microsoft.com/translate/auth", nil)
	if err != nil {
		return "", apperr.Wrap("network", err)
	}
	req.Header.Set("User-Agent", bingUA)
	resp, err := doRequest(ctx, client, req, mtTimeout)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", httpError(resp, "Bing")
	}
	// Cap the read — every other read in this file is bounded; the token is a
	// short JWT, so 64 KiB is generous and prevents a hostile/oversized response.
	tok, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", apperr.Wrap("network", err)
	}
	return string(tok), nil
}

// bingSegments translates segments with the Edge translator. Its request body is
// an array of { Text } objects translated positionally, so no reconstruction is
// needed; requests are chunked well under its per-call array limit.
func bingSegments(ctx context.Context, client *http.Client, token string, cores []string, target string) ([]string, error) {
	out := make([]string, 0, len(cores))
	for i := 0; i < len(cores); i += 900 {
		end := i + 900
		if end > len(cores) {
			end = len(cores)
		}
		chunk := cores[i:end]
		body := make([]map[string]string, len(chunk))
		for j, c := range chunk {
			body[j] = map[string]string{"Text": c}
		}
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, apperr.Wrap("translateFailed", err)
		}
		q := url.Values{}
		q.Set("from", "")
		q.Set("to", bingCode(target))
		q.Set("api-version", "3.0")
		u := "https://api-edge.cognitive.microsofttranslator.com/translate?" + q.Encode()
		req, err := http.NewRequest(http.MethodPost, u, bytes.NewReader(raw))
		if err != nil {
			return nil, apperr.Wrap("network", err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := doRequest(ctx, client, req, mtTimeout)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			err := httpError(resp, "Bing")
			resp.Body.Close()
			return nil, err
		}
		var items []struct {
			Translations []struct {
				Text string `json:"text"`
			} `json:"translations"`
		}
		decErr := json.NewDecoder(resp.Body).Decode(&items)
		resp.Body.Close()
		if decErr != nil {
			return nil, apperr.Codef("translateFailed", "Bing translate error: malformed response")
		}
		for _, item := range items {
			text := ""
			if len(item.Translations) > 0 {
				text = item.Translations[0].Text
			}
			out = append(out, text)
		}
	}
	return out, nil
}

// ─────────────────────────── LLM chat (ported from ai.rs) ───────────────────────────
//
// The `llm` engine reuses the same provider/key/model the ai module reads from
// settings (ai_provider / ai_api_key / ai_model / ai_base_url). Rather than
// import internal/ai and couple to it, a small dedicated non-streaming chat call
// lives here: translation reports progress once per batch, not per token, so the
// SSE response is consumed silently and the accumulated text returned whole.

// provider is the LLM API shape (request path + auth header + delta extraction).
type provider int

const (
	providerAnthropic provider = iota
	providerOpenAI
	// providerDeepSeek is OpenAI-compatible (same /chat/completions endpoint,
	// request body and SSE shape); it shares the OpenAI request/parsing path —
	// only the default base URL and model differ.
	providerDeepSeek
)

// aiConfig is the resolved AI configuration read from the settings table.
type aiConfig struct {
	provider provider
	apiKey   string
	model    string
	// baseURL is the API root without a trailing slash — the per-provider request
	// path (/messages, /chat/completions) is appended to it. Defaults to the
	// official endpoint; an override points at any compatible provider.
	baseURL string
}

// loadAiConfig resolves the LLM engine's provider from settings. The resolution
// itself belongs to internal/ai — it is the package that knows about provider
// profiles (ai_providers + ai_active_provider) and the legacy single-provider
// keys behind them. This package keeps only its own request path, because
// translation reports progress per batch rather than per token and so consumes
// the SSE response whole.
//
// It used to read ai_api_key directly, which silently stopped resolving the
// moment Settings began storing profiles: a fully configured provider produced
// "no key" here while the AI panel worked.
func loadAiConfig(ctx context.Context, q db.Querier) (aiConfig, error) {
	resolved, err := ai.ConfigFromSettings(ctx, q)
	if err != nil {
		return aiConfig{}, err // already an apperr — "noAiKey" when unconfigured
	}
	s := resolved.Settings()
	prov := providerAnthropic
	switch s.Provider {
	case "openai":
		prov = providerOpenAI
	case "deepseek":
		prov = providerDeepSeek
	}
	return aiConfig{provider: prov, apiKey: s.APIKey, model: s.Model, baseURL: s.BaseURL}, nil
}

// completeChat runs a single-turn completion to the end and returns its full
// text WITHOUT forwarding per-token deltas — translation reports progress once
// per batch instead of once per token, so token-level events over a full article
// would flood the frontend. (ai.rs complete_chat)
func completeChat(ctx context.Context, client *http.Client, cfg aiConfig, system, user string, maxTokens int, onProgress func(string)) (string, error) {
	var body []byte
	var u string
	if cfg.provider == providerAnthropic {
		body, _ = json.Marshal(map[string]any{
			"model":      cfg.model,
			"max_tokens": maxTokens,
			"system":     system,
			"stream":     true,
			"messages":   []map[string]any{{"role": "user", "content": user}},
		})
		u = cfg.baseURL + "/messages"
	} else {
		body, _ = json.Marshal(map[string]any{
			"model":      cfg.model,
			"max_tokens": maxTokens,
			"stream":     true,
			"messages": []map[string]any{
				{"role": "system", "content": system},
				{"role": "user", "content": user},
			},
		})
		u = cfg.baseURL + "/chat/completions"
	}
	req, err := http.NewRequest(http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return "", apperr.Wrap("network", err)
	}
	if cfg.provider == providerAnthropic {
		req.Header.Set("x-api-key", cfg.apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
		req.Header.Set("content-type", "application/json")
	} else {
		req.Header.Set("Authorization", "Bearer "+cfg.apiKey)
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := doRequest(ctx, client, req, aiRequestTimeout)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", markRetryable(resp.StatusCode,
			apperr.Codef("aiFailed", "AI API error %d: %s", resp.StatusCode, string(detail)))
	}
	return consumeSSE(resp.Body, cfg.provider, onProgress)
}

// maxSSEBuffer is a hard cap on the SSE line buffer. A well-behaved provider
// delimits every event with a newline, so the buffer never holds more than a
// single frame; a misbehaving or non-SSE endpoint could otherwise accumulate
// unbounded. 8 MiB is far larger than any genuine SSE frame while still stopping
// a runaway stream. (ai.rs MAX_SSE_BUFFER)
const maxSSEBuffer = 8 * 1024 * 1024

// consumeSSE drives the Server-Sent-Events response, extracting text deltas per
// provider and returning the accumulated text. A provider error carried inside a
// data frame (rate limit, overload, content filter — both providers can deliver
// one mid-stream after a 200 OK) is surfaced as an error rather than ending the
// generation silently with a truncated result.
func consumeSSE(r io.Reader, prov provider, onProgress func(string)) (string, error) {
	buf := make([]byte, 0, 8192)
	var full strings.Builder
	chunk := make([]byte, 16384)
	for {
		n, readErr := r.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
			if len(buf) > maxSSEBuffer {
				return "", apperr.Codef("aiFailed", "AI stream error: response is not server-sent events")
			}
			grew := false
			for {
				idx := bytes.IndexByte(buf, '\n')
				if idx < 0 {
					break
				}
				line := string(buf[:idx+1])
				buf = buf[idx+1:]
				before := full.Len()
				if err := handleSSELine(line, prov, &full); err != nil {
					return "", err
				}
				grew = grew || full.Len() > before
			}
			// One callback per read rather than per frame: the caller only wants
			// to know there is more text, and a frame is a token.
			if grew && onProgress != nil {
				onProgress(full.String())
			}
		}
		if readErr != nil {
			break
		}
	}
	// A standards-compliant provider newline-terminates every frame, but a custom
	// OpenAI-compatible endpoint (a local LLM server) may close the connection
	// right after the final `data:` line with no trailing newline. Without this,
	// that last frame — carrying the closing token(s) — would be silently dropped.
	if len(buf) > 0 {
		if err := handleSSELine(string(buf), prov, &full); err != nil {
			return "", err
		}
	}
	return full.String(), nil
}

// sseFrame is the union of the fields both providers carry in an SSE data frame.
// One decode covers error detection and delta extraction for either shape.
type sseFrame struct {
	// Anthropic: "error" | "content_block_delta"; absent on OpenAI frames.
	Type string `json:"type"`
	// Anthropic content delta text; on a message_delta frame the same field
	// carries stop_reason instead.
	Delta struct {
		Text       string `json:"text"`
		StopReason string `json:"stop_reason"`
	} `json:"delta"`
	// OpenAI streaming choices. FinishReason is "length" on a response the
	// output cap cut short.
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	// Anthropic reports the same thing on its message_delta frame, as
	// stop_reason "max_tokens".
	Message struct {
		StopReason string `json:"stop_reason"`
	} `json:"message"`
	// Error object (present on both shapes when something goes wrong; OpenAI
	// also emits a literal null here on healthy chunks — RawMessage lets us tell
	// null/absent from a real object).
	Error json.RawMessage `json:"error"`
}

// handleSSELine processes a single SSE line: pulls the `data:` payload, surfaces
// any provider error, and appends a text delta to full.
func handleSSELine(line string, prov provider, full *strings.Builder) error {
	data, ok := strings.CutPrefix(strings.TrimSpace(line), "data:")
	if !ok {
		return nil
	}
	data = strings.TrimSpace(data)
	if data == "" || data == "[DONE]" {
		return nil
	}
	var f sseFrame
	if err := json.Unmarshal([]byte(data), &f); err != nil {
		return nil
	}
	if msg, isErr := extractError(&f, prov); isErr {
		return apperr.Codef("aiFailed", "AI stream error: %s", msg)
	}
	if text := extractDelta(&f, prov); text != "" {
		full.WriteString(text)
	}
	// A batch cut off at the output cap is text silently lost: the fragment
	// would be stored, and read, as if the model had finished it.
	if truncated(&f, prov) {
		return errTruncated
	}
	return nil
}

// errTruncated marks a response the provider stopped at the output cap. It is
// retryable because the retry asks for the full cap (batchMaxTokens sizes the
// request to the batch, so a bad estimate is what got us here).
var errTruncated = retryable{apperr.Code("aiTruncated")}

// truncated reports whether this frame says the answer was cut short by the
// output token cap, in either provider's spelling.
func truncated(f *sseFrame, prov provider) bool {
	if prov == providerAnthropic {
		return f.Delta.StopReason == "max_tokens" || f.Message.StopReason == "max_tokens"
	}
	for _, c := range f.Choices {
		if c.FinishReason == "length" {
			return true
		}
	}
	return false
}

// extractError detects a provider error object carried inside an SSE data frame.
//
// For the OpenAI-compatible path the error must be a non-null object: many
// compatible servers (OpenRouter and others) include a literal `"error": null`
// alongside `choices` in their successful chunks. Treating that as a fault would
// abort an otherwise-fine generation with a bogus "stream error".
func extractError(f *sseFrame, prov provider) (string, bool) {
	if prov == providerAnthropic {
		if f.Type != "error" {
			return "", false
		}
	} else {
		// Require a non-null JSON object; a missing or literal-null `error` field
		// is not a fault.
		t := bytes.TrimSpace(f.Error)
		if len(t) == 0 || t[0] != '{' {
			return "", false
		}
	}
	var obj struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(f.Error, &obj)
	if obj.Message == "" {
		return "stream error", true
	}
	return obj.Message, true
}

// extractDelta pulls the incremental text token from a provider's SSE data frame.
func extractDelta(f *sseFrame, prov provider) string {
	if prov == providerAnthropic {
		if f.Type != "content_block_delta" {
			return ""
		}
		return f.Delta.Text
	}
	if len(f.Choices) > 0 {
		return f.Choices[0].Delta.Content
	}
	return ""
}

// ─────────────────────────── public API ───────────────────────────

// Translate translates an article body's HTML into targetLang using engine
// (one of "llm" | "google" | "deepl" | "bing"; anything else falls back to the
// LLM). It reads the LLM provider config/key from settings (db.GetSetting) when
// the LLM engine is selected, splits the body into greedy block batches under an
// engine-specific byte budget (never splitting a single block), translates each
// batch with the HTML structure preserved, and emits a start{total} event,
// then a batch{html,done} event per batch, then a final done{html} — returning
// the full translated HTML.
//
// emit may be nil. The returned batch/done HTML is raw engine output: the caller
// is responsible for sanitizing each batch before rendering or persisting it,
// matching commands::ai_translate, which sanitizes every batch with the same
// sanitizer as feed HTML.
func Translate(ctx context.Context, client *http.Client, q db.Querier, htmlStr, title, targetLang, engine string, emit func(Event)) (string, string, error) {
	// Normalise the engine: anything unrecognised is the LLM path.
	switch engine {
	case "google", "deepl", "bing":
	default:
		engine = "llm"
	}

	// Resolve the LLM config only when needed (keyless engines need no creds).
	var cfg aiConfig
	if engine == "llm" {
		c, err := loadAiConfig(ctx, q)
		if err != nil {
			return "", "", err
		}
		cfg = c
	}

	// Resolve the chosen engine (fetching Bing's auth token, if selected) before
	// any work starts, so a credential or network failure surfaces before any
	// progress is reported rather than mid-stream.
	b, err := ready(ctx, client, engine, cfg)
	if err != nil {
		return "", "", err
	}
	return translateWith(ctx, b, client, htmlStr, title, targetLang, engine, emit)
}

// translateWith runs the batch pipeline against an already-resolved engine.
// Split from Translate so the pipeline — chunking, concurrency, ordering — is
// testable against a fake endpoint without a database behind it.
func translateWith(ctx context.Context, b backend, client *http.Client, htmlStr, title, targetLang, engine string, emit func(Event)) (string, string, error) {
	send := func(e Event) {
		if emit != nil {
			emit(e)
		}
	}

	// Cut the chapter up so that as much of it as possible is in flight at
	// once (see batching.go), within each engine's own per-call limits.
	concurrency := translateConcurrency(engine)
	batches := planBatches(htmlStr, engine, concurrency)
	total := len(batches)

	// Cancelling stops the batches still in flight rather than letting them run
	// on (and bill) after the reader has moved away. wg.Wait is deferred first
	// so it runs last: no request outlives this call.
	runCtx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	defer wg.Wait()
	defer cancel()

	// The title is a short round-trip, but it used to be a serial one in front
	// of everything. Started here, it resolves while the first batches are
	// already in flight, so it costs nothing. Best-effort: a title hiccup must
	// not fail the body.
	titleCh := make(chan string, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		tt, _ := b.translateTitle(runCtx, client, title, targetLang)
		titleCh <- tt
	}()

	system := translateSystemPrompt(languageName(targetLang))

	// Each batch owns a slot: it writes only its own, and closes only its own
	// channel, so the finished results are read back in order without a lock.
	// `sofar` is the exception — it is written while the batch is still being
	// generated and read by the emitter below, so it takes the mutex.
	slots := make([]slot, total)
	for i := range slots {
		slots[i].ready = make(chan struct{})
		slots[i].wrote = make(chan struct{}, 1)
	}
	gate := make(chan struct{}, concurrency)
	for i, batch := range batches {
		wg.Add(1)
		go func(i int, batch string) {
			defer wg.Done()
			defer close(slots[i].ready)
			select {
			case gate <- struct{}{}:
				defer func() { <-gate }()
			case <-runCtx.Done():
				slots[i].err = runCtx.Err()
				return
			}
			slots[i].html, slots[i].err = withRetry(runCtx, func(attempt int) (string, error) {
				// A request asks for the room its batch should need; if that
				// turned out to be too little — the answer came back cut off —
				// the next attempt asks for everything.
				maxTokens := batchMaxTokens(batch)
				if attempt > 0 {
					maxTokens = translateMaxTokens
				}
				return b.translateBatch(runCtx, client, system, batch, targetLang, maxTokens, slots[i].progress)
			})
		}(i, batch)
	}

	translatedTitle := <-titleCh
	send(Event{Type: "start", Data: EventData{Total: total, Title: translatedTitle}})

	// Emit in batch order even though the batches finish out of order: the
	// reader appends each piece to what it has, so the page fills top-down.
	// Within the batch at the front, whatever the model has finished writing is
	// handed over as it lands — the batches behind it keep generating, and their
	// text is already waiting when their turn comes.
	var full strings.Builder
	for i := range slots {
		// What this batch has already handed to the reader. Kept as the text
		// rather than a count: a retried batch starts writing again from
		// nothing, and an offset into a string that just got shorter is a panic.
		sent := ""
		emit := func(text string) {
			if text == "" {
				return
			}
			full.WriteString(text)
			send(Event{Type: "batch", Data: EventData{HTML: text, Done: i}})
		}

	streaming:
		for {
			// Finished wins over more text: the final value is authoritative.
			select {
			case <-slots[i].ready:
				break streaming
			default:
			}
			select {
			case <-slots[i].ready:
				break streaming
			case <-slots[i].wrote:
				cur := streamPrefix(slots[i].read())
				if !strings.HasPrefix(cur, sent) {
					// The batch restarted (a retry). Stop streaming it and let
					// the finished result reconcile below.
					continue
				}
				ready, _ := splitCompleteBlocks(cur[len(sent):])
				sent += ready
				emit(ready)
			case <-ctx.Done():
				return "", "", ctx.Err()
			}
		}

		if slots[i].err != nil {
			return "", "", slots[i].err
		}
		// Engine output (LLM or machine translation) is untrusted. The caller
		// sanitizes; here we trim and emit it. Source URLs are already absolute
		// (sanitized at ingestion), so no base is needed downstream.
		clean := strings.TrimSpace(slots[i].html)
		// What was streamed is a prefix of the cleaned result by construction:
		// streamPrefix mirrors stripCodeFence's head, and only whole blocks are
		// sent. When that does not hold — a retry rewrote the batch — send
		// nothing more rather than the same text twice; the done event carries
		// the authoritative document and the reader replaces its copy with it.
		switch {
		case sent == "":
			emit(clean)
		case strings.HasPrefix(clean, sent):
			emit(clean[len(sent):])
		default:
			full.WriteString(clean)
		}
		full.WriteByte('\n')
		send(Event{Type: "batch", Data: EventData{Done: i + 1}})
	}

	finalHTML := strings.TrimSpace(full.String())
	send(Event{Type: "done", Data: EventData{HTML: finalHTML, Title: translatedTitle}})
	return finalHTML, translatedTitle, nil
}
