package translate

import (
	"strings"
	"testing"
)

// The contract these tests defend: whatever splitCompleteBlocks calls "done" is
// put into the reader's document as-is. Emitting one byte too many means
// unclosed markup on the page — the reason the streamed batch used to be
// withheld until it finished.
func TestSplitCompleteBlocks(t *testing.T) {
	cases := []struct {
		name       string
		in         string
		done, rest string
	}{
		{"nothing yet", "", "", ""},
		{"a tag being written", "<p", "", "<p"},
		{"an element being written", "<p>今夜甚", "", "<p>今夜甚"},
		{"one closed element", "<p>今夜甚美。</p>", "<p>今夜甚美。</p>", ""},
		{
			"a closed element and the next one starting",
			"<p>一</p><p>二",
			"<p>一</p>", "<p>二",
		},
		{
			"nesting is not complete until it unwinds",
			"<blockquote><p>a</p>",
			"", "<blockquote><p>a</p>",
		},
		{
			"nesting completes when the outer closes",
			"<blockquote><p>a</p></blockquote><p>b",
			"<blockquote><p>a</p></blockquote>", "<p>b",
		},
		{
			"a void element stands alone at the top level",
			"<img src=\"a.png\"><p>next",
			"<img src=\"a.png\">", "<p>next",
		},
		{
			"a void element inside a block does not end it",
			"<p>a<br>b</p>",
			"<p>a<br>b</p>", "",
		},
		{
			"a self-closing tag stands alone",
			"<hr /><p>x",
			"<hr />", "<p>x",
		},
		{
			"a > inside an attribute does not end the tag",
			`<a title="a > b">x</a><p`,
			`<a title="a > b">x</a>`, "<p",
		},
		{
			"a half-written attribute holds the whole element back",
			`<a title="a > `,
			"", `<a title="a > `,
		},
		{
			"trailing bare text is held back",
			"<p>a</p>\n\nand then",
			"<p>a</p>", "\n\nand then",
		},
		{
			"bare text before a closed element rides along with it",
			"lead in <p>a</p>",
			"lead in <p>a</p>", "",
		},
		{
			"a comment being written holds back what follows it",
			"<p>a</p><!-- unfinis",
			"<p>a</p>", "<!-- unfinis",
		},
		{
			"a finished comment is passed over",
			"<p>a</p><!-- note --><p>b</p>",
			"<p>a</p><!-- note --><p>b</p>", "",
		},
		{
			"a stray closing tag does not unbalance the count",
			"</p><p>a</p><p>b",
			"</p><p>a</p>", "<p>b",
		},
		{
			"attributes spanning the tag name are read correctly",
			`<p class="x">a</p><div`,
			`<p class="x">a</p>`, "<div",
		},
		{
			"an uppercase tag closes its lowercase self",
			"<P>a</P><p>b",
			"<P>a</P>", "<p>b",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			done, rest := splitCompleteBlocks(tc.in)
			if done != tc.done || rest != tc.rest {
				t.Errorf("split(%q)\n got  done=%q rest=%q\n want done=%q rest=%q",
					tc.in, done, rest, tc.done, tc.rest)
			}
			if done+rest != tc.in {
				t.Errorf("the two halves must reassemble to the input, got %q", done+rest)
			}
		})
	}
}

// Fed one byte at a time — which is what a token stream amounts to — the
// emitted pieces must concatenate to exactly the blocks of the whole, never
// overlapping and never skipping.
func TestSplitCompleteBlocksIsStableUnderStreaming(t *testing.T) {
	full := `<h2>经济</h2><p>我住在<b>林中</b>。</p><img src="pond.png">` +
		`<blockquote><p>引文</p></blockquote><p>末段。</p>`

	var emitted strings.Builder
	pending := ""
	for i := 0; i < len(full); i++ {
		pending += full[i : i+1] // byte by byte: a token stream splits multi-byte runes too
		done, rest := splitCompleteBlocks(pending)
		if done != "" {
			emitted.WriteString(done)
			pending = rest
		}
	}
	if got := emitted.String() + pending; got != full {
		t.Errorf("streamed reassembly = %q, want %q", got, full)
	}
	if pending != "" {
		t.Errorf("a complete document should leave nothing pending, got %q", pending)
	}
}

// A partial must always be a prefix of what the finished batch is cleaned to,
// or the reader would show text the final result then contradicts.
func TestStreamPrefixAgreesWithStripCodeFence(t *testing.T) {
	cases := []string{
		"<p>a</p><p>b</p>",
		"\n\n<p>a</p>",
		"```html\n<p>a</p><p>b</p>\n```",
		"```\n<p>a</p>\n```",
	}
	for _, raw := range cases {
		final := stripCodeFence(raw)
		// Every prefix of the raw stream, cleaned, must be a prefix of the final.
		for i := 0; i <= len(raw); i++ {
			done, _ := splitCompleteBlocks(streamPrefix(raw[:i]))
			if !strings.HasPrefix(final, done) {
				t.Fatalf("raw=%q at %d: emitted %q, which is not a prefix of the final %q",
					raw, i, done, final)
			}
		}
	}
}

// Until the fence's language line lands there is nothing to show: "```htm" is
// not the start of the answer.
func TestStreamPrefixWithholdsAnUnfinishedFence(t *testing.T) {
	// Fewer than three backticks is not a fence yet — it is bare text, which
	// splitCompleteBlocks holds back on its own, so it never reaches the page.
	for _, in := range []string{"```", "```htm", "```html"} {
		if got := streamPrefix(in); got != "" {
			t.Errorf("streamPrefix(%q) = %q, want nothing yet", in, got)
		}
	}
	if got := streamPrefix("```html\n<p>a"); got != "<p>a" {
		t.Errorf("streamPrefix after the fence = %q, want %q", got, "<p>a")
	}
}
