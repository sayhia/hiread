// Tests for the byte-carrying calls. Wails moves a Go []byte across the bridge
// as a base64 string in both directions, so api.ts is where bytes become text
// and back — and a book is exactly the kind of payload where a subtly wrong
// encoding survives every small test and then corrupts a real file.

import { describe, it, expect, vi, beforeEach } from "vitest";

// The mocks are typed with the signatures the generated bindings expose, so
// this file also pins the shape api.ts calls them with.
const importBytesMock = vi.fn(async (_fileName: string, _data: string) => ({
  fileName: "x.epub",
  bookId: 1,
  title: "x",
  duplicate: false,
  error: "",
}));
const coverBytesMock = vi.fn(async (_bookID: number): Promise<string> => "");
const resourceBytesMock = vi.fn(async (_bookID: number, _path: string): Promise<string> => "");
const setPdfMetadataMock = vi.fn(
  async (
    _bookID: number,
    _pageCount: number,
    _title: string,
    _author: string,
    _cover: string,
    _coverMime: string,
  ) => {},
);

vi.mock("../bindings/hiread/services", () => ({
  AIService: {},
  CollectionService: {},
  FontService: {},
  HighlightService: {},
  LibraryService: {
    ImportBytes: importBytesMock,
    CoverBytes: coverBytesMock,
    ResourceBytes: resourceBytesMock,
    SetPDFMetadata: setPdfMetadataMock,
  },
  SettingService: {},
  StorageService: {},
  SystemService: {},
  TagService: {},
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => {} } }));

beforeEach(() => vi.clearAllMocks());

/** Bytes that exercise every value a byte can take, repeated past the 0x8000
 *  chunk boundary the encoder splits on — a book is megabytes, not bytes. */
function payload(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 256;
  return bytes;
}

describe("importBytes", () => {
  it("sends a dropped file as base64 that decodes back byte for byte", async () => {
    const api = await import("./api");
    const data = payload(100_000);

    await api.importBytes("walden.epub", data);

    expect(importBytesMock).toHaveBeenCalledTimes(1);
    const [name, encoded] = importBytesMock.mock.calls[0];
    expect(name).toBe("walden.epub");

    const decoded = Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0));
    expect(decoded).toEqual(data);
  });
});

describe("byte-returning calls", () => {
  it("decodes a base64 response into the original bytes", async () => {
    const api = await import("./api");
    const original = payload(1000);
    let binary = "";
    for (const b of original) binary += String.fromCharCode(b);
    coverBytesMock.mockResolvedValueOnce(btoa(binary));

    expect(await api.coverBytes(7)).toEqual(original);
  });

  it("returns an empty array when a book has no cover", async () => {
    const api = await import("./api");
    coverBytesMock.mockResolvedValueOnce("");
    expect(await api.coverBytes(7)).toEqual(new Uint8Array());
  });
});

describe("setPdfMetadata", () => {
  it("sends a rendered cover as base64, and an empty string when there is none", async () => {
    const api = await import("./api");
    const cover = payload(2048);

    await api.setPdfMetadata(3, 120, "Report", "Someone", cover, "image/png");
    const sent = setPdfMetadataMock.mock.calls[0][4];
    expect(Uint8Array.from(atob(sent), (ch) => ch.charCodeAt(0))).toEqual(cover);

    // No cover to send is an empty string, not "null" or "[object Object]".
    await api.setPdfMetadata(3, 120, "Report", "Someone", null, "");
    expect(setPdfMetadataMock.mock.calls[1][4]).toBe("");
  });
});
