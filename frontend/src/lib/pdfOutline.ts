// A PDF's own table of contents.
//
// Most books-as-PDF carry one, and it is the only contents such a book will
// ever have — there are no chapters to extract from pages that are drawing
// instructions. The shape pdf.js hands back is a tree whose destinations are
// references into the file rather than page numbers, so each has to be
// resolved; this flattens the tree into the list a drawer can show.

export interface PdfOutlineEntry {
  title: string;
  /** Nesting depth, 0 for a top-level entry. */
  level: number;
  /** 1-based page. */
  page: number;
}

/** One node of what pdf.js returns from getOutline(). */
export interface PdfOutlineNode {
  title?: string;
  dest?: unknown;
  items?: PdfOutlineNode[];
}

/** How deep the outline is followed. A few PDFs nest every paragraph; past
 *  this the list stops being a way to get around and starts being the book. */
const MAX_DEPTH = 3;

/** Flatten an outline tree, resolving each destination to a page.
 *
 *  `resolvePage` returns 0 for a destination it cannot resolve — a broken
 *  reference, or one into a file that has been re-saved. Those entries are
 *  dropped: an entry that goes to an arbitrary page is worse than one that is
 *  not there, because it costs the reader their place to find out.
 */
export async function flattenPdfOutline(
  tree: PdfOutlineNode[] | null | undefined,
  resolvePage: (dest: unknown) => Promise<number>,
): Promise<PdfOutlineEntry[]> {
  const out: PdfOutlineEntry[] = [];
  const walk = async (nodes: PdfOutlineNode[], level: number) => {
    for (const node of nodes) {
      const title = String(node.title ?? "").trim();
      const page = title ? await resolvePage(node.dest) : 0;
      if (title && page > 0) out.push({ title, level, page });
      if (node.items?.length && level + 1 < MAX_DEPTH) {
        await walk(node.items, level + 1);
      }
    }
  };
  await walk(tree ?? [], 0);
  return out;
}
