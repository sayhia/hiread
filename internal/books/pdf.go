package books

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// PDF is the one format hiread does not render itself. Its pages are drawing
// instructions, not a document tree, so reflowing them into the reader's
// typography is not possible and re-implementing a rasterizer in Go is not
// worth it — pdf.js renders the pages in the frontend, from the original file
// bytes kept alongside the book.
//
// So parsePDF's job is small: confirm the file is a PDF, and pull out enough
// metadata for the library grid to show something better than a file name
// before the reader has ever opened it. Whatever it misses, the frontend
// corrects on first open, where pdf.js has the whole document parsed anyway.

var (
	pdfPageRe   = regexp.MustCompile(`/Type\s*/Page[^s]`)
	pdfCountRe  = regexp.MustCompile(`/Count\s+(\d+)`)
	pdfTitleRe  = regexp.MustCompile(`/Title\s*(\(([^\\)]|\\.)*\)|<[0-9A-Fa-f\s]*>)`)
	pdfAuthorRe = regexp.MustCompile(`/Author\s*(\(([^\\)]|\\.)*\)|<[0-9A-Fa-f\s]*>)`)
)

func parsePDF(data []byte) (*Book, error) {
	if !bytes.HasPrefix(data, []byte("%PDF-")) {
		return nil, fmt.Errorf("pdf: missing %%PDF header")
	}
	b := &Book{PageCount: pdfPageCount(data)}
	if m := pdfTitleRe.FindSubmatch(data); m != nil {
		b.Metadata.Title = collapseSpaces(decodePDFString(m[1]))
	}
	if m := pdfAuthorRe.FindSubmatch(data); m != nil {
		b.Metadata.Author = collapseSpaces(decodePDFString(m[1]))
	}
	return b, nil
}

// pdfPageCount counts page objects, then falls back to the page tree's /Count.
// Both readings only work on uncompressed cross-reference sections; a PDF 1.5+
// file with object streams reports 0 here and is corrected by pdf.js on open.
func pdfPageCount(data []byte) int {
	if n := len(pdfPageRe.FindAll(data, -1)); n > 0 {
		return n
	}
	best := 0
	for _, m := range pdfCountRe.FindAllSubmatch(data, -1) {
		if n, err := strconv.Atoi(string(m[1])); err == nil && n > best {
			best = n
		}
	}
	return best
}

// decodePDFString decodes either PDF string syntax: a literal (Hello) with
// backslash escapes, or a hex <48656C6C6F>. Both may hold UTF-16BE text
// introduced by a byte-order mark, which is how non-ASCII titles are stored.
func decodePDFString(raw []byte) string {
	s := string(raw)
	var out []byte
	switch {
	case strings.HasPrefix(s, "<"):
		clean := strings.Map(func(r rune) rune {
			if r == '<' || r == '>' || r == ' ' || r == '\n' || r == '\r' || r == '\t' {
				return -1
			}
			return r
		}, s)
		if len(clean)%2 == 1 {
			clean += "0"
		}
		decoded, err := hex.DecodeString(clean)
		if err != nil {
			return ""
		}
		out = decoded
	case strings.HasPrefix(s, "("):
		body := strings.TrimSuffix(strings.TrimPrefix(s, "("), ")")
		out = unescapePDFLiteral(body)
	default:
		return ""
	}

	if len(out) >= 2 && out[0] == 0xFE && out[1] == 0xFF {
		u16 := make([]uint16, 0, (len(out)-2)/2)
		for i := 2; i+1 < len(out); i += 2 {
			u16 = append(u16, uint16(out[i])<<8|uint16(out[i+1]))
		}
		return string(utf16.Decode(u16))
	}
	// Otherwise PDFDocEncoding, which agrees with Latin-1 over the range
	// metadata actually uses.
	r := make([]rune, 0, len(out))
	for _, c := range out {
		r = append(r, rune(c))
	}
	return string(r)
}

func unescapePDFLiteral(s string) []byte {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+1 >= len(s) {
			out = append(out, s[i])
			continue
		}
		i++
		switch s[i] {
		case 'n':
			out = append(out, '\n')
		case 'r':
			out = append(out, '\r')
		case 't':
			out = append(out, '\t')
		case 'b':
			out = append(out, '\b')
		case 'f':
			out = append(out, '\f')
		default:
			// \ddd octal, or an escaped literal character.
			if s[i] >= '0' && s[i] <= '7' {
				val, n := 0, 0
				for n < 3 && i < len(s) && s[i] >= '0' && s[i] <= '7' {
					val = val*8 + int(s[i]-'0')
					i++
					n++
				}
				i--
				out = append(out, byte(val))
				continue
			}
			out = append(out, s[i])
		}
	}
	return out
}
