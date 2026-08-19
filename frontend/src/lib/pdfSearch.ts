// Finding a passage in a PDF.
//
// A PDF's pages are drawing instructions, so nothing about them reaches the
// library's full-text index — searching a four-hundred-page file was simply
// not possible. pdf.js can hand back the text behind each page, and this is
// what turns that into hits: which page, and enough of the line around the
// match to recognise it.
//
// Kept apart from the component so the matching, the context window and the
// escaping are testable without a PDF or a canvas.

/** One run of text as pdf.js hands it over. */
export interface TextItem {
  str?: string;
  /** True on the item that ends a line. */
  hasEOL?: boolean;
}

/** Han, Kana and Hangul — scripts that set solid, with no spaces between
 *  words and none introduced by a line break. */
const WIDE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** Join the runs behind a page into its text.
 *
 *  The join at a line end is the whole question. In English a line break is a
 *  word boundary — run the lines together and "the" and "quick" become one
 *  word that matches neither. In Chinese it is not a boundary at all, and a
 *  break inserted there splits a phrase that was never split, so a search for
 *  it stops matching. So the boundary is only marked when the characters
 *  either side of it are not both from a script that sets solid.
 *
 *  Within a line the runs are joined as they come: their own trailing spaces
 *  are what separate the ones that need separating.
 */
export function joinTextItems(items: readonly TextItem[]): string {
  let out = "";
  for (let i = 0; i < items.length; i++) {
    const str = items[i].str ?? "";
    out += str;
    if (!items[i].hasEOL) continue;
    const before = out.slice(-1);
    let after = "";
    for (let j = i + 1; j < items.length && !after; j++) after = (items[j].str ?? "").slice(0, 1);
    if (!after) break;
    if (!(WIDE.test(before) && WIDE.test(after))) out += "\n";
  }
  return out;
}

export interface PageHit {
  /** 1-based. */
  page: number;
  /** The passage, with the match wrapped in <mark> and everything escaped. */
  snippet: string;
}

/** Characters either side of a match. Enough to recognise the sentence; a CJK
 *  line carries a lot in thirty characters. */
const CONTEXT = 30;
/** Hits from any one page, so a word that appears forty times on a title page
 *  does not fill the list. */
const PER_PAGE = 3;

const escapeHTML = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Search page texts for a query, newest page order preserved.
 *
 *  Matching is case-insensitive and literal — no word boundaries, because the
 *  books this is for are Chinese and have none. The text comes from the file,
 *  so every piece of the snippet is escaped before the <mark> goes in.
 */
export function findInPages(pages: readonly string[], query: string, limit = 40): PageHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const out: PageHit[] = [];

  for (let i = 0; i < pages.length && out.length < limit; i++) {
    const text = pages[i] ?? "";
    const hay = text.toLowerCase();
    let from = 0;
    for (let n = 0; n < PER_PAGE && out.length < limit; n++) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      const start = Math.max(0, at - CONTEXT);
      const end = Math.min(text.length, at + needle.length + CONTEXT);
      const lead = (start > 0 ? "…" : "") + escapeHTML(text.slice(start, at));
      const hit = escapeHTML(text.slice(at, at + needle.length));
      const tail = escapeHTML(text.slice(at + needle.length, end)) + (end < text.length ? "…" : "");
      out.push({ page: i + 1, snippet: `${lead}<mark>${hit}</mark>${tail}` });
      from = at + needle.length;
    }
  }
  return out;
}
