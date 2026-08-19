// Reading a chapter aloud.
//
// The voice is the platform's — WKWebView carries the system's, which on macOS
// includes Chinese ones — so what this owns is everything around it: which
// sentence is being spoken, moving to the next one, and stopping cleanly.
//
// One sentence is spoken at a time rather than the chapter being queued in one
// go. Queuing would be smoother between sentences, but nothing would then know
// where the voice is, stopping would take effect a paragraph later, and the
// reader could not be shown the line being read.

import { computed, onBeforeUnmount, ref } from "vue";
import type { Sentence } from "../lib/sentences";

export interface SpeechOptions {
  /** 0.5–2, where 1 is the voice's own pace. */
  rate: () => number;
  /** The voice's name, or "" for the platform's default. */
  voice: () => string;
  /** Called as each sentence starts, so the view can show where the voice is. */
  onSentence?: (index: number) => void;
  /** Called when the queue runs out on its own — not on a stop or a skip.
   *  Lets the reader carry the voice into the next chapter the way auto-scroll
   *  carries the page. */
  onDone?: () => void;
  /** Book / UI language when no saved voice is set. */
  lang?: () => string;
}

/** Whether this webview can speak at all. */
export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export function useSpeech(opts: SpeechOptions) {
  const speaking = ref(false);
  const paused = ref(false);
  const index = ref(-1);
  const supported = speechSupported();

  let queue: Sentence[] = [];
  /** Bumped on every stop, so an utterance that ends after we have moved on
   *  cannot advance the new run. */
  let token = 0;

  /** Telling the view where the voice is must never stop the voice. Painting a
   *  range or scrolling to it touches the DOM, and if that throws — an API the
   *  browser does not have, an element that has gone — the reading would
   *  simply never start, which is a strange way for a stylesheet to fail. */
  function notify(i: number) {
    try {
      opts.onSentence?.(i);
    } catch {
      /* the voice carries on; the reader loses the highlight, not the page */
    }
  }

  const voices = ref<SpeechSynthesisVoice[]>([]);
  function refreshVoices() {
    if (!supported) return;
    voices.value = window.speechSynthesis.getVoices();
  }
  if (supported) {
    refreshVoices();
    // Some platforms populate the list asynchronously.
    window.speechSynthesis.addEventListener?.("voiceschanged", refreshVoices);
  }

  function cleanup() {
    stop();
    if (supported) window.speechSynthesis.removeEventListener?.("voiceschanged", refreshVoices);
  }

  let keepAlive: ReturnType<typeof setInterval> | undefined;
  function armKeepAlive() {
    if (keepAlive != null) return;
    keepAlive = setInterval(() => {
      if (!speaking.value || paused.value) return;
      try {
        window.speechSynthesis.resume();
      } catch {
        /* some engines throw if nothing is paused */
      }
    }, 10_000);
  }
  function disarmKeepAlive() {
    if (keepAlive != null) {
      clearInterval(keepAlive);
      keepAlive = undefined;
    }
  }

  function speakCurrent() {
    if (!supported || index.value < 0 || index.value >= queue.length) {
      stop();
      return;
    }
    const mine = token;
    const u = new SpeechSynthesisUtterance(queue[index.value].text);
    u.rate = Math.min(2, Math.max(0.5, opts.rate()));
    const wanted = opts.voice();
    if (wanted) {
      const v = voices.value.find((x) => x.name === wanted);
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      }
    } else {
      const lang = (opts.lang?.() || document.documentElement.lang || "").trim();
      if (lang) u.lang = lang;
      const prefix = lang.slice(0, 2).toLowerCase();
      if (prefix) {
        const match = voices.value.find((x) => x.lang.toLowerCase().startsWith(prefix));
        if (match) {
          u.voice = match;
          u.lang = match.lang;
        }
      }
    }
    let advanced = false;
    const advance = () => {
      if (mine !== token || advanced) return;
      advanced = true;
      index.value += 1;
      if (index.value >= queue.length) {
        queue = [];
        index.value = -1;
        speaking.value = false;
        paused.value = false;
        token += 1;
        disarmKeepAlive();
        try {
          opts.onDone?.();
        } catch {
          /* carrying on is optional; a thrown handler must not revive us */
        }
        return;
      }
      notify(index.value);
      speakCurrent();
    };
    u.onend = advance;
    u.onerror = (ev) => {
      const err = (ev as SpeechSynthesisErrorEvent).error;
      if (err === "canceled" || err === "interrupted") return;
      advance();
    };
    armKeepAlive();
    window.speechSynthesis.speak(u);
  }

  /** Start reading `sentences`, from `from`. */
  function start(sentences: Sentence[], from = 0) {
    if (!supported || !sentences.length) return;
    stop();
    queue = sentences;
    index.value = Math.min(Math.max(0, from), sentences.length - 1);
    speaking.value = true;
    paused.value = false;
    // The voice first: the view is told where it is, not asked for permission.
    speakCurrent();
    notify(index.value);
  }

  function stop() {
    token += 1;
    queue = [];
    index.value = -1;
    speaking.value = false;
    paused.value = false;
    disarmKeepAlive();
    if (supported) window.speechSynthesis.cancel();
  }

  function pause() {
    if (!supported || !speaking.value || paused.value) return;
    paused.value = true;
    window.speechSynthesis.pause();
  }

  function resume() {
    if (!supported || !paused.value) return;
    paused.value = false;
    window.speechSynthesis.resume();
  }

  /** Skip a sentence in either direction, from wherever the voice is. */
  function skip(by: 1 | -1) {
    if (!speaking.value || !queue.length) return;
    const next = Math.min(queue.length - 1, Math.max(0, index.value + by));
    const sentences = queue;
    start(sentences, next);
  }

  onBeforeUnmount(cleanup);

  return {
    supported,
    speaking,
    paused,
    index,
    voices: computed(() => voices.value),
    start,
    stop,
    pause,
    resume,
    skip,
  };
}
