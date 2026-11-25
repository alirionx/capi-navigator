import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import {
  ManagedNamespaceSpecSchema,
  NAMESPACE_PROFILE_QUOTAS,
  singleClusterSelector,
  type ManagedNamespaces,
  type Permission,
} from '@capi-navigator/shared';
import { createAppI18n } from '../../i18n/index.js';
import { useAuthStore } from '../../stores/auth.js';
import ClusterNamespaces from './ClusterNamespaces.vue';

const spec = ManagedNamespaceSpecSchema.parse({
  name: 'team-a',
  namespace: 'team',
  clusterSelector: singleClusterSelector('prod'),
  quota: NAMESPACE_PROFILE_QUOTAS.small,
  accounts: [{ name: 'ci', role: 'edit' }],
});
const view = (): ManagedNamespaces => ({
  namespaces: [
    {
      name: 'team-a',
      spec,
      addon: { name: 'ns-team-a-1', ready: true },
      exists: true,
      leftOver: false,
      terminating: false,
      drift: [],
      quota: [{ resource: 'pods', used: '3', hard: '20' }],
      accounts: [{ name: 'ci', role: 'edit', exists: true }],
      tokens: [{ id: 'token-1', account: 'ci', createdBy: 'op', expired: false }],
    },
    {
      name: 'old',
      exists: true,
      leftOver: true,
      terminating: false,
      drift: [],
      quota: [],
      accounts: [],
      tokens: [],
    },
  ],
});

describe('ClusterNamespaces (FP36-F-11)', () => {
  let wrapper: VueWrapper;
  let data: ManagedNamespaces;

  async function render(permissions: Permission[]) {
    const pinia = createPinia();
    setActivePinia(pinia);
    useAuthStore().me = {
      username: 'u',
      mustChangePassword: false,
      bindings: [{ role: 'operator', permissions }],
    } as unknown as ReturnType<typeof useAuthStore>['me'];
    wrapper = mount(ClusterNamespaces, {
      props: { connection: 'home', namespace: 'team', name: 'prod' },
      global: { plugins: [pinia, createAppI18n(), createVuetify({ components })] },
    });
    await flushPromises();
    return wrapper;
  }
  const has = (id: string) => wrapper.find(`[data-testid=${id}]`).exists();

  beforeEach(() => {
    data = view();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })),
    );
  });
  afterEach(() => {
    wrapper.unmount();
    vi.unstubAllGlobals();
  });

  it('shows namespaces, usage, accounts and issued access', async () => {
    const w = await render(['view', 'clusters.access']);
    expect(w.find('[data-testid=namespace-team-a]').text()).toContain('Pods: 3 / 20');
    expect(w.find('[data-testid=namespace-team-a]').text()).toContain('Ready');
    expect(w.find('[data-testid=namespace-old]').text()).toContain('No access');
    expect(has('issue-team-a-ci')).toBe(true);
    expect(has('revoke-token-1')).toBe(true);
  });

  it('keeps ending the access and deleting the namespace apart (FP36-F-04, F-05)', async () => {
    await render(['view', 'clusters.access']);
    expect([has('end-namespace-team-a'), has('delete-namespace-team-a')]).toEqual([true, false]);
    expect([has('end-namespace-old'), has('delete-namespace-old')]).toEqual([false, true]);
  });

  it('offers nothing for a namespace that is being deleted', async () => {
    data.namespaces[1]!.terminating = true;
    await render(['view', 'clusters.access']);
    expect(wrapper.find('[data-testid=namespace-old]').text()).toContain('Being deleted');
    expect([has('take-over-namespace-old'), has('delete-namespace-old')]).toEqual([false, false]);
  });

  it('offers viewers no actions (FP36-F-12)', async () => {
    await render(['view']);
    for (const id of [
      'new-namespace',
      'end-namespace-team-a',
      'delete-namespace-old',
      'issue-team-a-ci',
      'revoke-token-1',
    ]) {
      expect(has(id)).toBe(false);
    }
  });

  it('cannot be used for an unsuitable cluster (FP36-F-03a)', async () => {
    data = { unsupported: 'The network isolation needs Calico', namespaces: [] };
    await render(['view', 'clusters.access']);
    expect(has('new-namespace')).toBe(false);
    expect(wrapper.find('[data-testid=namespaces-unsupported]').text()).toContain('needs Calico');
  });

  it('shows assigned people and offers to revoke what removed people issued (FP37-F-05)', async () => {
    const n = data.namespaces[0]!;
    n.spec = {
      ...spec,
      accounts: [{ ...spec.accounts[0]!, people: [{ kind: 'user', name: 'max', uid: 'u' }] }],
    };
    n.tokens = [
      { id: 'token-1', account: 'ci', createdBy: 'max', expired: false },
      { id: 'token-2', account: 'ci', createdBy: 'old', expired: false, unassigned: true },
      { id: 'token-3', account: 'ci', createdBy: 'old', expired: true, unassigned: true },
    ];
    await render(['view', 'clusters.access']);
    expect(wrapper.find('[data-testid=people-team-a-ci]').text()).toContain('max');
    expect(wrapper.find('[data-testid=unassigned-team-a]').text()).toContain('1 access was issued');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(data), { status: 200 }),
    );
    await wrapper.find('[data-testid=revoke-unassigned-team-a]').trigger('click');
    await flushPromises();
    const deleted = fetchMock.mock.calls.filter(([, i]) => i?.method === 'DELETE').map(([u]) => u);
    expect(deleted).toEqual([expect.stringMatching(/\/team-a\/tokens\/token-2$/)]);
  });

  it('offers to restore changed objects (FP36-F-06)', async () => {
    data.namespaces[0]!.drift = [
      { kind: 'ResourceQuota', name: 'capi-navigator', missing: false, fields: ['spec.hard.pods'] },
      { kind: 'LimitRange', name: 'capi-navigator', missing: true, fields: [] },
    ];
    await render(['view', 'clusters.access']);
    expect(has('restore-namespace-team-a')).toBe(true);
    expect(wrapper.find('[data-testid=drift-team-a]').text()).toContain('spec.hard.pods');
    expect(wrapper.find('[data-testid=drift-team-a]').text()).toContain(
      'LimitRange capi-navigator: missing',
    );
  });
});
