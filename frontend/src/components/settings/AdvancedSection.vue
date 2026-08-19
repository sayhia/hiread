<script setup lang="ts">
// Advanced: storage, network, and the danger zone.
// AI provider config + assistant tuning live in AiSection.

import StorageGroup from "./StorageGroup.vue";
import FontStorage from "./FontStorage.vue";
import NetworkGroup from "./NetworkGroup.vue";
import DangerZone from "./DangerZone.vue";
</script>

<template>
  <StorageGroup />
  <FontStorage />
  <NetworkGroup />
  <DangerZone />
</template>
