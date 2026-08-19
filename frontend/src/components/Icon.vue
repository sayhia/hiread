<script setup lang="ts">
// Minimal stroke icon set.
// Icons are decorative — every place that renders one also supplies a text
// label or an aria-label, so the SVG is hidden from assistive tech.

export type IconName =
  | "circle" | "star" | "star-fill" | "bookmark"
  | "bookmark-fill" | "clock" | "tag" | "folder" | "search"
  | "plus" | "check" | "check-all" | "sort" | "sparkle" | "sparkle-fill"
  | "open" | "share" | "send" | "more" | "refresh" | "settings" | "chevron-down"
  | "chevron-right" | "globe" | "translate" | "focus" | "arrow-down" | "arrow-up"
  | "eye" | "eye-off" | "trash" | "mute" | "pin" | "x" | "command"
  | "copy" | "list" | "grid" | "text" | "alert" | "hiread"
  | "play" | "pause" | "skip-back" | "skip-fwd" | "headphones"
  | "highlighter" | "book" | "books" | "toc";

const STROKE = 1.6;

const props = withDefaults(
  defineProps<{
    name: IconName;
    size?: number;
    color?: string;
  }>(),
  {
    size: 16,
    color: "currentColor",
  },
);
</script>

<template>
  <!-- stroke icons -->
  <svg
    v-if="name === 'circle'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <circle cx="12" cy="12" r="8" />
  </svg>

  <svg
    v-else-if="name === 'star'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M12 3.5l2.7 5.4 6 .9-4.3 4.2 1 6-5.4-2.8L6.6 20l1-6L3.3 9.8l6-.9z" />
  </svg>

  <svg
    v-else-if="name === 'star-fill'"
    :width="size" :height="size" viewBox="0 0 24 24" :fill="color" aria-hidden="true"
  >
    <path d="M12 3.5l2.7 5.4 6 .9-4.3 4.2 1 6-5.4-2.8L6.6 20l1-6L3.3 9.8l6-.9z" />
  </svg>

  <svg
    v-else-if="name === 'bookmark'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M6 4h12v17l-6-3.5L6 21z" />
  </svg>

  <svg
    v-else-if="name === 'bookmark-fill'"
    :width="size" :height="size" viewBox="0 0 24 24" :fill="color" aria-hidden="true"
  >
    <path d="M6 4h12v17l-6-3.5L6 21z" />
  </svg>

  <svg
    v-else-if="name === 'clock'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3 2" />
  </svg>

  <svg
    v-else-if="name === 'tag'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M3 12V4h8l10 10-8 8-10-10z" />
    <circle cx="7.5" cy="7.5" r="1.2" :fill="color" stroke="none" />
  </svg>

  <svg
    v-else-if="name === 'folder'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>

  <!-- An open book, seen from above: the reading surface itself. -->
  <svg
    v-else-if="name === 'book'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M12 6.5C10.5 5.2 8.6 4.6 6 4.6H3.5v13H6c2.6 0 4.5.6 6 1.9" />
    <path d="M12 6.5c1.5-1.3 3.4-1.9 6-1.9h2.5v13H18c-2.6 0-4.5.6-6 1.9" />
    <path d="M12 6.5v13" />
  </svg>

  <!-- Three books on a shelf: the library as a whole. -->
  <svg
    v-else-if="name === 'books'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <rect x="3.5" y="4.5" width="4.5" height="15" rx="1" />
    <rect x="9.75" y="4.5" width="4.5" height="15" rx="1" />
    <path d="m16.4 6.1 3.6.9-3 12.2-3.6-.9" />
  </svg>

  <!-- A table of contents: entries with their leaders. -->
  <svg
    v-else-if="name === 'toc'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M4 6h10M4 12h13M4 18h8" />
    <path d="M20 6h.01M20 12h.01M20 18h.01" />
  </svg>

  <svg
    v-else-if="name === 'search'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="M16 16l4 4" />
  </svg>

  <svg
    v-else-if="name === 'plus'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>

  <svg
    v-else-if="name === 'check'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M4 12l5 5L20 6" />
  </svg>

  <svg
    v-else-if="name === 'check-all'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M3 12l4 4 8-8M11 16l5 5L24 11" />
  </svg>

  <svg
    v-else-if="name === 'sort'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3" />
  </svg>

  <svg
    v-else-if="name === 'sparkle'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7zM19 4.5l.7 1.8L21.5 7l-1.8.7L19 9.5l-.7-1.8L16.5 7l1.8-.7zM6 16l.7 1.8L8.5 18.5l-1.8.7L6 21l-.7-1.8L3.5 18.5l1.8-.7z" />
  </svg>

  <svg
    v-else-if="name === 'sparkle-fill'"
    :width="size" :height="size" viewBox="0 0 24 24" :fill="color" aria-hidden="true"
  >
    <path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7zM19 4.5l.7 1.8L21.5 7l-1.8.7L19 9.5l-.7-1.8L16.5 7l1.8-.7zM6 16l.7 1.8L8.5 18.5l-1.8.7L6 21l-.7-1.8L3.5 18.5l1.8-.7z" />
  </svg>

  <svg
    v-else-if="name === 'open'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M14 4h6v6M20 4l-8 8M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
  </svg>

  <svg
    v-else-if="name === 'share'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M12 4v12M12 4l-4 4M12 4l4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
  </svg>

  <svg
    v-else-if="name === 'send'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M21 3L10 14M21 3l-7 18-4-8-8-4z" />
  </svg>

  <svg
    v-else-if="name === 'more'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <circle cx="5" cy="12" r="1.2" :fill="color" stroke="none" />
    <circle cx="12" cy="12" r="1.2" :fill="color" stroke="none" />
    <circle cx="19" cy="12" r="1.2" :fill="color" stroke="none" />
  </svg>

  <svg
    v-else-if="name === 'refresh'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M20 8a8 8 0 0 0-14 0M20 4v4h-4M4 16a8 8 0 0 0 14 0M4 20v-4h4" />
  </svg>

  <svg
    v-else-if="name === 'settings'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>

  <svg
    v-else-if="name === 'chevron-down'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M6 9l6 6 6-6" />
  </svg>

  <svg
    v-else-if="name === 'chevron-right'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M9 6l6 6-6 6" />
  </svg>

  <svg
    v-else-if="name === 'globe'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </svg>

  <!-- translate: a script glyph (top-left) + a latin "A" (bottom-right), the
       universal "languages / translate" mark. -->
  <svg
    v-else-if="name === 'translate'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1" />
    <path d="m22 22-5-10-5 10M14 18h6" />
  </svg>

  <!-- highlighter: pen-stroke + arrow on tip, the universal "highlight" mark. -->
  <svg
    v-else-if="name === 'highlighter'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M9 11l-4 9 5-2 9-9-3-3-7 5z" />
    <path d="M14 4l3 3" />
  </svg>

  <svg
    v-else-if="name === 'focus'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
  </svg>

  <svg
    v-else-if="name === 'arrow-down'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M12 5v14M5 12l7 7 7-7" />
  </svg>

  <svg
    v-else-if="name === 'arrow-up'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>

  <svg
    v-else-if="name === 'eye'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>

  <svg
    v-else-if="name === 'eye-off'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M3 3l18 18M10.6 6.2A10.5 10.5 0 0 1 22 12s-1.4 2.6-4 4.5M6.4 7.4C3.6 9.2 2 12 2 12s3.5 7 10 7c2 0 3.7-.6 5.2-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </svg>

  <svg
    v-else-if="name === 'trash'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
  </svg>

  <svg
    v-else-if="name === 'mute'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M11 5L6 9H3v6h3l5 4zM16 9l4 6M20 9l-4 6" />
  </svg>

  <svg
    v-else-if="name === 'pin'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M12 2l3 6 5 1-4 4 1 6-5-3-5 3 1-6-4-4 5-1z" />
  </svg>

  <svg
    v-else-if="name === 'x'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>

  <svg
    v-else-if="name === 'command'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M18 6a3 3 0 1 0-3 3h3v6h-3a3 3 0 1 0 3 3v-3H9v3a3 3 0 1 0 3-3V9H9V6a3 3 0 1 0-3 3" />
  </svg>

  <svg
    v-else-if="name === 'copy'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>

  <svg
    v-else-if="name === 'list'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>

  <svg
    v-else-if="name === 'grid'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="8" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
  </svg>

  <svg
    v-else-if="name === 'text'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M5 6h14M5 6V4.5M19 6V4.5M12 6v14M9 20h6" />
  </svg>

  <svg
    v-else-if="name === 'alert'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M12 4L2.5 20.5h19zM12 10v5" />
    <circle cx="12" cy="17.6" r="0.4" :fill="color" stroke="none" />
  </svg>

  <svg
    v-else-if="name === 'play'"
    :width="size" :height="size" viewBox="0 0 24 24" :fill="color" aria-hidden="true"
  >
    <path d="M7 4.5v15l13-7.5z" />
  </svg>

  <svg
    v-else-if="name === 'pause'"
    :width="size" :height="size" viewBox="0 0 24 24" :fill="color" aria-hidden="true"
  >
    <rect x="6" y="4.5" width="4.2" height="15" rx="1" />
    <rect x="13.8" y="4.5" width="4.2" height="15" rx="1" />
  </svg>

  <svg
    v-else-if="name === 'skip-back'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M11 6a8 8 0 1 1-3 6" />
    <path d="M8 4v6h6" />
  </svg>

  <svg
    v-else-if="name === 'skip-fwd'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M13 6a8 8 0 1 0 3 6" />
    <path d="M16 4v6h-6" />
  </svg>

  <svg
    v-else-if="name === 'headphones'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
    <rect x="2.5" y="13" width="4.5" height="7" rx="2" />
    <rect x="17" y="13" width="4.5" height="7" rx="2" />
  </svg>

  <svg
    v-else-if="name === 'hiread'"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    :stroke="color" :stroke-width="STROKE" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M12 3 19.8 7.5 19.8 16.5 12 21 4.2 16.5 4.2 7.5Z" />
    <path d="M9.5 13.3a2.2 2.2 0 0 1 2.2 2.2M9.5 11.4a4.1 4.1 0 0 1 4.1 4.1" />
    <circle cx="9.5" cy="15.5" r="1.05" :fill="color" stroke="none" />
  </svg>
</template>
