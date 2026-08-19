// Turning a PDF's pages back into prose.
//
// A page gives up its text as positioned runs: where each one was drawn, and
// how tall. That is enough to read but not enough to *reflow* — for that the
// runs have to be put back into lines, and the lines back into paragraphs,
// which the file itself does not record. What follows infers it from the
// geometry, which is what a reader's eye does too:
//
//   - a line that starts further right than the rest begins a paragraph
//     (Chinese sets the indent at two characters, English at one em);
//   - a line that stops well short of the right margin ended one;
//   - a gap taller than the usual line spacing is a break;
//   - a line set noticeably larger than the body is a heading;
//   - a line alone in the top or bottom margin, repeating page after page or
//     saying nothing but a number, is a running head and not prose at all.
//
// None of this is certain. It is a reading of a layout, and a layout can lie —
// which is why it is offered as a second view of a PDF rather than the only
// one.

export interface TextRun {
  str?: string;
  /** [scaleX, skewY, skewX, scaleY, x, y] in PDF user space, y upwards. */
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

export interface Line {
  text: string;
  /** Left edge, in page units. */
  x: number;
  /** Right edge. */
  right: number;
  /** Baseline, measured up from the foot of the page. */
  y: number;
  /** Type size. */
  size: number;
  page: number;
}

export interface Block {
  kind: "heading" | "para";
  text: string;
  /** The page the block starts on, so the text view can say where it is. */
  page: number;
}

/** Put a page's runs back into lines. */
export function linesFromRuns(runs: readonly TextRun[], page: number): Line[] {
  const out: Line[] = [];
  let text = "";
  let x = 0;
  let right = 0;
  let y = 0;
  let size = 0;
  let started = false;

  const flush = () => {
    if (started && text.trim()) out.push({ text: text.trim(), x, right, y, size, page });
    text = "";
    started = false;
  };

  for (const run of runs) {
    const str = run.str ?? "";
    const t = run.transform ?? [0, 0, 0, 0, 0, 0];
    if (!started && str.trim()) {
      x = t[4];
      y = t[5];
      size = Math.abs(t[3]) || run.height || 0;
      started = true;
    }
    if (started) right = Math.max(right, t[4] + (run.width ?? 0));
    text += str;
    if (run.hasEOL) flush();
  }
  flush();
  return out;
}

/** Where the body sets, from where its lines begin.
 *
 *  A page of prose has two common starting points and no others worth
 *  counting: the margin, where a continuing line begins, and the margin plus
 *  an indent, where a paragraph does. Which of the two is more common depends
 *  on how long the paragraphs are — in a book of dialogue most lines are first
 *  lines — so the margin is the *smaller* of the two, not the more frequent.
 *
 *  Taking the leftmost instead does not work either: a stray element hanging
 *  into the margin then makes every line look indented, and every line becomes
 *  its own paragraph. (Measured: it turned 2,700 paragraphs into 6,400.)
 */
function bodyMargin(xs: number[]): number {
  const counts = new Map<number, number>();
  for (const x of xs) {
    const k = Math.round(x);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const common = [...counts.entries()]
    // A share of the lines, not a count: on a real page the two that matter
    // are far above this, and on a handful of lines nothing should be excluded
    // for being rare.
    .filter(([, n]) => n >= xs.length * 0.08)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([x]) => x);
  return common.length ? Math.min(...common) : mode(xs);
}

/** The most common value in a list, to the nearest unit. */
function mode(values: number[]): number {
  const counts = new Map<number, number>();
  let best = values[0] ?? 0;
  let bestN = 0;
  for (const v of values) {
    const k = Math.round(v);
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Lines that are furniture rather than prose: running heads, folios. */
function isFurniture(line: Line, repeats: Map<string, number>, pages: number): boolean {
  const t = line.text.trim();
  if (!t) return true;
  // A page number, with or without decoration.
  if (/^[-—\s·]*\d{1,4}[-—\s·]*$/.test(t)) return true;
  // The same short line on many pages is a running head.
  if (t.length <= 40 && pages >= 3 && (repeats.get(t) ?? 0) >= Math.max(3, pages * 0.4)) return true;
  return false;
}

export interface ReflowOptions {
  /** How far right of the body margin counts as an indent, in units of the
   *  body type size. Two characters is the Chinese convention. */
  indent?: number;
  /** How far short of the right margin ends a paragraph, likewise. */
  short?: number;
  /** A gap this much larger than the usual line spacing is a break. */
  gap?: number;
  /** Type this much larger than the body is a heading. */
  headingScale?: number;
}

/** Put lines back into paragraphs. Lines arrive in reading order, and may span
 *  several pages — a paragraph broken by a page break is one paragraph. */
export function blocksFromLines(lines: readonly Line[], opts: ReflowOptions = {}): Block[] {
  const indentBy = opts.indent ?? 1.2;
  const shortBy = opts.short ?? 2;
  const gapBy = opts.gap ?? 1.5;
  const headingScale = opts.headingScale ?? 1.18;
  if (!lines.length) return [];

  const bodySize = median(lines.map((l) => l.size).filter(Boolean)) || 1;
  const bodyLeft = bodyMargin(lines.map((l) => l.x));
  const bodyRight = mode(lines.map((l) => l.right));

  const repeats = new Map<string, number>();
  for (const l of lines) repeats.set(l.text, (repeats.get(l.text) ?? 0) + 1);
  const pages = new Set(lines.map((l) => l.page)).size;

  // The usual line spacing is whatever most consecutive lines are apart —
  // the most common gap, not the middle one, which a handful of paragraph
  // breaks would drag upwards.
  const gaps = lines
    .slice(1)
    .map((l, i) => (l.page === lines[i].page ? lines[i].y - l.y : NaN))
    .filter((v) => Number.isFinite(v) && v > 0);
  const spacing = (gaps.length ? mode(gaps) : 0) || bodySize * 1.5;

  const blocks: Block[] = [];
  let cur: Block | null = null;
  let prev: Line | null = null;

  for (const line of lines) {
    if (isFurniture(line, repeats, pages)) continue;

    const heading = line.size > bodySize * headingScale;
    const indented = line.x > bodyLeft + bodySize * indentBy;
    const prevEndedShort = prev != null && prev.right < bodyRight - bodySize * shortBy;
    const jumped =
      prev != null && prev.page === line.page && prev.y - line.y > spacing * gapBy;
    const startsBlock =
      cur == null || heading || cur.kind === "heading" || indented || prevEndedShort || jumped;

    if (startsBlock || cur == null) {
      cur = { kind: heading ? "heading" : "para", text: line.text, page: line.page };
      blocks.push(cur);
    } else {
      // Inside a paragraph a line break is not a word boundary in Chinese and
      // is one in English — the same rule the search join uses.
      const a = cur.text.slice(-1);
      const b = line.text.slice(0, 1);
      cur.text += wide(a) && wide(b) ? line.text : ` ${line.text}`;
    }
    prev = line;
  }
  return blocks;
}

const WIDE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
const wide = (c: string) => WIDE.test(c);
