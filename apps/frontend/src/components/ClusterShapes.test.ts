import { mount, RouterLinkStub } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import type { ClusterSummary } from '@capi-navigator/shared';
import { createAppI18n } from '../i18n/index.js';
import ClusterShapes from './ClusterShapes.vue';

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

function mountShapes(clusters: ClusterSummary[]) {
  return mount(ClusterShapes, {
    props: { clusters },
    global: {
      plugins: [createAppI18n(), createVuetify({ components })],
      stubs: { RouterLink: RouterLinkStub },
    },
  });
}

describe('ClusterShapes (UX-02)', () => {
  it('shows control plane and worker nodes per pool, colored by state', () => {
    const w = mountShapes([
      cluster([
        { name: 'cp-a', role: 'control-plane', phase: 'Running', ready: true },
        { name: 'cp-b', role: 'control-plane', phase: 'Provisioning', ready: false },
        { name: 'w-a', role: 'worker', pool: 'default', phase: 'Running', ready: true },
        { name: 'w-b', role: 'worker', pool: 'gpu', phase: 'Deleting', ready: true },
        { name: 'w-c', role: 'worker', pool: 'gpu', phase: 'Failed', ready: false },
      ]),
    ]);
    expect(w.text()).toContain('pve-test');
    expect(w.text()).toContain('Proxmox VE');
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
    expect(w.findAllComponents(RouterLinkStub)[1]!.props('to')).toEqual({
      name: 'cluster',
      params: { namespace: 'default', name: 'pve-test' },
      query: { tab: 'machines' },
    });
  });

  it('says so when there are no clusters', () => {
    expect(mountShapes([]).text()).toContain('No workload clusters yet.');
  });
});
