<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ClusterSummary } from '@capi-navigator/shared';

/**
 * UX-02: the shape of one workload cluster, its control plane nodes and its worker nodes per pool
 * as small boxes colored by state; a box leads to the cluster's machines. Shown next to the
 * cluster in the provider graph of the home page.
 */
const props = defineProps<{ cluster: ClusterSummary }>();
const { t } = useI18n();

type Machine = NonNullable<ClusterSummary['machines']>[number];

/** Boxes per group before "+n": two rows would not fit the height of a graph node. */
const MAX_BOXES = 12;

const groups = computed(() => {
  const machines = props.cluster.machines ?? [];
  const pools = new Map<string, Machine[]>();
  for (const m of machines.filter((x) => x.role === 'worker')) {
    const pool = m.pool ?? t('shapes.workers');
    pools.set(pool, [...(pools.get(pool) ?? []), m]);
  }
  return [
    {
      name: t('shapes.controlPlane'),
      machines: machines.filter((m) => m.role === 'control-plane'),
    },
    ...[...pools.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, list]) => ({ name, machines: list })),
  ];
});

/** Green: node healthy; red: failed; grey: being deleted; amber: on its way. */
const machineState = (m: Machine) =>
  m.phase === 'Failed'
    ? 'failed'
    : m.phase === 'Deleting'
      ? 'deleting'
      : m.ready
        ? 'ready'
        : 'pending';

const to = computed(() => ({
  name: 'cluster',
  params: { namespace: props.cluster.namespace, name: props.cluster.name },
  query: { tab: 'machines' },
}));
</script>

<template>
  <div class="groups" data-testid="cluster-shape">
    <div v-for="g in groups" :key="g.name" class="group">
      <div class="text-caption text-medium-emphasis label">{{ g.name }}</div>
      <div class="boxes">
        <router-link
          v-for="m in g.machines.slice(0, MAX_BOXES)"
          :key="m.name"
          :to="to"
          :class="['box', `box--${machineState(m)}`]"
          :title="`${m.name}: ${m.phase}`"
          :aria-label="`${m.name}: ${m.phase}`"
          data-testid="shape-machine"
        />
        <span v-if="g.machines.length > MAX_BOXES" class="text-caption text-medium-emphasis"
          >+{{ g.machines.length - MAX_BOXES }}</span
        >
        <span v-if="!g.machines.length" class="text-caption text-disabled">–</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.groups {
  display: flex;
  align-items: stretch;
  gap: 8px;
  height: 100%;
}
/* UX-04: each group is a card like the cluster nodes of the graph. */
.group {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 12px;
  border-radius: 12px;
  background: rgb(var(--v-theme-surface));
  border: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.label {
  line-height: 1.2;
  white-space: nowrap;
}
.boxes {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  min-height: 16px;
  min-width: 60px;
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
</style>
