package translate

// Showing a batch as the model writes it.
//
// The LLM path has always streamed — completeChat consumed the SSE response and
// handed back the finished batch, so the first words of a chapter waited on the
// last words of the batch. On a model that writes at twenty tokens a second
// that is most of the wait.
//
// What stands in the way of handing text over as it arrives is that a
// half-written fragment is half-written markup: `<p>今夜甚` is not something to
// put into a document, and neither is `<blockquote><p>a</p>` — the quote is
// still open. splitCompleteBlocks draws that line: it returns the longest
// prefix that ends on a closed top-level element, and holds back the rest until
// it closes. Everything it returns is renderable on its own.

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"
)

// voidElements have no closing tag, so at the top level each one is a complete
// block by itself.
var voidElements = map[string]bool{
	"area": true, "base": true, "br": true, "col": true, "embed": true,
	"hr": true, "img": true, "input": true, "link": true, "meta": true,
	"param": true, "source": true, "track": true, "wbr": true,
}

// splitCompleteBlocks splits a partially written HTML fragment into the part
// that is safe to render — whole top-level elements, every tag they opened
// closed again — and the part still being written.
//
// Trailing bare text is held back as well. It may still be growing, and it is
// where a closing code fence lands when the model wrapped its answer in one.
func splitCompleteBlocks(s string) (done, rest string) {
	depth, cut := 0, 0
	for i := 0; i < len(s); {
		if s[i] != '<' {
			i++
			continue
		}
		if strings.HasPrefix(s[i:], "<!--") {
			end := strings.Index(s[i+4:], "-->")
			if end < 0 {
				break // the comment is still being written
			}
			i += 4 + end + 3
			continue
		}
		end := tagEnd(s, i)
		if end < 0 {
			break // the tag itself is half-written
		}
		name, closing, selfClosing := parseTag(s[i : end+1])
		switch {
		case name == "":
			// A doctype, processing instruction or stray `<`: not a block.
		case closing:
			// A stray close at the top level is the model's mistake, not a
			// reason to stop streaming: clamp rather than go negative.
			if depth > 0 {
				depth--
			}
			if depth == 0 {
				cut = end + 1
			}
		case selfClosing || voidElements[name]:
			if depth == 0 {
				cut = end + 1
			}
		default:
			depth++
		}
		i = end + 1
	}
	return s[:cut], s[cut:]
}

// tagEnd returns the index of the `>` closing the tag that starts at i, or -1
// if the tag is not finished yet. Quoted attribute values are skipped, so a `>`
// inside one (`<a title="a > b">`) does not end the tag early.
func tagEnd(s string, i int) int {
	var quote byte
	for j := i + 1; j < len(s); j++ {
		switch c := s[j]; {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '>':
			return j
		}
	}
	return -1
}

// parseTag reads a complete tag. An empty name means it is not an element tag
// (a doctype, a processing instruction, a stray `<>`).
func parseTag(tag string) (name string, closing, selfClosing bool) {
	body := strings.TrimSuffix(strings.TrimPrefix(tag, "<"), ">")
	if body = strings.TrimSpace(body); body == "" {
		return "", false, false
	}
	if strings.HasSuffix(body, "/") {
		selfClosing = true
		body = strings.TrimSpace(strings.TrimSuffix(body, "/"))
	}
	if strings.HasPrefix(body, "/") {
		closing = true
		body = strings.TrimSpace(strings.TrimPrefix(body, "/"))
	}
	if body == "" || body[0] == '!' || body[0] == '?' {
		return "", false, false
	}
	name = body
	if i := strings.IndexAny(name, " \t\r\n/"); i >= 0 {
		name = name[:i]
	}
	return strings.ToLower(name), closing, selfClosing
}

// streamPrefix normalises the part of a streamed answer that can be shown: it
// drops an opening code fence — models routinely wrap the fragment in one —
// and the leading whitespace, so that what is emitted mid-stream is always a
// prefix of what stripCodeFence produces at the end. An unfinished fence line
// yields "": there is nothing to show until we know what it opened.
func streamPrefix(s string) string {
	t := strings.TrimLeftFunc(s, unicode.IsSpace)
	rest, ok := strings.CutPrefix(t, "```")
	if !ok {
		return t
	}
	i := strings.IndexByte(rest, '\n')
	if i < 0 {
		return ""
	}
	return strings.TrimLeftFunc(rest[i+1:], unicode.IsSpace)
}

// slot is one batch's place in the pipeline: its finished result, and — while
// it is still being written — everything the model has produced so far.
type slot struct {
	html  string
	err   error
	ready chan struct{}

	mu    sync.Mutex
	sofar string
	// wrote carries a single pending "there is more text" nudge. It has room
	// for one because the reader only needs to know that something changed, not
	// how many times; a full buffer means the emitter has not caught up yet.
	wrote chan struct{}
}

// progress is the callback handed to the streaming request.
func (s *slot) progress(text string) {
	s.mu.Lock()
	s.sofar = text
	s.mu.Unlock()
	select {
	case s.wrote <- struct{}{}:
	default:
	}
}

// read returns everything written so far.
func (s *slot) read() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sofar
}

// ─────────────────────────── retrying a batch ───────────────────────────

// retryable marks an error worth trying again: the provider was busy or having
// a moment, not a request it will always refuse. It matters more now that a
// chapter sends several batches at once — one 429 in a burst of eight used to
// throw away every batch that had already been paid for and generated.
type retryable struct{ err error }

func (r retryable) Error() string { return r.err.Error() }
func (r retryable) Unwrap() error { return r.err }

// retryableStatus reports whether an HTTP status is worth another attempt:
// rate limiting, and the transient half of the server errors.
func retryableStatus(code int) bool {
	switch code {
	case http.StatusTooManyRequests, http.StatusInternalServerError,
		http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}

// markRetryable wraps err when the response says the failure is transient.
func markRetryable(status int, err error) error {
	if retryableStatus(status) {
		return retryable{err}
	}
	return err
}

// batchRetries is how many extra attempts a transient failure gets. Two is
// enough to ride out a rate-limit burst without turning a provider outage into
// a long silent wait.
const batchRetries = 2

// retryBackoff is the pause before attempt n (1-based). Fixed rather than
// exponential: the window we are riding out is a burst of our own making.
func retryBackoff(attempt int) time.Duration {
	return time.Duration(attempt) * 700 * time.Millisecond
}

// withRetry runs one batch, trying again after a transient failure. Anything
// else — a bad key, a model that does not exist, a cancelled context — fails on
// the first attempt, because retrying it would only make the reader wait longer
// for the same answer. run is told which attempt this is: a batch cut off at the
// output cap has to ask for a bigger one, or it will be cut off again.
func withRetry(ctx context.Context, run func(attempt int) (string, error)) (string, error) {
	var err error
	for attempt := 0; ; attempt++ {
		var out string
		out, err = run(attempt)
		if err == nil {
			return out, nil
		}
		var r retryable
		if attempt >= batchRetries || !errors.As(err, &r) || ctx.Err() != nil {
			return "", err
		}
		select {
		case <-time.After(retryBackoff(attempt + 1)):
		case <-ctx.Done():
			return "", err
		}
	}
}
