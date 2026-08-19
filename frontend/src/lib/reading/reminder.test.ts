// A reminder that arrives after lunch is a reminder that gets turned off. The
// cases worth checking are all the ways an hour can pass without an hour of
// reading in it.

import { describe, it, expect } from "vitest";
import { IDLE_MS, MAX_TICK_MS, startReading, tick } from "./reminder";

const EVERY = 30 * 60_000;

/** Run a stretch of ticks, saying whether the reader was present for them. */
function run(
  opts: { from?: number; ticks: number; step: number; visible?: boolean; active?: boolean },
) {
  let state = startReading();
  let reminders = 0;
  let at = opts.from ?? 0;
  for (let i = 0; i < opts.ticks; i++) {
    at += opts.step;
    const r = tick(state, {
      at,
      visible: opts.visible ?? true,
      lastActivity: (opts.active ?? true) ? at : -IDLE_MS * 10,
      everyMs: EVERY,
    });
    state = r.state;
    if (r.remind) reminders++;
  }
  return { state, reminders, at };
}

describe("counting reading rather than time", () => {
  it("says something after the reading adds up", () => {
    // Half an hour of ten-second ticks, plus the one that starts the clock:
    // the first tick has no previous time to measure from and contributes
    // nothing, which is why it is 181 and not 180.
    const { reminders } = run({ ticks: 181, step: 10_000 });
    expect(reminders).toBe(1);
    expect(run({ ticks: 180, step: 10_000 }).reminders).toBe(0);
  });

  it("says nothing while the window is behind something else", () => {
    const { reminders, state } = run({ ticks: 360, step: 10_000, visible: false });
    expect(reminders).toBe(0);
    expect(state.read).toBe(0);
  });

  it("says nothing to a window left open", () => {
    // Present, but nothing has happened in it for far longer than a reader is
    // still for.
    const { reminders } = run({ ticks: 360, step: 10_000, active: false });
    expect(reminders).toBe(0);
  });

  // Reading *is* being still. Someone with a slow eye on a long page may not
  // touch anything for minutes, and is the exact person a break is for.
  it("counts a reader who has not moved for a few minutes", () => {
    let state = startReading();
    let reminders = 0;
    const activity = 0;
    for (let at = 10_000; at <= 30 * 60_000 + IDLE_MS; at += 10_000) {
      const r = tick(state, { at, visible: true, lastActivity: activity, everyMs: EVERY });
      state = r.state;
      if (r.remind) reminders++;
    }
    // Their stillness counted until it passed the idle mark, and not after.
    expect(reminders).toBe(0);
    expect(state.read).toBeGreaterThan(IDLE_MS - 20_000);
    expect(state.read).toBeLessThanOrEqual(IDLE_MS);
  });

  // A machine that slept, or a tab that was frozen, hands over one enormous
  // tick. It must not be able to hand over the hours it was gone.
  it("will not take an hour from a single late tick", () => {
    let state = startReading();
    state = tick(state, { at: 1_000, visible: true, lastActivity: 1_000, everyMs: EVERY }).state;
    const r = tick(state, {
      at: 1_000 + 3 * 60 * 60_000,
      visible: true,
      lastActivity: 1_000 + 3 * 60 * 60_000,
      everyMs: EVERY,
    });
    expect(r.remind).toBe(false);
    expect(r.state.read).toBe(MAX_TICK_MS);
  });

  it("starts again after it has said something", () => {
    const { reminders } = run({ ticks: 361, step: 10_000 });
    expect(reminders).toBe(2);
  });

  it("says nothing at all when it is turned off", () => {
    let state = startReading();
    let reminders = 0;
    for (let at = 10_000; at <= 5 * 60 * 60_000; at += 10_000) {
      const r = tick(state, { at, visible: true, lastActivity: at, everyMs: 0 });
      state = r.state;
      if (r.remind) reminders++;
    }
    expect(reminders).toBe(0);
  });

  it("counts nothing for the first tick, having nothing to count from", () => {
    const r = tick(startReading(), {
      at: 5_000_000,
      visible: true,
      lastActivity: 5_000_000,
      everyMs: EVERY,
    });
    expect(r.state.read).toBe(0);
    expect(r.remind).toBe(false);
  });
});
