package sanitize

import (
	"strings"
	"testing"
)

func eq(t *testing.T, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestHTMLToText(t *testing.T) {
	eq(t, HTMLToText("<h1>Title</h1><p>Body</p>"), "Title Body")
	eq(t, HTMLToText("un<b>der</b>line"), "underline")
	eq(t, HTMLToText("<p>Tom &amp; Jerry</p>"), "Tom & Jerry")
	eq(t, HTMLToText("caf&#233;"), "café")
	eq(t, HTMLToText("a &lt;tag&gt; b"), "a <tag> b")
	eq(t, HTMLToText("<p>hi</p><script>alert(1)</script><style>x{}</style>"), "hi")
	eq(t, HTMLToText("<p>  lots   of\n\n  space </p>"), "lots of space")
	eq(t, HTMLToText(""), "")
	eq(t, HTMLToText("just text"), "just text")

	// Iterative-equivalent: 5000 nested divs must not blow the stack.
	deep := strings.Repeat("<div>", 5000) + "word" + strings.Repeat("</div>", 5000)
	eq(t, HTMLToText(deep), "word")
}

func TestSanitizeStripsScriptsAndHandlers(t *testing.T) {
	out := Sanitize(`<p onclick="steal()">hi</p><script>evil()</script>`, "")
	if strings.Contains(out, "script") {
		t.Errorf("script survived: %s", out)
	}
	if strings.Contains(out, "onclick") {
		t.Errorf("event handler survived: %s", out)
	}
	if !strings.Contains(out, "hi") {
		t.Errorf("content lost: %s", out)
	}
}

func TestSanitizeAddsRelToLinks(t *testing.T) {
	out := Sanitize(`<a href="https://example.com">x</a>`, "")
	if !strings.Contains(out, "noreferrer") {
		t.Errorf("link rel missing noreferrer: %s", out)
	}
}

func TestFirstImage(t *testing.T) {
	if got := FirstImage(`<p>intro</p><img src="https://ex.com/a.png"><img src="https://ex.com/b.png">`); got == nil || *got != "https://ex.com/a.png" {
		t.Errorf("first absolute img = %v, want a.png", got)
	}
	if got := FirstImage(`<img src="/local.png">`); got != nil {
		t.Errorf("relative src should be skipped, got %v", *got)
	}
	if got := FirstImage(`<img src="data:image/png;base64,AAAA">`); got != nil {
		t.Errorf("data blob should be skipped, got %v", *got)
	}
	if got := FirstImage("<p>no images</p>"); got != nil {
		t.Errorf("no image expected, got %v", *got)
	}
	if got := FirstImage(`<img src="/rel.png"><img src="https://ex.com/real.jpg">`); got == nil || *got != "https://ex.com/real.jpg" {
		t.Errorf("should fall through to absolute, got %v", got)
	}
}

func TestSanitizeImagesNoReferrer(t *testing.T) {
	out := Sanitize(`<img src="https://wx1.sinaimg.cn/large/a.jpg">`, "")
	if !strings.Contains(out, `referrerpolicy="no-referrer"`) {
		t.Errorf("img missing no-referrer: %s", out)
	}
	// A feed-shipped weaker policy must not win.
	out = Sanitize(`<img src="https://wx1.sinaimg.cn/large/a.jpg" referrerpolicy="origin">`, "")
	if !strings.Contains(out, `referrerpolicy="no-referrer"`) || strings.Contains(out, `referrerpolicy="origin"`) {
		t.Errorf("weaker policy won: %s", out)
	}
}

func TestSanitizeRewritesRelativeURLs(t *testing.T) {
	out := Sanitize(`<img src="/pic.png">`, "https://example.com/post/")
	if !strings.Contains(out, "https://example.com/pic.png") {
		t.Errorf("relative URL not rewritten: %s", out)
	}
}

func TestPromoteLazyImages(t *testing.T) {
	out := Sanitize(`<img src="" data-src="https://cdnfile.sspai.com/a.jpg">`, "")
	if !strings.Contains(out, `src="https://cdnfile.sspai.com/a.jpg"`) {
		t.Errorf("data-src not promoted: %s", out)
	}
	out = Sanitize(`<img srcset="https://ex.com/a.jpg 1x, https://ex.com/b.jpg 2x">`, "")
	if !strings.Contains(out, `src="https://ex.com/a.jpg"`) {
		t.Errorf("srcset not promoted: %s", out)
	}
	out = Sanitize(`<img src="data:image/gif;base64,AAAA" data-original="https://ex.com/real.jpg">`, "")
	if !strings.Contains(out, `src="https://ex.com/real.jpg"`) || strings.Contains(out, "data:image/gif") {
		t.Errorf("placeholder not replaced: %s", out)
	}
	out = Sanitize(`<img src="https://ex.com/real.jpg" data-src="https://ex.com/other.jpg">`, "")
	if !strings.Contains(out, `src="https://ex.com/real.jpg"`) || strings.Contains(out, "other.jpg") {
		t.Errorf("real src wrongly overridden: %s", out)
	}
}

// Inline HTML5 video survives sanitize.

func TestSanitizeKeepsVideoAndSource(t *testing.T) {
	out := Sanitize(`<video poster="https://ex.com/p.jpg"><source src="https://ex.com/v.mp4" type="video/mp4"></video>`, "")
	if !strings.Contains(out, "<video") {
		t.Errorf("video tag dropped: %s", out)
	}
	if !strings.Contains(out, "<source") {
		t.Errorf("source tag dropped: %s", out)
	}
	if !strings.Contains(out, `src="https://ex.com/v.mp4"`) {
		t.Errorf("source src dropped: %s", out)
	}
	if !strings.Contains(out, `type="video/mp4"`) {
		t.Errorf("source type dropped: %s", out)
	}
	if !strings.Contains(out, `poster="https://ex.com/p.jpg"`) {
		t.Errorf("poster dropped: %s", out)
	}
}

func TestSanitizeForcesVideoControls(t *testing.T) {
	// A clip with no controls (and no autoplay) is an unplayable frozen frame —
	// controls are forced on so the reader can always play it.
	out := Sanitize(`<video src="https://ex.com/v.mp4"></video>`, "")
	if !strings.Contains(out, "controls") {
		t.Errorf("controls not forced: %s", out)
	}
}

func TestSanitizeStripsVideoAutoplayAndHandlers(t *testing.T) {
	// autoplay isn't whitelisted (feed video must be user-initiated), and event
	// handlers are stripped like everywhere else.
	out := Sanitize(`<video src="https://ex.com/v.mp4" autoplay onerror="evil()"></video>`, "")
	if strings.Contains(out, "autoplay") {
		t.Errorf("autoplay survived: %s", out)
	}
	if strings.Contains(out, "onerror") {
		t.Errorf("event handler survived: %s", out)
	}
}

func TestSanitizeRewritesRelativeVideoSrc(t *testing.T) {
	out := Sanitize(`<video src="/clip.mp4"></video>`, "https://example.com/post/")
	if !strings.Contains(out, "https://example.com/clip.mp4") {
		t.Errorf("relative video src not rewritten: %s", out)
	}
}

func TestSanitizeDropsJavascriptVideoSrc(t *testing.T) {
	out := Sanitize(`<video src="javascript:evil()"></video>`, "")
	if strings.Contains(out, "javascript:") {
		t.Errorf("javascript: src survived: %s", out)
	}
}

func TestEscapeHTML(t *testing.T) {
	eq(t, EscapeHTML(`a & b < c > d " e ' f`), `a &amp; b &lt; c &gt; d &quot; e &#39; f`)
}
