<script setup lang="ts">
import AIModelSettings from './AIModelSettings.vue';
import ChatSettings from './ChatSettings.vue';
</script>

<template>
  <div class="ai-settings">
    <AIModelSettings />
    <ChatSettings />
  </div>
</template>

<style scoped>
.ai-settings { display: grid; gap: 16px; min-width: 0; }
</style>
