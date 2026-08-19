<script setup lang="ts">
// A toggle row backed by a persisted backend setting ("1" / "0").

import { onMounted, ref } from "vue";
import * as api from "../../api";
import SettingsRow from "./SettingsRow.vue";
import SettingsToggle from "./SettingsToggle.vue";

const props = withDefaults(
  defineProps<{
    settingKey: string;
    label: string;
    desc?: string;
    fallback?: boolean;
  }>(),
  {
    fallback: false,
  },
);

const emit = defineEmits<{
  (e: "changed", value: boolean): void;
}>();

const val = ref(props.fallback);

onMounted(() => {
  api
    .getSetting(props.settingKey)
    .then((v) => {
      if (v != null && v !== "") val.value = v === "1";
    })
    .catch(() => {});
});

function change(v: boolean): void {
  val.value = v;
  api.setSetting(props.settingKey, v ? "1" : "0").catch(() => {});
  emit("changed", v);
}
</script>

<template>
  <SettingsRow :label="label" :desc="desc" v-slot="{ ariaLabel }">
    <SettingsToggle :checked="val" :aria-label="ariaLabel" @change="change" />
  </SettingsRow>
</template>
