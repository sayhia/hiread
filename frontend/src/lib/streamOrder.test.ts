// Unit tests for the streaming reorder buffer. `streamOrder.ts` is pure and
// DOM-free, so it runs fully in node — it models the fix for Wails v3 delivering
// per-stream events out of order (which scrambled AI summary text).

import { describe, it, expect } from "vitest";
import { createReorderBuffer } from "./streamOrder";

/** Collect everything a buffer delivers, given (seq, data) pairs pushed in the
 *  supplied arrival order. Returns the concatenation, mirroring how AIDrawer
 *  accumulates token deltas. */
function collect(arrivals: Array<[number, string]>, flush = true): string {
  let out = "";
  const buf = createReorderBuffer<string>((d) => (out += d));
  for (const [seq, data] of arrivals) buf.push(seq, data);
  if (flush) buf.flush();
  return out;
}

describe("createReorderBuffer — ordering", () => {
  it("passes already-ordered events straight through", () => {
    expect(
      collect([
        [1, "蔚来"],
        [2, "2030"],
        [3, "年纯电"],
      ]),
    ).toBe("蔚来2030年纯电");
  });

  it("restores emit order when events arrive shuffled", () => {
    // The exact failure mode from the bug report: correct tokens, wrong order.
    const tokens: Array<[number, string]> = [
      [1, "2030"],
      [2, "年"],
      [3, "纯"],
      [4, "电"],
      [5, "车型"],
    ];
    const shuffled = [tokens[2], tokens[0], tokens[4], tokens[1], tokens[3]];
    expect(collect(shuffled)).toBe("2030年纯电车型");
  });

  it("holds an out-of-order run until the gap fills, then releases it contiguously", () => {
    const delivered: string[] = [];
    const buf = createReorderBuffer<string>((d) => delivered.push(d));
    buf.push(2, "b");
    buf.push(3, "c");
    expect(delivered).toEqual([]); // 1 is missing — nothing may be delivered yet
    buf.push(1, "a");
    expect(delivered).toEqual(["a", "b", "c"]); // the gap filled; all three flush in order
  });
});

describe("createReorderBuffer — robustness", () => {
  it("ignores a duplicate sequence number", () => {
    expect(
      collect([
        [1, "a"],
        [2, "b"],
        [1, "DUP"],
        [3, "c"],
      ]),
    ).toBe("abc");
  });

  it("delivers a buffered tail in order on flush when a seq never arrives", () => {
    // seq 2 is dropped entirely; flush must still deliver 3 and 4 (in order)
    // rather than lose them.
    expect(
      collect([
        [1, "a"],
        [3, "c"],
        [4, "d"],
      ]),
    ).toBe("acd");
  });

  it("delivers nothing extra when flushed empty", () => {
    expect(collect([[1, "a"]])).toBe("a");
  });
});
