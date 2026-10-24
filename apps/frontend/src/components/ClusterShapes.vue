<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ClusterSummary } from '@capi-navigator/shared';

/**
 * UX-02: the shape of every workload cluster at a glance. One row per cluster with its
 * infrastructure and state, then its control plane nodes and its worker nodes per pool as small
 * boxes colored by state; a click leads to the cluster, a box to its machines.
 */
const props = defineProps<{ clusters: ClusterSummary[] }>();
const { t, te } = useI18n();

type Machine = NonNullable<ClusterSummary['machines']>[number];

const rows = computed(() =>
  props.clusters.map((c) => {
    const machines = c.machines ?? [];
    const pools = new Map<string, Machine[]>();
    for (const m of machines.filter((x) => x.role === 'worker')) {
      const pool = m.pool ?? t('shapes.workers');
      pools.set(pool, [...(pools.get(pool) ?? []), m]);
    }
    return {
      cluster: c,
      controlPlane: machines.filter((m) => m.role === 'control-plane'),
      pools: [...pools.entries()].sort(([a], [b]) => a.localeCompare(b)),
    };
  }),
);

const provider = (c: ClusterSummary) =>
  c.provider && te(`credentials.providers.${c.provider}`)
    ? t(`credentials.providers.${c.provider}`)
    : (c.provider ?? '–');

const clusterColor = (c: ClusterSummary) =>
  c.ready
    ? 'success'
    : c.phase === 'Failed'
      ? 'error'
      : c.phase === 'Deleting'
        ? 'warning'
        : 'info';

/** Green: node healthy; red: failed; grey: being deleted; amber: on its way. */
const machineState = (m: Machine) =>
  m.phase === 'Failed'
    ? 'failed'
    : m.phase === 'Deleting'
      ? 'deleting'
      : m.ready
        ? 'ready'
        : 'pending';

const to = (c: ClusterSummary, tab?: string) => ({
  name: 'cluster',
  params: { namespace: c.namespace, name: c.name },
  ...(tab ? { query: { tab } } : {}),
});
</script>

<template>
  <div class="shapes" data-testid="cluster-shapes">
    <p v-if="!rows.length" class="text-body-2 text-medium-emphasis">{{ t('shapes.none') }}</p>
    <div v-for="r in rows" :key="`${r.cluster.namespace}/${r.cluster.name}`" class="shape-row">
      <router-link :to="to(r.cluster)" class="shape-cluster text-decoration-none">
        <div class="text-body-2 font-weight-medium text-high-emphasis">{{ r.cluster.name }}</div>
        <div class="text-caption text-medium-emphasis">
          {{ provider(r.cluster) }} · {{ r.cluster.namespace }}
        </div>
        <v-chip size="x-small" variant="tonal" :color="clusterColor(r.cluster)" class="mt-1">
          {{ r.cluster.ready ? t('clusters.ready') : r.cluster.phase }}
        </v-chip>
      </router-link>
      <div class="shape-group">
        <div class="text-caption text-medium-emphasis">{{ t('shapes.controlPlane') }}</div>
        <div class="boxes">
          <router-link
            v-for="m in r.controlPlane"
            :key="m.name"
            :to="to(r.cluster, 'machines')"
            :class="['box', `box--${machineState(m)}`]"
            :title="`${m.name}: ${m.phase}`"
            :aria-label="`${m.name}: ${m.phase}`"
            data-testid="shape-machine"
          />
          <span v-if="!r.controlPlane.length" class="text-caption text-disabled">–</span>
        </div>
      </div>
      <div v-for="[pool, machines] in r.pools" :key="pool" class="shape-group">
        <div class="text-caption text-medium-emphasis">{{ pool }}</div>
        <div class="boxes">
          <router-link
            v-for="m in machines"
            :key="m.name"
            :to="to(r.cluster, 'machines')"
            :class="['box', `box--${machineState(m)}`]"
            :title="`${m.name}: ${m.phase}`"
            :aria-label="`${m.name}: ${m.phase}`"
            data-testid="shape-machine"
          />
        </div>
      </div>
    </div>
    <div v-if="rows.length" class="legend text-caption text-medium-emphasis">
      <span><span class="box box--ready" />{{ t('shapes.ready') }}</span>
      <span><span class="box box--pending" />{{ t('shapes.pending') }}</span>
      <span><span class="box box--deleting" />{{ t('shapes.deleting') }}</span>
      <span><span class="box box--failed" />{{ t('shapes.failed') }}</span>
    </div>
  </div>
</template>

<style scoped>
.shape-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px 32px;
  padding: 12px 0;
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.shape-cluster {
  min-width: 220px;
  max-width: 260px;
}
.shape-group {
  min-width: 80px;
}
.boxes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
  max-width: 260px;
}
.box {
  display: inline-block;
  width: 16px;
  height: 16px;
  border-radius: 3px;
}
a.box:hover {
  outline: 2px solid rgb(var(--v-theme-on-surface));
}
.box--ready {
  background: rgb(var(--v-theme-success));
}
.box--pending {
  background: rgb(var(--v-theme-warning));
}
.box--deleting {
  background: rgba(var(--v-theme-on-surface), 0.3);
}
.box--failed {
  background: rgb(var(--v-theme-error));
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding-top: 12px;
}
.legend > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.legend .box {
  width: 10px;
  height: 10px;
}
</style>
