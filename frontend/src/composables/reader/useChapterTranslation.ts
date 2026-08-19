// A translation belongs to a chapter, not to the reader: it keeps running while
// the page is turned, and a chapter already translated into this language comes
// back from the cache instead of being paid for again.
//
// While a chapter is being read, the next one is translated in the background,
// so turning the page lands on a translation that is already there. Only ever
// one chapter ahead, and only while translation is actually on.

import { computed, ref, watch, type Ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import * as api from "../../api";
import { interleaveBlocks, topLevelBlocks } from "../../lib/bilingual";
import { jobKey, useTranslationJobs } from "../../stores/translation";
import type { TransView } from "../../types";

export function useChapterTranslation(opts: {
  bookId: Ref<number | null | undefined>;
  chapterIndex: Ref<number>;
  chapterCount: Ref<number>;
  chapterHtml: Ref<string>;
  chapterTitle: Ref<string>;
  locale: Ref<string>;
}) {
  const jobs = useTranslationJobs();

  const transOpen = ref(false);
  const transView = ref<TransView>("original");
  /** The view to return to when translation is switched back on, so a reader who
   *  chose bilingual gets bilingual again rather than plain translation. */
  const lastTransView = ref<Exclude<TransView, "original">>("translation");

  const transSettings = useQuery({
    queryKey: ["setting", "translate_target_lang"],
    queryFn: () => api.getSetting("translate_target_lang"),
  });
  const engineSetting = useQuery({
    queryKey: ["setting", "translate_engine"],
    queryFn: () => api.getSetting("translate_engine"),
  });
  /** Translate every chapter as it opens, without asking each time. */
  const autoSetting = useQuery({
    queryKey: ["setting", "translate_auto"],
    queryFn: () => api.getSetting("translate_auto"),
  });
  const autoTranslate = computed(() => autoSetting.data.value === "1");
  /** A per-session override of the stored defaults; null follows the settings. */
  const tmpLang = ref<string | null>(null);
  const tmpEngine = ref<string | null>(null);
  const targetLang = computed(() => tmpLang.value ?? transSettings.data.value ?? opts.locale.value);
  const engine = computed(() => tmpEngine.value ?? engineSetting.data.value ?? "llm");

  const transKey = computed(() =>
    opts.bookId.value == null ? "" : jobKey(opts.bookId.value, opts.chapterIndex.value),
  );

  /** The live job for this chapter, if one is running for this exact target. */
  const job = computed(() => {
    const j = jobs.jobs[transKey.value];
    return j && j.lang === targetLang.value && j.engine === engine.value ? j : undefined;
  });
  const translating = computed(() => job.value?.status === "translating");

  /** A finished translation already stored for this chapter and target. */
  const cached = useQuery({
    queryKey: computed(
      () =>
        ["translation", opts.bookId.value, opts.chapterIndex.value, targetLang.value, engine.value] as const,
    ),
    queryFn: () =>
      api.getTranslation(
        opts.bookId.value as number,
        opts.chapterIndex.value,
        targetLang.value,
        engine.value,
      ),
    enabled: computed(() => opts.bookId.value != null),
  });

  /** The translated body: whatever the running job has produced so far, else the
   *  stored copy. */
  const translatedHtml = computed(() => {
    if (job.value && job.value.html) return job.value.html;
    if (job.value?.status === "translating") return "";
    return cached.data.value?.html ?? "";
  });
  const hasTranslation = computed(() => translatedHtml.value !== "");

  const originalBlocks = computed(() => topLevelBlocks(opts.chapterHtml.value));

  /** What the body actually renders: the chapter, the translation, or the two
   *  interleaved. */
  const displayBody = computed(() => {
    const original = opts.chapterHtml.value;
    if (transView.value === "original") return original;
    const tr = translatedHtml.value;
    if (transView.value === "bilingual") {
      return interleaveBlocks(originalBlocks.value, tr ? topLevelBlocks(tr) : []);
    }
    // Nothing translated yet: keep the original on screen rather than blanking
    // the page while the first batch is in flight.
    return tr || original;
  });

  /** The translated title, once there is one. */
  const displayTitle = computed(() => {
    if (transView.value === "original") return opts.chapterTitle.value;
    return job.value?.title || cached.data.value?.title || opts.chapterTitle.value;
  });

  function startTranslation() {
    const id = opts.bookId.value;
    if (id == null) return;
    jobs.translate(id, opts.chapterIndex.value, targetLang.value, engine.value);
  }

  /** The toolbar button: turn translation on (translating if needed), or off. */
  function toggleTranslation() {
    if (transView.value !== "original") {
      lastTransView.value = transView.value;
      transView.value = "original";
      return;
    }
    transView.value = lastTransView.value;
    if (!hasTranslation.value && !translating.value) startTranslation();
  }

  function pickView(v: TransView) {
    transView.value = v;
    if (v !== "original") {
      lastTransView.value = v;
      if (!hasTranslation.value && !translating.value) startTranslation();
    }
  }

  function pickLang(v: string) {
    tmpLang.value = v;
    if (transView.value !== "original") startTranslation();
  }

  function pickEngine(v: string) {
    tmpEngine.value = v;
    if (transView.value !== "original") startTranslation();
  }

  // A finished job is now in the database; refetch so the cache serves it next
  // time and the job's copy stops being the source of truth.
  watch(
    () => job.value?.status,
    (status) => {
      if (status === "done") cached.refetch();
    },
  );

  // Turning the page keeps the mode you were reading in.
  watch(
    () => opts.chapterIndex.value,
    () => {
      transOpen.value = false;
      if (transView.value !== "original") startTranslation();
    },
  );

  const prefetching = ref<string>("");
  async function prefetchNext() {
    const id = opts.bookId.value;
    if (id == null) return;
    const next = opts.chapterIndex.value + 1;
    if (next >= opts.chapterCount.value) return;

    const key = `${id}:${next}:${targetLang.value}:${engine.value}`;
    if (prefetching.value === key) return;
    prefetching.value = key;
    try {
      const stored = await api.getTranslation(id, next, targetLang.value, engine.value);
      if (stored) return;
      if (transView.value === "original" || opts.chapterIndex.value + 1 !== next) return;
      jobs.translate(id, next, targetLang.value, engine.value);
    } catch {
      /* a prefetch is an optimisation: it fails silently */
    }
  }

  watch(
    [hasTranslation, transView, () => opts.chapterIndex.value],
    () => {
      if (hasTranslation.value && transView.value !== "original") prefetchNext();
    },
    { immediate: true },
  );

  // With auto-translate on, opening a chapter translates it.
  watch(
    [autoTranslate, () => opts.chapterIndex.value, () => opts.chapterHtml.value],
    () => {
      if (!autoTranslate.value || !opts.chapterHtml.value) return;
      if (transView.value === "original") transView.value = lastTransView.value;
      if (!hasTranslation.value && !translating.value) startTranslation();
    },
    { immediate: true },
  );

  return {
    transOpen,
    transView,
    targetLang,
    engine,
    job,
    translating,
    hasTranslation,
    displayBody,
    displayTitle,
    toggleTranslation,
    pickView,
    pickLang,
    pickEngine,
  };
}
