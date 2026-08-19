// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { nextTick, ref } from "vue";
import { isOrnamentSize, useChapterImages } from "./useChapterImages";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

vi.mock("../../api", () => ({
  resourceBytes: vi.fn(async () => png),
}));

describe("isOrnamentSize", () => {
  it("treats a dingbat as an ornament and a plate as a figure", () => {
    expect(isOrnamentSize(16, 16)).toBe(true);
    expect(isOrnamentSize(48, 48)).toBe(true);
    expect(isOrnamentSize(49, 20)).toBe(false);
    expect(isOrnamentSize(800, 600)).toBe(false);
    expect(isOrnamentSize(0, 0)).toBe(false);
  });
});

describe("useChapterImages", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockImplementation((obj: Blob | MediaSource) =>
      `blob:${obj instanceof Blob ? obj.type || "unknown" : "media"}`,
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mountBody(html: string) {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  }

  it("resolves data-res images to a typed blob and opens the viewer on click", async () => {
    const root = mountBody('<img data-res="OEBPS/img/pond.png" alt="The pond">');
    const bodyRef = ref<HTMLElement | null>(root);
    const bookId = ref<number | null>(1);
    const { imageSrcs, imageAlts, viewerIndex, resolveImages, releaseImages } = useChapterImages(
      bookId,
      bodyRef,
    );

    await resolveImages();
    const img = root.querySelector("img")!;
    expect(img.src).toContain("blob:image/png");
    expect(imageSrcs.value).toEqual(["blob:image/png"]);
    expect(imageAlts.value).toEqual(["The pond"]);
    expect(img.getAttribute("role")).toBe("button");

    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(viewerIndex.value).toBe(0);

    releaseImages();
    root.remove();
  });

  it("marks a decoded dingbat as an ornament and keeps it out of the viewer", async () => {
    const root = mountBody('<img data-res="OEBPS/img/dot.png">');
    const bodyRef = ref<HTMLElement | null>(root);
    const { imageSrcs, resolveImages, viewerIndex, releaseImages } = useChapterImages(
      ref(1),
      bodyRef,
    );
    await resolveImages();
    const img = root.querySelector("img")!;
    Object.defineProperty(img, "naturalWidth", { value: 16, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 16, configurable: true });
    img.dispatchEvent(new Event("load"));
    await nextTick();

    expect(img.classList.contains("img-ornament")).toBe(true);
    expect(imageSrcs.value).toEqual([]);
    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(viewerIndex.value).toBeNull();

    releaseImages();
    root.remove();
  });

  it("coalesces layout callbacks after a figure decodes", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const onLayout = vi.fn();
    const root = mountBody('<img data-res="OEBPS/img/map.png" alt="Map">');
    const { resolveImages, releaseImages } = useChapterImages(ref(1), ref(root), { onLayout });
    await resolveImages();
    const img = root.querySelector("img")!;
    Object.defineProperty(img, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 600, configurable: true });
    img.dispatchEvent(new Event("load"));
    img.dispatchEvent(new Event("load"));
    expect(onLayout).toHaveBeenCalledTimes(1);
    releaseImages();
    root.remove();
  });
});
