// Chapter HTML addresses its images as data-res="<path into the book>", never
// as a URL: the book is local and complete, and a src the webview could fetch
// would be a tracker. Each one is resolved to a typed blob URL after the body
// mounts.

import { onBeforeUnmount, ref, type Ref } from "vue";
import * as api from "../../api";
import { imageBlob } from "../../lib/imageBytes";

/** A dingbat / chapter ornament is a few glyphs tall, not a plate. Opening
 *  those in the viewer and giving them a figure's shadow is noise. */
export function isOrnamentSize(width: number, height: number): boolean {
  if (!(width > 0 && height > 0)) return false;
  return width <= 48 && height <= 48;
}

function altFromPath(path: string): string {
  const base = path.split("/").pop() ?? "";
  return base.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
}

export function useChapterImages(
  bookId: Ref<number | null | undefined>,
  bodyRef: Ref<HTMLElement | undefined | null>,
  opts?: {
    /** Fired (once per frame) after a figure decodes and the chapter's
     *  height/width has changed — the reader puts itself back by ratio. */
    onLayout?: () => void;
  },
) {
  const objectUrls: string[] = [];
  const held = new Map<HTMLImageElement, { url: string; bytes: Uint8Array; path: string; retried: boolean }>();
  const imageSrcs = ref<string[]>([]);
  const imageAlts = ref<string[]>([]);
  const viewerIndex = ref<number | null>(null);

  let gen = 0;
  let boundRoot: HTMLElement | null = null;
  let layoutRaf = 0;

  function scheduleLayout() {
    if (layoutRaf) return;
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = 0;
      opts?.onLayout?.();
    });
  }

  function publishSrcs() {
    const srcs: string[] = [];
    const alts: string[] = [];
    const found = boundRoot
      ? Array.from(boundRoot.querySelectorAll<HTMLImageElement>("img[data-res]"))
      : [];
    for (const img of found) {
      if (!img.src || img.classList.contains("img-ornament") || img.classList.contains("img-missing")) {
        continue;
      }
      srcs.push(img.src);
      alts.push(img.dataset.altFallback ? "" : (img.getAttribute("alt") ?? ""));
    }
    imageSrcs.value = srcs;
    imageAlts.value = alts;
  }

  function classify(img: HTMLImageElement) {
    if (isOrnamentSize(img.naturalWidth, img.naturalHeight)) {
      img.classList.add("img-ornament");
      img.classList.remove("img-missing");
      img.tabIndex = -1;
      img.removeAttribute("role");
      img.setAttribute("alt", "");
      img.setAttribute("aria-hidden", "true");
    } else {
      img.classList.remove("img-ornament");
      img.tabIndex = 0;
      img.setAttribute("role", "button");
    }
    publishSrcs();
    scheduleLayout();
  }

  function onImgLoad(ev: Event) {
    const img = ev.currentTarget as HTMLImageElement;
    classify(img);
  }

  function onImgError(ev: Event) {
    const img = ev.currentTarget as HTMLImageElement;
    const slot = held.get(img);
    // WKWebView has been seen to drop a blob's backing store under memory
    // pressure; one fresh blob from the bytes we still hold usually brings
    // the plate back. A second failure is a missing resource.
    if (slot && !slot.retried) {
      slot.retried = true;
      URL.revokeObjectURL(slot.url);
      const url = URL.createObjectURL(imageBlob(slot.path, slot.bytes));
      slot.url = url;
      objectUrls.push(url);
      img.src = url;
      return;
    }
    img.classList.add("img-missing");
    img.classList.remove("img-ornament");
    img.tabIndex = -1;
    img.removeAttribute("role");
    publishSrcs();
  }

  function open(img: HTMLImageElement) {
    if (img.classList.contains("img-ornament") || img.classList.contains("img-missing")) return;
    const i = imageSrcs.value.indexOf(img.currentSrc || img.src);
    if (i >= 0) viewerIndex.value = i;
  }

  function onRootClick(ev: MouseEvent) {
    const img = (ev.target as Element | null)?.closest?.("img[data-res]");
    if (!(img instanceof HTMLImageElement)) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (!img.src) return;
    if (img.naturalWidth && isOrnamentSize(img.naturalWidth, img.naturalHeight)) {
      classify(img);
      return;
    }
    open(img);
  }

  function onRootKey(ev: KeyboardEvent) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const img = ev.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.res) return;
    ev.preventDefault();
    ev.stopPropagation();
    open(img);
  }

  function bindRoot(root: HTMLElement) {
    if (boundRoot === root) return;
    unbindRoot();
    boundRoot = root;
    root.addEventListener("click", onRootClick);
    root.addEventListener("keydown", onRootKey);
  }

  function unbindRoot() {
    if (!boundRoot) return;
    boundRoot.removeEventListener("click", onRootClick);
    boundRoot.removeEventListener("keydown", onRootKey);
    boundRoot = null;
  }

  function detach(img: HTMLImageElement) {
    img.removeEventListener("load", onImgLoad);
    img.removeEventListener("error", onImgError);
  }

  function releaseImages() {
    gen += 1;
    cancelAnimationFrame(layoutRaf);
    layoutRaf = 0;
    for (const img of held.keys()) detach(img);
    held.clear();
    for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
    imageSrcs.value = [];
    imageAlts.value = [];
    viewerIndex.value = null;
    unbindRoot();
  }

  async function resolveImages() {
    const root = bodyRef.value;
    const id = bookId.value;
    if (!root || id == null) return;
    const my = ++gen;
    bindRoot(root);
    const imgs = Array.from(root.querySelectorAll<HTMLImageElement>("img[data-res]"));
    // Every figure in parallel — a chapter of plates used to wait on N serial
    // IPC round-trips, which also delayed position restore.
    const resolved = await Promise.all(
      imgs.map(async (img) => {
        const path = img.dataset.res;
        if (!path) return null;
        try {
          const bytes = await api.resourceBytes(id, path);
          if (!bytes.length) return null;
          return { img, path, bytes, url: URL.createObjectURL(imageBlob(path, bytes)) };
        } catch {
          // A resource the book referenced but did not ship: leave the empty
          // <img> rather than break the chapter around it.
          return null;
        }
      }),
    );
    if (my !== gen) {
      for (const r of resolved) if (r) URL.revokeObjectURL(r.url);
      return;
    }
    const srcs: string[] = [];
    const alts: string[] = [];
    for (const r of resolved) {
      if (!r) continue;
      const { img, path, bytes, url } = r;
      objectUrls.push(url);
      held.set(img, { url, bytes, path, retried: false });
      img.draggable = false;
      img.decoding = "async";
      // Bytes are already local; lazy only defers *decode* until the plate is
      // near the view, so a long illustrated chapter does not unpack every
      // figure on open.
      img.loading = "lazy";
      if (img.getAttribute("alt") == null) {
        img.setAttribute("alt", altFromPath(path));
        img.dataset.altFallback = "1";
      }
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.addEventListener("load", onImgLoad);
      img.addEventListener("error", onImgError);
      img.src = url;
      srcs.push(url);
      alts.push(img.dataset.altFallback ? "" : (img.getAttribute("alt") ?? ""));
    }
    imageSrcs.value = srcs;
    imageAlts.value = alts;
  }

  onBeforeUnmount(releaseImages);

  return { imageSrcs, imageAlts, viewerIndex, releaseImages, resolveImages };
}
