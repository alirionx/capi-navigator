import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEFAULT_PROXMOX_MACHINE_SIZES } from '../credentials.js';
import { renderManifests } from '../operator-manifests.js';
import { ADDON_PRESETS } from './addons.js';
import { awsPlugin } from './aws.js';
import { hostedK0sImage } from './k0s.js';
import { proxmoxPlugin } from './proxmox.js';
import { ClusterSpecSchema, HOSTED_ON_LABEL, type ClusterSpecInput } from './spec.js';
import { transform, type TransformContext } from './transform.js';

// FP-24, ADR-0034: hosted control planes with k0smotron.
const ctx: TransformContext = {
  credential: { cloudName: 'infomaniak', machineSizes: DEFAULT_PROXMOX_MACHINE_SIZES },
};
const K0S = 'v1.35.9+k0s.0';

const tenant = (
  infrastructure: ClusterSpecInput['infrastructure'],
  replicas: 1 | 3 = 3,
  over: Partial<ClusterSpecInput> = {},
): ClusterSpecInput => ({
  name: 'tenant',
  namespace: 'team-a',
  kubernetes: { flavor: 'k0s', version: K0S },
  topology: {
    mode: 'hosted',
    controlPlane: { replicas, machineSize: 'unused' },
    workerPools: [{ name: 'default', replicas: 2, machineSize: 'small' }],
    hosted: { host: 'host' },
  },
  infrastructure,
  ...over,
});
const openstack: ClusterSpecInput['infrastructure'] = {
  provider: 'openstack',
  credentialRef: 'infomaniak',
  image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
  externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
};
const aws: ClusterSpecInput['infrastructure'] = {
  provider: 'aws',
  credentialRef: 'aws',
  region: 'eu-central-1',
  image: 'ami-0e27250725fa51794',
};
const proxmox: ClusterSpecInput['infrastructure'] = {
  provider: 'proxmox',
  credentialRef: 'homelab',
  sourceNode: 'homeserver',
  image: '7211',
  storage: 'local-zfs',
  network: {
    nodeCidr: '192.168.10.0/24',
    gateway: '192.168.10.1',
    addresses: ['192.168.10.81-192.168.10.85'],
    loadBalancerAddresses: ['192.168.10.86-192.168.10.89'],
  },
  // The tenant's API address, from the host's LoadBalancer range (FP24-F-06).
  apiEndpoint: '192.168.10.78',
};

// FP24-F-14, ADR-0037: air-gapped tenants, with the k0s artifact pinned for the workers.
const airGapped: ClusterSpecInput['airGapped'] = {
  registry: {
    host: 'registry.example.internal',
    mirrors: [
      { upstream: 'docker.io', path: 'proxy-docker-io' },
      { upstream: 'registry.k8s.io', path: 'proxy-k8s-io' },
      { upstream: 'quay.io', path: 'proxy-quay-io' },
    ],
    artifactsPath: 'library',
  },
  artifacts: [
    {
      version: K0S,
      repository: 'library/k0s-amd64',
      files: [{ name: 'k0s', digest: `sha256:${'d'.repeat(64)}` }],
    },
  ],
};

const objects = (input: ClusterSpecInput) => transform(ClusterSpecSchema.parse(input), ctx);
// Deep manifest paths in assertions; a missing field fails the expectation anyway.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Manifest = Record<string, any>;
const find = (input: ClusterSpecInput, kind: string) =>
  objects(input).find((o) => o.kind === kind) as Manifest;
const issues = (input: ClusterSpecInput) =>
  ClusterSpecSchema.safeParse(input).error?.issues.map((i) => i.message) ?? [];

describe('hosted control planes (FP-24)', () => {
  for (const [name, infra] of [
    ['OpenStack', openstack],
    ['AWS', aws],
    ['Proxmox VE', proxmox],
  ] as const) {
    for (const replicas of [1, 3] as const) {
      it(`${name}, ${replicas} replica(s): k0smotron control plane in the host, k0s workers (FP24-F-04, FP24-F-05)`, () => {
        expect(renderManifests(objects(tenant(infra, replicas)))).toMatchSnapshot();
      });
    }
  }

  for (const [name, infra, replicas] of [
    ['Proxmox VE', proxmox, 1],
    ['OpenStack', openstack, 3],
  ] as const) {
    it(`${name}, ${replicas} replica(s), air-gapped: k0s workers from the internal registry (FP24-F-14)`, () => {
      expect(renderManifests(objects(tenant(infra, replicas, { airGapped })))).toMatchSnapshot();
    });
  }

  it('pins the images of the control plane in the host (FP24-F-14, ADR-0037)', () => {
    const cp = find(tenant(openstack), 'K0smotronControlPlane').spec;
    expect(cp.image).toBe('quay.io/k0sproject/k0s');
    expect(cp.storage.etcd.image).toBe('quay.io/k0sproject/etcd:v3.7.1');
    expect(hostedK0sImage('v1.35.9+k0s.0')).toBe('quay.io/k0sproject/k0s:v1.35.9-k0s.0');
    expect(hostedK0sImage('v1.33.13+k0s.1')).toBe('quay.io/k0sproject/k0s:v1.33.13-k0s.1');
    expect(hostedK0sImage('v1.36.5')).toBe('quay.io/k0sproject/k0s:v1.36.5-k0s.0');
  });

  it('runs air-gapped tenant workers like other air-gapped k0s nodes (FP24-F-14)', () => {
    const workers = find(tenant(proxmox, 1, { airGapped }), 'K0sWorkerConfigTemplate').spec.template
      .spec;
    expect(workers.preInstalledK0s).toBe(true);
    expect(
      workers.files.some((f: Manifest) => String(f.path).endsWith('/quay.io/hosts.toml')),
    ).toBe(true);
    expect(issues(tenant(proxmox, 1, { airGapped }))).toEqual([]);
  });

  it('creates no control plane machines and points the Cluster to the K0smotronControlPlane', () => {
    const all = objects(tenant(openstack));
    expect(all.filter((o) => o.kind === 'OpenStackMachineTemplate')).toHaveLength(1);
    expect(all.some((o) => o.kind === 'K0sControlPlane')).toBe(false);
    const cluster = find(tenant(openstack), 'Cluster');
    expect(cluster.spec.controlPlaneRef).toEqual({
      apiGroup: 'controlplane.cluster.x-k8s.io',
      kind: 'K0smotronControlPlane',
      name: 'tenant-control-plane',
    });
    expect(cluster.metadata.labels[HOSTED_ON_LABEL]).toBe('host');
    expect(all.filter((o) => o.kind === 'MachineDeployment')).toHaveLength(1);
  });

  it('runs the control plane in the host with fixed requests and hard spread (FP24-F-04, ADR-0034)', () => {
    const cp = find(tenant(openstack), 'K0smotronControlPlane').spec;
    expect(cp.remoteHostCluster.kubeconfigRef).toEqual({
      name: 'host-kubeconfig',
      namespace: 'team-a',
      key: 'value',
    });
    expect(cp.service).toEqual({ type: 'LoadBalancer', apiPort: 6443, konnectivityPort: 8132 });
    expect(cp.storage.etcd).toMatchObject({
      autoDeletePVCs: true,
      persistence: { size: '1Gi' },
      resources: { requests: { cpu: '50m', memory: '128Mi' } },
    });
    expect(cp.resources).toEqual({ requests: { cpu: '100m', memory: '512Mi' } });
    expect(cp.resources).not.toHaveProperty('limits');
    expect(cp.topologySpreadConstraints[0]).toMatchObject({
      topologyKey: 'kubernetes.io/hostname',
      whenUnsatisfiable: 'DoNotSchedule',
      labelSelector: { matchLabels: { app: 'k0smotron', cluster: 'tenant', component: 'cluster' } },
    });
    const etcdPatch = cp.patches.find(
      (p: Manifest) => p.target.kind === 'StatefulSet' && p.target.component === 'etcd',
    );
    expect(
      JSON.parse(etcdPatch.patch.content).spec.template.spec.topologySpreadConstraints[0],
    ).toMatchObject({ labelSelector: { matchLabels: { component: 'etcd' } } });
    expect(cp.controlPlaneFlags).toEqual(['--enable-cloud-provider=true']);
    expect(cp).not.toHaveProperty('externalAddress');
  });

  it('builds infrastructure clusters without API load balancer (FP24-F-05)', () => {
    const os = find(tenant(openstack), 'OpenStackCluster').spec;
    expect(os.apiServer).toEqual({ enableFloatingIP: false });
    const awsCluster = find(tenant(aws), 'AWSCluster').spec;
    expect(awsCluster.controlPlaneLoadBalancer).toEqual({ loadBalancerType: 'disabled' });
    const pve = find(tenant(proxmox), 'ProxmoxCluster');
    expect(pve.spec.externalManagedControlPlane).toBe(true);
    expect(pve.spec).not.toHaveProperty('controlPlaneEndpoint');
    expect(pve.metadata.annotations[HOSTED_ON_LABEL]).toBe('host');
  });

  it('gives AWS workers the control plane instance profile, with a warning (FP24-F-05)', () => {
    const template = find(tenant(aws), 'AWSMachineTemplate').spec.template.spec;
    expect(template.iamInstanceProfile).toBe('control-plane.cluster-api-provider-aws.sigs.k8s.io');
    const spec = ClusterSpecSchema.parse(tenant(aws));
    expect(awsPlugin.warnings!(spec, spec.infrastructure as never).join()).toContain(
      'control plane instance profile',
    );
  });

  it('fixes the tenant address on Proxmox VE for kube-vip (FP24-F-06)', () => {
    const cp = find(tenant(proxmox), 'K0smotronControlPlane').spec;
    expect(cp.externalAddress).toBe('192.168.10.78');
    const servicePatch = cp.patches.find((p: Manifest) => p.target.kind === 'Service');
    expect(servicePatch.target.component).toBe('control-plane');
    expect(JSON.parse(servicePatch.patch.content)).toEqual({
      metadata: { annotations: { 'kube-vip.io/loadbalancerIPs': '192.168.10.78' } },
    });
  });

  it('takes the etcd volume size from the spec', () => {
    const spec = tenant(openstack);
    spec.topology.hosted = { host: 'host', etcdVolumeGiB: 5 };
    expect(find(spec, 'K0smotronControlPlane').spec.storage.etcd.persistence.size).toBe('5Gi');
  });

  it('refuses what hosted control planes cannot do (FP24-F-02, FP24-F-03)', () => {
    expect(issues(tenant(openstack, 3, { kubernetes: { version: 'v1.35.9+rke2r1' } }))).toContain(
      'Hosted control planes need k0s',
    );
    const five = tenant(openstack);
    (five.topology.controlPlane as { replicas: number }).replicas = 5;
    expect(issues(five)).toContain('Hosted control planes have 1 or 3 replicas');
    const gcp = tenant({
      provider: 'gcp',
      credentialRef: 'gcp',
      project: 'my-project-123',
      region: 'europe-west6',
      image: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261001',
    });
    expect(issues(gcp).join()).toContain(
      'Google Cloud cannot run workers of hosted control planes',
    );
    const noHost = tenant(openstack);
    delete noHost.topology.hosted;
    expect(issues(noHost)).toContain('Choose a host cluster');
    const self = tenant(openstack);
    self.topology.hosted = { host: 'tenant' };
    expect(issues(self)).toContain('A cluster cannot host itself');
    const standard = tenant(openstack);
    standard.topology.mode = 'standard';
    expect(issues(standard)).toContain('Only hosted control planes have a host');
    const noWorkers = tenant(openstack);
    noWorkers.topology.workerPools = [];
    expect(issues(noWorkers)).toContain('Add at least one worker pool');
  });

  it('checks Proxmox VE addresses with tenants in mind (FP24-F-08)', () => {
    const hostCluster = {
      metadata: {
        name: 'host',
        namespace: 'team-a',
        annotations: { 'capi-navigator.io/loadbalancer-addresses': '192.168.10.78-192.168.10.80' },
      },
      spec: {
        ipv4Config: { addresses: ['192.168.10.72-192.168.10.77'] },
        controlPlaneEndpoint: { host: '192.168.10.71' },
      },
    };
    const spec = ClusterSpecSchema.parse(tenant(proxmox));
    const conflicts = (others: Record<string, unknown>[]) =>
      proxmoxPlugin.addressConflicts!(spec, spec.infrastructure as never, others);
    // The tenant's address from its host's LoadBalancer range is intended.
    expect(conflicts([hostCluster])).toEqual([]);
    // Another tenant with the same address is a conflict.
    const other = {
      metadata: { name: 'other', namespace: 'team-a', annotations: { [HOSTED_ON_LABEL]: 'host' } },
      spec: {
        ipv4Config: { addresses: ['192.168.10.90'] },
        controlPlaneEndpoint: { host: '192.168.10.78' },
      },
    };
    expect(conflicts([hostCluster, other])).toHaveLength(1);
    // A host in another namespace is not this tenant's host.
    expect(
      conflicts([{ ...hostCluster, metadata: { ...hostCluster.metadata, namespace: 'b' } }]),
    ).toHaveLength(1);

    // From the host's side: its tenant's endpoint in its LoadBalancer range is intended too.
    const host = ClusterSpecSchema.parse({
      name: 'host',
      namespace: 'team-a',
      kubernetes: { flavor: 'k0s', version: K0S },
      topology: {
        mode: 'standard',
        controlPlane: { replicas: 1, machineSize: 'small' },
        workerPools: [{ name: 'default', replicas: 3, machineSize: 'small' }],
      },
      infrastructure: {
        ...proxmox,
        network: {
          nodeCidr: '192.168.10.0/24',
          gateway: '192.168.10.1',
          addresses: ['192.168.10.72-192.168.10.77'],
          loadBalancerAddresses: ['192.168.10.78-192.168.10.80'],
        },
        apiEndpoint: '192.168.10.71',
      },
    });
    const tenantCluster = {
      metadata: { name: 'tenant', namespace: 'team-a', annotations: { [HOSTED_ON_LABEL]: 'host' } },
      spec: {
        ipv4Config: { addresses: ['192.168.10.81-192.168.10.85'] },
        controlPlaneEndpoint: { host: '192.168.10.78' },
      },
    };
    expect(
      proxmoxPlugin.addressConflicts!(host, host.infrastructure as never, [tenantCluster]),
    ).toEqual([]);
    const stranger = { ...tenantCluster, metadata: { name: 'stranger', namespace: 'team-a' } };
    expect(
      proxmoxPlugin.addressConflicts!(host, host.infrastructure as never, [stranger]),
    ).toHaveLength(1);
  });
});

/**
 * Evaluates the `{{ if eq .ControlPlane.kind "…" }}` conditions of a CAAPH values template for one
 * control plane kind; other template expressions become a placeholder.
 */
function renderFor(template: string, kind: string): string {
  const tokens = template.split(/({{[^}]*}})/);
  let i = 0;
  const block = (): string => {
    let out = '';
    while (i < tokens.length) {
      const t = tokens[i]!;
      const tag = /^{{\s*(.*?)\s*}}$/.exec(t)?.[1];
      if (tag === undefined) {
        out += t;
        i++;
      } else if (tag === 'end' || tag === 'else' || tag.startsWith('else if')) {
        return out;
      } else if (tag.startsWith('if ')) {
        out += conditional(tag.slice(3));
      } else {
        out += 'placeholder';
        i++;
      }
    }
    return out;
  };
  const holds = (cond: string) => {
    const m = /^eq \.ControlPlane\.kind "([A-Za-z0-9]+)"$/.exec(cond);
    if (!m) throw new Error(`unsupported condition ${cond}`);
    return m[1] === kind;
  };
  const conditional = (cond: string): string => {
    i++;
    let taken = holds(cond);
    let out = '';
    let body = block();
    if (taken) out = body;
    for (;;) {
      const tag = /^{{\s*(.*?)\s*}}$/.exec(tokens[i]!)![1]!;
      i++;
      if (tag === 'end') return out;
      const elseIf = /^else if (.*)$/.exec(tag)?.[1];
      const now = !taken && (elseIf === undefined || holds(elseIf));
      body = block();
      if (now) {
        out = body;
        taken = true;
      }
    }
  };
  return block();
}

describe('CCM and CSI presets for hosted tenants (FP24-F-07)', () => {
  const selector = (id: string, kind: string, path: string[]) => {
    const preset = ADDON_PRESETS.find((p) => p.id === id)!;
    let v = parse(renderFor(preset.valuesTemplate, kind)) as Manifest;
    for (const p of path) v = v[p];
    return v;
  };
  const cp = 'node-role.kubernetes.io/control-plane';

  for (const [id, path] of [
    ['openstack-ccm', ['nodeSelector']],
    ['aws-ccm', ['nodeSelector']],
  ] as const) {
    it(`${id}: removes the chart's control plane selector with null`, () => {
      expect(selector(id, 'K0sControlPlane', [...path])).toEqual({ [cp]: 'true' });
      expect(selector(id, 'KubeadmControlPlane', [...path])).toEqual({ [cp]: '' });
      expect(selector(id, 'K0smotronControlPlane', [...path])).toEqual({ [cp]: null });
    });
  }
  for (const [id, path] of [
    ['proxmox-ccm', ['nodeSelector']],
    ['aws-csi', ['controller', 'nodeSelector']],
  ] as const) {
    it(`${id}: replaces the selector with an empty map`, () => {
      expect(selector(id, 'RKE2ControlPlane', [...path])).toEqual({ [cp]: 'true' });
      expect(selector(id, 'KubeadmControlPlane', [...path])).toEqual({ [cp]: '' });
      expect(selector(id, 'K0smotronControlPlane', [...path])).toEqual({});
    });
  }
});
