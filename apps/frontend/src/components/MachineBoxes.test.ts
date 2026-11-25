import { mount, RouterLinkStub } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import type { ClusterSummary, InstalledProvider } from '@capi-navigator/shared';
import { createAppI18n } from '../i18n/index.js';
import MachineBoxes from './MachineBoxes.vue';
import ProviderGraph from './ProviderGraph.vue';

const cluster = (machines: ClusterSummary['machines']): ClusterSummary => ({
  name: 'pve-test',
  namespace: 'default',
  provider: 'proxmox',
  phase: 'Provisioned',
  ready: true,
  labels: {},
  managed: true,
  machines,
});
const global = {
  plugins: [createAppI18n(), createVuetify({ components })],
  stubs: { RouterLink: RouterLinkStub },
};

describe('MachineBoxes (UX-02)', () => {
  it('shows control plane and worker nodes per pool, colored by state', () => {
    const w = mount(MachineBoxes, {
      props: {
        cluster: cluster([
          { name: 'cp-a', role: 'control-plane', phase: 'Running', ready: true },
          { name: 'cp-b', role: 'control-plane', phase: 'Provisioning', ready: false },
          { name: 'w-a', role: 'worker', pool: 'default', phase: 'Running', ready: true },
          { name: 'w-b', role: 'worker', pool: 'gpu', phase: 'Deleting', ready: true },
          { name: 'w-c', role: 'worker', pool: 'gpu', phase: 'Failed', ready: false },
        ]),
      },
      global,
    });
    expect(w.text()).toContain('Control plane');
    expect(w.text()).toContain('gpu');
    const boxes = w.findAll('[data-testid="shape-machine"]');
    expect(boxes.map((b) => b.attributes('title'))).toEqual([
      'cp-a: Running',
      'cp-b: Provisioning',
      'w-a: Running',
      'w-b: Deleting',
      'w-c: Failed',
    ]);
    expect(boxes.map((b) => b.classes().find((c) => c.startsWith('box--')))).toEqual([
      'box--ready',
      'box--pending',
      'box--ready',
      'box--deleting',
      'box--failed',
    ]);
    // A box leads to the machines of its cluster.
    expect(w.findAllComponents(RouterLinkStub)[0]!.props('to')).toEqual({
      name: 'cluster',
      params: { namespace: 'default', name: 'pve-test' },
      query: { tab: 'machines' },
    });
  });

  it('shows at most twelve boxes per group, then the rest as a number', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      name: `w-${i}`,
      role: 'worker' as const,
      pool: 'default',
      phase: 'Running',
      ready: true,
    }));
    const w = mount(MachineBoxes, { props: { cluster: cluster(many) }, global });
    expect(w.findAll('[data-testid="shape-machine"]')).toHaveLength(12);
    expect(w.text()).toContain('+3');
  });
});

describe('ProviderGraph with the nodes of each cluster (UX-02)', () => {
  const core = {
    kind: 'CoreProvider',
    name: 'cluster-api',
    namespace: 'capi-system',
    phase: 'Ready',
  } as unknown as InstalledProvider;

  it('places the nodes next to their cluster, with the legend below', () => {
    const w = mount(ProviderGraph, {
      props: {
        providers: [core],
        clusters: [
          cluster([{ name: 'cp-a', role: 'control-plane', phase: 'Running', ready: true }]),
        ],
      },
      global,
    });
    // Row 1 is the header, row 2 the offset that centers the clusters, then one row per cluster.
    const top = /top: (\d+)px/.exec(w.findAll('.node').at(-1)!.attributes('style')!)![1];
    expect(w.get('.shapes').attributes('style')).toContain(
      `grid-template-rows: 28px ${top}px repeat(1, 62px)`,
    );
    expect(w.get('.shape').attributes('style')).toContain('grid-row: 3');
    expect(w.get('.shape').find('[data-testid="cluster-shape"]').exists()).toBe(true);
    expect(w.text()).toContain('Nodes: control plane and worker pools');
    expect(w.text()).toContain('Starting or not ready');
  });

  it('shows neither nodes column nor legend without clusters', () => {
    const w = mount(ProviderGraph, { props: { providers: [core], clusters: [] }, global });
    expect(w.find('[data-testid="cluster-shape"]').exists()).toBe(false);
    expect(w.text()).not.toContain('Starting or not ready');
  });
});
