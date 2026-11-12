<script setup lang="ts">
import SlIcon from './SlIcon.vue';

withDefaults(
  defineProps<{
    title: string;
    icon?: string;
    description?: string;
    tone?: 'default' | 'warning' | 'danger';
    /** true 时去掉卡片描边/底色（内容只有一两个操作、不需要一块独立surface时用）。 */
    flat?: boolean;
  }>(),
  { tone: 'default', flat: false },
);
</script>

<template>
  <section class="miot-section" :class="`miot-section-${tone}`">
    <header class="section-heading">
      <span v-if="icon" class="section-heading-icon" aria-hidden="true">
        <SlIcon :name="icon" :size="20" />
      </span>
      <span class="section-heading-copy">
        <span class="section-title-row">
          <h2 class="section-title">{{ title }}</h2>
          <span v-if="$slots.actions" class="section-heading-actions"><slot name="actions" /></span>
        </span>
        <span v-if="description" class="section-description">{{ description }}</span>
      </span>
    </header>
    <div class="card miot-card" :class="{ 'miot-card-flat': flat }">
      <slot />
    </div>
  </section>
</template>
