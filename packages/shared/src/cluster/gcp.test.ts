import { describe, expect, it } from 'vitest';
import { renderManifests } from '../operator-manifests.js';
import { setBastion, SpecChangeError } from './changes.js';
import { ClusterSpecSchema, type ClusterSpecInput } from './spec.js';
import { transform, type TransformContext } from './transform.js';

const ctx: TransformContext = {
  credential: { secret: { name: 'capi-navigator-credential-gcp-dev', namespace: 'capg-system' } },
};

const VERSIONS = { rke2: 'v1.35.9+rke2r1', k0s: 'v1.35.8+k0s.1', kubeadm: 'v1.35.9' } as const;
const IMAGE = 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261015';

const gcp = (
  flavor: keyof typeof VERSIONS = 'rke2',
  over: Partial<ClusterSpecInput> = {},
): ClusterSpecInput => ({
  name: `demo-gcp-${flavor}`,
  namespace: 'team-a',
  kubernetes: { flavor, version: VERSIONS[flavor] },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 3, machineSize: 'e2-standard-2' },
    workerPools: [
      {
        name: 'default',
        replicas: 2,
        machineSize: 'n2-standard-4',
        rootVolumeSizeGB: 80,
        rootVolumeType: 'pd-balanced',
      },
    ],
  },
  infrastructure: {
    provider: 'gcp',
    credentialRef: 'gcp-dev',
    project: 'demo-proj',
    region: 'europe-west6',
    image: IMAGE,
  },
  ...over,
});

const inZone = (base: ClusterSpecInput, zone: string): ClusterSpecInput => ({
  ...base,
  infrastructure: { ...base.infrastructure, zone } as ClusterSpecInput['infrastructure'],
});

const allInOne = (base: ClusterSpecInput): ClusterSpecInput => ({
  ...base,
  name: `${base.name}-aio`,
  topology: {
    mode: 'all-in-one',
    controlPlane: { ...base.topology.controlPlane, replicas: 1 },
    workerPools: [],
  },
});

const objects = (input: ClusterSpecInput) => transform(ClusterSpecSchema.parse(input), ctx);
const render = (input: ClusterSpecInput) => renderManifests(objects(input));
// Deep manifest paths in assertions; a missing field fails the expectation anyway.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const find = (input: ClusterSpecInput, kind: string) =>
  objects(input).find((o) => o.kind === kind) as Record<string, any>;

describe('Google Cloud snapshots (FP25-F-06)', () => {
  for (const flavor of ['rke2', 'k0s', 'kubeadm'] as const) {
    it(`${flavor} standard (3 control plane nodes, one pool) with CCM and CSI`, () => {
      expect(render(gcp(flavor))).toMatchSnapshot();
    });
    it(`${flavor} all-in-one in one zone`, () => {
      expect(render(allInOne(inZone(gcp(flavor), 'europe-west6-b')))).toMatchSnapshot();
    });
  }
});

describe('Google Cloud specifics (FP25-F-06, FP25-F-07, ADR-0022)', () => {
  it('creates a dedicated network with one subnet and references the credential Secret', () => {
    const cluster = find(gcp(), 'GCPCluster');
    expect(cluster.apiVersion).toBe('infrastructure.cluster.x-k8s.io/v1beta1');
    expect(cluster.spec).toMatchObject({
      project: 'demo-proj',
      region: 'europe-west6',
      credentialsRef: { name: 'capi-navigator-credential-gcp-dev', namespace: 'capg-system' },
      network: {
        name: 'demo-gcp-rke2',
        autoCreateSubnetworks: false,
        subnets: [
          { name: 'demo-gcp-rke2-nodes', cidrBlock: '10.6.0.0/24', region: 'europe-west6' },
        ],
      },
    });
    // No public IPs: the dedicated network gets Cloud NAT from CAPG.
    const template = find(gcp(), 'GCPMachineTemplate');
    expect(template.spec.template.spec).not.toHaveProperty('publicIP');
  });

  it('serves the API on 6443 through the load balancer for every distribution', () => {
    for (const flavor of ['rke2', 'k0s', 'kubeadm'] as const) {
      expect(find(gcp(flavor), 'Cluster').spec.clusterNetwork.apiServerPort).toBe(6443);
    }
    // Other providers keep their defaults: the existing snapshots have no apiServerPort.
  });

  it('sets provider ID and node name in the form of the GCP CCM (FP25-F-07)', () => {
    const cp = find(gcp('kubeadm'), 'KubeadmControlPlane');
    const reg = cp.spec.kubeadmConfigSpec.initConfiguration.nodeRegistration;
    expect(reg.name).toBe('{{ v1.local_hostname }}');
    expect(reg.kubeletExtraArgs).toContainEqual({
      name: 'provider-id',
      value: 'gce://demo-proj/{{ v1.availability_zone }}/{{ v1.local_hostname }}',
    });
  });

  it('lets the health check read /readyz on RKE2 and runs k0s without Konnectivity', () => {
    const rke2 = find(gcp('rke2'), 'RKE2ControlPlane');
    expect(rke2.spec.serverConfig.kubeAPIServer).toEqual({ extraArgs: ['anonymous-auth=true'] });
    const k0s = find(gcp('k0s'), 'K0sControlPlane');
    expect(k0s.spec.k0sConfigSpec.args).toContain('--disable-components=konnectivity-server');
    expect(k0s.spec.k0sConfigSpec.k0s.spec.api.extraArgs['anonymous-auth']).toBe('true');
  });

  it('puts workers into the chosen zone and leaves the zones to CAPG otherwise', () => {
    const base = gcp();
    const zoned = inZone(base, 'europe-west6-b');
    expect(find(zoned, 'MachineDeployment').spec.template.spec.failureDomain).toBe(
      'europe-west6-b',
    );
    expect(find(zoned, 'GCPCluster').spec.failureDomains).toEqual(['europe-west6-b']);
    expect(find(base, 'MachineDeployment').spec.template.spec).not.toHaveProperty('failureDomain');
    expect(find(base, 'GCPCluster').spec).not.toHaveProperty('failureDomains');
  });

  it('validates project, zone, image and disk type', () => {
    const base = gcp();
    const issues = (infra: Record<string, unknown>, cp: Record<string, unknown> = {}) => {
      const r = ClusterSpecSchema.safeParse({
        ...base,
        infrastructure: { ...base.infrastructure, ...infra },
        topology: {
          ...base.topology,
          controlPlane: { ...base.topology.controlPlane, ...cp },
        },
      });
      return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    };
    expect(issues({})).toEqual([]);
    expect(issues({ project: 'Demo' })).toEqual(['infrastructure.project']);
    expect(issues({ zone: 'us-central1-a' })).toEqual(['infrastructure.zone']);
    expect(issues({ image: 'ami-0123456789abcdef0' })).toEqual(['infrastructure.image']);
    expect(issues({}, { rootVolumeType: 'gp3' })).toEqual(['topology.controlPlane.rootVolumeType']);
    expect(issues({}, { image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2' })).toEqual([
      'topology.controlPlane.image',
    ]);
  });

  it('offers no bastion host (CAPG has none, FP25-F-09)', () => {
    const spec = ClusterSpecSchema.parse(gcp());
    expect(() => setBastion(spec, { enabled: true })).toThrow(SpecChangeError);
  });
});
