<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ClusterStatus, Condition, ResourceRef } from '@capi-navigator/shared';
import YamlButton from './YamlButton.vue';

/**
 * Resource tree of a cluster (FP6-F-03): Cluster → infrastructure, control plane and
 * MachineDeployments → machines, laid out in columns with a status color per node.
 */
const props = defineProps<{ status: ClusterStatus }>();
const { t } = useI18n();

type Tone = 'success' | 'info' | 'warning' | 'error';
interface TreeNode {
  id: string;
  kind: string;
  name: string;
  detail?: string;
  tone: Tone;
  conditions: Condition[];
  level: number;
  row: number;
  parent?: string;
}

const NODE_W = 240;
const NODE_H = 58;
const COL_GAP = 72;
const ROW_GAP = 12;

const machineTone = (phase: string): Tone =>
  phase === 'Running'
    ? 'success'
    : phase === 'Failed'
      ? 'error'
      : phase === 'Deleting' || phase === 'Deleted'
        ? 'warning'
        : 'info';

const nodes = computed<TreeNode[]>(() => {
  const s = props.status;
  const out: TreeNode[] = [];
  let row = 0;
  const branch = (node: Omit<TreeNode, 'level' | 'row' | 'parent'>, children: TreeNode[]) => {
    const start = row;
    const placed = children.map((c, i) => ({ ...c, level: 2, row: start + i, parent: node.id }));
    const span = Math.max(1, children.length);
    out.push({ ...node, level: 1, row: start + (span - 1) / 2, parent: 'cluster' }, ...placed);
    row += span;
  };
  const machine = (m: ClusterStatus['machines'][number]): TreeNode => ({
    id: `m/${m.name}`,
    kind: 'Machine',
    name: m.name,
    detail: [m.phase, m.size].filter(Boolean).join(' · '),
    tone: machineTone(m.phase),
    conditions: m.conditions,
    level: 2,
    row: 0,
  });

  if (s.infrastructure) {
    branch(
      {
        id: 'infra',
        kind: s.infrastructure.kind,
        name: s.infrastructure.name,
        detail: s.infrastructure.ready ? t('clusters.provisioned') : t('clusters.provisioning'),
        tone: s.infrastructure.ready ? 'success' : 'info',
        conditions: s.infrastructure.conditions,
      },
      [],
    );
  }
  if (s.controlPlane) {
    const cp = s.controlPlane;
    branch(
      {
        id: 'cp',
        kind: cp.kind,
        name: cp.name,
        detail: `${cp.ready}/${cp.replicas} ${t('clusters.available')}`,
        tone: cp.ready === cp.replicas ? 'success' : 'info',
        conditions: cp.conditions,
      },
      s.machines.filter((m) => m.role === 'control-plane').map(machine),
    );
  }
  for (const md of s.machineDeployments) {
    branch(
      {
        id: `md/${md.name}`,
        kind: 'MachineDeployment',
        name: md.name,
        detail: `${md.ready}/${md.replicas} ${t('clusters.ready')}`,
        tone: md.ready === md.replicas ? 'success' : 'info',
        conditions: md.conditions,
      },
      s.machines.filter((m) => m.role === 'worker' && m.deployment === md.name).map(machine),
    );
  }
  out.unshift({
    id: 'cluster',
    kind: 'Cluster',
    name: s.summary.name,
    detail: s.summary.ready ? t('clusters.ready') : s.summary.phase,
    tone: s.summary.ready ? 'success' : s.summary.phase === 'Failed' ? 'error' : 'info',
    conditions: s.conditions,
    level: 0,
    row: Math.max(0, (row - 1) / 2),
  });
  return out;
});

const pos = (n: TreeNode) => ({
  x: n.level * (NODE_W + COL_GAP),
  y: n.row * (NODE_H + ROW_GAP),
});
const width = computed(() => 3 * NODE_W + 2 * COL_GAP);
const height = computed(
  () => (Math.max(...nodes.value.map((n) => n.row)) + 1) * (NODE_H + ROW_GAP) - ROW_GAP,
);

const edges = computed(() =>
  nodes.value
    .filter((n) => n.parent)
    .map((n) => {
      const parent = nodes.value.find((p) => p.id === n.parent)!;
      const a = pos(parent);
      const b = pos(n);
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      return { id: n.id, d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`, tone: n.tone };
    }),
);

const selected = ref<string | null>(null);

/** Reference of a tree node for "View YAML" (FP7-F-01). */
function refOf(n: TreeNode): ResourceRef {
  const group =
    n.id === 'infra'
      ? 'infrastructure.cluster.x-k8s.io'
      : n.id === 'cp'
        ? 'controlplane.cluster.x-k8s.io'
        : 'cluster.x-k8s.io';
  return {
    apiVersion: `${group}/v1beta2`,
    kind: n.kind,
    namespace: props.status.summary.namespace,
    name: n.name,
  };
}
const selectedNode = computed(() => nodes.value.find((n) => n.id === selected.value));
</script>

<template>
  <div class="tree-scroll" data-testid="resource-tree">
    <div class="tree" :style="{ width: `${width}px`, height: `${height}px` }">
      <svg :width="width" :height="height" class="edges" aria-hidden="true">
        <path v-for="e in edges" :key="e.id" :d="e.d" :class="`edge edge--${e.tone}`" />
      </svg>
      <button
        v-for="n in nodes"
        :key="n.id"
        type="button"
        class="node"
        :class="[`node--${n.tone}`, { 'node--selected': selected === n.id }]"
        :style="{
          left: `${pos(n).x}px`,
          top: `${pos(n).y}px`,
          width: `${NODE_W}px`,
          height: `${NODE_H}px`,
        }"
        :aria-pressed="selected === n.id"
        @click="selected = selected === n.id ? null : n.id"
      >
        <span class="dot" aria-hidden="true" />
        <span class="text">
          <span class="kind">{{ n.kind }}</span>
          <span class="name">{{ n.name }}</span>
          <span v-if="n.detail" class="detail">{{ n.detail }}</span>
        </span>
      </button>
    </div>
  </div>

  <v-card v-if="selectedNode" border class="mt-4" data-testid="tree-selection">
    <v-card-item :title="selectedNode.name" :subtitle="selectedNode.kind">
      <template #append><YamlButton :target="refOf(selectedNode)" label /></template>
    </v-card-item>
    <v-card-text>
      <div class="text-subtitle-2 mb-2">{{ t('clusters.conditions') }}</div>
      <v-table v-if="selectedNode.conditions.length" density="compact">
        <tbody>
          <tr v-for="c in selectedNode.conditions" :key="c.type">
            <td style="width: 14rem">{{ c.type }}</td>
            <td style="width: 4rem">
              <v-icon
                :color="c.status === 'True' ? 'success' : 'warning'"
                :icon="c.status === 'True' ? 'mdi-check-circle' : 'mdi-alert-circle'"
                size="small"
              />
            </td>
            <td class="text-caption">{{ c.reason }}{{ c.message ? ': ' + c.message : '' }}</td>
          </tr>
        </tbody>
      </v-table>
      <div v-else class="text-medium-emphasis">–</div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.tree-scroll {
  overflow-x: auto;
  padding: 4px 2px 8px;
}
.tree {
  position: relative;
}
.edges {
  position: absolute;
  inset: 0;
}
.edge {
  fill: none;
  stroke-width: 1.5;
  stroke: rgba(var(--v-border-color), 0.35);
}
.edge--success {
  stroke: rgba(var(--v-theme-success), 0.55);
}
.edge--error {
  stroke: rgba(var(--v-theme-error), 0.7);
}
.edge--warning {
  stroke: rgba(var(--v-theme-warning), 0.7);
}
.node {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  text-align: left;
  border-radius: 12px;
  background: rgb(var(--v-theme-surface));
  border: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-left-width: 4px;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  transition: border-color 0.15s;
}
.node:hover,
.node--selected {
  border-color: rgb(var(--v-theme-primary));
}
.node:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
.node--success {
  border-left-color: rgb(var(--v-theme-success));
}
.node--info {
  border-left-color: rgb(var(--v-theme-info));
}
.node--warning {
  border-left-color: rgb(var(--v-theme-warning));
}
.node--error {
  border-left-color: rgb(var(--v-theme-error));
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
}
.node--success .dot {
  background: rgb(var(--v-theme-success));
}
.node--info .dot {
  background: rgb(var(--v-theme-info));
}
.node--warning .dot {
  background: rgb(var(--v-theme-warning));
}
.node--error .dot {
  background: rgb(var(--v-theme-error));
}
.text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}
.kind {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.7;
}
.name,
.detail {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.name {
  font-weight: 600;
  font-size: 0.875rem;
}
.detail {
  font-size: 0.75rem;
  opacity: 0.75;
}
</style>
