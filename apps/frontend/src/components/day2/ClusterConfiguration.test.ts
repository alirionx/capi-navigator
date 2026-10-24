import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { ClusterSpecSchema, type ClusterStatus } from '@capi-navigator/shared';
import { createAppI18n } from '../../i18n/index.js';
import ClusterConfiguration from './ClusterConfiguration.vue';

const spec = ClusterSpecSchema.parse({
  name: 'pve',
  namespace: 'default',
  kubernetes: { version: 'v1.35.9+rke2r1' },
  topology: {
    mode: 'all-in-one',
    controlPlane: { replicas: 1, machineSize: 'medium' },
    workerPools: [],
  },
  infrastructure: {
    provider: 'proxmox',
    credentialRef: 'homelab',
    sourceNode: 'homeserver',
    image: '7112',
    storage: 'local-zfs',
    network: {
      nodeCidr: '192.168.10.0/24',
      gateway: '192.168.10.1',
      addresses: ['192.168.10.71-192.168.10.75'],
    },
    apiEndpoint: '192.168.10.89',
  },
});
const status = { machines: [], machineDeployments: [] } as unknown as ClusterStatus;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const emptyPreview = { diffs: [], rollouts: [], drift: [], warnings: [], blockers: [] };

describe('ClusterConfiguration: infrastructure settings (FP-33)', () => {
  let requests: { url: string; body: unknown }[];
  beforeEach(() => {
    requests = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // Vuetify's dialog positions itself against the visual viewport.
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 1024, height: 768 }));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/spec')) return Promise.resolve(json(spec));
        if (url.endsWith('/changes/preview')) return Promise.resolve(json(emptyPreview));
        return Promise.resolve(json([]));
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the changeable fields and sends only declared ones', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const w = mount(ClusterConfiguration, {
      props: { connection: 'home', namespace: 'default', name: 'pve', status },
      global: { plugins: [pinia, createAppI18n(), createVuetify({ components })] },
      attachTo: document.body,
    });
    await flushPromises();
    const card = w.get('[data-testid="day2-infra"]');
    expect(card.text()).toContain('ProxmoxCluster');
    expect(card.text()).toContain('Memory scheduling (%)');
    expect(card.text()).toContain('192.168.10.71-192.168.10.75');
    expect(card.text()).not.toContain('Gateway');

    await card.get('[data-testid="day2-infra-change"]').trigger('click');
    await flushPromises();
    const dialog = document.body;
    expect(dialog.textContent).toContain('addresses can only be added');
    const input = dialog.querySelector<HTMLInputElement>('[data-testid="pve-addresses"] input')!;
    input.value = '192.168.10.71-192.168.10.75, 192.168.10.76';
    input.dispatchEvent(new Event('input'));
    await flushPromises();
    dialog.querySelector<HTMLButtonElement>('[data-testid="change-preview"]')!.click();
    await flushPromises();
    const sent = requests.filter((r) => r.url.endsWith('/changes/preview')).at(-1)!.body;
    expect(sent).toEqual({
      change: {
        type: 'infrastructure',
        values: {
          memoryAdjustment: 0,
          'network.dnsNameservers': ['1.1.1.1', '8.8.8.8'],
          'network.addresses': ['192.168.10.71-192.168.10.75', '192.168.10.76'],
          allowedNodes: null,
        },
      },
    });
    w.unmount();
  });
});
