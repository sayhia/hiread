// Chapter turns and the book flags that live next to them.
//
// goTo is the one path that actually changes the chapter: next/prev, the
// contents, a bookmark, a highlight, the voice and auto-scroll all funnel
// through it so progress is saved once and the panels that belong to the
// previous chapter close.

import { computed, unref, type MaybeRef } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useI18n } from "vue-i18n";
import * as api from "../../api";
import { useUi } from "../../stores/ui";
import { reportError } from "../../stores/toasts";

export function useChapterNav(opts: {
  bookId: MaybeRef<number>;
  isFavorite: MaybeRef<boolean> | (() => boolean);
  isFinished: MaybeRef<boolean> | (() => boolean);
  chapterIndex: { value: number };
  chapterCount: MaybeRef<number>;
  chapterTitle: MaybeRef<string>;
  saveProgress: () => void;
  setRestoreRatio: (ratio: number) => void;
  restorePosition?: () => void | Promise<void>;
  markReady: () => void;
  markNotReady: () => void;
  currentRatio: () => number;
  yieldMotion: () => void;
  stopAuto: () => void;
  onToast: (text: string) => void;
  closePanels: () => void;
}) {
  const qc = useQueryClient();
  const ui = useUi();
  const { t } = useI18n();

  const bookId = () => unref(opts.bookId);
  const chapterCount = () => unref(opts.chapterCount);
  const chapterTitle = () => unref(opts.chapterTitle);
  const fav = () =>
    typeof opts.isFavorite === "function" ? opts.isFavorite() : unref(opts.isFavorite);
  const fin = () =>
    typeof opts.isFinished === "function" ? opts.isFinished() : unref(opts.isFinished);

  const hasPrev = computed(() => opts.chapterIndex.value > 0);
  const hasNext = computed(() => opts.chapterIndex.value < chapterCount() - 1);

  function goTo(index: number, ratio = 0) {
    if (index < 0 || index >= chapterCount()) return;
    if (index === opts.chapterIndex.value) {
      opts.closePanels();
      if (ratio > 0) {
        opts.setRestoreRatio(ratio);
        void opts.restorePosition?.();
      }
      return;
    }
    opts.saveProgress();
    opts.chapterIndex.value = index;
    opts.setRestoreRatio(ratio);
    opts.closePanels();
    const id = bookId();
    // The scroller still shows the old chapter until the new html paints.
    // Leaving positionReady true let a pending debounce write the old
    // ratio under the new index.
    opts.markNotReady();
    api.saveProgress(id, index, ratio, 1).catch(() => {});
    qc.invalidateQueries({ queryKey: ["books"] });
  }

  function goToByUser(index: number, ratio = 0) {
    opts.yieldMotion();
    goTo(index, ratio);
  }

  function maybeFinish() {
    if (ui.prefs.markFinishedAtEnd && !fin()) finish();
  }

  function next() {
    opts.yieldMotion();
    if (hasNext.value) goTo(opts.chapterIndex.value + 1);
    else maybeFinish();
  }

  function prev() {
    opts.yieldMotion();
    if (hasPrev.value) goTo(opts.chapterIndex.value - 1);
  }

  function finish() {
    const id = bookId();
    const wasFinished = fin();
    api
      .setBookFlag(id, "finished", !wasFinished)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["book", id] });
        qc.invalidateQueries({ queryKey: ["books"] });
        qc.invalidateQueries({ queryKey: ["libraryCounts"] });
        opts.onToast(wasFinished ? t("reader.markedUnfinished") : t("reader.markedFinished"));
      })
      .catch(reportError);
  }

  function toggleFavorite() {
    const id = bookId();
    api
      .setBookFlag(id, "favorite", !fav())
      .then(() => {
        qc.invalidateQueries({ queryKey: ["book", id] });
        qc.invalidateQueries({ queryKey: ["books"] });
      })
      .catch(reportError);
  }

  function addBookmark() {
    const id = bookId();
    api
      .addBookmark(id, opts.chapterIndex.value, opts.currentRatio(), null, chapterTitle())
      .then(() => {
        qc.invalidateQueries({ queryKey: ["bookmarks", id] });
        opts.onToast(t("reader.bookmarkAdded"));
      })
      .catch(reportError);
  }

  function focusHighlight(index: number, highlightId: number) {
    ui.pendingHighlightId = highlightId;
    if (index === opts.chapterIndex.value) {
      opts.yieldMotion();
      opts.closePanels();
    } else {
      goToByUser(index);
    }
  }

  return {
    hasPrev,
    hasNext,
    goTo,
    goToByUser,
    next,
    prev,
    finish,
    maybeFinish,
    toggleFavorite,
    addBookmark,
    focusHighlight,
  };
}
