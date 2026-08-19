package db

import (
	"strings"

	"hiread/internal/models"
)

// mdEscape escapes the minimal set of Markdown special characters that, in
// inline/blockquote position, would otherwise change rendering: backslash,
// backtick, asterisk, underscore, hash, and the link brackets. We don't touch
// '<' or '&' — most renderers treat blockquote content as plain text.
var mdEscaper = strings.NewReplacer(
	`\`, `\\`,
	"`", "\\`",
	`*`, `\*`,
	`_`, `\_`,
	`#`, `\#`,
	`[`, `\[`,
	`]`, `\]`,
)

// mdInline escapes a string for use inside a single Markdown line (heading,
// paragraph, blockquote line). Newlines are preserved literally — the
// caller decides how to format them (blockquote re-prefixes each line with `> `).
func mdInline(s string) string {
	return mdEscaper.Replace(s)
}

// BuildHighlightsMarkdown renders a list of highlights — already in the order
// they should appear in the export — as a single Markdown document grouped by
// book and, inside a book, by chapter. The exportDate is injected (rather than
// read from the clock) so the function stays pure and deterministically
// testable.
//
// Format:
//
//	# Highlights — exported <date>
//
//	## Book title
//	*Author*
//
//	### Chapter title
//
//	> highlight quote
//
//	*optional note*
//
//	---
//
//	> next quote in the same chapter
//
//	### Next chapter
//	...
func BuildHighlightsMarkdown(rows []models.HighlightWithContext, exportDate string) string {
	var b strings.Builder
	b.WriteString("# Highlights — exported ")
	b.WriteString(exportDate)
	b.WriteString("\n\n")

	if len(rows) == 0 {
		b.WriteString("*No highlights yet.*\n")
		return b.String()
	}

	// Walk in input order; emit a header whenever the book or chapter changes.
	var (
		prevBook    int64 = -1
		prevChapter int64 = -1
	)
	for _, r := range rows {
		switch {
		case r.BookID != prevBook:
			if prevBook != -1 {
				b.WriteString("\n")
			}
			writeBookHeader(&b, r)
			writeChapterHeader(&b, r)
		case r.ChapterIndex != prevChapter:
			b.WriteString("\n")
			writeChapterHeader(&b, r)
		default:
			// Separator between highlights inside the same chapter block.
			b.WriteString("\n---\n\n")
		}
		prevBook, prevChapter = r.BookID, r.ChapterIndex

		writeQuote(&b, r.Quote)
		if note := strings.TrimSpace(r.Note); note != "" {
			b.WriteString("\n*")
			b.WriteString(mdInline(note))
			b.WriteString("*\n")
		}
	}
	return b.String()
}

func writeBookHeader(b *strings.Builder, r models.HighlightWithContext) {
	b.WriteString("## ")
	b.WriteString(mdInline(r.BookTitle))
	b.WriteString("\n")
	if r.BookAuthor != nil && strings.TrimSpace(*r.BookAuthor) != "" {
		b.WriteString("*")
		b.WriteString(mdInline(*r.BookAuthor))
		b.WriteString("*\n")
	}
}

// writeChapterHeader emits the chapter heading. A book whose chapters are
// untitled (a flat text file, a PDF) has nothing worth printing, so the
// highlights sit directly under the book heading instead.
func writeChapterHeader(b *strings.Builder, r models.HighlightWithContext) {
	if title := strings.TrimSpace(r.ChapterTitle); title != "" {
		b.WriteString("\n### ")
		b.WriteString(mdInline(title))
		b.WriteString("\n")
	}
	b.WriteString("\n")
}

func writeQuote(b *strings.Builder, quote string) {
	// Escape, then re-prefix each line with "> " so multi-line quotes
	// stay inside the blockquote.
	esc := mdInline(quote)
	for i, line := range strings.Split(esc, "\n") {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString("> ")
		b.WriteString(line)
	}
	b.WriteString("\n")
}
