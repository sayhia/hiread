// Package sanitize is hiread's HTML sanitization and text-extraction layer. Every
// piece of feed- or web-supplied HTML passes through Sanitize before it is ever
// stored or rendered (bluemonday + goquery + x/net/html).
package sanitize

import (
	"strings"

	"net/url"

	"github.com/PuerkitoBio/goquery"
	"github.com/microcosm-cc/bluemonday"
	"golang.org/x/net/html"
)

// skipTags are tags whose text content is dropped wholesale (not human copy).
var skipTags = map[string]bool{
	"script": true, "style": true, "template": true, "noscript": true,
}

// blockTags are block-level tags whose edges are word boundaries, so text on
// either side must not run together ("</h1><p>" → "TitleBody").
var blockTags = map[string]bool{
	"address": true, "article": true, "aside": true, "blockquote": true,
	"br": true, "caption": true, "dd": true, "div": true, "dl": true, "dt": true,
	"figcaption": true, "figure": true, "footer": true, "h1": true, "h2": true,
	"h3": true, "h4": true, "h5": true, "h6": true, "header": true, "hr": true,
	"li": true, "main": true, "nav": true, "ol": true, "p": true, "pre": true,
	"section": true, "table": true, "td": true, "th": true, "tr": true, "ul": true,
}

// policy is the shared bluemonday policy. Built once; bluemonday policies are
// safe for concurrent use.
var policy = buildPolicy()

func buildPolicy() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()
	// Allow the loading hint and our forced referrer policy on images.
	p.AllowAttrs("loading", "referrerpolicy").OnElements("img")
	// Allow inline HTML5 video. UGCPolicy drops <video> and <source> entirely,
	// so a feed that embeds a clip with a <video> tag reached the reader as
	// nothing at all. Permit the element plus its safe layout/playback
	// attributes (and <source> for multiple formats); src/poster are URL
	// attributes, so they go through the same relative-URL rewriting and scheme
	// filtering in the goquery pass as every other URL here, which strips
	// javascript: and friends. autoplay is deliberately not whitelisted — feed-
	// embedded video must be user-initiated. controls is forced on in the
	// goquery pass (bluemonday can't set attribute values).
	p.AllowAttrs("src", "poster", "width", "height", "preload", "loop", "muted", "playsinline", "controls").OnElements("video")
	p.AllowAttrs("src", "type", "media").OnElements("source")
	// Links open without leaking the reader's origin (noreferrer ⇒ noopener in
	// modern engines) and carry nofollow (UGCPolicy already adds nofollow).
	p.RequireNoReferrerOnLinks(true)
	return p
}

// keepHTTPURL reports whether a (base-resolved) URL is safe to keep on a media
// attribute: http(s) or relative. bluemonday only scheme-filters `src` on its
// hardcoded "linkable" element list — which excludes <source> and never covers
// <video poster> — so those are filtered here instead.
func keepHTTPURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "", "http", "https":
		return true
	default:
		return false
	}
}

// Sanitize cleans untrusted HTML for safe rendering inside the reader webview.
// Relative URLs are rewritten against base so feed images/links resolve.
func Sanitize(htmlStr string, base string) string {
	// Pre-pass on a parsed DOM: recover lazy-loaded image URLs, force a
	// no-referrer policy on every image (hotlink-protected CDNs 403 a request
	// carrying the reader's origin), and resolve relative URLs against base.
	// bluemonday then has the final say on safety.
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(htmlStr))
	if err != nil {
		return policy.Sanitize(htmlStr)
	}
	var b *url.URL
	if base != "" {
		b, _ = url.Parse(base)
	}
	doc.Find("img").Each(func(_ int, s *goquery.Selection) {
		promoteLazyImage(s)
		s.SetAttr("referrerpolicy", "no-referrer")
		if b != nil {
			if src, ok := s.Attr("src"); ok {
				s.SetAttr("src", resolveURL(b, src))
			}
		}
	})
	// Always expose player controls: a feed clip with no controls (and no
	// whitelisted autoplay) would otherwise be a frozen, unplayable frame.
	// bluemonday can't set attribute values, so force it here. It also does NOT
	// scheme-filter <video poster> or <source src> (only `src` on its hardcoded
	// linkable list), so resolve against base and http(s)-filter them here —
	// otherwise a javascript:/data: scheme would survive.
	doc.Find("video").Each(func(_ int, s *goquery.Selection) {
		s.SetAttr("controls", "")
		for _, attr := range []string{"src", "poster"} {
			v, ok := s.Attr(attr)
			if !ok {
				continue
			}
			if b != nil {
				v = resolveURL(b, v)
			}
			if keepHTTPURL(v) {
				s.SetAttr(attr, v)
			} else {
				s.RemoveAttr(attr)
			}
		}
	})
	doc.Find("source[src]").Each(func(_ int, s *goquery.Selection) {
		v, _ := s.Attr("src")
		if b != nil {
			v = resolveURL(b, v)
		}
		if keepHTTPURL(v) {
			s.SetAttr("src", v)
		} else {
			s.RemoveAttr("src")
		}
	})
	if b != nil {
		doc.Find("a[href]").Each(func(_ int, s *goquery.Selection) {
			if href, ok := s.Attr("href"); ok {
				s.SetAttr("href", resolveURL(b, href))
			}
		})
	}
	// goquery wraps fragments in <html><body>; emit the body's inner HTML.
	inner, err := doc.Find("body").Html()
	if err != nil {
		inner = htmlStr
	}
	return policy.Sanitize(inner)
}

// chapterPolicy sanitizes book chapters. It differs from the feed policy in two
// ways: images are addressed by data-res (a path into the book's own stored
// resources) rather than by URL, and intra-book links become data-link, which
// the reader turns into a chapter jump. Both attributes are opaque strings the
// frontend looks up — neither can cause a fetch on its own.
var chapterPolicy = buildChapterPolicy()

func buildChapterPolicy() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()
	p.AllowAttrs("data-res").OnElements("img")
	p.AllowAttrs("data-link").OnElements("a")
	// Anchors within a chapter (footnote markers and their targets) need ids.
	p.AllowAttrs("id").Globally()
	p.AllowAttrs("name").OnElements("a")
	p.RequireNoReferrerOnLinks(true)
	return p
}

// Chapter cleans a parsed book chapter for rendering. Unlike feed HTML, a
// chapter must not reach the network at all: the book is local and complete, so
// any remaining src on an image is a tracker or a dead link, and either way the
// image is dropped. The book's own presentation is dropped too — hiread renders
// every book in one typography system the reader controls.
func Chapter(htmlStr string) string {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(htmlStr))
	if err != nil {
		return chapterPolicy.Sanitize(htmlStr)
	}
	doc.Find("script, style, link, iframe, object, embed, form").Remove()
	doc.Find("img").Each(func(_ int, s *goquery.Selection) {
		if _, ok := s.Attr("data-res"); !ok {
			s.Remove()
			return
		}
		s.RemoveAttr("src")
		s.RemoveAttr("srcset")
	})
	doc.Find("[style]").RemoveAttr("style")
	doc.Find("[class]").RemoveAttr("class")

	inner, err := doc.Find("body").Html()
	if err != nil {
		inner = htmlStr
	}
	return chapterPolicy.Sanitize(inner)
}

// promoteLazyImage moves a lazy-loaded image's real URL into src so it survives
// sanitization. Lazy-loading feeds ship src="" / a data: placeholder and put
// the real URL in data-src / data-original / srcset; bluemonday's img whitelist
// keeps src but drops those, leaving an unloadable <img>.
func promoteLazyImage(s *goquery.Selection) {
	if src, ok := s.Attr("src"); ok {
		t := strings.TrimSpace(src)
		if t != "" && !strings.HasPrefix(t, "data:") {
			return // already has a real src
		}
	}
	for _, attr := range []string{"data-src", "data-original", "data-actualsrc", "data-lazy-src"} {
		if v, ok := s.Attr(attr); ok && strings.TrimSpace(v) != "" {
			s.SetAttr("src", strings.TrimSpace(v))
			return
		}
	}
	// srcset is "url1 1x, url2 2x" / "url1 480w, …" — take the first URL.
	if ss, ok := s.Attr("srcset"); ok {
		first := strings.TrimSpace(strings.SplitN(ss, ",", 2)[0])
		if fields := strings.Fields(first); len(fields) > 0 && fields[0] != "" {
			s.SetAttr("src", fields[0])
		}
	}
}

// resolveURL resolves ref against base, leaving an already-absolute or
// unparseable URL unchanged.
func resolveURL(base *url.URL, ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ref
	}
	u, err := url.Parse(ref)
	if err != nil {
		return ref
	}
	if u.IsAbs() {
		return ref
	}
	return base.ResolveReference(u).String()
}

// HTMLToText strips all markup from HTML, yielding collapsed plain text. Used
// for the FTS body index, list snippets and AI prompt context. Entities are
// decoded and a space is emitted at every block boundary so adjacent
// paragraphs keep their words apart, while inline tags still join seamlessly.
//
// It walks the token stream rather than a parse tree, so pathologically deep
// markup can never overflow the stack (matching the Rust iterative traversal).
func HTMLToText(htmlStr string) string {
	z := html.NewTokenizer(strings.NewReader(htmlStr))
	var sb strings.Builder
	skip := 0 // depth inside a script/style/etc. subtree — text is dropped
	for {
		switch z.Next() {
		case html.ErrorToken:
			return strings.Join(strings.Fields(sb.String()), " ")
		case html.TextToken:
			if skip == 0 {
				sb.Write(z.Text())
			}
		case html.StartTagToken:
			name, _ := z.TagName()
			n := string(name)
			if skipTags[n] {
				skip++
			} else if skip == 0 && blockTags[n] {
				sb.WriteByte(' ')
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			n := string(name)
			if skipTags[n] {
				if skip > 0 {
					skip--
				}
			} else if skip == 0 && blockTags[n] {
				sb.WriteByte(' ')
			}
		case html.SelfClosingTagToken:
			name, _ := z.TagName()
			if skip == 0 && blockTags[string(name)] {
				sb.WriteByte(' ')
			}
		}
	}
}

// FirstImage returns the first usable image URL embedded in a block of
// (already-sanitized) HTML — a card-thumbnail fallback when the feed ships no
// media thumbnail. A non-absolute src is unresolvable and a data: blob is an
// inline pixel; both are skipped.
func FirstImage(htmlStr string) *string {
	z := html.NewTokenizer(strings.NewReader(htmlStr))
	for {
		switch z.Next() {
		case html.ErrorToken:
			return nil
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			if string(name) != "img" {
				continue
			}
			for hasAttr {
				var k, v []byte
				k, v, hasAttr = z.TagAttr()
				if string(k) == "src" {
					src := strings.TrimSpace(string(v))
					if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
						return &src
					}
				}
			}
		}
	}
}

// EscapeHTML escapes the five characters that can break out of element-text or
// attribute-value context (& < > " ').
func EscapeHTML(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&#39;",
	)
	return r.Replace(s)
}
