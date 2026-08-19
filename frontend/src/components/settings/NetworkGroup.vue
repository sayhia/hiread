<script setup lang="ts">
// Network: proxy and request timeout. The HTTP client actually reads these.

import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "../../api";
import { reportError, toast } from "../../stores/toasts";
import { clampSetting } from "./helpers";
import SettingsRow from "./SettingsRow.vue";
import SettingsSelect from "./SettingsSelect.vue";
import SettingsSlider from "./SettingsSlider.vue";

const { t } = useI18n();

const proxy = ref("system");
const customProxy = ref("");
const timeoutSec = ref(30);

onMounted(() => {
  Promise.all([
    api.getSetting("net_proxy"),
    api.getSetting("net_timeout_sec"),
  ])
    .then(([p, to]) => {
      if (p === "system" || p === "none") proxy.value = p;
      else if (p) {
        proxy.value = "custom";
        customProxy.value = p;
      }
      if (to) timeoutSec.value = clampSetting(to, 30, 5, 120);
    })
    .catch(() => {});
});

function saveProxy(mode: string, custom: string): void {
  const value = mode === "custom" ? custom : mode;
  api
    .setSetting("net_proxy", value)
    .then(() => api.applyNetworkSettings())
    .then(() => toast.show(t("settings.advanced.proxyApplied")))
    .catch((e) => reportError(e));
}

function onProxyChange(v: string): void {
  proxy.value = v;
  if (v !== "custom") saveProxy(v, "");
}

function onTimeoutCommit(v: number): void {
  api
    .setSetting("net_timeout_sec", String(v))
    .then(() => api.applyNetworkSettings())
    .catch(() => {});
}
</script>

<template>
  <div class="settings-group">
    <h3 class="settings-group-title">{{ t("settings.advanced.network") }}</h3>
    <SettingsRow :label="t('settings.advanced.proxy')" v-slot="{ ariaLabel }">
      <SettingsSelect
        :value="proxy"
        :options="[
          { value: 'system', label: t('settings.advanced.proxySystem') },
          { value: 'none', label: t('settings.advanced.proxyNone') },
          { value: 'custom', label: t('settings.advanced.proxyCustom') },
        ]"
        :aria-label="ariaLabel"
        @change="onProxyChange($event)"
      />
    </SettingsRow>
    <SettingsRow
      v-if="proxy === 'custom'"
      :label="t('settings.advanced.proxyAddress')"
      :desc="t('settings.advanced.proxyAddressDesc')"
      v-slot="{ ariaLabel }"
    >
      <input
        class="s-text-input"
        v-model="customProxy"
        placeholder="http://host:port"
        :aria-label="ariaLabel"
        @blur="saveProxy('custom', customProxy)"
      />
    </SettingsRow>
    <SettingsRow :label="t('settings.advanced.timeout')" v-slot="{ ariaLabel }">
      <SettingsSlider
        :value="timeoutSec"
        :min="5"
        :max="120"
        :step="5"
        :unit="t('settings.advanced.secondsUnit')"
        :aria-label="ariaLabel"
        @change="timeoutSec = $event"
        @commit="onTimeoutCommit"
      />
    </SettingsRow>
  </div>
</template>
