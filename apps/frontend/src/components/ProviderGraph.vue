<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  catalogEntry,
  clustersUsing,
  PROVIDER_KINDS,
  type ClusterSummary,
  type InstalledProvider,
} from '@capi-navigator/shared';
import MachineBoxes from './MachineBoxes.vue';

/**
 * Which providers are installed and which clusters use them (FP6-F-08, US-10): providers on the
 * left, clusters in the middle, connected per usage, and next to each cluster its nodes (UX-02).
 * Hovering a node highlights its connections.
 */
const props = defineProps<{ providers: InstalledProvider[]; clusters: ClusterSummary[] }>();
const { t } = useI18n();

const NODE_W = 260;
const NODE_H = 52;
const GAP = 10;
const COL_GAP = 160;
const SHAPE_GAP = 40;
const SHAPE_W = 420;

const providers = computed(() =>
  [...props.providers].sort(
    (a, b) =>
      PROVIDER_KINDS.indexOf(a.kind) - PROVIDER_KINDS.indexOf(b.kind) ||
      a.name.localeCompare(b.name),
  ),
);
const key = (c: ClusterSummary) => `${c.namespace}/${c.name}`;

const rows = computed(() => Math.max(providers.value.length, props.clusters.length, 1));
const height = computed(() => rows.value * (NODE_H + GAP) - GAP);
const clusterX = NODE_W + COL_GAP;
const shapeX = clusterX + NODE_W + SHAPE_GAP;
const width = computed(() => (props.clusters.length ? shapeX + SHAPE_W : clusterX + NODE_W));
/** Vertical offset that centers the shorter column. */
const offset = (count: number) => ((rows.value - count) * (NODE_H + GAP)) / 2;
const providerY = (i: number) => offset(providers.value.length) + i * (NODE_H + GAP);
const clusterY = (i: number) => offset(props.clusters.length) + i * (NODE_H + GAP);

const edges = computed(() =>
  providers.value.flatMap((p, i) =>
    clustersUsing(p, props.clusters).map((c) => {
      const j = props.clusters.findIndex((x) => key(x) === key(c));
      const x1 = NODE_W;
      const y1 = providerY(i) + NODE_H / 2;
      const x2 = NODE_W + COL_GAP;
      const y2 = clusterY(j) + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      return {
        id: `${p.kind}/${p.name}->${key(c)}`,
        provider: `${p.kind}/${p.name}`,
        cluster: key(c),
        d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`,
      };
    }),
  ),
);

/** Short links from each cluster to its nodes. */
const shapeLinks = computed(() =>
  props.clusters.map((c, j) => {
    const y = clusterY(j) + NODE_H / 2;
    return { id: key(c), d: `M${clusterX + NODE_W},${y} H${shapeX - 8}` };
  }),
);

const hover = ref<string | null>(null);
const active = (e: { provider: string; cluster: string }) =>
  hover.value === e.provider || hover.value === e.cluster;
const providerTone = (p: InstalledProvider) =>
  p.phase === 'Ready' ? 'success' : p.phase === 'Failed' ? 'error' : 'info';
const clusterTone = (c: ClusterSummary) =>
  c.deletion ? 'warning' : c.ready ? 'success' : c.phase === 'Failed' ? 'error' : 'info';
const kindLabel = (k: string) => k.replace('Provider', '');
</script>

<template>
  <div class="graph-scroll" data-testid="provider-graph">
    <div class="d-flex text-body-small text-medium-emphasis mb-2" :style="{ width: `${width}px` }">
      <span :style="{ width: `${clusterX}px` }">{{ t('overview.providers') }}</span>
      <span :style="{ width: `${NODE_W + SHAPE_GAP}px` }">{{ t('overview.clusters') }}</span>
      <span v-if="clusters.length">{{ t('overview.nodes') }}</span>
    </div>
    <div class="graph" :style="{ width: `${width}px`, height: `${height}px` }">
      <svg :width="width" :height="height" class="edges" aria-hidden="true">
        <path
          v-for="e in edges"
          :key="e.id"
          :d="e.d"
          class="edge"
          :class="{ 'edge--active': active(e), 'edge--dim': hover && !active(e) }"
        />
        <path
          v-for="l in shapeLinks"
          :key="`shape-${l.id}`"
          :d="l.d"
          class="edge"
          :class="{ 'edge--active': hover === l.id, 'edge--dim': hover && hover !== l.id }"
        />
      </svg>
      <div
        v-for="(p, i) in providers"
        :key="`${p.kind}/${p.name}`"
        class="node"
        :class="`node--${providerTone(p)}`"
        :style="{
          left: '0px',
          top: `${providerY(i)}px`,
          width: `${NODE_W}px`,
          height: `${NODE_H}px`,
        }"
        tabindex="0"
        @mouseenter="hover = `${p.kind}/${p.name}`"
        @mouseleave="hover = null"
        @focus="hover = `${p.kind}/${p.name}`"
        @blur="hover = null"
      >
        <span class="dot" aria-hidden="true" />
        <span class="text">
          <span class="kind">{{ kindLabel(p.kind) }}</span>
          <span class="name">{{ catalogEntry(p.catalogId ?? '')?.displayName ?? p.name }}</span>
          <span class="detail">{{ p.installedVersion ?? p.version ?? '' }} · {{ p.phase }}</span>
        </span>
      </div>
      <router-link
        v-for="(c, j) in clusters"
        :key="key(c)"
        :to="{ name: 'cluster', params: { namespace: c.namespace, name: c.name } }"
        class="node"
        :class="`node--${clusterTone(c)}`"
        :style="{
          left: `${clusterX}px`,
          top: `${clusterY(j)}px`,
          width: `${NODE_W}px`,
          height: `${NODE_H}px`,
        }"
        @mouseenter="hover = key(c)"
        @mouseleave="hover = null"
        @focus="hover = key(c)"
        @blur="hover = null"
      >
        <span class="dot" aria-hidden="true" />
        <span class="text">
          <span class="kind">{{ c.namespace }}</span>
          <span class="name">{{ c.name }}</span>
          <span class="detail"
            >{{ c.provider ?? '–' }} · {{ c.flavor ?? '–' }} ·
            {{ c.ready ? t('clusters.ready') : c.phase }}</span
          >
        </span>
      </router-link>
      <MachineBoxes
        v-for="(c, j) in clusters"
        :key="`shape-${key(c)}`"
        :cluster="c"
        class="shape"
        :style="{
          left: `${shapeX}px`,
          top: `${clusterY(j)}px`,
          width: `${SHAPE_W}px`,
          height: `${NODE_H}px`,
        }"
        @mouseenter="hover = key(c)"
        @mouseleave="hover = null"
      />
      <div
        v-if="clusters.length === 0"
        class="empty text-medium-emphasis text-body-medium"
        :style="{ left: `${clusterX}px`, width: `${NODE_W}px` }"
      >
        {{ t('clusters.empty') }}
      </div>
    </div>
    <div v-if="clusters.length" class="legend text-body-small text-medium-emphasis">
      <span><span class="box box--ready" />{{ t('shapes.ready') }}</span>
      <span><span class="box box--pending" />{{ t('shapes.pending') }}</span>
      <span><span class="box box--deleting" />{{ t('shapes.deleting') }}</span>
      <span><span class="box box--failed" />{{ t('shapes.failed') }}</span>
    </div>
  </div>
</template>

<style scoped>
.graph-scroll {
  overflow-x: auto;
  padding-bottom: 8px;
}
.graph {
  position: relative;
}
.edges {
  position: absolute;
  inset: 0;
}
.edge {
  fill: none;
  stroke-width: 1.5;
  stroke: rgba(var(--v-theme-primary), 0.35);
  transition:
    stroke 0.15s,
    opacity 0.15s;
}
.edge--active {
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 2;
}
.edge--dim {
  opacity: 0.15;
}
.node {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border-radius: 12px;
  background: rgb(var(--v-theme-surface));
  border: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-left-width: 4px;
  color: rgb(var(--v-theme-on-surface)) !important;
  text-decoration: none;
}
.node:hover,
.node:focus-visible {
  border-color: rgb(var(--v-theme-primary));
  outline: none;
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
.empty {
  position: absolute;
  top: 0;
  padding: 16px 12px;
}
.shape {
  position: absolute;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding-top: 16px;
}
.legend > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.legend .box {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
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
