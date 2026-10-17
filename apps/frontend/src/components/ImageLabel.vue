<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

/** Image name (if the cloud knows it) with the full ID and a copy button (FP6-F-02). */
const props = defineProps<{ id: string; name?: string; notFound?: boolean; dense?: boolean }>();
const { t } = useI18n();
const copied = ref(false);

async function copy(): Promise<void> {
  await navigator.clipboard.writeText(props.id);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1200);
}
</script>

<template>
  <div class="image-label" :class="{ dense }">
    <div v-if="name" class="name" :title="name">{{ name }}</div>
    <div v-else-if="notFound" class="name text-medium-emphasis">{{ t('images.notFound') }}</div>
    <div class="d-flex align-center ga-1">
      <span class="id font-monospace" :title="id">{{ id }}</span>
      <v-btn
        :icon="copied ? 'mdi-check' : 'mdi-content-copy'"
        size="x-small"
        variant="text"
        density="comfortable"
        :aria-label="t('images.copyId')"
        :title="t('images.copyId')"
        @click.stop="copy"
      />
    </div>
  </div>
</template>

<style scoped>
.image-label {
  min-width: 0;
  line-height: 1.3;
}
.name {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.id {
  font-size: 0.75rem;
  opacity: 0.75;
  word-break: break-all;
}
.dense .name {
  font-size: 0.8125rem;
}
</style>
