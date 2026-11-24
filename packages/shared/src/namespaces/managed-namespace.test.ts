import { describe, expect, it } from 'vitest';
import { FLAVOR_PLUGINS } from '../cluster/transform.js';
import { checkManifests, manifestsFromValuesTemplate } from '../helm/manifest-addon.js';
import { renderManifests } from '../operator-manifests.js';
import {
  ACCOUNTS_NAMESPACE,
  buildNamespaceHelmChartProxy,
  changedFields,
  managedNamespaceFromHelmChartProxy,
  managedNamespaceObjects,
  ManagedNamespaceSpecSchema,
  NAMESPACE_PROFILE_QUOTAS,
  NAMESPACE_PROFILES,
  namespaceAddonName,
  namespacesUnsupported,
  singleClusterSelector,
  type ManagedNamespaceSpecInput,
} from './managed-namespace.js';

const spec = (over: Partial<ManagedNamespaceSpecInput> = {}) =>
  ManagedNamespaceSpecSchema.parse({
    name: 'team-a',
    namespace: 'default',
    clusterSelector: singleClusterSelector('prod'),
    quota: NAMESPACE_PROFILE_QUOTAS.small,
    accounts: [{ name: 'ci', role: 'edit' }, { name: 'audit' }],
    ...over,
  });
const issues = (over: Record<string, unknown>) =>
  ManagedNamespaceSpecSchema.safeParse({ ...spec(), ...over }).error?.issues.map(
    (i) => `${i.path.join('.')}: ${i.message}`,
  ) ?? [];

describe('managed namespaces (FP-36)', () => {
  describe('objects per profile (FP36-F-02, hard rule 3)', () => {
    for (const profile of NAMESPACE_PROFILES) {
      it(profile, () => {
        const s = spec({
          profile,
          quota: NAMESPACE_PROFILE_QUOTAS[profile],
          allowFrom: profile === 'small' ? [] : ['ingress-nginx'],
        });
        expect(renderManifests(managedNamespaceObjects(s))).toMatchSnapshot();
        expect(renderManifests(managedNamespaceObjects(spec(s)))).toBe(
          renderManifests(managedNamespaceObjects(s)),
        );
      });
    }
  });

  it('keeps everything but the access when the release is removed (FP36-F-04)', () => {
    const keep = (o: { metadata: { annotations?: Record<string, string> } }) =>
      o.metadata.annotations?.['helm.sh/resource-policy'] === 'keep';
    const objects = managedNamespaceObjects(spec());
    expect(objects.filter(keep).map((o) => o.kind)).toEqual([
      'Namespace',
      'ResourceQuota',
      'LimitRange',
      'Tier',
      'NetworkPolicy',
    ]);
    expect(new Set(objects.filter((o) => !keep(o)).map((o) => o.kind))).toEqual(
      new Set(['ServiceAccount', 'RoleBinding']),
    );
  });

  it('keeps accounts out of the namespace and binds only view and edit there (FP36-F-07)', () => {
    const objects = managedNamespaceObjects(spec());
    const accounts = objects.filter((o) => o.kind === 'ServiceAccount');
    expect(accounts.map((a) => `${a.metadata.namespace}/${a.metadata.name}`)).toEqual([
      `${ACCOUNTS_NAMESPACE}/team-a.ci`,
      `${ACCOUNTS_NAMESPACE}/team-a.audit`,
    ]);
    const bindings = objects.filter((o) => o.kind.endsWith('Binding'));
    expect(
      bindings.every((b) => b.kind === 'RoleBinding' && b.metadata.namespace === 'team-a'),
    ).toBe(true);
    expect(bindings.map((b) => (b.roleRef as { name: string }).name)).toEqual(['edit', 'view']);
    expect(issues({ accounts: [{ name: 'x', role: 'admin' }] })).toHaveLength(1);
    expect(issues({ accounts: [{ name: 'x' }, { name: 'x' }] })).toEqual([
      'accounts.1.name: Account "x" is listed twice',
    ]);
    // "a" + "b-c" and "a-b" + "c" must not share an account.
    const name = (ns: string, account: string) =>
      managedNamespaceObjects(spec({ name: ns, accounts: [{ name: account }] })).find(
        (o) => o.kind === 'ServiceAccount',
      )!.metadata.name;
    expect(name('a', 'b-c')).not.toBe(name('a-b', 'c'));
  });

  it('refuses reserved names and limits below the requests (FP36-F-13)', () => {
    for (const name of ['default', 'kube-system', 'capi-navigator-accounts', 'calico-system']) {
      expect(issues({ name })).toEqual(['name: This name is reserved']);
    }
    expect(issues({ name: 'Team_A' })).toHaveLength(1);
    expect(issues({ clusterSelector: {} })).toHaveLength(1);
    expect(
      issues({ quota: { ...NAMESPACE_PROFILE_QUOTAS.small, cpuLimits: 1, memoryLimitsGiB: 2 } }),
    ).toEqual([
      'quota.cpuLimits: At least the requests',
      'quota.memoryLimitsGiB: At least the requests',
    ]);
  });

  it('becomes one HelmChartProxy and back (FP36-F-01)', () => {
    const s = spec();
    const hcp = buildNamespaceHelmChartProxy(s, { version: '0.20.0' });
    expect(hcp).toMatchSnapshot();
    expect(managedNamespaceFromHelmChartProxy(hcp)).toEqual(s);
    const values = (hcp.spec as { valuesTemplate: string }).valuesTemplate;
    const manifests = manifestsFromValuesTemplate(values)!;
    expect(checkManifests(manifests)).toMatchObject({ errors: [] });
    // FP30-F-06 stays: nothing secret in the HelmChartProxy.
    expect(manifests).not.toContain('kind: Secret');
    expect(values).not.toContain('{{');
  });

  it('ignores a form model copied to another HelmChartProxy', () => {
    const hcp = buildNamespaceHelmChartProxy(spec(), { version: '0.20.0' });
    for (const metadata of [
      { ...hcp.metadata, name: 'other' },
      { ...hcp.metadata, namespace: 'other' },
      { ...hcp.metadata, annotations: { 'capi-navigator.io/managed-namespace': '{' } },
      { ...hcp.metadata, labels: {} },
    ]) {
      expect(managedNamespaceFromHelmChartProxy({ ...hcp, metadata })).toBeUndefined();
    }
  });

  it('changes the values with every revision, but not the name (FP36-F-06)', () => {
    const a = buildNamespaceHelmChartProxy(spec(), { version: '1.0.0' });
    const b = buildNamespaceHelmChartProxy(spec({ revision: 2 }), { version: '1.0.0' });
    expect(b.metadata.name).toBe(a.metadata.name);
    expect(b.spec).not.toEqual(a.spec);
    expect(namespaceAddonName(spec({ clusterSelector: { env: 'dev' } }))).not.toBe(a.metadata.name);
    expect((b.spec as { releaseName: string }).releaseName).toBe('ns-team-a');
  });

  it('sees only changes of generated fields as drift (FP36-F-06)', () => {
    const quota = managedNamespaceObjects(spec())[1]!;
    const live = {
      ...quota,
      metadata: {
        ...quota.metadata,
        uid: 'x',
        annotations: { ...quota.metadata.annotations, y: 'z' },
      },
      status: { used: { pods: '3' } },
    };
    expect(changedFields(quota, live)).toEqual([]);
    const spec2 = structuredClone(quota.spec) as { hard: Record<string, string> };
    spec2.hard.pods = '99';
    expect(changedFields(quota, { ...live, spec: spec2 })).toEqual(['spec.hard.pods']);
    expect(changedFields(quota, undefined).length).toBeGreaterThan(3);
  });

  it('is offered only for distributions with Calico (FP36-F-03a)', () => {
    for (const flavor of ['rke2', 'k0s', 'kubeadm'] as const) {
      expect(namespacesUnsupported({ flavor })).toBeUndefined();
    }
    const plugin = FLAVOR_PLUGINS.k0s!;
    const cni = plugin.cni;
    try {
      plugin.cni = 'other';
      expect(namespacesUnsupported({ flavor: 'k0s' })).toContain('needs Calico');
    } finally {
      plugin.cni = cni;
    }
  });
});
