import { describe, expect, it } from "vitest";
import { imageDataUrl, imageBlob, imageMime } from "./imageBytes";

describe("imageMime", () => {
  it("detects PNG from its magic bytes regardless of URL", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(imageMime("https://cdn.example/x", png)).toBe("image/png");
  });

  it("detects JPEG, GIF and WebP signatures", () => {
    expect(imageMime("x", new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(imageMime("x", new Uint8Array([0x47, 0x49, 0x46]))).toBe("image/gif");
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(imageMime("x", webp)).toBe("image/webp");
  });

  it("detects BMP and AVIF signatures", () => {
    expect(imageMime("x", new Uint8Array([0x42, 0x4d, 0, 0]))).toBe("image/bmp");
    const avif = new Uint8Array(12);
    avif.set([0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 4);
    expect(imageMime("x", avif)).toBe("image/avif");
  });

  it("trusts magic bytes over a misleading extension", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(imageMime("https://cdn.example/photo.jpg", png)).toBe("image/png");
  });

  it("falls back to the extension when bytes are unrecognised", () => {
    const junk = new Uint8Array([0, 1, 2, 3]);
    expect(imageMime("https://cdn.example/a.png?v=2", junk)).toBe("image/png");
    expect(imageMime("https://cdn.example/a.svg", junk)).toBe("image/svg+xml");
    expect(imageMime("https://cdn.example/a.webp#frag", junk)).toBe("image/webp");
    expect(imageMime("https://cdn.example/a.avif", junk)).toBe("image/avif");
  });

  it("defaults to image/jpeg when nothing identifies the type", () => {
    expect(imageMime("https://cdn.example/no-ext", new Uint8Array([0, 1, 2]))).toBe(
      "image/jpeg",
    );
  });
});

describe("imageDataUrl", () => {
  it("builds a base64 data: URL with the detected MIME", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(imageDataUrl("https://cdn.example/x", png)).toBe(
      `data:image/png;base64,${btoa("\x89PNG")}`,
    );
  });

  it("encodes large inputs without overflowing the call stack", () => {
    const big = new Uint8Array(200_000).fill(0x41); // 'A'
    const url = imageDataUrl("https://cdn.example/big.jpg", big);
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
    // Round-trips back to the same bytes.
    const decoded = atob(url.slice("data:image/jpeg;base64,".length));
    expect(decoded.length).toBe(big.length);
  });
});

describe("imageBlob", () => {
  it("wraps the bytes in a Blob of the right size and detected type", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const blob = imageBlob("https://cdn.example/x", png);
    expect(blob.size).toBe(4);
    expect(blob.type).toBe("image/png");
  });

  it("defaults the mime to JPEG when the type can't be identified", () => {
    expect(imageBlob("https://cdn.example/no-ext", new Uint8Array([0, 1, 2])).type).toBe(
      "image/jpeg",
    );
  });
});
