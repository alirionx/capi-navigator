import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import type { MyNamespaces } from '@capi-navigator/shared';
import { createAppI18n } from '../i18n/index.js';
import MyNamespacesView from './MyNamespacesView.vue';

const entry = (): MyNamespaces['namespaces'][number] => ({
  connection: 'home',
  clusterNamespace: 'team',
  cluster: 'prod',
  namespace: 'team-a',
  accounts: [{ name: 'ci', role: 'edit' }],
  ready: true,
  unreachable: false,
  quota: [{ resource: 'requests.storage', used: '1Gi', hard: '20Gi' }],
  tokens: [{ id: 'token-1', account: 'ci', expired: false }],
});

describe('MyNamespacesView (FP37-F-03)', () => {
  let wrapper: VueWrapper;
  let data: MyNamespaces;
  const calls: [string, string][] = [];

  async function render() {
    const pinia = createPinia();
    setActivePinia(pinia);
    wrapper = mount(MyNamespacesView, {
      global: { plugins: [pinia, createAppI18n(), createVuetify({ components })] },
    });
    await flushPromises();
  }
  const find = (id: string) => wrapper.find(`[data-testid=${id}]`);

  beforeEach(() => {
    data = { incomplete: false, namespaces: [entry()] };
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([init?.method ?? 'GET', url]);
        return init?.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify(data), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    wrapper.unmount();
    vi.unstubAllGlobals();
  });

  it('shows cluster, usage, accounts and own access, and asks for nothing else', async () => {
    await render();
    const text = find('my-namespace-team-a').text();
    expect(text).toContain('Cluster prod');
    expect(text).toContain('Storage: 1Gi / 20Gi');
    expect(find('my-issue-team-a-ci').exists()).toBe(true);
    expect(calls).toEqual([['GET', '/api/my/namespaces']]);
  });

  it('revokes own access', async () => {
    await render();
    await find('my-revoke-token-1').trigger('click');
    await flushPromises();
    expect(calls).toContainEqual([
      'DELETE',
      '/api/my/namespaces/home/team/prod/team-a/tokens/token-1',
    ]);
  });

  it('explains an empty list and what is missing', async () => {
    data = { incomplete: true, namespaces: [] };
    await render();
    expect(find('my-namespaces-none').text()).toContain('Ask the owner');
    expect(find('my-namespaces').text()).toContain('Namespaces may be missing');
  });

  it('offers no access while the namespace is not ready', async () => {
    data.namespaces[0]!.ready = false;
    await render();
    expect(find('my-issue-team-a-ci').attributes('disabled')).toBeDefined();
  });
});
