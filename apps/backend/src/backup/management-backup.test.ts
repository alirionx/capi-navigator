import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import {
  backupCrds,
  buildManagementEntries,
  cleanForClusterctl,
  selectManagementBackup,
  workloadNamespaces,
  type KubeObject,
  type ManagementBackupInput,
  type RawCrd,
} from './management-backup.js';

const crd = (
  group: string,
  kind: string,
  labels: Record<string, string> = { 'clusterctl.cluster.x-k8s.io': '' },
  scope = 'Namespaced',
): RawCrd => ({
  metadata: { name: `${kind.toLowerCase()}s.${group}`, labels },
  spec: {
    group,
    scope,
    names: { kind, plural: `${kind.toLowerCase()}s` },
    versions: [
      { name: 'v1beta1', storage: false },
      { name: 'v1beta2', storage: true },
    ],
  },
});
const hierarchy = {
  'clusterctl.cluster.x-k8s.io': '',
  'clusterctl.cluster.x-k8s.io/move-hierarchy': '',
};

const RAW_CRDS: RawCrd[] = [
  crd('cluster.x-k8s.io', 'Cluster'),
  crd('cluster.x-k8s.io', 'Machine'),
  crd('controlplane.cluster.x-k8s.io', 'KubeadmControlPlane'),
  crd('controlplane.cluster.x-k8s.io', 'K0smotronControlPlane'),
  crd('infrastructure.cluster.x-k8s.io', 'DockerCluster'),
  crd('infrastructure.cluster.x-k8s.io', 'AWSClusterStaticIdentity', hierarchy, 'Cluster'),
  crd('infrastructure.cluster.x-k8s.io', 'OpenStackClusterIdentity', undefined, 'Cluster'),
  crd('addons.cluster.x-k8s.io', 'HelmChartProxy', hierarchy),
  crd('cert-manager.io', 'Certificate'),
  // The CAPI Operator's CRDs carry only …/core.
  crd('operator.cluster.x-k8s.io', 'CoreProvider', {
    'clusterctl.cluster.x-k8s.io/core': 'capi-operator',
  }),
  // Not labelled at all.
  crd('openstack.k-orc.cloud', 'Network', {}),
];

let uid = 0;
const obj = (
  apiVersion: string,
  kind: string,
  name: string,
  namespace: string | undefined,
  extra: Partial<KubeObject> & { owners?: KubeObject[] } = {},
): KubeObject => {
  const { owners, metadata, ...rest } = extra;
  return {
    apiVersion,
    kind,
    metadata: {
      name,
      ...(namespace ? { namespace } : {}),
      uid: `uid-${++uid}`,
      resourceVersion: '123',
      creationTimestamp: '2026-11-28T00:00:00Z',
      managedFields: [{ manager: 'capi' }],
      ...(owners
        ? {
            ownerReferences: owners.map((o) => ({
              apiVersion: o.apiVersion,
              kind: o.kind,
              name: o.metadata.name,
              uid: o.metadata.uid!,
              controller: true,
            })),
          }
        : {}),
      ...metadata,
    },
    ...rest,
  };
};

function fixture(): ManagementBackupInput {
  uid = 0;
  const provisioned = {
    status: { initialization: { infrastructureProvisioned: true, controlPlaneInitialized: true } },
  };
  const wl1 = obj('cluster.x-k8s.io/v1beta2', 'Cluster', 'wl1', 'team-a', {
    metadata: {
      name: 'wl1',
      labels: { 'capi-navigator.io/managed-by': 'capi-navigator' },
      annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"secret":"x"}' },
    },
    spec: { controlPlaneRef: { kind: 'KubeadmControlPlane', name: 'wl1-cp' } },
    ...provisioned,
  });
  const kcp = obj(
    'controlplane.cluster.x-k8s.io/v1beta2',
    'KubeadmControlPlane',
    'wl1-cp',
    'team-a',
    {
      owners: [wl1],
    },
  );
  const machine = obj('cluster.x-k8s.io/v1beta2', 'Machine', 'wl1-cp-abc', 'team-a', {
    owners: [kcp],
    status: { nodeRef: { name: 'wl1-cp-abc' } },
  });
  const newMachine = obj('cluster.x-k8s.io/v1beta2', 'Machine', 'wl1-cp-new', 'team-a', {
    owners: [kcp],
    status: {},
  });
  const infra = obj('infrastructure.cluster.x-k8s.io/v1beta2', 'DockerCluster', 'wl1', 'team-a', {
    owners: [wl1],
  });
  // Hosted cluster in the same namespace.
  const hcp = obj('cluster.x-k8s.io/v1beta2', 'Cluster', 'tenant', 'team-a', {
    metadata: { name: 'tenant', labels: { 'capi-navigator.io/hosted-on': 'wl1' } },
    spec: { controlPlaneRef: { kind: 'K0smotronControlPlane', name: 'tenant-control-plane' } },
    ...provisioned,
  });
  const hcpCp = obj(
    'controlplane.cluster.x-k8s.io/v1beta2',
    'K0smotronControlPlane',
    'tenant-control-plane',
    'team-a',
    { owners: [hcp] },
  );
  const chp = obj(
    'addons.cluster.x-k8s.io/v1alpha1',
    'HelmChartProxy',
    'capi-navigator-ccm',
    'team-a',
  );
  const chpOnly = obj('addons.cluster.x-k8s.io/v1alpha1', 'HelmChartProxy', 'ns-dev', 'team-b');
  const awsIdentity = obj(
    'infrastructure.cluster.x-k8s.io/v1beta2',
    'AWSClusterStaticIdentity',
    'aws-prod',
    undefined,
    { metadata: { name: 'aws-prod', labels: { 'capi-navigator.io/credential': 'aws-prod' } } },
  );
  const osIdentity = obj(
    'infrastructure.cluster.x-k8s.io/v1beta2',
    'OpenStackClusterIdentity',
    'os-prod',
    undefined,
    { metadata: { name: 'os-prod', labels: { 'capi-navigator.io/credential': 'os-prod' } } },
  );
  const certificate = obj('cert-manager.io/v1', 'Certificate', 'capi-serving-cert', 'capi-system');
  const secret = (
    name: string,
    ns: string,
    extra: Partial<KubeObject> & { owners?: KubeObject[] } = {},
  ) => obj('v1', 'Secret', name, ns, { type: 'Opaque', data: { value: 'c2VjcmV0' }, ...extra });
  return {
    crds: backupCrds(RAW_CRDS),
    objects: [
      wl1,
      kcp,
      machine,
      newMachine,
      infra,
      hcp,
      hcpCp,
      chp,
      chpOnly,
      awsIdentity,
      osIdentity,
      certificate,
    ],
    secrets: [
      secret('wl1-ca', 'team-a', { owners: [kcp] }),
      secret('wl1-kubeconfig', 'team-a', { owners: [kcp] }),
      // Soft owner: CAPI name, no owner reference.
      secret('wl1-etcd', 'team-a'),
      secret('tenant-kubeconfig', 'team-a', { owners: [hcpCp] }),
      secret('tenant-ca', 'team-a'),
      secret('wl1-proxmox-credentials', 'team-a', {
        metadata: {
          name: 'wl1-proxmox-credentials',
          labels: {
            'capi-navigator.io/managed-by': 'capi-navigator',
            'cluster.x-k8s.io/cluster-name': 'wl1',
          },
        },
      }),
      secret('someone-elses', 'team-a'),
    ],
    configMaps: [obj('v1', 'ConfigMap', 'kube-root-ca.crt', 'team-a', { data: { 'ca.crt': 'x' } })],
    providers: [
      obj('operator.cluster.x-k8s.io/v1alpha2', 'InfrastructureProvider', 'aws', 'capa-system', {
        spec: { version: 'v2.13.1', configSecret: { name: 'aws-infrastructure-variables' } },
        status: { installedVersion: 'v2.13.1' },
      }),
      obj('operator.cluster.x-k8s.io/v1alpha2', 'CoreProvider', 'cluster-api', 'capi-system', {
        spec: { version: 'v1.14.4' },
      }),
    ],
    providerNamespaces: [
      obj('v1', 'Namespace', 'capa-system', undefined, {
        metadata: {
          name: 'capa-system',
          labels: { 'capi-navigator.io/managed-by': 'capi-navigator' },
        },
      }),
      obj('v1', 'Namespace', 'capi-system', undefined),
    ],
    providerSecrets: [
      secret('capi-navigator-credential-aws-prod', 'capa-system'),
      secret('aws-infrastructure-variables', 'capa-system'),
    ],
    hostedControlPlaneKinds: ['K0smotronControlPlane'],
  };
}

const keys = (objects: KubeObject[]) =>
  objects.map(
    (o) => `${o.kind} ${o.metadata.namespace ? `${o.metadata.namespace}/` : ''}${o.metadata.name}`,
  );

describe('backup of a management cluster (FP-39)', () => {
  it('selects the CRDs clusterctl would, without cert-manager and the operator (FP39-F-02)', () => {
    const crds = backupCrds(RAW_CRDS);
    expect(crds.map((c) => c.kind)).toEqual([
      'HelmChartProxy',
      'Cluster',
      'Machine',
      'K0smotronControlPlane',
      'KubeadmControlPlane',
      'AWSClusterStaticIdentity',
      'DockerCluster',
      'OpenStackClusterIdentity',
    ]);
    expect(crds.every((c) => c.version === 'v1beta2')).toBe(true);
    expect(crds.find((c) => c.kind === 'AWSClusterStaticIdentity')).toMatchObject({
      namespaced: false,
      moveHierarchy: true,
    });
  });

  it('finds the workload namespaces by their roots, never provider namespaces (FP39-F-02)', () => {
    const input = fixture();
    expect(workloadNamespaces(input.crds, input.objects)).toEqual(['team-a', 'team-b']);
  });

  it('keeps the CAPI hierarchy, its Secrets and the app objects, and leaves out hosted clusters (FP39-F-03, F-06)', () => {
    const s = selectManagementBackup(fixture());
    expect(keys(s.capi)).toEqual([
      'AWSClusterStaticIdentity aws-prod',
      'Secret team-a/wl1-ca',
      'Secret team-a/wl1-etcd',
      'Secret team-a/wl1-kubeconfig',
      'Secret team-a/wl1-proxmox-credentials',
      'HelmChartProxy team-a/capi-navigator-ccm',
      'Cluster team-a/wl1',
      'Machine team-a/wl1-cp-abc',
      'Machine team-a/wl1-cp-new',
      'KubeadmControlPlane team-a/wl1-cp',
      'DockerCluster team-a/wl1',
      'HelmChartProxy team-b/ns-dev',
    ]);
    // Not: cert-manager, the hosted cluster with its control plane and Secrets, foreign Secrets,
    // the OpenStack identity (not move-hierarchy: it goes to identities/).
    expect(s.excluded).toEqual([
      {
        kind: 'Cluster',
        namespace: 'team-a',
        name: 'tenant',
        message:
          'Hosted control plane: its etcd is not part of the backup, so the cluster is left out.',
      },
    ]);
    const app = s.capi.find((o) => o.metadata.name === 'wl1-proxmox-credentials')!;
    expect(app.metadata.labels).toMatchObject({ 'clusterctl.cluster.x-k8s.io/move': '' });
    const owned = s.capi.find((o) => o.metadata.name === 'wl1-ca')!;
    expect(owned.metadata.labels?.['clusterctl.cluster.x-k8s.io/move']).toBeUndefined();
  });

  it('keeps uid and owner references for clusterctl, pauses clusters and drops the rest (FP39-F-05)', () => {
    const s = selectManagementBackup(fixture());
    const cluster = s.capi.find((o) => o.kind === 'Cluster')!;
    expect(cluster.spec?.paused).toBe(true);
    expect(cluster.status).toBeUndefined();
    expect(cluster.metadata.uid).toBeDefined();
    expect(cluster.metadata).not.toHaveProperty('resourceVersion');
    expect(cluster.metadata).not.toHaveProperty('managedFields');
    expect(cluster.metadata).not.toHaveProperty('creationTimestamp');
    expect(cluster.metadata.annotations).toBeUndefined();
    const kcp = s.capi.find((o) => o.kind === 'KubeadmControlPlane')!;
    expect(kcp.metadata.ownerReferences?.[0]).toMatchObject({
      kind: 'Cluster',
      uid: cluster.metadata.uid,
    });
    const cc = cleanForClusterctl({
      apiVersion: 'cluster.x-k8s.io/v1beta2',
      kind: 'ClusterClass',
      metadata: { name: 'quick-start', namespace: 'team-a' },
    });
    expect(cc.metadata.annotations).toEqual({ 'cluster.x-k8s.io/paused': '' });
  });

  it('drops a namespace that held only hosted clusters (FP39-F-06)', () => {
    const input = fixture();
    input.objects.push({
      apiVersion: 'cluster.x-k8s.io/v1beta2',
      kind: 'Cluster',
      metadata: { name: 'only-hosted', namespace: 'team-c', uid: 'uid-c' },
      spec: { controlPlaneRef: { kind: 'K0smotronControlPlane', name: 'x' } },
    });
    const s = selectManagementBackup(input);
    expect(s.namespaces).toEqual(['team-a', 'team-b']);
    expect(s.excluded.map((e) => e.name)).toEqual(['tenant', 'only-hosted']);
  });

  it('never changes the objects it was given (FP39-F-01)', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    selectManagementBackup(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('builds the provider part for kubectl: no uid, owners or status (FP39-F-04)', () => {
    const s = selectManagementBackup(fixture());
    expect(keys(s.providers.providers)).toEqual([
      'CoreProvider capi-system/cluster-api',
      'InfrastructureProvider capa-system/aws',
    ]);
    expect(s.providers.providers[1]!.status).toBeUndefined();
    expect(keys(s.providers.namespaces)).toEqual([
      'Namespace capa-system',
      'Namespace capi-system',
    ]);
    expect(keys(s.providers.secrets)).toEqual([
      'Secret capa-system/aws-infrastructure-variables',
      'Secret capa-system/capi-navigator-credential-aws-prod',
    ]);
    for (const o of [...s.providers.secrets, ...s.identities]) {
      expect(o.metadata.uid).toBeUndefined();
      expect(o.metadata.ownerReferences).toBeUndefined();
    }
    expect(keys(s.identities)).toEqual([
      'AWSClusterStaticIdentity aws-prod',
      'OpenStackClusterIdentity os-prod',
    ]);
  });

  it('warns about clusters in the middle of a change instead of stopping (FP39-F-07)', () => {
    const input = fixture();
    const cluster = input.objects.find((o) => o.metadata.name === 'wl1')!;
    cluster.spec = { ...cluster.spec, paused: true };
    cluster.status = { initialization: { infrastructureProvisioned: true } };
    input.objects.find((o) => o.metadata.name === 'wl1-cp')!.metadata.deletionTimestamp =
      '2026-11-28T01:00:00Z';
    const s = selectManagementBackup(input);
    expect(s.warnings.map((w) => `${w.kind} ${w.name}: ${w.message}`)).toEqual([
      'Cluster wl1: Not provisioned yet; a restore continues where it stands.',
      'Cluster wl1: Paused in the source; clusterctl unpauses it at the end of a restore.',
      'KubeadmControlPlane wl1-cp: Being deleted; the backup holds it as it was.',
      'Machine wl1-cp-new: Machine without a node yet.',
    ]);
    expect(s.capi.find((o) => o.kind === 'KubeadmControlPlane')!.metadata).not.toHaveProperty(
      'deletionTimestamp',
    );
  });

  it('writes capi/ with one file per namespace, providers/, identities/ and the guide (snapshot)', () => {
    const s = selectManagementBackup(fixture());
    const entries = buildManagementEntries(s, {
      connection: 'prod',
      createdAt: new Date('2026-11-28T03:00:00Z'),
      createdBy: 'admin',
      appVersion: '0.23.0',
      recipients: ['ABCDEF'],
      versions: [
        { name: 'cluster-api', version: 'v1.14.4' },
        { name: 'aws', version: 'v2.13.1' },
      ],
    });
    expect(entries.map((e) => e.name)).toEqual([
      'manifest.json',
      'RESTORE.md',
      'providers/10-namespaces.yaml',
      'providers/20-secrets.yaml',
      'providers/30-providers.yaml',
      'identities/identities.yaml',
      'capi/_cluster-scoped.yaml',
      'capi/team-a.yaml',
      'capi/team-b.yaml',
    ]);
    const capiA = parseAllDocuments(
      entries.find((e) => e.name === 'capi/team-a.yaml')!.content.toString(),
    ).map((d) => d.toJS() as KubeObject);
    expect(capiA.every((o) => o.metadata.namespace === 'team-a')).toBe(true);
    const manifest = JSON.parse(entries[0]!.content.toString());
    expect(manifest.excluded).toHaveLength(1);
    expect(
      manifest.files.find((f: { name: string }) => f.name === 'capi/team-a.yaml').objects,
    ).toContainEqual({
      kind: 'Secret',
      count: 4,
    });
    const guide = entries[1]!.content.toString();
    expect(guide).toContain('clusterctl v1.14.x (the CAPI version of the backup is v1.14.4)');
    expect(guide).toContain('- team-a/tenant');
    expect(
      Object.fromEntries(entries.map((e) => [e.name, e.content.toString()])),
    ).toMatchSnapshot();
  });

  it('gives byte-identical archives for the same input (hard rule 3)', () => {
    const meta = {
      connection: 'prod',
      createdAt: new Date('2026-11-28T03:00:00Z'),
      createdBy: 'admin',
      appVersion: '0.23.0',
      recipients: [],
      versions: [],
    };
    const a = buildManagementEntries(selectManagementBackup(fixture()), meta);
    const b = buildManagementEntries(selectManagementBackup(fixture()), meta);
    expect(a.map((e) => e.content.toString())).toEqual(b.map((e) => e.content.toString()));
  });
});
