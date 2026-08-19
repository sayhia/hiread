package books

import (
	"bytes"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/gogs/chardet"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/htmlindex"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"

	"hiread/internal/sanitize"
)

// maxAutoChapterRunes is how long a synthesized chapter grows before the
// splitter cuts at the next paragraph boundary. Books with no headings at all
// still need to be divided into something the reader can page through and
// remember a position in; ~3000 characters is a comfortable few screens in
// either Chinese or English.
const maxAutoChapterRunes = 3000

// headingPatterns match a line that opens a chapter. The Chinese forms come
// first because they are what most .txt books in the wild use: a bare
// "第十二章 落雪" line with no blank line around it.
var headingPatterns = []*regexp.Regexp{
	// 第N章/节/回/卷/篇/部/集/话 — N in Arabic, full-width or Chinese numerals.
	regexp.MustCompile(`^\s{0,8}第\s*[0-9０-９一二三四五六七八九十百千万零两]{1,12}\s*[章节節回卷篇部集话話幕](\s|$|[:：、.．·　-])`),
	// Structural sections that carry no number.
	regexp.MustCompile(`^\s{0,8}(序章|序言|自序|楔子|前言|引子|导言|導言|后记|後記|跋|尾声|尾聲|番外|附录|附錄)(\s|$|[:：、.．·　-])`),
	// Chapter 12 / Part IV / Book Two.
	regexp.MustCompile(`(?i)^\s{0,8}(chapter|part|book|section)\s+([0-9]{1,4}|[ivxlcdm]{1,8}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b`),
	// A lone "12." or "12、" on its own line, as numbered essay collections use.
	regexp.MustCompile(`^\s{0,8}[0-9]{1,3}\s*[、.．]\s*\S`),
}

// parseText turns a plain-text book into chapters. The bytes are decoded to
// UTF-8 first: Chinese .txt books are overwhelmingly GB18030 or Big5, and
// reading one as UTF-8 yields a screen of replacement characters.
func parseText(data []byte) (*Book, error) {
	text := decodeText(data)
	lines := strings.Split(text, "\n")

	cuts, titles := textChapterCuts(lines)
	var chapters []Chapter
	if len(cuts) >= 2 {
		for i, start := range cuts {
			end := len(lines)
			if i+1 < len(cuts) {
				end = cuts[i+1]
			}
			chapters = append(chapters, textChapter(titles[i], lines[start:end]))
		}
	} else {
		chapters = splitFixed(lines)
	}

	b := &Book{Chapters: chapters}
	b.Metadata = textMetadata(lines)

	// Drop the leading fragment when it holds nothing worth reading: a file that
	// opens directly on a chapter heading leaves an empty one, and a download
	// site's "书名：… 作者：…" header is already in the metadata by now. Either
	// would otherwise show up as a junk first chapter.
	if len(chapters) > 1 && isFrontMatter(chapters[0].Text) {
		chapters = chapters[1:]
		b.Chapters = chapters
	}
	if len(chapters) == 0 {
		b.Chapters = []Chapter{{Title: "", HTML: "", Text: ""}}
	}
	return b, nil
}

// frontMatterLine matches the header lines download sites prepend to a .txt
// book, whose content textMetadata has already lifted into the book's title and
// author.
var frontMatterLine = regexp.MustCompile(`^\s*(书名|書名|作者|Title|Author|title|author)\s*[:：]`)

// isFrontMatter reports whether a leading fragment is only a header block (or
// nothing at all), rather than the opening of the book itself.
func isFrontMatter(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return true
	}
	// A long fragment is prose, however it starts.
	if utf8.RuneCountInString(trimmed) > 80 {
		return false
	}
	for _, ln := range strings.Split(trimmed, "\n") {
		if strings.TrimSpace(ln) == "" {
			continue
		}
		if !frontMatterLine.MatchString(ln) {
			return false
		}
	}
	return true
}

// parseMarkdown renders Markdown to HTML, splitting the source at its top two
// heading levels so the document's own structure becomes the table of contents.
func parseMarkdown(data []byte) (*Book, error) {
	src := decodeText(data)
	md := goldmark.New(goldmark.WithExtensions(extension.GFM))

	render := func(s string) (string, error) {
		var buf bytes.Buffer
		if err := md.Convert([]byte(s), &buf); err != nil {
			return "", err
		}
		return strings.TrimSpace(buf.String()), nil
	}

	var chapters []Chapter
	for _, sec := range splitMarkdownSections(src) {
		html, err := render(sec.body)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(html) == "" {
			continue
		}
		chapters = append(chapters, Chapter{
			Title: sec.title,
			HTML:  html,
			Text:  sanitize.HTMLToText(html),
			Level: sec.level,
		})
	}
	if len(chapters) == 0 {
		return nil, nil
	}

	b := &Book{Chapters: chapters}
	// A document whose first heading is a lone H1 is titled by it, and that
	// heading then belongs to the book rather than to chapter one.
	if len(chapters) > 1 && chapters[0].Level == 0 && strings.TrimSpace(chapters[0].Text) == chapters[0].Title {
		b.Metadata.Title = chapters[0].Title
		b.Chapters = chapters[1:]
	} else if chapters[0].Level == 0 {
		b.Metadata.Title = chapters[0].Title
	}
	return b, nil
}

type mdSection struct {
	title string
	level int
	body  string
}

// splitMarkdownSections cuts a Markdown document at its H1 and H2 headings,
// stepping over fenced code blocks so a "# comment" inside a shell snippet does
// not open a chapter.
func splitMarkdownSections(src string) []mdSection {
	lines := strings.Split(src, "\n")
	var (
		out    []mdSection
		cur    = mdSection{}
		body   []string
		fenced bool
		fence  string
	)
	flush := func() {
		cur.body = strings.TrimSpace(strings.Join(body, "\n"))
		if cur.body != "" || cur.title != "" {
			out = append(out, cur)
		}
		body = nil
	}
	for _, ln := range lines {
		trimmed := strings.TrimSpace(ln)
		if fenced {
			if strings.HasPrefix(trimmed, fence) {
				fenced = false
			}
			body = append(body, ln)
			continue
		}
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			fenced = true
			fence = trimmed[:3]
			body = append(body, ln)
			continue
		}
		level := 0
		switch {
		case strings.HasPrefix(ln, "# "):
			level = 0
		case strings.HasPrefix(ln, "## "):
			level = 1
		default:
			body = append(body, ln)
			continue
		}
		flush()
		cur = mdSection{title: strings.TrimSpace(strings.TrimLeft(ln, "# ")), level: level}
		body = append(body, ln)
	}
	flush()
	return out
}

// textChapterCuts returns the line indexes where chapters start, plus the
// heading text for each. A heading line must be short — a paragraph that
// happens to open with "第一章讲的是…" is prose, not a heading.
func textChapterCuts(lines []string) ([]int, []string) {
	var cuts []int
	var titles []string
	// Everything before the first heading is front matter and becomes its own
	// leading chapter, so the text is never silently dropped.
	cuts = append(cuts, 0)
	titles = append(titles, "")
	for i, ln := range lines {
		if i == 0 {
			continue
		}
		t := strings.TrimSpace(ln)
		if t == "" || utf8.RuneCountInString(t) > 40 {
			continue
		}
		for _, re := range headingPatterns {
			if re.MatchString(t) {
				cuts = append(cuts, i)
				titles = append(titles, collapseSpaces(t))
				break
			}
		}
	}
	return cuts, titles
}

// textChapter builds one chapter from a run of lines: blank-line-separated
// runs become paragraphs, and a single-line-per-paragraph file (the usual CJK
// shape) yields one paragraph per line.
func textChapter(title string, lines []string) Chapter {
	var (
		html strings.Builder
		text strings.Builder
		para []string
	)
	flush := func() {
		if len(para) == 0 {
			return
		}
		joined := strings.TrimSpace(strings.Join(para, ""))
		para = nil
		if joined == "" {
			return
		}
		html.WriteString("<p>" + sanitize.EscapeHTML(joined) + "</p>\n")
		text.WriteString(joined + "\n")
	}

	// A titled chapter opens with its heading line. It is emitted on its own —
	// a heading rarely ends in punctuation, so leaving it to the paragraph
	// logic below would glue it onto the first sentence of the chapter.
	headingPending := title != ""
	for _, ln := range lines {
		t := strings.TrimRight(ln, "\r")
		trimmed := strings.TrimSpace(t)
		if headingPending && trimmed != "" {
			headingPending = false
			if collapseSpaces(trimmed) == title {
				html.WriteString("<h2>" + sanitize.EscapeHTML(trimmed) + "</h2>\n")
				text.WriteString(trimmed + "\n")
				continue
			}
		}
		if trimmed == "" {
			flush()
			continue
		}
		para = append(para, trimmed)
		// A hard-wrapped Western paragraph continues across lines; a CJK line
		// that already ends in a full stop does not.
		if endsParagraph(t) {
			flush()
		}
	}
	flush()
	return Chapter{Title: title, HTML: strings.TrimSpace(html.String()), Text: strings.TrimSpace(text.String())}
}

// endsParagraph reports whether a line ends on terminal punctuation, meaning
// the next line starts a new paragraph rather than continuing this one.
func endsParagraph(line string) bool {
	t := strings.TrimRight(line, " \t\r　")
	if t == "" {
		return true
	}
	r, _ := utf8.DecodeLastRuneInString(t)
	switch r {
	case '。', '！', '？', '”', '」', '』', '…', '.', '!', '?', '"', '\'', ':', '：':
		return true
	}
	return false
}

// splitFixed divides a heading-less book into readable chunks at paragraph
// boundaries, so progress and navigation still work.
func splitFixed(lines []string) []Chapter {
	var (
		out   []Chapter
		buf   []string
		runes int
	)
	flush := func() {
		if len(buf) == 0 {
			return
		}
		c := textChapter("", buf)
		if strings.TrimSpace(c.Text) != "" {
			out = append(out, c)
		}
		buf, runes = nil, 0
	}
	for _, ln := range lines {
		buf = append(buf, ln)
		runes += utf8.RuneCountInString(ln)
		if runes >= maxAutoChapterRunes && strings.TrimSpace(ln) == "" {
			flush()
		}
	}
	flush()
	return out
}

// textMetadata scrapes a title and author out of the header lines download
// sites prepend to .txt books ("书名：…" / "作者：…").
func textMetadata(lines []string) Metadata {
	var m Metadata
	limit := 12
	if len(lines) < limit {
		limit = len(lines)
	}
	for _, ln := range lines[:limit] {
		t := strings.TrimSpace(ln)
		switch {
		case m.Title == "":
			for _, p := range []string{"书名：", "書名：", "书名:", "Title:", "title:"} {
				if strings.HasPrefix(t, p) {
					m.Title = strings.TrimSpace(strings.TrimPrefix(t, p))
				}
			}
		}
		for _, p := range []string{"作者：", "作者:", "Author:", "author:"} {
			if strings.HasPrefix(t, p) && m.Author == "" {
				m.Author = strings.TrimSpace(strings.TrimPrefix(t, p))
			}
		}
	}
	return m
}

// decodeText converts a text file's bytes to UTF-8, honouring a BOM when there
// is one and falling back to statistical charset detection (which is what
// catches the GB18030 and Big5 files no BOM announces).
func decodeText(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}):
		data = data[3:]
	case bytes.HasPrefix(data, []byte{0xFF, 0xFE}), bytes.HasPrefix(data, []byte{0xFE, 0xFF}):
		dec := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder()
		if out, _, err := transform.Bytes(dec, data); err == nil {
			return normalizeNewlines(string(out))
		}
	}
	if utf8.Valid(data) {
		return normalizeNewlines(string(data))
	}
	if enc := detectEncoding(data); enc != nil {
		if out, _, err := transform.Bytes(enc.NewDecoder(), data); err == nil {
			return normalizeNewlines(string(out))
		}
	}
	// Nothing decoded cleanly; keep the bytes rather than lose the book, with
	// invalid sequences replaced so the JSON round-trip to the frontend holds.
	return normalizeNewlines(strings.ToValidUTF8(string(data), "�"))
}

func detectEncoding(data []byte) encoding.Encoding {
	res, err := chardet.NewTextDetector().DetectBest(data)
	if err != nil || res == nil {
		return nil
	}
	enc, err := htmlindex.Get(res.Charset)
	if err != nil {
		return nil
	}
	return enc
}

func normalizeNewlines(s string) string {
	if !strings.ContainsRune(s, '\r') {
		return s
	}
	return strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(s)
}
