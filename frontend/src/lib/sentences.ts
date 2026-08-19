// Splitting a chapter into what gets read aloud.
//
// Speech is synthesised one sentence at a time rather than a chapter at a
// time, so that the reader can be shown where the voice is, can stop between
// sentences rather than at the end, and can start from what is on screen. That
// makes the split a real piece of logic: where a sentence ends, and what to do
// with prose that never says.

export interface Sentence {
  /** Character offsets into the chapter's plain text. */
  start: number;
  end: number;
  text: string;
}

/** What ends a sentence. The CJK marks are full-width and unambiguous; the
 *  Latin ones only count when something follows that could begin a new one. */
const TERMINATORS = "。．！？；!?;…";
/** Punctuation that belongs to the sentence it follows — a closing quote after
 *  a full stop is the end of the same sentence, not the start of the next. */
const TRAILERS = `」』”’"')）］》〉】`;
/** Words whose full stop is part of the word. Not a complete list of English
 *  abbreviations — it does not need to be. Getting one wrong costs a pause in
 *  the middle of a sentence, not a word, and this covers the ones that turn up
 *  in a book's prose. Initials ("J. R. R.") are handled by length. */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "vs", "etc", "eg", "ie",
  "no", "fig", "vol", "ch", "pp", "ed", "cf", "al",
]);

/** Where a sentence with no end of its own may be broken instead. */
const SOFT_BREAKS = "，、,:：—";

/** A sentence longer than this is broken at the nearest comma, and failing
 *  that, outright. A voice given a whole page as one utterance cannot be
 *  stopped part-way through it, and the highlight would cover the screen. */
const MAX_LEN = 120;
/** Below this a fragment is joined to what follows rather than spoken alone —
 *  a lone bracket or a stray character is not a sentence. */
const MIN_LEN = 2;

/** Split a chapter's plain text into sentences, in order, with their offsets. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;

  const push = (from: number, to: number) => {
    const slice = text.slice(from, to);
    const lead = slice.length - slice.trimStart().length;
    const body = slice.trim();
    if (!body) return;
    // Join a fragment too short to be a sentence onto the one before it.
    const prev = out[out.length - 1];
    if (body.length < MIN_LEN && prev) {
      prev.end = from + lead + body.length;
      prev.text = text.slice(prev.start, prev.end);
      return;
    }
    out.push({ start: from + lead, end: from + lead + body.length, text: body });
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isEnd =
      TERMINATORS.includes(ch) ||
      // A Latin full stop ends a sentence only before a space or the end of
      // the text — inside "3.5" it does not — and not when it belongs to the
      // word in front of it.
      (ch === "." && (i + 1 >= text.length || /\s/.test(text[i + 1])) && !endsAbbreviation(text, i));
    if (!isEnd && ch !== "\n") continue;

    let end = i + 1;
    while (end < text.length && TRAILERS.includes(text[end])) end++;
    push(start, end);
    start = end;
  }
  push(start, text.length);

  return out.flatMap(breakLongSentence);
}

/** Whether the full stop at `at` belongs to the word before it. */
function endsAbbreviation(text: string, at: number): boolean {
  let from = at;
  while (from > 0 && /[A-Za-z]/.test(text[from - 1])) from--;
  const word = text.slice(from, at);
  // A single letter is an initial — "J. R. R. Tolkien" is one name.
  return word.length === 1 || ABBREVIATIONS.has(word.toLowerCase());
}

/** Break a sentence that never ends into pieces a voice can be stopped
 *  between, preferring a comma to a hard cut. */
function breakLongSentence(s: Sentence): Sentence[] {
  if (s.text.length <= MAX_LEN) return [s];
  const parts: Sentence[] = [];
  let from = 0;
  while (s.text.length - from > MAX_LEN) {
    let cut = -1;
    for (let i = Math.min(from + MAX_LEN, s.text.length) - 1; i > from + MAX_LEN / 3; i--) {
      if (SOFT_BREAKS.includes(s.text[i])) {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) cut = from + MAX_LEN;
    parts.push({ start: s.start + from, end: s.start + cut, text: s.text.slice(from, cut) });
    from = cut;
  }
  if (from < s.text.length) {
    parts.push({ start: s.start + from, end: s.end, text: s.text.slice(from) });
  }
  return parts;
}

/** The sentence a character offset falls in — how reading aloud starts from
 *  what the reader is looking at rather than from the top of the chapter. */
export function sentenceAt(sentences: readonly Sentence[], offset: number): number {
  for (let i = 0; i < sentences.length; i++) {
    if (offset < sentences[i].end) return i;
  }
  return Math.max(0, sentences.length - 1);
}
