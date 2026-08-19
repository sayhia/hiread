// Turn raw image bytes into something the webview can display or save.
//
// `api.fetchImage` already decodes the base64 transport into a `Uint8Array`;
// these helpers take the bytes directly and produce a data URL or a Blob for
// <img src>, downloads, etc.

/** Default MIME when nothing identifies the image type. */
const DEFAULT_MIME = "image/jpeg";

/** Base64-encode raw bytes without blowing the call stack on large images:
 *  `String.fromCharCode(...bytes)` spreads every byte as an argument and throws
 *  "Maximum call stack size exceeded" past ~100KB, so build the binary string
 *  in fixed-size chunks before `btoa`. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** MIME type from the byte signature, or null when none of the known image
 *  formats match. SVG is text (no fixed magic bytes), so it is left to the
 *  extension fallback in `imageMime`. */
function sniffImageMime(b: Uint8Array): string | null {
  // PNG: 89 50 4E 47
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png";
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  // GIF: "GIF"
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  // WebP: "RIFF"…"WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  // BMP: "BM"
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  // AVIF: ISO-BMFF `ftyp` + major brand avif/avis (offset 4 and 8).
  if (
    b.length >= 12 &&
    b[4] === 0x66 &&
    b[5] === 0x74 &&
    b[6] === 0x79 &&
    b[7] === 0x70
  ) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

/** Detect an image's MIME type from its leading "magic" bytes, falling back to
 *  the URL's file extension, and finally to image/jpeg. The type matters for a
 *  data: URL: unlike a Blob (whose bytes the webview sniffs), a data: URL's
 *  MIME is *declared*, so a wrong or empty type makes the <img> fail to render.
 *  Many CDN image URLs carry no extension, which is why the byte sniff comes
 *  first. */
export function imageMime(src: string, bytes: Uint8Array): string {
  const sniffed = sniffImageMime(bytes);
  if (sniffed) return sniffed;
  const path = src.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".avif")) return "image/avif";
  if (path.endsWith(".bmp")) return "image/bmp";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return DEFAULT_MIME;
}

/** A self-contained `data:` URL for the image, suitable for an `<img src>`
 *  binding. The MIME type is detected from `src` + `bytes` (see `imageMime`).
 *
 *  Images that fail to load directly (hotlink-protected hosts) are refetched
 *  through the backend and re-injected here. A blob: URL would be the obvious
 *  carrier, but WKWebView/WebView2 silently drop a blob:'s backing data under
 *  memory pressure (e.g. layer recompositing while scrolling), so the recovered
 *  image vanishes the moment the user scrolls away and back. A data: URL keeps
 *  the bytes inline in the DOM, so the webview can always repaint it — and it
 *  needs no revoke bookkeeping. */
export function imageDataUrl(src: string, bytes: Uint8Array): string {
  return `data:${imageMime(src, bytes)};base64,${bytesToBase64(bytes)}`;
}

/** A `Blob` for the image, suitable for `downloadBlob` or `URL.createObjectURL`.
 *  The MIME type is detected from `src` + `bytes` (see `imageMime`). */
export function imageBlob(src: string, bytes: Uint8Array): Blob {
  // Copy into a fresh ArrayBuffer so the Blob never references a Uint8Array
  // backed by a larger (pooled / shared) buffer than its own [byteOffset, len).
  return new Blob([bytes.slice()], { type: imageMime(src, bytes) });
}
