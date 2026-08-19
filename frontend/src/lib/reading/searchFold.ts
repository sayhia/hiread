/** Fold a search needle or haystack so FTS hits can be found in the DOM.
 *  The index is case-insensitive and collapses whitespace; landing used to
 *  do a raw indexOf and miss mixed case and wrapped lines. */
export function foldSearch(s: string): string {
  return decodeEntities(s).toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

/** Map a folded-string index back onto the original string. */
export function foldIndexMap(raw: string): { folded: string; toRaw: number[] } {
  const folded: string[] = [];
  const toRaw: number[] = [];
  let space = true;
  const lower = decodeEntities(raw).toLocaleLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    const isSpace = /\s/.test(ch);
    if (isSpace) {
      if (!space) {
        folded.push(" ");
        toRaw.push(i);
      }
      space = true;
      continue;
    }
    folded.push(ch);
    toRaw.push(i);
    space = false;
  }
  return { folded: folded.join("").replace(/ +$/, ""), toRaw };
}

/** First raw index of `needle` in `raw`, after folding. Tries shorter
 *  prefixes the way the reader already did with indexOf. */
export function findFolded(raw: string, needle: string): number {
  const n = foldSearch(needle);
  if (n.length < 2) return -1;
  const { folded, toRaw } = foldIndexMap(raw);
  let at = folded.indexOf(n);
  if (at < 0 && n.length > 16) at = folded.indexOf(n.slice(0, 32));
  if (at < 0 && n.length > 8) at = folded.indexOf(n.slice(0, 16));
  if (at < 0) return -1;
  return toRaw[at] ?? -1;
}
