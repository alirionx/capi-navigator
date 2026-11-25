<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ClusterNamespace, ClusterSummary } from '@capi-navigator/shared';

/**
 * UX-17: the managed namespaces of one workload cluster in the provider graph of the home page, as a
 * card next to its nodes; a name leads to the cluster's namespaces.
 */
const props = defineProps<{ cluster: ClusterSummary; namespaces: ClusterNamespace[] }>();
const { t } = useI18n();

/** Names before "+n": the card has the height of one graph node. */
const MAX_NAMES = 3;
const shown = computed(() => props.namespaces.slice(0, MAX_NAMES));
const more = computed(() => props.namespaces.slice(MAX_NAMES));
const to = computed(() => ({
  name: 'cluster',
  params: { namespace: props.cluster.namespace, name: props.cluster.name },
  query: { tab: 'namespaces' },
}));
const state = (n: ClusterNamespace) => t(n.ready ? 'namespaces.ready' : 'namespaces.installing');
</script>

<template>
  <div class="group" data-testid="cluster-namespaces">
    <div class="text-body-small text-medium-emphasis label">
      {{ t('overview.namespaceCount', { n: namespaces.length }, namespaces.length) }}
    </div>
    <div class="names">
      <router-link
        v-for="n in shown"
        :key="n.name"
        :to="to"
        class="name"
        :title="`${n.name}: ${state(n)}`"
        data-testid="graph-namespace"
      >
        <span class="dot" :class="n.ready ? 'dot--ready' : 'dot--pending'" aria-hidden="true" />
        <span class="text">{{ n.name }}</span>
      </router-link>
      <router-link
        v-if="more.length"
        :to="to"
        class="name text-medium-emphasis"
        :title="more.map((n) => n.name).join(', ')"
        >+{{ more.length }}</router-link
      >
    </div>
  </div>
</template>

<style scoped>
.group {
  display: flex;
  flex-direction: column;
  justify-content: center;
  height: 100%;
  padding: 0 12px;
  border-radius: 12px;
  background: rgb(var(--v-theme-surface));
  border: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.label {
  line-height: 1.2;
  white-space: nowrap;
}
.names {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
  min-height: 16px;
}
.name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.2;
  text-decoration: none;
}
.name:hover,
.name:focus-visible {
  text-decoration: underline;
}
.text {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.dot--ready {
  background: rgb(var(--v-theme-success));
}
.dot--pending {
  background: rgb(var(--v-theme-warning));
}
</style>
