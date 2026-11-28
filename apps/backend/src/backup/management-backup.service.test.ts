import {
  ApiextensionsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  type KubeConfig,
} from '@kubernetes/client-node';
import * as openpgp from 'openpgp';
import { describe, expect, it } from 'vitest';
import type { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { readFromChartArchive } from '../helm/chart-archive.js';
import type { BackupService } from './backup.service.js';
import { hostedControlPlaneKinds, ManagementBackupService } from './management-backup.service.js';

const forbidden = () =>
  Object.assign(new Error('forbidden'), {
    code: 403,
    body: { message: 'ipaddresses is forbidden' },
  });
const notFound = () => Object.assign(new Error('not found'), { code: 404 });

const crd = (
  group: string,
  kind: string,
  scope = 'Namespaced',
  extra: Record<string, string> = {},
) => ({
  metadata: {
    name: `${kind.toLowerCase()}s.${group}`,
    labels: { 'clusterctl.cluster.x-k8s.io': '', ...extra },
  },
  spec: {
    group,
    scope,
    names: { kind, plural: `${kind.toLowerCase()}s` },
    versions: [{ name: 'v1beta2', storage: true }],
  },
});

/** A management cluster behind fake API clients; records every call. */
function fakeCluster(opts: { forbidIpam?: boolean } = {}) {
  const calls: string[] = [];
  const cluster = {
    metadata: { name: 'wl1', namespace: 'team-a', uid: 'c1', resourceVersion: '7' },
    spec: { controlPlaneRef: { kind: 'KubeadmControlPlane', name: 'wl1-cp' } },
    status: { initialization: { infrastructureProvisioned: true, controlPlaneInitialized: true } },
  };
  const kcp = {
    metadata: {
      name: 'wl1-cp',
      namespace: 'team-a',
      uid: 'k1',
      ownerReferences: [
        { apiVersion: 'cluster.x-k8s.io/v1beta2', kind: 'Cluster', name: 'wl1', uid: 'c1' },
      ],
    },
  };
  const custom = {
    listClusterCustomObject: async (a: { group: string; plural: string; _continue?: string }) => {
      calls.push(`list ${a.plural}.${a.group}${a._continue ? ' (page 2)' : ''}`);
      if (a.group === 'cluster.x-k8s.io' && a.plural === 'clusters') return { items: [cluster] };
      if (a.plural === 'kubeadmcontrolplanes')
        // Two pages, to cover paging.
        return a._continue
          ? { items: [], metadata: {} }
          : { items: [kcp], metadata: { _continue: 'next' } };
      if (a.group === 'ipam.cluster.x-k8s.io' && opts.forbidIpam) throw forbidden();
      if (a.group === 'operator.cluster.x-k8s.io') {
        if (a.plural === 'coreproviders')
          return {
            items: [
              {
                apiVersion: 'operator.cluster.x-k8s.io/v1alpha2',
                metadata: { name: 'cluster-api', namespace: 'capi-system' },
                spec: { version: 'v1.14.4', configSecret: { name: 'capi-variables' } },
              },
            ],
          };
        throw notFound();
      }
      return { items: [] };
    },
  };
  const core = {
    listNamespacedSecret: async (a: { namespace: string; labelSelector?: string }) => {
      calls.push(`secrets ${a.namespace}${a.labelSelector ? ` ${a.labelSelector}` : ''}`);
      if (a.namespace === 'team-a')
        return {
          items: [
            {
              metadata: {
                name: 'wl1-ca',
                namespace: 'team-a',
                uid: 's1',
                ownerReferences: [
                  {
                    apiVersion: 'controlplane.cluster.x-k8s.io/v1beta2',
                    kind: 'KubeadmControlPlane',
                    name: 'wl1-cp',
                    uid: 'k1',
                  },
                ],
              },
              data: { 'tls.key': 'a2V5' },
            },
            { metadata: { name: 'other', namespace: 'team-a', uid: 's2' }, data: {} },
          ],
        };
      return {
        items: [
          {
            metadata: {
              name: 'capi-navigator-credential-x',
              namespace: a.namespace,
              labels: { 'capi-navigator.io/managed-by': 'capi-navigator' },
            },
            data: { 'clouds.yaml': 'eA==' },
          },
        ],
      };
    },
    listNamespacedConfigMap: async () => ({ items: [] }),
    readNamespace: async (a: { name: string }) => ({ metadata: { name: a.name } }),
    readNamespacedSecret: async (a: { name: string; namespace: string }) => {
      calls.push(`read secret ${a.namespace}/${a.name}`);
      return { metadata: { name: a.name, namespace: a.namespace }, data: { v: 'eA==' } };
    },
  };
  const ext = {
    listCustomResourceDefinition: async () => ({
      items: [
        crd('cluster.x-k8s.io', 'Cluster'),
        crd('controlplane.cluster.x-k8s.io', 'KubeadmControlPlane'),
        crd('ipam.cluster.x-k8s.io', 'IPAddress'),
        crd('cert-manager.io', 'Certificate'),
      ],
    }),
  };
  const kc = {
    makeApiClient: (cls: unknown) => {
      if (cls === CustomObjectsApi) return custom;
      if (cls === CoreV1Api) return core;
      if (cls === ApiextensionsV1Api) return ext;
      // detectPrerequisites asks further APIs; the backup works without them.
      throw new Error('not faked');
    },
  } as unknown as KubeConfig;
  return { kc, calls };
}

async function setup(opts: { forbidIpam?: boolean; noKey?: boolean } = {}) {
  const key = await openpgp.generateKey({
    type: 'curve25519',
    userIDs: [{ name: 'Ops', email: 'ops@example.com' }],
    format: 'armored',
  });
  const cluster = fakeCluster(opts);
  const clients = { forConnection: async () => cluster.kc } as unknown as ManagementClusterClients;
  const backup = {
    storedSpec: async () => ({ recipients: opts.noKey ? [] : [{ publicKey: key.publicKey }] }),
    recipientKeys: async () => {
      if (opts.noKey) throw Object.assign(new Error('No backup key is set'), { status: 400 });
      return [await openpgp.readKey({ armoredKey: key.publicKey })];
    },
  } as unknown as BackupService;
  return { svc: new ManagementBackupService(clients, backup), key, calls: cluster.calls };
}

describe('backup of a management cluster through its connection (FP-39)', () => {
  it('names the hosted control plane kinds of the flavor plugins (FP39-F-06)', () => {
    expect(hostedControlPlaneKinds()).toEqual(['K0smotronControlPlane']);
  });

  it('previews the content and reads only what it needs (FP39-F-09)', async () => {
    const { svc, calls } = await setup();
    const preview = await svc.preview('prod');
    expect(preview).toMatchObject({
      connection: 'prod',
      namespaces: ['team-a'],
      unreadable: [],
      recipients: 1,
      versions: [{ name: 'cluster-api', version: 'v1.14.4' }],
    });
    expect(Object.fromEntries(preview.capi.map((i) => [i.kind, i.count]))).toEqual({
      Cluster: 1,
      KubeadmControlPlane: 1,
      Secret: 1,
    });
    expect(Object.fromEntries(preview.providers.map((i) => [i.kind, i.count]))).toEqual({
      CoreProvider: 1,
      Namespace: 1,
      Secret: 2,
    });
    // Never cert-manager; Secrets only in the workload and provider namespaces.
    expect(calls.some((c) => c.includes('cert-manager'))).toBe(false);
    expect(calls).toContain('list kubeadmcontrolplanes.controlplane.cluster.x-k8s.io (page 2)');
    expect(calls).toContain('secrets capi-system capi-navigator.io/managed-by=capi-navigator');
    expect(calls).toContain('read secret capi-system/capi-variables');
  });

  it('names kinds it cannot read and refuses an incomplete backup (FP39-F-10)', async () => {
    const { svc } = await setup({ forbidIpam: true });
    const preview = await svc.preview('prod');
    expect(preview.unreadable).toEqual([
      {
        kind: 'IPAddress',
        resource: 'ipaddresss.ipam.cluster.x-k8s.io',
        message: 'ipaddresses is forbidden',
      },
    ]);
    await expect(svc.create('prod', 'admin')).rejects.toMatchObject({
      status: 409,
      response: { message: 'The connection cannot read IPAddress' },
    });
  });

  it('writes an encrypted archive with the provider and the CAPI part (FP39-F-01, F-05)', async () => {
    const { svc, key } = await setup();
    const backup = await svc.create('prod', 'admin', new Date('2026-11-28T03:00:00Z'));
    expect(backup.fileName).toBe('capi-navigator-mgmt-prod-20261128T030000Z.tar.gz.gpg');
    expect(backup.summary).toMatch(/^Management cluster prod: 7 objects, encrypted to [0-9A-F]+$/);
    expect(Buffer.from(backup.data).includes(Buffer.from('wl1-ca'))).toBe(false);
    const message = await openpgp.readMessage({ binaryMessage: backup.data });
    const decryptionKeys = await openpgp.readPrivateKey({ armoredKey: key.privateKey });
    const { data } = await openpgp.decrypt({ message, decryptionKeys, format: 'binary' });
    const file = (name: string) =>
      readFromChartArchive(Buffer.from(data as Uint8Array), (p) => p === name);
    const capi = file('capi/team-a.yaml')!;
    expect(capi).toContain('name: wl1-ca');
    expect(capi).toContain('paused: true');
    expect(capi).not.toContain('name: other');
    expect(capi).not.toContain('resourceVersion');
    expect(file('providers/20-secrets.yaml')).toContain('name: capi-variables');
    expect(JSON.parse(file('manifest.json')!)).toMatchObject({
      connection: 'prod',
      createdBy: 'admin',
    });
  });

  it('refuses without a recipient key before reading the cluster', async () => {
    const { svc, calls } = await setup({ noKey: true });
    await expect(svc.create('prod', 'admin')).rejects.toThrow('No backup key is set');
    expect(calls).toEqual([]);
  });
});
