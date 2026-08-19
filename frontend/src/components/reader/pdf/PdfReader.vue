<script lang="ts">
// Module scope (a <script setup> block re-runs per instance, so a cache must
// live here): the PDF's bytes travel as base64 over the bridge and are decoded
// byte by byte — on a multi-megabyte file that is the slow part of opening.
// Keep the last book's bytes so closing and reopening it (the common loop
// while consulting a reference) skips the round-trip entirely; the next book
// replaces them.
export let pdfBytesCache: { bookId: number; bytes: Uint8Array } | null = null;
</script>

<script setup lang="ts">
// PDF rendering, via pdf.js bundled with the app (no CDN — hiread reads
// offline). A PDF's pages are drawing instructions rather than text, so they
// cannot be reflowed into the reader's typography the way every other format
// is; they are rasterized to canvases at the device pixel ratio and scrolled.
//
// This component is also where a PDF's metadata comes from. The Go importer can
// only sniff what an uncompressed cross-reference section exposes, so on first
// open pdf.js reports the real page count and /Info dictionary, and renders
// page one as the cover — all of which is sent back to the library.

import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import * as api from "../../../api";
import { useUi } from "../../../stores/ui";
import type { BookDetail, Highlight } from "../../../types";
import { flattenPdfOutline, type PdfOutlineEntry } from "../../../lib/pdfOutline";
import { findInPages, joinTextItems, type PageHit } from "../../../lib/pdfSearch";
import { toneFor, tonePixels } from "../../../lib/pdfPaper";
import { blocksFromLines, linesFromRuns, type Block, type Line } from "../../../lib/pdfText";
import { cropBox, inkOfPage, type Box, type PageInk } from "../../../lib/pdfCrop";
import { metrics, scrollTo, stepFor } from "../../../lib/reading/position";
import { captureContext } from "../../../lib/anchor";
import { highlightBg } from "../../../lib/highlightColors";
import { swallowPageClick } from "../../../composables/reader/useTextReaderInput";
import { reportError, withUndo } from "../../../stores/toasts";
import { Browser } from "@wailsio/runtime";
import Icon from "../../Icon.vue";
import HighlightPopover from "../../HighlightPopover.vue";

// pdf.js ships its worker as a separate module; Vite's ?url import gives a
// bundled, local URL for it.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const props = defineProps<{ book: BookDetail }>();
const emit = defineEmits<{
  (e: "toast", text: string): void;
  /** The page the reader has reached, so the text view can open where they
   *  left off — the two views agree by page and nothing else. */
  (e: "page", page: number): void;
  /** The document's own outline, once it is known — a PDF that carries one has
   *  a table of contents as good as any EPUB's, and it is the only contents it
   *  will ever have. */
  (e: "outline", entries: PdfOutlineEntry[]): void;
  /** The file is open and its pages exist. The text view can extract now;
   *  calling earlier used to cache an empty extraction forever. */
  (e: "ready"): void;
  /** Space/arrows past the last page — honour markFinishedAtEnd. */
  (e: "end"): void;
}>();



const { t, locale } = useI18n();
const ui = useUi();
const qc = useQueryClient();

// The same minute-tick the text status line uses: a reader glancing down
// wants the time, not a digit changing every second.
const now = ref("");
let clock: number | undefined;
function tickClock() {
  now.value = new Date().toLocaleTimeString(locale.value, { hour: "2-digit", minute: "2-digit" });
  clock = window.setTimeout(tickClock, 60_000 - (Date.now() % 60_000));
}
watch(
  () => [ui.readerShowClock, locale.value] as const,
  ([on]) => {
    window.clearTimeout(clock);
    clock = undefined;
    if (on) tickClock();
    else now.value = "";
  },
  { immediate: true },
);

const scrollRef = ref<HTMLDivElement>();
const pagesRef = ref<HTMLDivElement>();
const loading = ref(true);
const failed = ref(false);
const pageCount = ref(props.book.pageCount);
const currentPage = ref(props.book.progress.page || 1);
/** Page scale, persisted per session rather than per book: a reader who zooms
 *  in usually wants that for every PDF they open next. */
const zoomStored = sessionStorage.getItem("pdfZoom");
const zoom = ref(Number(zoomStored) || 1);
/** True while zoom is "whatever fits the window". ± zoom clears it so a
 *  resize (or a trim) does not fight a size the reader chose. */
let fitted = !zoomStored;

// ── trimming the margins ─────────────────────────────────────────────────
// A book laid out for paper carries margins for thumbs and binding; on screen
// they are half the page. Trimming them is measured from the text's own
// geometry rather than by scanning pixels, and one box is used for the whole
// book — a chapter opening whose text stops halfway down would otherwise be
// trimmed to its own ink and its type would jump.
const cropped = ref(localStorage.getItem(`pdfCrop.${props.book.id}`) === "1");
const crop = ref<Box | null>(null);

/** Work out the box from a spread of pages. Cheap: it is the text's geometry,
 *  which costs a getTextContent each and no rendering at all. */
async function measureCrop(): Promise<Box | null> {
  const pdf = doc.value;
  if (!pdf) return null;
  const total = pdf.numPages;
  const sample = Math.min(total, 24);
  const inks: PageInk[] = [];
  let width = 0;
  let height = 0;
  for (let i = 0; i < sample; i++) {
    const n = 1 + Math.floor(((i + 0.5) * total) / sample);
    try {
      const page = await pdf.getPage(Math.min(total, n));
      const vp = page.getViewport({ scale: 1 });
      width = vp.width;
      height = vp.height;
      const ink = inkOfPage(linesFromRuns((await page.getTextContent()).items, n), n);
      if (ink) inks.push(ink);
    } catch {
      /* a page that will not give up its text says nothing about the margins */
    }
  }
  return width && height ? cropBox(inks, width, height) : null;
}

async function setCropped(on: boolean) {
  cropped.value = on;
  localStorage.setItem(`pdfCrop.${props.book.id}`, on ? "1" : "0");
  if (on && !crop.value) crop.value = await measureCrop();
  const at = currentPage.value;
  await layoutPages();
  scrollToPage(at);
  if (fitted) await fitWidth();
}

/** The viewport a page is drawn through: the whole sheet, or the box the book
 *  is trimmed to. */
function pageViewport(page: any) {
  const vp = page.getViewport({ scale: zoom.value });
  const box = cropped.value ? crop.value : null;
  if (!box) return vp;
  // offsetX/offsetY shift the drawing; the canvas is then sized to the box, so
  // what falls outside it is simply never drawn.
  return page.getViewport({
    scale: zoom.value,
    offsetX: -box.x * zoom.value,
    offsetY: -(vp.height / zoom.value - box.y - box.height) * zoom.value,
  });
}

/** How big a trimmed page is on screen. */
function pageSize(page: any) {
  const vp = page.getViewport({ scale: zoom.value });
  const box = cropped.value ? crop.value : null;
  return box
    ? { width: box.width * zoom.value, height: box.height * zoom.value }
    : { width: vp.width, height: vp.height };
}

const doc = shallowRef<any>(null);
let renderToken = 0;
let saveTimer: number | undefined;
let resolveReady = () => {};
const whenReady = new Promise<void>((r) => {
  resolveReady = r;
});

async function load() {
  loading.value = true;
  failed.value = false;
  try {
    let bytes = pdfBytesCache?.bookId === props.book.id ? pdfBytesCache.bytes : null;
    if (!bytes) {
      bytes = await api.sourceBytes(props.book.id);
      if (!bytes.length) throw new Error("empty pdf");
      pdfBytesCache = { bookId: props.book.id, bytes };
    }
    doc.value = await pdfjs.getDocument({ data: bytes }).promise;
    pageCount.value = doc.value.numPages;
    // A book left trimmed opens trimmed. The box is not saved with the
    // preference — it belongs to the file, and measuring it costs a
    // getTextContent on two dozen pages — but it has to exist before the pages
    // are laid out, or they are laid out at the untrimmed size.
    if (cropped.value) crop.value = await measureCrop();
    await layoutPages();
    if (!zoomStored) await fitWidth();
    await backfillMetadata();
    void loadOutline();
    void indexText();
    // Restore the saved page after the pages exist to scroll to. Prefer
    // currentPage so a search jump that already called goToPage is not
    // overwritten by the book's last progress.
    scrollToPage(currentPage.value || props.book.progress.page || 1);
    emit("ready");
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
    resolveReady();
  }
}

// Pages are laid out first and drawn only as they come into view. A 500-page
// PDF at one full-resolution canvas per page is gigabytes of pixels, so each
// page starts as an empty box of the right size and gets its canvas when the
// reader approaches it — and gives it back when they leave. The boxes never
// resize, so the scrollbar stays honest and the page never jumps under the
// cursor.

/** How far outside the viewport a page is still worth drawing, so scrolling
 *  lands on a painted page rather than a blank one. */
const RENDER_MARGIN = "150% 0px";

let observer: IntersectionObserver | null = null;
/** In-flight renders, so a page scrolled past mid-draw can be cancelled. */
const inFlight = new Map<number, { cancel: () => void }>();

/** Cached page boxes, refreshed when the page list is rebuilt. onScroll uses
 *  them with a binary search instead of re-querying and reading every box's
 *  offsetTop on each scroll event (500 pages × every frame was the old cost). */
let pageEls: HTMLElement[] = [];
function refreshPageEls() {
  const host = pagesRef.value;
  pageEls = host ? Array.from(host.querySelectorAll<HTMLElement>(".pdf-page[data-page]")) : [];
}

/** Lay out an empty box per page at the current zoom. */
async function layoutPages() {
  const host = pagesRef.value;
  const pdf = doc.value;
  if (!host || !pdf) return;
  const token = ++renderToken;

  observer?.disconnect();
  inFlight.forEach((task) => task.cancel());
  inFlight.clear();
  // The boxes below are being rebuilt. Without clearing the cached list, a
  // scroll landing in this async window would binary-search the old (now
  // detached) boxes — offsetTop 0 throughout — and land on the last page.
  // An empty list degrades to page 1, like reading the live DOM used to.
  pageEls = [];
  host.replaceChildren();

  // getPage is a round-trip to the worker. Asking for pages one at a time
  // serializes a 500-page document into 500 waits; batching them cuts the
  // layout to a handful of round-trips. The pages are still appended in order
  // and the token is re-checked after each batch, so a cancelled relayout
  // (zoom, paper change) stops exactly where it did before.
  const BATCH = 32;
  for (let start = 1; start <= pdf.numPages; start += BATCH) {
    if (token !== renderToken) return;
    const end = Math.min(pdf.numPages + 1, start + BATCH);
    const pages = await Promise.all(
      Array.from({ length: end - start }, (_, i) => pdf.getPage(start + i)),
    );
    if (token !== renderToken) return;
    for (let i = 0; i < pages.length; i++) {
      const n = start + i;
      const size = pageSize(pages[i]);
      const box = document.createElement("div");
      box.className = "pdf-page";
      box.dataset.page = String(n);
      box.style.width = `${Math.floor(size.width)}px`;
      box.style.height = `${Math.floor(size.height)}px`;
      // The text layer's font sizes are written in the page's own units and
      // scaled through this; it is the one thing pdf.js expects the host to set.
      box.style.setProperty("--total-scale-factor", String(zoom.value));
      host.appendChild(box);
    }
  }
  refreshPageEls();

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const box = entry.target as HTMLElement;
        if (entry.isIntersecting) void drawPage(box, token);
        else releasePage(box);
      }
    },
    { root: scrollRef.value, rootMargin: RENDER_MARGIN },
  );
  for (const box of Array.from(host.children)) observer.observe(box);
}

/** Draw one page into its box, unless it is already drawn or being drawn. */
async function drawPage(box: HTMLElement, token: number) {
  const pdf = doc.value;
  const n = Number(box.dataset.page);
  if (!pdf || !n || box.querySelector("canvas") || inFlight.has(n)) return;

  const page = await pdf.getPage(n);
  if (token !== renderToken) return;
  const viewport = pageViewport(page);
  const size = pageSize(page);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const canvas = document.createElement("canvas");
  // Back the canvas at device resolution and scale it down in CSS, so a page is
  // sharp on a retina display; the transform maps the PDF's own units onto
  // those extra pixels.
  canvas.width = Math.floor(size.width * dpr);
  canvas.height = Math.floor(size.height * dpr);
  canvas.style.width = `${Math.floor(size.width)}px`;
  canvas.style.height = `${Math.floor(size.height)}px`;

  // Hand pdf.js the canvas rather than a context of our own: it then makes an
  // opaque one itself. A context from getContext("2d") carries an alpha
  // channel, which leaves everything the page does not paint transparent — the
  // reader's dark background would show through the paper.
  const task = page.render({
    canvas,
    viewport,
    transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
  });
  inFlight.set(n, task);
  try {
    await task.promise;
    if (token !== renderToken || box.querySelector("canvas")) return;
    tonePage(canvas);
    box.appendChild(canvas);
    await drawTextLayer(box, page, viewport, token);
    if (token !== renderToken) return;
    await drawAnnotLayer(box, page, viewport, token);
    paintPageMarks(box);
  } catch {
    // A cancelled render is the normal outcome of scrolling quickly.
  } finally {
    inFlight.delete(n);
  }
}

/** Put the page on the reader's paper.
 *
 *  Every other format is rendered into hiread's own surface, so the page
 *  colour setting is the page; a PDF's paper is baked into the picture, and a
 *  dark reading surface left a white rectangle burning in the middle of it.
 *  The re-toning is a single pass over the pixels, done before the canvas goes
 *  into the document so the page never appears in the wrong colour first.
 */
function tonePage(canvas: HTMLCanvasElement) {
  const tone = toneFor(ui.readerPaper, ui.resolvedTheme === "dark", ui.readerPaperCustom);
  if (tone === "none") return;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  try {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    tonePixels(image.data, tone);
    ctx.putImageData(image, 0, 0);
  } catch {
    // A canvas the browser will not let us read back is left as printed.
  }
}

/** Lay the page's own text over its picture, invisibly.
 *
 *  A rendered page is pixels: without this there is nothing to select, nothing
 *  to copy, and nothing for a highlight to attach to — which is why the marks
 *  tab existed for PDFs with no way to make a mark. pdf.js positions each run
 *  where it was drawn; the spans are transparent, so what the reader sees is
 *  still the page.
 */
async function drawTextLayer(box: HTMLElement, page: any, viewport: any, token: number) {
  try {
    const content = await page.getTextContent();
    if (token !== renderToken || box.querySelector(".textLayer")) return;
    const layer = document.createElement("div");
    layer.className = "textLayer";
    box.appendChild(layer);
    await new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport }).render();
  } catch {
    // No text behind this page, or the render was cancelled: the picture is
    // still there, and it is the picture that is being read.
  }
}

function annotBox(viewport: { convertToViewportRectangle?: (r: number[]) => number[]; convertToViewportPoint: (x: number, y: number) => number[] }, rect: number[]) {
  let x1: number, y1: number, x2: number, y2: number;
  if (typeof viewport.convertToViewportRectangle === "function") {
    [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
  } else {
    const p1 = viewport.convertToViewportPoint(rect[0], rect[1]);
    const p2 = viewport.convertToViewportPoint(rect[2], rect[3]);
    x1 = p1[0]; y1 = p1[1]; x2 = p2[0]; y2 = p2[1];
  }
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  return { left, top, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/** Clickable PDF links (in-page dests and URIs) over the picture. */
async function drawAnnotLayer(box: HTMLElement, page: { getAnnotations: (o: { intent: string }) => Promise<any[]> }, viewport: any, token: number) {
  try {
    const annots = await page.getAnnotations({ intent: "display" });
    if (token !== renderToken || box.querySelector(".pdf-links")) return;
    const host = document.createElement("div");
    host.className = "pdf-links";
    for (const a of annots) {
      if (a.subtype !== "Link" && a.subtype !== "link") continue;
      const rect = Array.isArray(a.rect) ? a.rect : null;
      if (!rect || rect.length < 4) continue;
      const boxRect = annotBox(viewport, rect);
      if (boxRect.width < 2 || boxRect.height < 2) continue;
      const el = document.createElement("a");
      el.className = "pdf-link";
      el.href = a.url || "#";
      el.style.left = `${boxRect.left}px`;
      el.style.top = `${boxRect.top}px`;
      el.style.width = `${boxRect.width}px`;
      el.style.height = `${boxRect.height}px`;
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        swallowPageClick();
        if (a.url) {
          Browser.OpenURL(a.url).catch(() => {});
          return;
        }
        if (a.dest != null) {
          void destinationPage(a.dest).then((p) => {
            if (p > 0) goToPage(p);
          });
        }
      });
      host.appendChild(el);
    }
    if (host.childElementCount) box.appendChild(host);
  } catch {
    /* a page without annotations is the common case */
  }
}

function quoteRects(layer: HTMLElement, quote: string): DOMRect[] {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (needle.length < 2) return [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let acc = "";
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    nodes.push({ node: t, start: acc.length });
    acc += t.data;
  }
  let at = acc.indexOf(needle);
  let len = needle.length;
  if (at < 0) {
    const short = needle.slice(0, 24);
    if (short.length >= 2) at = acc.indexOf(short);
    len = Math.min(24, needle.length);
  }
  if (at < 0) return [];
  const end = Math.min(acc.length, at + len);
  const startNode = nodes.find((s, i) => at >= s.start && at < (nodes[i + 1]?.start ?? Infinity));
  const endAt = Math.max(at, end - 1);
  const endNode = nodes.find((s, i) => endAt >= s.start && endAt < (nodes[i + 1]?.start ?? Infinity));
  if (!startNode || !endNode) return [];
  const range = document.createRange();
  range.setStart(startNode.node, Math.min(startNode.node.data.length, at - startNode.start));
  range.setEnd(endNode.node, Math.min(endNode.node.data.length, end - endNode.start));
  return Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
}

function paintPageMarks(box: HTMLElement) {
  box.querySelector(".hl-overlay")?.remove();
  const layer = box.querySelector<HTMLElement>(".textLayer");
  if (!layer || !pageMarks.value.length) return;
  const overlay = document.createElement("div");
  overlay.className = "hl-overlay";
  const pageBox = box.getBoundingClientRect();
  for (const hl of pageMarks.value) {
    const rects = quoteRects(layer, hl.quote);
    if (!rects.length) continue;
    for (const r of rects) {
      const d = document.createElement("button");
      d.type = "button";
      d.className = "hl-pdf-mark";
      d.dataset.hl = String(hl.id);
      d.style.left = `${r.left - pageBox.left}px`;
      d.style.top = `${r.top - pageBox.top}px`;
      d.style.width = `${r.width}px`;
      d.style.height = `${r.height}px`;
      d.style.background = highlightBg(hl.color);
      d.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        swallowPageClick();
        pendingHl.value = {
          x: r.left,
          y: r.bottom + 8,
          quote: hl.quote,
          page: Number(box.dataset.page) || 0,
          prefix: hl.prefix,
          suffix: hl.suffix,
          existing: hl,
        };
      });
      overlay.appendChild(d);
    }
  }
  if (overlay.childElementCount) box.appendChild(overlay);
}

function paintVisibleMarks() {
  for (const box of pageEls) {
    if (box.querySelector(".textLayer")) paintPageMarks(box);
  }
}

function reloadMarks() {
  api
    .listBookHighlights(props.book.id)
    .then((rows) => {
      pageMarks.value = rows;
      paintVisibleMarks();
    })
    .catch(() => {
      pageMarks.value = [];
    });
}

/** Give a page's pixels back once it is well out of view. */
function releasePage(box: HTMLElement) {
  inFlight.get(Number(box.dataset.page))?.cancel();
  const canvas = box.querySelector("canvas");
  if (!canvas) return;
  // Zeroing the backing store is what actually frees the memory; removing the
  // element alone leaves it to the garbage collector's discretion.
  canvas.width = 0;
  canvas.height = 0;
  // Takes the text layer with it — it is only meaningful over the picture it
  // was measured against, and a page that is redrawn builds a fresh one.
  box.replaceChildren();
}

/** Send back what only a renderer can know, the first time this PDF is opened:
 *  the true page count, the /Info title and author, and page one as the cover. */
async function backfillMetadata() {
  const pdf = doc.value;
  if (!pdf) return;
  const needsCover = !props.book.hasCover;
  const needsCount = props.book.pageCount !== pdf.numPages;
  let title = "";
  let author = "";
  try {
    const meta = await pdf.getMetadata();
    title = String(meta?.info?.Title ?? "").trim();
    author = String(meta?.info?.Author ?? "").trim();
  } catch {
    // Metadata is optional; the file name already stands in for a title.
  }
  const needsMeta = (title && props.book.title === props.book.fileName) || (author && !props.book.author);
  if (!needsCover && !needsCount && !needsMeta) return;

  let cover: Uint8Array | null = null;
  if (needsCover) cover = await renderCover(pdf);
  try {
    await api.setPdfMetadata(props.book.id, pdf.numPages, title, author, cover, "image/png");
    qc.invalidateQueries({ queryKey: ["book", props.book.id] });
    qc.invalidateQueries({ queryKey: ["books"] });
  } catch {
    // A failed backfill only costs a plainer library card.
  }
}

/** Rasterize page one at cover size (~400px wide). */
async function renderCover(pdf: any): Promise<Uint8Array | null> {
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 400 / base.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

function scrollToPage(n: number) {
  const box = pagesRef.value?.querySelector<HTMLElement>(`.pdf-page[data-page="${n}"]`);
  box?.scrollIntoView({ block: "start" });
}

/** The page whose top edge is nearest the top of the viewport is "the page the
 *  reader is on" — what the position indicator shows and what is saved. Runs
 *  at most once per frame (rAF), and finds the page by binary search over the
 *  cached box list: a long PDF no longer costs a query + a layout read per box
 *  on every scroll event. */
let scrollRaf = 0;
function dismissHlPopover() {
  if (pendingHl.value) pendingHl.value = null;
}

function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const scroller = scrollRef.value;
    if (!scroller) return;
    const top = scroller.scrollTop;
    let lo = 0;
    let hi = pageEls.length - 1;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pageEls[mid].offsetTop - 40 <= top) {
        best = Number(pageEls[mid].dataset.page);
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    currentPage.value = best;
    emit("page", best);
  });
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    api.saveProgress(props.book.id, 0, 0, currentPage.value).catch(() => {});
  }, 600);
}

function setZoom(next: number) {
  fitted = false;
  zoom.value = Math.min(3, Math.max(0.5, Number(next.toFixed(2))));
}

/** Scale the widest page to the width of the window. What a reader reaches for
 *  first on a PDF whose pages are not the shape of the screen. */
async function fitWidth() {
  const pdf = doc.value;
  const scroller = scrollRef.value;
  if (!pdf || !scroller) return;
  fitted = true;
  const page = await pdf.getPage(currentPage.value);
  // Fit what will be shown: a trimmed page is narrower than the sheet.
  const natural = (cropped.value && crop.value ? crop.value.width : page.getViewport({ scale: 1 }).width);
  // The gutter the pages sit in, so fitting does not put them under the edge.
  const room = scroller.clientWidth - 48;
  if (!(natural > 0 && room > 0)) return;
  const next = Math.min(3, Math.max(0.5, Number((room / natural).toFixed(2))));
  if (next === zoom.value) return;
  zoom.value = next;
}

/** Space on a tall (zoomed) page first walks the rest of the sheet; the
 *  next page is only for when this one is already fully in view. */
function pageBy(dir: number) {
  const el = scrollRef.value;
  const d = dir < 0 ? -1 : 1;
  const n = currentPage.value || 1;
  const pageEl =
    pageEls.find((p) => Number(p.dataset.page) === n) ??
    pagesRef.value?.querySelector<HTMLElement>(`.pdf-page[data-page="${n}"]`);
  if (el && pageEl) {
    const view = el.getBoundingClientRect();
    const box = pageEl.getBoundingClientRect();
    const more = d > 0 ? box.bottom > view.bottom + 2 : box.top < view.top - 2;
    if (more) {
      const m = metrics(el, "y");
      scrollTo(el, "y", m.at + d * stepFor(m, "y", 24), true);
      return;
    }
  }
  const next = n + d;
  if (pageCount.value > 0 && (next > pageCount.value || next < 1)) {
    if (d > 0) emit("end");
    return;
  }
  goToPage(next);
}

function goToPage(n: number) {
  const raw = Math.round(n) || currentPage.value;
  if (!Number.isFinite(raw)) return;
  // A file whose library pageCount is still 0 must not clamp the jump to 1.
  const at = pageCount.value > 0 ? Math.min(pageCount.value, Math.max(1, raw)) : Math.max(1, raw);
  currentPage.value = at;
  emit("page", at);
  scrollToPage(at);
}

function flushSave() {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  if (currentPage.value > 0) {
    api.saveProgress(props.book.id, 0, 0, currentPage.value).catch(() => {});
  }
}

/** Read the document's own outline. The tree comes from pdf.js; turning it
 *  into a list, and deciding what to do with an entry that will not resolve,
 *  is in lib/pdfOutline. */
async function loadOutline() {
  const pdf = doc.value;
  if (!pdf) return;
  try {
    const entries = await flattenPdfOutline(await pdf.getOutline(), destinationPage);
    if (entries.length) emit("outline", entries);
  } catch {
    /* a malformed outline is no outline; the reader still has its pages */
  }
}

/** Resolve one destination to a 1-based page, or 0 if it cannot be followed. */
async function destinationPage(dest: unknown): Promise<number> {
  const pdf = doc.value;
  if (!pdf || dest == null) return 0;
  try {
    const resolved = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || !resolved.length) return 0;
    return (await pdf.getPageIndex(resolved[0])) + 1;
  } catch {
    return 0;
  }
}

/** The text behind the pages, pulled once and kept. Extracting it is the only
 *  slow part of searching a PDF — a few hundred pages take a moment — so it is
 *  done on the first search rather than on open, and never again. */
interface PageText {
  /** One string per page, for searching and for the library's index. */
  pages: string[];
  /** The same text as laid-out lines, for reading it back as prose. */
  lines: Line[];
}

let extracted: PageText | null = null;
let extracting: Promise<PageText> | null = null;

/** Pages read between yields when nobody is waiting. Four hundred pages take
 *  well under a second of work, but it is a second the reader would otherwise
 *  spend watching the first page fail to scroll. */
const YIELD_EVERY = 16;
const yieldToRender = () => new Promise((r) => setTimeout(r, 0));

/** Read the text behind every page.
 *
 *  `gentle` is for the pass nobody is waiting on — indexing — and gives the
 *  renderer the thread back regularly. A search asks for it outright, and gets
 *  it as fast as the document will give it up.
 */
function extractText(gentle = false): Promise<PageText> {
  if (extracted) return Promise.resolve(extracted);
  if (extracting) return extracting;
  extracting = (async () => {
    if (!doc.value) await whenReady;
    const pdf = doc.value;
    if (!pdf) {
      extracting = null;
      return { pages: [], lines: [] };
    }
    const pages: string[] = [];
    const lines: Line[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      try {
        const content = await pdf.getPage(n).then((pg: any) => pg.getTextContent());
        // The items are laid-out runs, not lines. How they are joined — and
        // what happens at a line end — decides whether a search finds
        // anything; see joinTextItems.
        pages.push(joinTextItems(content.items));
        lines.push(...linesFromRuns(content.items, n));
      } catch {
        pages.push("");
      }
      if (gentle && n % YIELD_EVERY === 0) await yieldToRender();
    }
    extracted = { pages, lines };
    return extracted;
  })();
  return extracting;
}

/** The book as prose: its pages read back into paragraphs. Both halves of the
 *  extraction come from one pass and the positioned runs are then thrown away
 *  — keeping the hundreds of thousands a book is made of, to do the other job
 *  later, is not worth the memory. */
async function readingBlocks(): Promise<Block[]> {
  return blocksFromLines((await extractText()).lines);
}

/** Read the text behind the pages once, and hand it to the library so a search
 *  there can find this book too. Runs in the background on first open: without
 *  it, searching the library for a phrase that is in this PDF finds nothing,
 *  which is indistinguishable from the phrase not being there. */
async function indexText() {
  try {
    if (await api.hasIndexedText(props.book.id)) return;
    // Nobody is waiting on this, and the reader is: start once the window has
    // nothing better to do, and hand the thread back as it goes.
    await whenIdle();
    const { pages } = await extractText(true);
    if (pages.some((p) => p.trim())) await api.indexPdfText(props.book.id, pages);
  } catch {
    /* the reader works without it; the search is what is missing */
  }
}

/** Resolve when the window is idle, or shortly, if it never is. */
function whenIdle(): Promise<void> {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: object) => number })
    .requestIdleCallback;
  return new Promise((resolve) => {
    if (ric) ric(() => resolve(), { timeout: 3000 });
    else setTimeout(resolve, 1200);
  });
}

/** Find a passage. Returns the page and the line around it. */
async function search(query: string, limit = 40): Promise<PageHit[]> {
  return findInPages((await extractText()).pages, query, limit);
}

const pageMarks = ref<Highlight[]>([]);
const pendingHl = ref<{
  x: number;
  y: number;
  quote: string;
  page: number;
  prefix: string;
  suffix: string;
  existing?: Highlight;
} | null>(null);

function onPageMouseUp(ev: MouseEvent) {
  if (ev.button !== 0) return;
  if ((ev.target as Element | null)?.closest?.(".hl-pdf-mark, .pdf-link")) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const quote = sel.toString().replace(/\s+/g, " ").trim();
  if (quote.length < 2) return;
  const node = sel.anchorNode;
  const host = node instanceof Element ? node : node?.parentElement;
  if (!host?.closest(".textLayer")) return;
  const range = sel.rangeCount ? sel.getRangeAt(0) : null;
  const rect = range?.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return;
  const pageEl = host.closest(".pdf-page") as HTMLElement | null;
  const page = Number(pageEl?.dataset.page ?? currentPage.value);
  const layer = host.closest(".textLayer") as HTMLElement;
  const text = layer?.textContent ?? "";
  const at = text.indexOf(quote);
  const ctx = at >= 0 ? captureContext(text, at, at + quote.length) : { prefix: "", suffix: "" };
  swallowPageClick();
  pendingHl.value = { x: rect.left, y: rect.bottom + 8, quote, page, prefix: ctx.prefix, suffix: ctx.suffix };
}

async function commitPageHighlight(color: string, note: string) {
  const cur = pendingHl.value;
  if (!cur || cur.existing) return;
  try {
    await api.createHighlight({
      bookId: props.book.id,
      chapterIndex: cur.page || 0,
      quote: cur.quote,
      prefix: cur.prefix,
      suffix: cur.suffix,
      textOffset: 0,
      color,
      note,
    });
    window.getSelection()?.removeAllRanges();
    qc.invalidateQueries({ queryKey: ["book-highlights", props.book.id] });
    qc.invalidateQueries({ queryKey: ["highlights"] });
    qc.invalidateQueries({ queryKey: ["libraryCounts"] });
    reloadMarks();
  } catch (e) {
    reportError(e);
  }
}

function deletePageHighlight(hl: Highlight) {
  withUndo({
    text: t("highlights.deleted"),
    apply: () => {
      pendingHl.value = null;
      reloadMarks();
    },
    commit: () => {
      api
        .deleteHighlight(hl.id)
        .catch(reportError)
        .finally(() => {
          qc.invalidateQueries({ queryKey: ["book-highlights", props.book.id] });
          qc.invalidateQueries({ queryKey: ["highlights"] });
          qc.invalidateQueries({ queryKey: ["libraryCounts"] });
          reloadMarks();
        });
    },
    revert: () => reloadMarks(),
  });
}

defineExpose({ goToPage, pageBy, fitWidth, setZoom, zoom, currentPage, pageCount, search, readingBlocks, cropped, setCropped });

// The reading surface can change while a book is open, and the pages already
// drawn carry the old one baked in — they are redrawn rather than left behind.
watch(
  () => [ui.readerPaper, ui.resolvedTheme, ui.readerPaperCustom],
  async () => {
    const at = currentPage.value;
    await layoutPages();
    scrollToPage(at);
  },
);

watch(zoom, async (z) => {
  sessionStorage.setItem("pdfZoom", String(z));
  const at = currentPage.value;
  await layoutPages();
  scrollToPage(at);
});

let sizeWatch: ResizeObserver | null = null;
let resizeTimer: number | undefined;
function scheduleFit() {
  if (!fitted || loading.value) return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (fitted) void fitWidth();
  }, 120);
}

onMounted(() => {
  window.addEventListener("resize", scheduleFit);
  if (typeof ResizeObserver === "function" && scrollRef.value) {
    sizeWatch = new ResizeObserver(() => scheduleFit());
    sizeWatch.observe(scrollRef.value);
  }
  void load();
  reloadMarks();
});
onBeforeUnmount(() => {
  renderToken++;
  cancelAnimationFrame(scrollRaf);
  window.clearTimeout(clock);
  window.clearTimeout(resizeTimer);
  window.removeEventListener("resize", scheduleFit);
  sizeWatch?.disconnect();
  observer?.disconnect();
  inFlight.forEach((task) => task.cancel());
  inFlight.clear();
  flushSave();
  extracted = null;
  extracting = null;
  doc.value?.destroy?.();
});
</script>

<template>
  <div class="pdf-reader">
    <div v-if="failed" class="empty" :style="{ flex: 1 }">
      <div class="glyph"><Icon name="alert" :size="22" /></div>
      <div>{{ t("reader.pdfError") }}</div>
      <button class="empty-retry" @click="load">
        <Icon name="refresh" :size="12" />
        {{ t("common.retry") }}
      </button>
    </div>

    <template v-else>
      <div
        class="reader-scroll pdf-scroll"
        ref="scrollRef"
        @scroll.passive="onScroll"
        @wheel.passive="dismissHlPopover"
        @touchmove.passive="dismissHlPopover"
        @mouseup="onPageMouseUp"
      >
        <div v-if="loading" class="empty" :style="{ flex: 1 }">
          <div class="ai-loading">
            <span class="ai-dot" /><span class="ai-dot" /><span class="ai-dot" />
          </div>
          <div>{{ t("reader.pdfLoading") }}</div>
        </div>
        <div class="pdf-pages" ref="pagesRef" />
      </div>

      <!-- Focus mode hides the bar (opacity 0, pointer-events none). This
           strip is what the pointer finds first, the way the top chrome
           has .reader-chrome-hotzone. -->
      <div v-if="!loading" class="pdf-bar-hotzone" aria-hidden="true" />
      <!-- A PDF is read by page, so its own bar is where the reading controls
           live: which page, how big, and moving between them. The chrome above
           belongs to the book — this belongs to the document. -->
      <div class="pdf-bar" v-if="!loading">
        <button
          class="tb-btn"
          :disabled="currentPage <= 1"
          @click="pageBy(-1)"
          :aria-label="t('reader.prevPage')"
          :title="t('reader.prevPage')"
        >
          <Icon name="chevron-right" :size="14" :style="{ transform: 'rotate(180deg)' }" />
        </button>
        <!-- Typing a page number is how anyone gets around a 400-page PDF. -->
        <span class="pdf-jump">
          <input
            class="pdf-jump-input"
            type="text"
            inputmode="numeric"
            :value="currentPage"
            :aria-label="t('reader.goToPage')"
            @change="goToPage(Number(($event.target as HTMLInputElement).value))"
            @keydown.enter="goToPage(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="pdf-jump-total">/ {{ pageCount }}</span>
        </span>
        <button
          class="tb-btn"
          :disabled="currentPage >= pageCount"
          @click="pageBy(1)"
          :aria-label="t('reader.nextPage')"
          :title="t('reader.nextPage')"
        >
          <Icon name="chevron-right" :size="14" />
        </button>

        <span class="pdf-bar-sep" />

        <button class="tb-btn" @click="setZoom(zoom - 0.2)" :aria-label="t('reader.zoomOut')">
          <Icon name="arrow-down" :size="14" />
        </button>
        <span class="pdf-zoom">{{ Math.round(zoom * 100) }}%</span>
        <button class="tb-btn" @click="setZoom(zoom + 0.2)" :aria-label="t('reader.zoomIn')">
          <Icon name="arrow-up" :size="14" />
        </button>
        <button class="pdf-fit" @click="fitWidth" :title="t('reader.fitWidth')">
          {{ t("reader.fitWidth") }}
        </button>
        <!-- The margins a page carries for paper are half the screen. -->
        <button
          :class="['pdf-fit', cropped ? 'on' : '']"
          @click="setCropped(!cropped)"
          :title="t('reader.trimMarginsHint')"
          :aria-pressed="cropped"
        >
          {{ t("reader.trimMargins") }}
        </button>
        <span v-if="ui.readerShowPage || (ui.readerShowClock && now)" class="pdf-meta">
          <span v-if="ui.readerShowPage" class="pdf-pageno">{{ t("reader.pageOf", { n: currentPage, total: pageCount }) }}</span>
          <span v-if="ui.readerShowClock && now">{{ now }}</span>
        </span>
      </div>
    </template>
    <HighlightPopover
      v-if="pendingHl"
      :pending="pendingHl.existing ? undefined : { quote: pendingHl.quote }"
      :hl="pendingHl.existing"
      :x="pendingHl.x"
      :y="pendingHl.y"
      :on-close="() => (pendingHl = null)"
      :on-create="commitPageHighlight"
      :on-delete="deletePageHighlight"
      :on-changed="reloadMarks"
    />
  </div>
</template>
