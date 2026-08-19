<script setup lang="ts">
// The actions that belong to the book rather than to the format it is in:
// whether it is a favourite, whether it is finished, and whether the window is
// out of the way. Every reading screen carries them, and they mean the same
// thing on each — so they live here rather than being written out twice and
// drifting apart.

import { useI18n } from "vue-i18n";
import { useUi } from "../../../stores/ui";
import Icon from "../../Icon.vue";

defineProps<{ isFavorite: boolean; isFinished: boolean }>();
const emit = defineEmits<{ (e: "favorite"): void; (e: "finish"): void }>();

const { t } = useI18n();
const ui = useUi();
</script>

<template>
  <button
    :class="['tb-btn', isFavorite ? 'on' : '']"
    @click="emit('favorite')"
    :title="isFavorite ? t('library.unfavorite') : t('library.favorite')"
    :aria-label="isFavorite ? t('library.unfavorite') : t('library.favorite')"
    :aria-pressed="isFavorite"
  >
    <Icon :name="isFavorite ? 'star-fill' : 'star'" :size="16" />
  </button>
  <button
    :class="['tb-btn', isFinished ? 'on' : '']"
    @click="emit('finish')"
    :title="isFinished ? t('library.markUnfinished') : t('library.markFinished')"
    :aria-label="isFinished ? t('library.markUnfinished') : t('library.markFinished')"
    :aria-pressed="isFinished"
  >
    <Icon name="check-all" :size="16" />
  </button>
  <button
    :class="['tb-btn', ui.focusMode ? 'on' : '']"
    @click="ui.setFocusMode(!ui.focusMode)"
    :title="t('reader.focus')"
    :aria-label="t('reader.focus')"
    :aria-pressed="ui.focusMode"
  >
    <Icon name="focus" :size="16" />
  </button>
</template>
