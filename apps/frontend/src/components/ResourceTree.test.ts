import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import type { ClusterStatus } from '@capi-navigator/shared';
import { createAppI18n } from '../i18n/index.js';
import ResourceTree from './ResourceTree.vue';

const machine = (name: string, extra: Partial<ClusterStatus['machines'][number]>) => ({
  name,
  role: 'worker' as const,
  phase: 'Running',
  conditions: [],
  ...extra,
});

const status: ClusterStatus = {
  summary: {
    name: 'demo',
    namespace: 'team-a',
    phase: 'Provisioned',
    ready: false,
    labels: {},
    managed: true,
  },
  conditions: [],
  infrastructure: { kind: 'OpenStackCluster', name: 'demo', ready: true, conditions: [] },
  controlPlane: {
    kind: 'RKE2ControlPlane',
    name: 'demo-control-plane',
    replicas: 1,
    ready: 1,
    conditions: [],
  },
  machineDeployments: [
    { name: 'demo-default', replicas: 2, ready: 1, upToDate: 2, conditions: [] },
  ],
  machines: [
    machine('cp-1', { role: 'control-plane' }),
    machine('w-1', { deployment: 'demo-default' }),
    machine('w-2', { deployment: 'demo-default', phase: 'Failed' }),
  ],
  events: [],
  kubeconfigAvailable: true,
};

describe('ResourceTree (FP6-F-03)', () => {
  it('renders cluster, infrastructure, control plane, pools and machines with status colors', async () => {
    const w = mount(ResourceTree, {
      props: { status },
      global: { plugins: [createAppI18n(), createVuetify({ components })] },
    });
    const nodes = w.findAll('.node');
    expect(nodes.map((n) => n.find('.name').text())).toEqual([
      'demo',
      'demo',
      'demo-control-plane',
      'cp-1',
      'demo-default',
      'w-1',
      'w-2',
    ]);
    // One edge per node except the root.
    expect(w.findAll('path.edge')).toHaveLength(6);
    expect(nodes.find((n) => n.text().includes('w-2'))!.classes()).toContain('node--error');
    expect(nodes.find((n) => n.text().includes('demo-default'))!.classes()).toContain('node--info');

    await nodes.find((n) => n.text().includes('w-2'))!.trigger('click');
    expect(w.find('[data-testid=tree-selection]').text()).toContain('w-2');
  });
});
