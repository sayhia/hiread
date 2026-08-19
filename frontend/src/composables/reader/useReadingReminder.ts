// The part of the break reminder that needs a window: a clock, whether the
// window is in front, and when the reader last did anything. The decision
// itself is in lib/reading/reminder, where it can be checked against an hour
// passing in every way an hour can pass without an hour of reading in it.

import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useUi } from "../../stores/ui";
import { toast } from "../../stores/toasts";
import { startReading, tick, type ReminderState } from "../../lib/reading/reminder";

/** How often to look. Often enough that a threshold is not overshot by much,
 *  rarely enough to cost nothing — and a tick that arrives late is capped
 *  where the decision is made, not here. */
const EVERY_MS = 10_000;

export function useReadingReminder(opts: {
  /** The element a reader touches while reading. */
  scrollRef: { value: HTMLElement | undefined | null };
}) {
  const ui = useUi();
  const { t } = useI18n();

  const state = ref<ReminderState>(startReading());
  let lastActivity = Date.now();
  let timer: number | undefined;

  const noteActivity = () => {
    lastActivity = Date.now();
  };

  function step() {
    const now = Date.now();
    const r = tick(state.value, {
      at: now,
      visible: document.visibilityState === "visible",
      lastActivity,
      everyMs: ui.readerRemindAfter * 60_000,
    });
    if (r.remind) {
      // Said with the reading in it rather than as an instruction: the reader
      // knows whether they want to stop. The number is the interval they asked
      // for, which is what just elapsed — the accumulator can overshoot it by
      // up to one tick, and "you have been reading for 30 minutes" is the
      // sentence they set up.
      toast.show(t("reading.remind", { n: ui.readerRemindAfter }));
    }
    state.value = r.state;
  }

  onMounted(() => {
    const el = opts.scrollRef.value;
    el?.addEventListener("scroll", noteActivity, { passive: true });
    window.addEventListener("keydown", noteActivity);
    window.addEventListener("pointerdown", noteActivity);
    timer = window.setInterval(step, EVERY_MS);
  });

  onBeforeUnmount(() => {
    const el = opts.scrollRef.value;
    el?.removeEventListener("scroll", noteActivity);
    window.removeEventListener("keydown", noteActivity);
    window.removeEventListener("pointerdown", noteActivity);
    window.clearInterval(timer);
  });

  return { noteActivity };
}
