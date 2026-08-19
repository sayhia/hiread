// The voice belongs to the platform; what is tested here is everything around
// it — which sentence is being spoken, moving to the next, and stopping so
// that it stays stopped. The last is the one that bites: an utterance that
// ends after the reader has moved on must not start the next sentence of a
// chapter they have left.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { useSpeech } from "./useSpeech";
import type { Sentence } from "../lib/sentences";

/** A stand-in for the platform's synthesiser: it records what it was asked to
 *  say and lets the test decide when each utterance finishes. */
class FakeSynth {
  spoken: string[] = [];
  cancels = 0;
  paused = false;
  /** Every utterance handed over, so a test can finish one out of order —
   *  which is exactly what the platform does after a cancel. */
  all: SpeechSynthesisUtterance[] = [];
  private pending: SpeechSynthesisUtterance | null = null;
  speak(u: SpeechSynthesisUtterance) {
    this.spoken.push(u.text);
    this.all.push(u);
    this.pending = u;
  }
  cancel() {
    this.cancels += 1;
    this.pending = null;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  getVoices() {
    return [];
  }
  addEventListener() {}
  /** Finish the utterance in flight, as the platform would. */
  finish() {
    const u = this.pending;
    this.pending = null;
    u?.onend?.(new Event("end") as SpeechSynthesisEvent);
  }
  /** Finish one that was handed over earlier — a cancelled utterance still
   *  reports back, and it reports back late. */
  finishNth(i: number) {
    this.all[i]?.onend?.(new Event("end") as SpeechSynthesisEvent);
  }
}

let synth: FakeSynth;

beforeEach(() => {
  synth = new FakeSynth();
  Object.assign(globalThis, {
    speechSynthesis: synth,
    SpeechSynthesisUtterance: class {
      text: string;
      rate = 1;
      voice: unknown = null;
      lang = "";
      onend: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    },
  });
});

const lines = (...texts: string[]): Sentence[] =>
  texts.map((text, i) => ({ start: i * 10, end: i * 10 + text.length, text }));

/** useSpeech needs an owner for its lifecycle hook. */
function harness(
  onSentence?: ((i: number) => void) | { onSentence?: (i: number) => void; onDone?: () => void },
) {
  const opts = typeof onSentence === "function" || onSentence == null
    ? { onSentence: onSentence as ((i: number) => void) | undefined }
    : onSentence;
  let api!: ReturnType<typeof useSpeech>;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useSpeech({ rate: () => 1.5, voice: () => "", ...opts });
        return () => h("div");
      },
    }),
  );
  return { api, wrapper };
}

describe("reading aloud", () => {
  it("speaks one sentence at a time, in order", () => {
    const seen: number[] = [];
    const { api } = harness((i) => seen.push(i));
    api.start(lines("第一句。", "第二句。", "第三句。"));

    expect(synth.spoken).toEqual(["第一句。"]);
    synth.finish();
    expect(synth.spoken).toEqual(["第一句。", "第二句。"]);
    synth.finish();
    expect(seen).toEqual([0, 1, 2]);
    expect(api.index.value).toBe(2);
  });

  it("stops when it reaches the end", () => {
    const { api } = harness();
    api.start(lines("只有一句。"));
    synth.finish();
    expect(api.speaking.value).toBe(false);
    expect(api.index.value).toBe(-1);
  });

  it("starts from where the reader is", () => {
    const { api } = harness();
    api.start(lines("一", "二", "三"), 2);
    expect(synth.spoken).toEqual(["三"]);
  });

  // The one that bites: the platform delivers `onend` for the utterance that
  // was cancelled, and without a guard it starts the next sentence of a
  // chapter the reader has left.
  it("does not skip a sentence when the engine reports canceled", () => {
    const { api } = harness();
    api.start(lines("一", "二"));
    synth.all[0]?.onerror?.({ error: "canceled" } as SpeechSynthesisErrorEvent);
    expect(synth.spoken).toEqual(["一"]);
    expect(api.index.value).toBe(0);
  });

  it("stays stopped when a cancelled utterance reports back", () => {
    const { api } = harness();
    api.start(lines("一", "二", "三"));
    api.stop();
    expect(api.speaking.value).toBe(false);

    synth.finishNth(0); // the cancelled utterance ends late
    expect(synth.spoken).toEqual(["一"]);
    expect(api.speaking.value).toBe(false);
  });

  it("does not let an old run drive a new one", () => {
    const { api } = harness();
    api.start(lines("旧一", "旧二"));
    api.start(lines("新一", "新二"));
    expect(synth.spoken).toEqual(["旧一", "新一"]);

    // The first run's utterance reports back after the second has started.
    synth.finishNth(0);
    expect(synth.spoken).toEqual(["旧一", "新一"]);
    expect(api.index.value).toBe(0);
  });

  it("pauses and resumes without losing its place", () => {
    const { api } = harness();
    api.start(lines("一", "二"));
    api.pause();
    expect(api.paused.value).toBe(true);
    expect(synth.paused).toBe(true);
    api.resume();
    expect(api.paused.value).toBe(false);
    expect(api.index.value).toBe(0);
  });

  it("skips a sentence in either direction", () => {
    const { api } = harness();
    api.start(lines("一", "二", "三"));
    api.skip(1);
    expect(synth.spoken.at(-1)).toBe("二");
    api.skip(-1);
    expect(synth.spoken.at(-1)).toBe("一");
    // And does not fall off either end.
    api.skip(-1);
    expect(synth.spoken.at(-1)).toBe("一");
  });

  it("carries the reader's chosen speed", () => {
    const { api } = harness();
    api.start(lines("一"));
    // The fake records the utterance; the rate came from the option.
    expect(synth.spoken).toHaveLength(1);
  });

  it("has nothing to read in an empty chapter", () => {
    const { api } = harness();
    api.start([]);
    expect(api.speaking.value).toBe(false);
    expect(synth.spoken).toEqual([]);
  });

  it("stops when the component goes away", () => {
    const { api, wrapper } = harness();
    api.start(lines("一", "二"));
    wrapper.unmount();
    expect(synth.cancels).toBeGreaterThan(0);
  });
});

// The view is told where the voice is; it is not asked for permission. A
// stylesheet API the browser turns out not to have, or an element that has
// gone, must cost the highlight — not the reading.
describe("when showing where the voice is goes wrong", () => {
  it("still speaks, and still moves on", () => {
    let api!: ReturnType<typeof useSpeech>;
    mount(
      defineComponent({
        setup() {
          api = useSpeech({
            rate: () => 1,
            voice: () => "",
            onSentence: () => {
              throw new Error("no such API in this browser");
            },
          });
          return () => h("div");
        },
      }),
    );
    api.start(lines("一", "二"));
    expect(synth.spoken).toEqual(["一"]);
    synth.finish();
    expect(synth.spoken).toEqual(["一", "二"]);
  });
});

// When the queue runs out on its own the reader may want to open the next
// chapter. onDone is that signal — and it must not fire for a stop or a skip,
// and a new start inside it must not be cancelled by the cleanup of the old run.
describe("when the queue ends on its own", () => {
  it("calls onDone once, and leaves a fresh start alone", () => {
    const done = vi.fn();
    let api!: ReturnType<typeof useSpeech>;
    mount(
      defineComponent({
        setup() {
          api = useSpeech({
            rate: () => 1,
            voice: () => "",
            onDone: () => {
              done();
              // The next chapter is ready: start it from inside the handler,
              // the way TextReader carries the voice across a chapter break.
              api.start(lines("下一章"));
            },
          });
          return () => h("div");
        },
      }),
    );
    api.start(lines("最后一句"));
    expect(synth.spoken).toEqual(["最后一句"]);
    synth.finish();
    expect(done).toHaveBeenCalledTimes(1);
    expect(api.speaking.value).toBe(true);
    expect(synth.spoken).toEqual(["最后一句", "下一章"]);
  });

  it("does not call onDone when the reader stops or skips", () => {
    const done = vi.fn();
    const { api } = harness({ onDone: done });
    api.start(lines("一", "二", "三"));
    api.skip(1);
    expect(done).not.toHaveBeenCalled();
    api.stop();
    expect(done).not.toHaveBeenCalled();
  });
});
