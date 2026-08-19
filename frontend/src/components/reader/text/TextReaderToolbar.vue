<script setup lang="ts">
// Top chrome for the text reader: a frosted bar that groups navigation on the
// left, the book/chapter title in the centre, and the actions a reader reaches
// for while reading on the right. Secondary actions (bookmark, summary, book
// flags) live under a single "more" menu so the bar stays scannable.

import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useUi } from "../../../stores/ui";
import { useDismiss } from "../../../composables/useDismiss";
import { useMenuKeyboard } from "../../../composables/useMenuKeyboard";
import { swallowPageClick } from "../../../composables/reader/useTextReaderInput";
import { isMac } from "../../../lib/platform";
import type { TransView } from "../../../types";
import Icon from "../../Icon.vue";
import TranslatePopover from "../shared/TranslatePopover.vue";
import ReaderTypography from "../shared/ReaderTypography.vue";

const props = defineProps<{
  bookId: number;
  bookTitle: string;
  chapterTitle?: string;
  scrolled: boolean;
  chromeVisible: boolean;
  tocOpen: boolean;
  typeOpen: boolean;
  summaryOpen: boolean;
  moreOpen: boolean;
  transOpen: boolean;
  transView: TransView;
  targetLang: string;
  engine: string;
  translating: boolean;
  hasTranslation: boolean;
  jobDone: number;
  jobTotal: number;
  isFavorite: boolean;
  isFinished: boolean;
  speechSupported: boolean;
  speechSpeaking: boolean;
  speechPaused: boolean;
  autoScrolling: boolean;
  onToggleToc: () => void;
  onToggleType: () => void;
  onToggleSummary: () => void;
  onToggleMore: () => void;
  onCloseMore: () => void;
  onAddBookmark: () => void;
  onToggleTranslation: () => void;
  onToggleTransOpen: () => void;
  onPickView: (v: TransView) => void;
  onPickLang: (v: string) => void;
  onPickEngine: (v: string) => void;
  onCloseTrans: () => void;
  onFavorite: () => void;
  onFinish: () => void;
  onToggleSpeech: () => void;
  onStopSpeech: () => void;
  onToggleAuto: () => void;
  onCloseType: () => void;
  onOpenSettings: (section?: string) => void;
}>();

const { t } = useI18n();
const ui = useUi();

const moreEl = ref<HTMLDivElement>();
const moreMenuEl = ref<HTMLDivElement>();
useDismiss(moreEl, () => {
  swallowPageClick();
  props.onCloseMore();
}, { enabled: () => props.moreOpen });
const onMoreKey = useMenuKeyboard(moreMenuEl, () => props.moreOpen);
watch(
  () => props.moreOpen,
  async (on) => {
    if (!on) {
      moreEl.value?.querySelector<HTMLElement>(":scope > .tb-btn")?.focus();
      return;
    }
    await nextTick();
    moreMenuEl.value?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  },
);

function pickMore(fn: () => void) {
  props.onCloseMore();
  fn();
}

const titlePrimary = computed(() => props.chapterTitle || props.bookTitle);
const titleSecondary = computed(() =>
  props.chapterTitle && props.chapterTitle !== props.bookTitle ? props.bookTitle : "",
);

const speechIcon = computed(() =>
  props.speechPaused ? "play" : props.speechSpeaking ? "pause" : "headphones",
);
const speechLabel = computed(() => {
  if (props.speechPaused) return t("reader.readAloudResume");
  if (props.speechSpeaking) return t("reader.readAloudPause");
  return t("reader.readAloud");
});
const autoLabel = computed(() =>
  props.autoScrolling ? t("reader.autoScrollPause") : t("reader.autoScroll"),
);
</script>

<template>
  <div
    class="reader-chrome"
    :class="{ hidden: !chromeVisible }"
    role="banner"
  >
    <div class="reader-toolbar reader-toolbar-v2" v-bind="isMac ? { 'data-tauri-drag-region': true } : {}">
      <div class="tb-cluster-start">
        <button
          :class="['tb-btn', tocOpen ? 'on' : '']"
          @click="onToggleToc"
          :title="t('reader.toc')"
          :aria-label="t('reader.toc')"
          :aria-expanded="tocOpen"
        >
          <Icon name="toc" :size="16" />
        </button>
      </div>

      <div class="tb-title-stack">
        <span class="tb-title-primary" :title="titlePrimary">{{ titlePrimary }}</span>
        <span v-if="titleSecondary" class="tb-title-secondary" :title="titleSecondary">{{ titleSecondary }}</span>
      </div>

      <div class="tb-cluster-end">
        <div class="tb-cluster">
          <button
            :class="['tb-btn', 'tb-type', typeOpen ? 'on' : '']"
            @click="onToggleType"
            :title="t('reader.type.title')"
            :aria-label="t('reader.type.title')"
            :aria-expanded="typeOpen"
          >
            <span class="tb-aa" aria-hidden="true">Aa</span>
          </button>

          <div class="tb-trans">
            <button
              :class="['tb-btn', 'tb-trans-main', transView !== 'original' ? 'on' : '']"
              @click="onToggleTranslation"
              :title="t('reader.tbTranslate')"
              :aria-label="t('reader.tbTranslate')"
              :aria-pressed="transView !== 'original'"
            >
              <Icon v-if="!translating" name="translate" :size="16" />
              <Icon v-else name="refresh" :size="16" class="spinning" />
            </button>
            <button
              :class="[
                'tb-btn',
                'tb-trans-caret',
                transView !== 'original' ? 'on' : '',
                transOpen ? 'open' : '',
              ]"
              @click="onToggleTransOpen"
              :title="t('reader.translateOptions')"
              :aria-label="t('reader.translateOptions')"
              :aria-expanded="transOpen"
            >
              <Icon name="chevron-down" :size="12" />
            </button>
            <TranslatePopover
              v-if="transOpen"
              :view="transView"
              :lang="targetLang"
              :engine="engine"
              :busy="translating"
              :done="jobDone"
              :total="jobTotal"
              :translated="hasTranslation"
              :on-view="onPickView"
              :on-lang="onPickLang"
              :on-engine="onPickEngine"
              :on-close="onCloseTrans"
            />
          </div>

          <button
            v-if="speechSupported"
            :class="['tb-btn', speechSpeaking ? 'on' : '']"
            @click="onToggleSpeech"
            @contextmenu.prevent="onStopSpeech"
            :title="speechLabel"
            :aria-label="speechLabel"
            :aria-pressed="speechSpeaking"
          >
            <Icon :name="speechIcon" :size="16" />
          </button>
          <button
            :class="['tb-btn', autoScrolling ? 'on' : '']"
            @click="onToggleAuto"
            :title="autoLabel"
            :aria-label="autoLabel"
            :aria-pressed="autoScrolling"
          >
            <Icon :name="autoScrolling ? 'pause' : 'play'" :size="16" />
          </button>

          <div class="tb-more" ref="moreEl">
            <button
              :class="['tb-btn', moreOpen || summaryOpen ? 'on' : '']"
              @click="onToggleMore"
              :title="t('reader.more')"
              :aria-label="t('reader.more')"
              :aria-expanded="moreOpen"
              :aria-haspopup="true"
            >
              <Icon name="more" :size="16" />
            </button>
            <div v-if="moreOpen" ref="moreMenuEl" class="tb-more-menu" role="menu" @keydown="onMoreKey">
              <button role="menuitem" @click="pickMore(onAddBookmark)">
                <Icon name="bookmark" :size="14" />
                {{ t("reader.addBookmark") }}
              </button>
              <button
                role="menuitem"
                :class="{ on: summaryOpen }"
                @click="pickMore(onToggleSummary)"
              >
                <Icon name="sparkle" :size="14" />
                {{ t("reader.summarize") }}
              </button>
              <div class="tb-more-sep" />
              <button role="menuitem" :class="{ on: isFavorite }" @click="pickMore(onFavorite)">
                <Icon :name="isFavorite ? 'star-fill' : 'star'" :size="14" />
                {{ isFavorite ? t("library.unfavorite") : t("library.favorite") }}
              </button>
              <button role="menuitem" :class="{ on: isFinished }" @click="pickMore(onFinish)">
                <Icon name="check-all" :size="14" />
                {{ isFinished ? t("library.markUnfinished") : t("library.markFinished") }}
              </button>
              <button
                role="menuitem"
                :class="{ on: ui.focusMode }"
                @click="pickMore(() => ui.setFocusMode(!ui.focusMode))"
              >
                <Icon name="focus" :size="14" />
                {{ t("reader.focus") }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <ReaderTypography
      v-if="typeOpen"
      :book-id="bookId"
      :on-close="onCloseType"
      :on-open-settings="
        () => {
          onCloseType();
          onOpenSettings('reading');
        }
      "
    />
  </div>
</template>
