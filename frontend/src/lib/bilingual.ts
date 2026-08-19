// Pairing a chapter with its translation for the side-by-side view.
//
// The backend translates block by block and hands the blocks back in the order
// it took them, so the two can be zipped by position. Splitting the original
// once and interleaving on each streaming batch keeps a long chapter's markup
// from being re-parsed for every batch that arrives.

/** Generic wrappers that carry no readable text — mirrors translate.go's
 *  unwrapTags, so the blocks split here line up with the backend's batches. */
const UNWRAP_TAGS = new Set(["DIV", "ARTICLE", "SECTION", "MAIN"]);

/** Split body HTML into its top-level blocks, unwrapping a lone generic
 *  container first (the "whole chapter inside one <div>" shape a converted EPUB
 *  often has) so the blocks pair up with the translation's. DOMParser documents
 *  are inert — nothing in them loads or runs. */
export function topLevelBlocks(html: string): string[] {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  let root: Element = doc.body;
  for (;;) {
    const kids = Array.from(root.children);
    if (kids.length === 1 && UNWRAP_TAGS.has(kids[0].tagName)) {
      root = kids[0];
      continue;
    }
    break;
  }
  return Array.from(root.children).map((el) => el.outerHTML);
}

/** Interleave original and translated blocks, each original followed by its
 *  translation. Blocks pair by index; an unpaired tail — which is most of the
 *  chapter while a translation is still streaming — shows the original alone,
 *  so the page fills in from the top rather than appearing all at once. */
export function interleaveBlocks(original: string[], translated: string[]): string {
  const n = Math.max(original.length, translated.length);
  let out = "";
  for (let i = 0; i < n; i++) {
    out += '<div class="bi-pair">';
    if (original[i]) out += `<div class="bi-src">${original[i]}</div>`;
    if (translated[i]) out += `<div class="bi-tr">${translated[i]}</div>`;
    out += "</div>";
  }
  return out;
}
