// Vertical (古籍) typography helpers.

/** Runs of 2–4 digits, alone in their text — a year, a page number, an age.
 *  Five or more digits are too wide to compress into one cell and stay
 *  legible, and a single digit has nothing to combine. */
const DIGIT_RUN = /(?<![0-9０-９])(?:[0-9]{2,4}|[０-９]{2,4})(?![0-9０-９])/g;

/** A measure — 12cm, 3%, ４ｋｇ is too rare to chase — stands as one cell
 *  with its unit, the way a year does. Applied before the bare digit pass
 *  so the digits are not wrapped on their own and the unit left behind. */
const MEASURE_RUN = /(?<![0-9０-９])(?:[0-9]{1,4}|[０-９]{1,4})(?:cm|mm|km|kg|px|em|％|%)(?![A-Za-z0-9０-９％%])/gi;

/** A closed range of small numbers — 12〜15, １２～１５ — one cell, not
 *  two years with a dash stacked between them. Applied before the digit
 *  pass so the ends are not wrapped on their own. */
const RANGE_RUN = /(?<![0-9０-９])(?:[0-9]{1,2}|[０-９]{1,2})[〜～~](?:[0-9]{1,2}|[０-９]{1,2})(?![0-9０-９])/g;

/** A Japanese era year — 令和6, 平成31 — even a single digit, which the
 *  bare digit pass would leave standing on its own. */
const ERA_DIGIT = /(?<=(?:令和|平成|昭和|大正|明治))[0-9０-９]{1,2}(?![0-9０-９])/g;

/** A date particle's digit — 3月, 4日; 12年 is already a digit run, a
 *  lone 3 before 月 is not. */
const DATE_DIGIT = /(?<![0-9０-９])[0-9０-９](?=[年月日号])/g;

/** Short Latin runs that a column should stand as one cell — OK, CD, TV,
 *  and the same in fullwidth (ＯＫ) — not a word (four+ letters) and not
 *  a single letter. */
const LATIN_RUN = /(?<![A-Za-zＡ-Ｚａ-ｚ])(?:[A-Za-z]{2,3}|[Ａ-Ｚａ-ｚ]{2,3})(?![A-Za-zＡ-Ｚａ-ｚ])/g;

/** Unicode roman numerals that a 古籍 column otherwise stacks as one
 *  glyph per stroke — Ⅱ–Ⅻ. Ⅰ is a single cell already. */
const ROMAN_RUN = /[ⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]/g;

/** Circled and parenthesized numerals that a column otherwise stacks as
 *  a ring plus a digit. */
const CIRCLED_RUN = /[①-⑳❶-❿⑴-⒇⒈-⒛㊀-㊉㈠-㈩⓪]/g;

/** Doubled or mixed bangs and questions — ！！, ？？, !?, ……, ‼ — read
 *  as one cell the way a year does, not two glyphs stacked in the column. */
const PUNCT_RUN = /……|‼|⁉|⁈|⁇|[！!]{2,3}|[？?]{2,3}|[!！][?？]|[?？][!！]/g;

/** An already-wrapped 纵中横 cell, even with extra classes or attributes.
 *  It must not be wrapped again: the pass is applied every time a chapter
 *  is laid out, so a run that came in wrapped has to stay exactly as it was. */
const WRAPPED_CELL = /<span\b[^>]*\bclass=(["'])(?:(?!\1).)*\btcy\b(?:(?!\1).)*\1[^>]*>[\s\S]*?<\/span>/g;

/** A numeric character reference — `&#8212;`, `&#x2014;`. Its digits are a
 *  run, but they are the *name* of a character, not text to combine. */
const NUMERIC_ENTITY = /&#\d+;|&#x[0-9a-fA-F]+;/g;

/** Wrap runs of 2–4 digits (ASCII or fullwidth) and short Latin tokens
 *  (OK, CD) with `text-combine-upright: all` (纵中横), so a vertical
 *  column reads them as one horizontal cell. Only bare text is touched:
 *  tags and their attributes are never entered, a numeric character
 *  reference is shielded, and a run already wrapped in a `.tcy` cell is
 *  left exactly as it was. */
export function tateChuYoko(html: string): string {
  const shielded: string[] = [];
  // Index encoded as a private-use glyph so a later digit/latin pass
  // cannot read the placeholder itself as a run (`\u000012\u0000` is
  // the year 12).
  const hide = (s: string) => {
    shielded.push(s);
    return `\u0000${String.fromCharCode(0xe000 + shielded.length - 1)}\u0000`;
  };
  const wrap = (d: string) => hide(`<span class="tcy">${d}</span>`);
  const protectedHtml = html
    .replace(WRAPPED_CELL, hide)
    .replace(NUMERIC_ENTITY, hide);
  const wrapped = protectedHtml
    .split(/(<[^>]+>)/)
    .map((part, i) =>
      i % 2 === 0
        ? part
            .replace(MEASURE_RUN, wrap)
            .replace(RANGE_RUN, wrap)
            .replace(ERA_DIGIT, wrap)
            .replace(DATE_DIGIT, wrap)
            .replace(DIGIT_RUN, wrap)
            .replace(LATIN_RUN, wrap)
            .replace(ROMAN_RUN, wrap)
            .replace(CIRCLED_RUN, wrap)
            .replace(PUNCT_RUN, wrap)
        : part,
    )
    .join("");
  return wrapped.replace(/\u0000([\ue000-\uf8ff])\u0000/g, (_m, ch: string) =>
    shielded[ch.charCodeAt(0) - 0xe000],
  );
}
