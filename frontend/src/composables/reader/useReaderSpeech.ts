// Reading aloud over a chapter of text.
//
// The voice is the platform's; what is here is where it is — sentence paint,
// bilingual column exclusion, and carrying the voice into the next chapter.
// The engine itself lives in useSpeech.

import { nextTick, onBeforeUnmount, watch, type Ref, toValue, type MaybeRefOrGetter } from "vue";
import { isAcross, metrics, scrollTo, settle, type ReadingAxis } from "../../lib/reading/position";
import { leadFromView, leadingViewX } from "../../lib/reading/direction";
import { useQuery } from "@tanstack/vue-query";
import * as api from "../../api";
import { offsetAtPoint, rangesFor, readingText } from "../../lib/highlightDom";
import { sentenceAt, splitSentences, type Sentence } from "../../lib/sentences";
import { useSpeech } from "../useSpeech";
import type { TransView } from "../../types";

export function useReaderSpeech(opts: {
  scrollRef: Ref<HTMLElement | undefined | null>;
  bodyRef: Ref<HTMLElement | undefined | null>;
  /** Which way the chapter runs; a paged one runs across. */
  axis?: MaybeRefOrGetter<ReadingAxis>;
  /** Snap the spoken sentence onto a page. Off for scrolled 古籍. */
  paged?: MaybeRefOrGetter<boolean>;
  chapterIndex: Ref<number>;
  hasNext: Ref<boolean>;
  transView: Ref<TransView>;
  translating: Ref<boolean>;
  hasTranslation: Ref<boolean>;
  displayBody: Ref<string>;
  currentRatio: () => number;
  goTo: (index: number, ratio?: number) => void;
  /** Stop auto-scroll when the voice starts — two things reading the page is a fight. */
  stopAuto: () => void;
  /** Last sentence of the last chapter — honour markFinishedAtEnd. */
  onBookEnd?: () => void;
  /** BCP 47 tag from the book, used when no voice is saved. */
  lang?: () => string;
}) {
  const axis = (): ReadingAxis => toValue(opts.axis) ?? "y";
  const snapPaged = (): boolean => toValue(opts.paged) ?? false;
  const speechRate = useQuery({
    queryKey: ["setting", "speech_rate"],
    queryFn: () => api.getSetting("speech_rate"),
  });
  const speechVoice = useQuery({
    queryKey: ["setting", "speech_voice"],
    queryFn: () => api.getSetting("speech_voice"),
  });

  let sentences: Sentence[] = [];
  /** The plain text the current queue was split from. A body rewrite that leaves
   *  this string alone (bilingual view filling in its translation column, for
   *  example) must not stop the voice — the offsets still point at the same
   *  characters. */
  let spokenBasis = "";
  /** Set while the voice is carrying itself into the next chapter. */
  let speakOnLoad = false;

  const speech = useSpeech({
    rate: () => Number(speechRate.data.value ?? 1) || 1,
    voice: () => speechVoice.data.value ?? "",
    onSentence: (i) => showSpoken(sentences[i]),
    // A book does not stop at a chapter boundary; neither should the voice.
    onDone: () => {
      if (!opts.hasNext.value) {
        opts.onBookEnd?.();
        return;
      }
      speakOnLoad = true;
      opts.goTo(opts.chapterIndex.value + 1);
    },
    lang: () => opts.lang?.() ?? "",
  });

  /** In the bilingual view the page holds every sentence twice. Reading both
   *  sides is not a reading of the chapter. Drop the translation column. */
  function speechExclude(): string | undefined {
    return opts.transView.value === "bilingual" ? ".bi-tr" : undefined;
  }

  function showSpoken(s: Sentence | undefined) {
    const body = opts.bodyRef.value;
    const el = opts.scrollRef.value;
    if (!body || !el || !s) return;
    const ranges = rangesFor(body, s.start, s.end, speechExclude());
    paintSpoken(ranges);
    const first = ranges[0];
    if (!first) return;
    // A third of the way in, so the sentence being read has what comes next
    // under it rather than sitting at the very edge — and on whichever axis
    // the chapter runs.
    const ax = axis();
    const m = metrics(el, ax);
    const box = first.getBoundingClientRect();
    const view = el.getBoundingClientRect();
    const lead = leadFromView(view, box, ax);
    const near = !isAcross(ax)
      ? box.top >= view.top + 40 && box.bottom <= view.bottom - 40
      : ax === "x-rtl"
        ? Math.abs(lead) < m.view * 0.35
        : box.left >= view.left + 20 && box.right <= view.right - 20;
    if (!near) {
      // A third of the way in down a scrolled chapter; the page it is on
      // across a paged one. Scrolled 古籍 has no page grid — snap=false.
      const to = !isAcross(ax)
        ? m.at + lead - m.view / 3
        : settle(m, ax, m.at + lead, "contain", snapPaged());
      scrollTo(el, ax, to, true);
    }
  }

  function paintSpoken(ranges: Range[]) {
    const apiHl = (window as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const Ctor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!apiHl || !Ctor) return;
    if (!ranges.length) apiHl.delete("hiread-spoken");
    else apiHl.set("hiread-spoken", new Ctor(...ranges));
  }

  /** Start reading the chapter on screen. `fromTop` is the hand-off from the
   *  previous chapter; otherwise the sentence at the top of the viewport. */
  function speakChapter(fromTop = false) {
    const body = opts.bodyRef.value;
    const el = opts.scrollRef.value;
    if (!body || !el) return;
    const exclude = speechExclude();
    spokenBasis = readingText(body, exclude);
    sentences = splitSentences(spokenBasis);
    if (!sentences.length) {
      // A title page or image-only chapter is not the end of the book.
      // Hand the voice to the next chapter instead of dying mid-read.
      if (fromTop && opts.hasNext.value) {
        speakOnLoad = true;
        opts.goTo(opts.chapterIndex.value + 1);
      } else {
        stopSpeech();
      }
      return;
    }

    let offset = 0;
    if (!fromTop) {
      const box = body.getBoundingClientRect();
      const view = el.getBoundingClientRect();
      // The sentence to start from is the one at the leading edge of the
      // view: down a scrolled chapter that is the article's centre (a third
      // in), across a paged one the page's start (the viewport's left edge),
      // and in a vertical (古籍) column the viewport's right edge — the
      // reading-start of the column in view.
      const ax = axis();
      const at = !isAcross(ax)
        ? offsetAtPoint(body, box.left + box.width / 2, view.top + 8, exclude)
        : offsetAtPoint(body, leadingViewX(view, ax), view.top + 8, exclude);
      offset =
        at ?? Math.floor(opts.currentRatio() * (sentences[sentences.length - 1]?.end ?? 0));
    }

    opts.stopAuto();
    speech.start(sentences, sentenceAt(sentences, offset));
  }

  function speakFromHere() {
    speakChapter(false);
  }

  function toggleSpeech() {
    if (!speech.speaking.value) speakFromHere();
    else if (speech.paused.value) speech.resume();
    else speech.pause();
  }

  function stopSpeech() {
    speakOnLoad = false;
    spokenBasis = "";
    speech.stop();
    paintSpoken([]);
  }

  /** Start the voice that was handed off from the previous chapter, once the
   *  page it is going to read is ready. */
  function trySpeakOnLoad() {
    if (!speakOnLoad) return;
    if (opts.transView.value === "translation" && opts.translating.value) return;
    if (opts.transView.value === "translation" && !opts.hasTranslation.value) {
      speakOnLoad = false;
      return;
    }
    speakOnLoad = false;
    speakChapter(true);
  }

  // A chapter turn the reader made themselves ends the reading. The voice's own
  // turn into the next chapter is the exception — see speakOnLoad.
  watch(
    () => opts.chapterIndex.value,
    () => {
      if (speakOnLoad) return;
      stopSpeech();
    },
  );

  watch(
    () => opts.displayBody.value,
    async () => {
      if (!speech.speaking.value) return;
      await nextTick();
      const body = opts.bodyRef.value;
      if (!body || readingText(body, speechExclude()) !== spokenBasis) stopSpeech();
    },
  );

  // Prefetch / a fresh request may land after the body has painted.
  watch([() => opts.hasTranslation.value, () => opts.translating.value], () => trySpeakOnLoad());

  onBeforeUnmount(stopSpeech);

  return {
    speech,
    speakChapter,
    speakFromHere,
    toggleSpeech,
    stopSpeech,
    trySpeakOnLoad,
  };
}
