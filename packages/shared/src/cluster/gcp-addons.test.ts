import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manifestAddonsFor, MANIFEST_ADDONS } from './addons.js';
import { buildManifestAddonResourceSet, parseManifest } from './manifest-addons.js';

/** The manifests shipped with the backend (apps/backend/assets, versions.yaml addonManifests). */
const asset = (dir: string, file: string) =>
  readFileSync(new URL(`../../../../apps/backend/assets/${dir}/${file}`, import.meta.url), 'utf8');
const addon = (id: string) => MANIFEST_ADDONS.find((a) => a.id === id)!;
const adapted = (id: string) => {
  const a = addon(id);
  return parseManifest(a.forCluster(asset(a.dir, a.file)));
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const find = (objects: any[], kind: string, name: string) =>
  objects.find((o) => o.kind === kind && o.metadata.name === name);

describe('Google Cloud add-on manifests (FP25-F-08, ADR-0023)', () => {
  it('ships the manifests with the checksums of versions.yaml', () => {
    for (const a of MANIFEST_ADDONS) {
      const sum = createHash('sha256').update(asset(a.dir, a.file)).digest('hex');
      expect(sum, a.file).toBe(a.sha256);
    }
  });

  it('runs the CCM with a pinned image, its arguments and the cloud config as ConfigMap', () => {
    const objects = adapted('gcp-ccm');
    const ds = find(objects, 'DaemonSet', 'cloud-controller-manager');
    const c = ds.spec.template.spec.containers[0];
    expect(c.image).toBe(
      `registry.k8s.io/cloud-provider-gcp/cloud-controller-manager:${addon('gcp-ccm').version}`,
    );
    expect(c.args).toEqual(
      expect.arrayContaining([
        '--cloud-provider=gce',
        '--cloud-config=/etc/kubernetes/gce/cloud.config',
        '--configure-cloud-routes=false',
        '--allocate-node-cidrs=false',
        '--controllers=*,-node-ipam-controller',
      ]),
    );
    // The kubernetes Service instead of 127.0.0.1, which kubeadm's certificate lacks (seen live).
    expect(JSON.stringify(c.env ?? [])).not.toContain('KUBERNETES_SERVICE_HOST');
    expect(ds.spec.template.spec.volumes).toEqual([
      { name: 'cloudconfig', configMap: { name: 'gce-cloud-config' } },
    ]);
    expect(find(objects, 'ConfigMap', 'gce-cloud-config').data['cloud.config']).toContain(
      'multizone = true',
    );
    expect(find(objects, 'Role', 'capi-navigator:cloud-controller-manager').rules).toEqual([
      { apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'create', 'update'] },
    ]);
    // Still on control plane nodes, tolerating the "uninitialized" taint it removes.
    expect(JSON.stringify(ds.spec.template.spec.affinity)).toContain('control-plane');
  });

  it('keeps the CSI controller on control plane nodes and adds namespace and StorageClass', () => {
    const objects = adapted('gcp-csi');
    expect(objects[0]).toEqual({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'gce-pd-csi-driver' },
    });
    const pod = find(objects, 'Deployment', 'csi-gce-pd-controller').spec.template.spec;
    expect(JSON.stringify(pod.affinity)).toContain('node-role.kubernetes.io/control-plane');
    expect(pod.tolerations).toContainEqual({
      key: 'node-role.kubernetes.io/control-plane',
      operator: 'Exists',
      effect: 'NoSchedule',
    });
    // The node plugin runs on control plane nodes too (all-in-one clusters).
    expect(find(objects, 'DaemonSet', 'csi-gce-pd-node').spec.template.spec).not.toHaveProperty(
      'affinity',
    );
    // noauth overlay: no key mounted.
    expect(JSON.stringify(pod)).not.toContain('cloud-sa');
    expect(find(objects, 'StorageClass', 'pd-balanced')).toMatchObject({
      provisioner: 'pd.csi.storage.gke.io',
      volumeBindingMode: 'WaitForFirstConsumer',
      metadata: { annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
    });
  });

  it('fails instead of rolling out a manifest that lacks the expected objects', () => {
    expect(() => addon('gcp-ccm').forCluster('kind: ConfigMap\nmetadata: {name: x}\n')).toThrow(
      /DaemonSet cloud-controller-manager not found/,
    );
  });

  it('delivers each add-on by a ClusterResourceSet per namespace, selected by label', () => {
    const a = addon('gcp-csi');
    const [cm, crs] = buildManifestAddonResourceSet(a, 'team-a', asset(a.dir, a.file));
    expect(cm!.metadata.name).toMatch(/^capi-navigator-gcp-csi-v1-27-5-[0-9a-f]{6}$/);
    expect(crs).toMatchObject({
      kind: 'ClusterResourceSet',
      metadata: { name: cm!.metadata.name, namespace: 'team-a' },
      spec: {
        clusterSelector: { matchLabels: { 'capi-navigator.io/csi': 'gcp' } },
        resources: [{ kind: 'ConfigMap', name: cm!.metadata.name }],
        strategy: 'ApplyOnce',
      },
    });
    expect(
      manifestAddonsFor({ 'capi-navigator.io/ccm': 'gcp', 'capi-navigator.io/csi': 'aws' }).map(
        (x) => x.id,
      ),
    ).toEqual(['gcp-ccm']);
  });
});
