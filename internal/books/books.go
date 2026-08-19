// Package books parses local book files into one uniform in-memory shape the
// rest of hiread works with: a Book carrying metadata, an ordered slice of
// Chapters (HTML plus a plain-text render), a cover and the embedded resources
// chapters reference.
//
// Four container formats are supported, each in its own file:
//
//   - epub.go  — EPUB 2 and 3 (zip + OPF spine, nav document or NCX for the TOC)
//   - text.go  — plain text and Markdown, including GBK/Big5 decoding and
//     heuristic chapter splitting for the way Chinese TXT books are written
//   - mobi.go  — MOBI / AZW / AZW3, i.e. PalmDB records with PalmDOC-LZ77 or
//     HUFF/CDIC compressed markup
//   - pdf.go   — PDF, whose pages are rendered by pdf.js in the frontend, so
//     here we only sniff the page count and the /Info dictionary
//
// Parsers never touch the database or the network: they take bytes and return a
// Book. Persisting it (and sanitizing the chapter HTML) is db.ImportBook's job.
package books

import (
	"bytes"
	"fmt"
	"path/filepath"
	"strings"
)

// Format is a supported book container format.
type Format = string

const (
	FormatEPUB Format = "epub"
	FormatMOBI Format = "mobi"
	FormatPDF  Format = "pdf"
	FormatTXT  Format = "txt"
	FormatMD   Format = "md"
)

// Metadata is what a parser can learn about a book without reading its body.
// Every field is best-effort: formats disagree on what they carry, and plain
// text carries nothing at all, so callers fall back to the file name.
type Metadata struct {
	Title       string
	Author      string
	Language    string
	Publisher   string
	Description string
	// Identifier is the ISBN / UUID / ASIN the file claims, used to spot a
	// re-import of a book already in the library.
	Identifier string
	// Published is a free-form date string exactly as the file spells it;
	// normalizing the dozen shapes publishers use is not worth the loss.
	Published string
}

// Chapter is one readable unit — an EPUB spine item, a heading-delimited slice
// of a text file, or a pagebreak-delimited slice of MOBI markup.
type Chapter struct {
	// Index is the chapter's 0-based position in reading order.
	Index int
	Title string
	// HTML is the chapter body, not yet sanitized. Empty for PDF, whose pages
	// are rendered client-side from the original file.
	HTML string
	// Text is the plain-text render of HTML: what full-text search indexes and
	// what the reader measures progress against.
	Text string
	// Href is the chapter's path inside the container (EPUB spine item), used
	// to resolve intra-book links. Empty for formats without one.
	Href string
	// Level is the chapter's TOC depth, 0 for a top-level entry.
	Level int
}

// Resource is an asset a chapter references — an image, and for EPUB also the
// stylesheet and fonts the book ships. Stored alongside the book so reading
// works offline and survives the source file being moved or deleted.
type Resource struct {
	// Path is the resource's normalized path inside the container. Chapter HTML
	// references it through a data-res attribute carrying exactly this string.
	Path string
	Mime string
	Data []byte
}

// Book is a fully parsed book, ready to be written to the library.
type Book struct {
	Format   Format
	Metadata Metadata
	Chapters []Chapter
	// Cover is the cover image if the file carries one. PDF covers are rendered
	// by the frontend after import, so a PDF arrives here without one.
	Cover *Resource
	// Resources are the assets chapters reference, keyed by Resource.Path.
	Resources []Resource
	// PageCount is set for PDF only; other formats measure progress in
	// characters, not pages.
	PageCount int
}

// WordCount is the total plain-text length across chapters, in runes. The
// reader turns it into a reading-time estimate.
func (b *Book) WordCount() int {
	n := 0
	for i := range b.Chapters {
		n += len([]rune(b.Chapters[i].Text))
	}
	return n
}

// DetectFormat identifies a book file from its magic bytes, falling back to the
// file extension for the two formats that have no magic (text and Markdown).
// head should hold at least the first 68 bytes; a shorter slice simply narrows
// what can be detected.
func DetectFormat(name string, head []byte) (Format, bool) {
	switch {
	case bytes.HasPrefix(head, []byte("%PDF-")):
		return FormatPDF, true
	// A PalmDB database names its type and creator at offset 60. BOOKMOBI is
	// MOBI/AZW/AZW3; TEXtREAd is the older PalmDOC ebook, which the same reader
	// handles.
	case len(head) >= 68 && (bytes.Equal(head[60:68], []byte("BOOKMOBI")) || bytes.Equal(head[60:68], []byte("TEXtREAd"))):
		return FormatMOBI, true
	// EPUB is a zip whose first entry must be an uncompressed "mimetype" file;
	// checking the zip magic plus that entry name avoids claiming every zip.
	case bytes.HasPrefix(head, []byte("PK\x03\x04")):
		if bytes.Contains(head, []byte("mimetype")) || strings.EqualFold(filepath.Ext(name), ".epub") {
			return FormatEPUB, true
		}
		return "", false
	}

	switch strings.ToLower(filepath.Ext(name)) {
	case ".md", ".markdown":
		return FormatMD, true
	case ".txt", ".text":
		return FormatTXT, true
	case ".epub":
		return FormatEPUB, true
	case ".mobi", ".azw", ".azw3", ".prc":
		return FormatMOBI, true
	case ".pdf":
		return FormatPDF, true
	}
	return "", false
}

// Extensions lists the file extensions the library accepts, for the import
// dialog's file filter.
func Extensions() []string {
	return []string{"epub", "mobi", "azw", "azw3", "prc", "pdf", "txt", "text", "md", "markdown"}
}

// Parse turns a book file's bytes into a Book. name is the original file name,
// used both to pick a parser when the bytes carry no magic and as the title of
// last resort.
func Parse(name string, data []byte) (*Book, error) {
	head := data
	if len(head) > 1024 {
		head = head[:1024]
	}
	format, ok := DetectFormat(name, head)
	if !ok {
		return nil, fmt.Errorf("unrecognized book format: %s", filepath.Base(name))
	}

	var (
		b   *Book
		err error
	)
	switch format {
	case FormatEPUB:
		b, err = parseEPUB(data)
	case FormatMOBI:
		b, err = parseMOBI(data)
	case FormatPDF:
		b, err = parsePDF(data)
	case FormatMD:
		b, err = parseMarkdown(data)
	default:
		b, err = parseText(data)
	}
	if err != nil {
		return nil, err
	}

	b.Format = format
	if strings.TrimSpace(b.Metadata.Title) == "" {
		b.Metadata.Title = titleFromFilename(name)
	}
	for i := range b.Chapters {
		b.Chapters[i].Index = i
		if strings.TrimSpace(b.Chapters[i].Title) == "" {
			b.Chapters[i].Title = fallbackChapterTitle(b.Chapters[i], i)
		}
	}
	return b, nil
}

// titleFromFilename derives a book title from a file name: drop the extension,
// then the bracketed "[author]" and "(publisher)" noise that download sites add.
func titleFromFilename(name string) string {
	base := filepath.Base(name)
	base = strings.TrimSuffix(base, filepath.Ext(base))
	base = strings.NewReplacer("_", " ", ".", " ").Replace(base)
	return strings.TrimSpace(collapseSpaces(base))
}

// fallbackChapterTitle names an untitled chapter after its opening words, so a
// TOC of "Chapter 12" entries stays useful for books that ship no headings.
func fallbackChapterTitle(c Chapter, index int) string {
	head := strings.TrimSpace(c.Text)
	if head == "" {
		return fmt.Sprintf("%d", index+1)
	}
	r := []rune(collapseSpaces(head))
	if len(r) > 24 {
		r = r[:24]
		return strings.TrimSpace(string(r)) + "…"
	}
	return string(r)
}

// collapseSpaces squeezes every run of whitespace (including the ideographic
// space common in CJK text files) down to one ASCII space.
func collapseSpaces(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	space := false
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '　' || r == ' ' {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}
