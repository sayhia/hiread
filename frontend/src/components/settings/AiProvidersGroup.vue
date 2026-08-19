<script setup lang="ts">
// Multiple AI provider profiles shown as a card list: each card is a named
// { dialect, key, model, base URL } config; the one with the filled radio is
// active and drives summaries, Q&A, digest, and LLM translation. A "custom"
// provider is just a card with your own name + base URL (any OpenAI-compatible
// endpoint via the openai dialect). Persisted as JSON in ai_providers + the
// active id in ai_active_provider, which the backend (ai.ConfigFromSettings)
// prefers over the legacy single-provider keys. An existing legacy config is
// migrated into one card on first load.

import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import * as api from "../../api";
import { reportError } from "../../stores/toasts";
import Icon from "../Icon.vue";
import SettingsSelect from "./SettingsSelect.vue";

// The API dialect (request/SSE shape), not the vendor. Two shapes — Anthropic
// and OpenAI; "custom" is any OpenAI-compatible endpoint (DeepSeek, OpenRouter, a
// local server, …) via your own base URL. DeepSeek isn't a separate type — it is
// OpenAI-shaped, so an existing DeepSeek config folds into a custom profile.
type AiProvider = "anthropic" | "openai" | "custom";
interface Profile {
  id: string;
  name: string;
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
}

const { t } = useI18n();

const profiles = ref<Profile[]>([]);
const activeId = ref("");
// Which card is expanded for editing ("" = all collapsed). Accordion: one at a time.
const editingId = ref("");

function providerLabel(p: AiProvider): string {
  if (p === "openai") return "OpenAI";
  if (p === "custom") return t("settings.ai.customLabel");
  return "Anthropic";
}
// Raw stored/partial shape — provider is an arbitrary string until normalized.
interface RawProfile {
  id?: string;
  name?: string;
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}
// Coerce stored/partial data into a valid Profile. DeepSeek is no longer a
// separate type (it's OpenAI-compatible) — fold an existing DeepSeek config into
// a custom profile pointing at DeepSeek's endpoint so it keeps working, and keep
// "DeepSeek" as its name.
function normalize(p: RawProfile): Profile {
  const raw = p.provider;
  let provider: AiProvider = raw === "openai" || raw === "custom" ? raw : "anthropic";
  let model = p.model ?? "";
  let baseUrl = p.baseUrl ?? "";
  if (raw === "deepseek") {
    provider = "custom";
    if (!model.trim()) model = "deepseek-chat";
    if (!baseUrl.trim()) baseUrl = "https://api.deepseek.com";
  }
  return {
    id: p.id || crypto.randomUUID(),
    name: p.name || (raw === "deepseek" ? "DeepSeek" : providerLabel(provider)),
    provider,
    apiKey: p.apiKey ?? "",
    model,
    baseUrl,
  };
}
const providerOptions = computed(() => [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "custom", label: t("settings.ai.apiTypeCustom") },
]);

// Persist silently — the card list is the live source of truth, so a toast per
// keystroke-blur would just be noise.
const qc = useQueryClient();

function persist(): void {
  Promise.all([
    api.setSetting("ai_providers", JSON.stringify(profiles.value)),
    api.setSetting("ai_active_provider", activeId.value),
  ])
    // Adding the first provider makes the LLM translation engine usable; the
    // reader's "needs a key" warning has to hear about it without a restart.
    .then(() => qc.invalidateQueries({ queryKey: ["ai", "configured"] }))
    .catch((e) => reportError(e));
}

onMounted(async () => {
  try {
    const raw = await api.getSetting("ai_providers");
    if (raw && raw.trim()) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        profiles.value = parsed.map(normalize);
        const stored = (await api.getSetting("ai_active_provider")) ?? "";
        activeId.value = profiles.value.some((p) => p.id === stored) ? stored : profiles.value[0].id;
        return;
      }
    }
    // Migrate an existing legacy single-provider config into one card.
    const [prov, key, model, base] = await Promise.all([
      api.getSetting("ai_provider"),
      api.getSetting("ai_api_key"),
      api.getSetting("ai_model"),
      api.getSetting("ai_base_url"),
    ]);
    if (key && key.trim()) {
      const p = normalize({ provider: prov ?? "anthropic", apiKey: key, model: model ?? "", baseUrl: base ?? "" });
      profiles.value = [p];
      activeId.value = p.id;
      persist();
    }
  } catch {
    /* leave the list empty on read/parse error — the user can add one */
  }
});

function setActive(id: string): void {
  activeId.value = id;
  persist();
}
function toggleEdit(id: string): void {
  editingId.value = editingId.value === id ? "" : id;
}
function addProfile(): void {
  const p = normalize({ name: t("settings.ai.newProviderName") });
  profiles.value.push(p);
  activeId.value = p.id;
  editingId.value = p.id; // open the new card for editing right away
  persist();
}
function deleteProfile(id: string): void {
  const i = profiles.value.findIndex((p) => p.id === id);
  if (i < 0) return;
  profiles.value.splice(i, 1);
  if (activeId.value === id) activeId.value = profiles.value[0]?.id ?? "";
  if (editingId.value === id) editingId.value = "";
  persist();
}
function setProvider(p: Profile, v: string): void {
  p.provider = v as AiProvider;
  // Model + base URL are provider-specific; clear so the new dialect's defaults apply.
  p.model = "";
  p.baseUrl = "";
  persist();
}
function onFieldBlur(p: Profile, field: "name" | "apiKey" | "model" | "baseUrl"): void {
  p[field] = p[field].trim();
  persist();
}
function modelPlaceholder(p: Profile): string {
  if (p.provider === "openai") return t("settings.advanced.aiModelPlaceholderOpenai");
  if (p.provider === "custom") return "";
  return t("settings.advanced.aiModelPlaceholderAnthropic");
}
function baseUrlPlaceholder(p: Profile): string {
  if (p.provider === "openai") return "https://api.openai.com/v1";
  if (p.provider === "custom") return "https://your-endpoint/v1";
  return "https://api.anthropic.com/v1";
}
</script>

<template>
  <div class="settings-group">
    <h3 class="settings-group-title">{{ t("settings.advanced.aiSummary") }}</h3>
    <p class="settings-group-desc">{{ t("settings.ai.providerListDesc") }}</p>

    <p v-if="!profiles.length" class="ai-prov-empty">{{ t("settings.ai.noProviders") }}</p>

    <div v-else class="ai-prov-list">
      <div
        v-for="p in profiles"
        :key="p.id"
        class="ai-prov-card"
        :class="{ active: p.id === activeId }"
      >
        <div class="ai-prov-row">
          <button
            class="ai-prov-radio"
            :class="{ on: p.id === activeId }"
            role="radio"
            :aria-checked="p.id === activeId"
            :title="t('settings.ai.useProvider')"
            :aria-label="t('settings.ai.useProvider')"
            @click="setActive(p.id)"
          >
            <span class="dot" />
          </button>
          <button class="ai-prov-info" @click="toggleEdit(p.id)">
            <span class="ai-prov-name">{{ p.name || t("settings.ai.unnamedProvider") }}</span>
            <span class="ai-prov-meta">
              <span class="ai-prov-badge">{{ providerLabel(p.provider) }}</span>
              <span v-if="p.model" class="ai-prov-model">· {{ p.model }}</span>
              <span v-if="!p.apiKey" class="ai-prov-nokey">· {{ t("settings.ai.noKeySet") }}</span>
            </span>
          </button>
          <div class="ai-prov-actions">
            <button
              class="tb-btn"
              :title="t('settings.ai.editProvider')"
              :aria-label="t('settings.ai.editProvider')"
              @click="toggleEdit(p.id)"
            >
              <Icon :name="editingId === p.id ? 'chevron-down' : 'chevron-right'" :size="14" />
            </button>
            <button
              class="tb-btn ai-prov-del"
              :title="t('settings.ai.deleteProvider')"
              :aria-label="t('settings.ai.deleteProvider')"
              @click="deleteProfile(p.id)"
            >
              <Icon name="trash" :size="14" />
            </button>
          </div>
        </div>

        <div v-if="editingId === p.id" class="ai-prov-edit">
          <label class="ai-prov-field">
            <span>{{ t("settings.ai.providerName") }}</span>
            <input
              class="s-text-input"
              type="text"
              v-model="p.name"
              :placeholder="t('settings.ai.newProviderName')"
              @blur="onFieldBlur(p, 'name')"
            />
          </label>
          <label class="ai-prov-field">
            <span>{{ t("settings.ai.apiType") }}</span>
            <SettingsSelect :value="p.provider" :options="providerOptions" @change="setProvider(p, $event)" />
            <small class="ai-prov-hint">{{ t("settings.ai.apiTypeDesc") }}</small>
          </label>
          <label class="ai-prov-field">
            <span>{{ t("settings.advanced.aiApiKey") }}</span>
            <input
              class="s-text-input"
              type="password"
              v-model="p.apiKey"
              placeholder="sk-…"
              @blur="onFieldBlur(p, 'apiKey')"
            />
          </label>
          <label class="ai-prov-field">
            <span>{{ t("settings.advanced.aiModel") }}</span>
            <input
              class="s-text-input"
              type="text"
              v-model="p.model"
              :placeholder="modelPlaceholder(p)"
              @blur="onFieldBlur(p, 'model')"
            />
          </label>
          <label class="ai-prov-field">
            <span>{{ t("settings.advanced.aiBaseUrl") }}</span>
            <input
              class="s-text-input"
              type="text"
              v-model="p.baseUrl"
              :placeholder="baseUrlPlaceholder(p)"
              @blur="onFieldBlur(p, 'baseUrl')"
            />
          </label>
        </div>
      </div>
    </div>

    <button class="ai-prov-add" @click="addProfile">
      <Icon name="plus" :size="14" /> {{ t("settings.ai.addProvider") }}
    </button>
  </div>
</template>
