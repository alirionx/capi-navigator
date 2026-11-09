import { describe, expect, it } from 'vitest';
import { distributionCatalog } from '../catalog/kubernetes-versions.js';
import { DEFAULT_PROXMOX_MACHINE_SIZES } from '../credentials.js';
import { buildCrd, ClusterBlueprintCrd } from '../crds/index.js';
import { renderManifests } from '../operator-manifests.js';
import {
  blueprintParametersJsonSchema,
  blueprintToSpecSchema,
  ClusterBlueprintSpecSchema,
  versionsOutsideCatalog,
  type ClusterBlueprintSpecInput,
} from './blueprint.js';
import type { ClusterSpecInput, OpenStackInfra } from './spec.js';
import { INFRA_PLUGINS, transform, type TransformContext } from './transform.js';

const workers = (machineSize: string) => ({
  mode: 'standard' as const,
  controlPlane: { replicas: 1 as const, machineSize },
  workerPools: [{ name: 'default', replicas: 2, machineSize }],
});

const SPECS: Record<string, { cluster: ClusterSpecInput; sizes: string[]; ctx: TransformContext }> =
  {
    openstack: {
      cluster: {
        name: 'example',
        namespace: 'osb',
        labels: { addons: 'base' },
        kubernetes: { version: 'v1.35.9+rke2r1' },
        topology: workers('a2-ram4-disk50-perf1'),
        infrastructure: {
          provider: 'openstack',
          credentialRef: 'infomaniak',
          image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
          externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
        },
      },
      sizes: ['a2-ram4-disk50-perf1', 'a4-ram8-disk50-perf1'],
      ctx: { credential: { cloudName: 'infomaniak' } },
    },
    aws: {
      cluster: {
        name: 'example',
        namespace: 'osb',
        kubernetes: { flavor: 'k0s', version: 'v1.35.9+k0s.0' },
        topology: workers('t3.large'),
        infrastructure: {
          provider: 'aws',
          credentialRef: 'aws-dev',
          region: 'eu-central-1',
          image: 'ami-0e27250725fa51794',
        },
      },
      sizes: ['t3.large', 't3.xlarge'],
      ctx: { credential: {} },
    },
    gcp: {
      cluster: {
        name: 'example',
        namespace: 'osb',
        kubernetes: { flavor: 'kubeadm', version: 'v1.35.9' },
        topology: workers('e2-standard-2'),
        infrastructure: {
          provider: 'gcp',
          credentialRef: 'gcp-dev',
          project: 'demo-proj',
          region: 'europe-west6',
          image: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261015',
          controlPlaneServiceAccount: 'capi@demo-proj.iam.gserviceaccount.com',
        },
      },
      sizes: ['e2-standard-2', 'n2-standard-4'],
      ctx: {
        credential: {
          secret: { name: 'capi-navigator-credential-gcp-dev', namespace: 'capg-system' },
        },
      },
    },
    proxmox: {
      cluster: {
        name: 'example',
        namespace: 'osb',
        kubernetes: { version: 'v1.35.9+rke2r1' },
        topology: workers('medium'),
        infrastructure: {
          provider: 'proxmox',
          credentialRef: 'homelab',
          sourceNode: 'homeserver',
          image: '7112',
          storage: 'local-zfs',
          bootDisk: 'virtio0',
          network: {
            nodeCidr: '10.20.0.0/24',
            gateway: '10.20.0.1',
            addresses: ['10.20.0.71-10.20.0.88'],
          },
          apiEndpoint: '10.20.0.89',
        },
      },
      sizes: ['medium', 'large'],
      ctx: { credential: { machineSizes: DEFAULT_PROXMOX_MACHINE_SIZES } },
    },
  };

const POOL = ['10.20.0.100-10.20.0.119'];

const blueprint = (provider: string, over: Partial<ClusterBlueprintSpecInput> = {}) => {
  const { cluster, sizes } = SPECS[provider]!;
  return ClusterBlueprintSpecSchema.parse({
    displayName: `Small ${provider}`,
    connection: 'home',
    cluster,
    ...(provider === 'proxmox' ? { addressPool: POOL } : {}),
    parameters: {
      workerCounts: [{ pool: 'default', min: 1, max: 5 }],
      machineSizes: [{ pool: 'default', choices: sizes }],
    },
    ...over,
  });
};

describe('cluster blueprints (FP-34)', () => {
  describe('blueprint + parameters → cluster spec → YAML snapshots (FP34-F-05)', () => {
    for (const provider of Object.keys(SPECS)) {
      it(provider, () => {
        const bp = blueprint(provider);
        const spec = blueprintToSpecSchema('small', bp).parse({
          name: 'ordered',
          parameters: {
            workerPools: { default: { replicas: 3, machineSize: SPECS[provider]!.sizes[1] } },
          },
          labels: { 'osb.example.com/instance-id': 'b5a3f0c2-1d7e-4c51-9a8e-2f6b3c4d5e6f' },
        });
        expect(spec.name).toBe('ordered');
        expect(spec.topology.workerPools[0]).toMatchObject({
          replicas: 3,
          machineSize: SPECS[provider]!.sizes[1],
        });
        expect(renderManifests(transform(spec, SPECS[provider]!.ctx))).toMatchSnapshot();
      });
    }
  });

  it('keeps the base spec without parameters', () => {
    const bp = blueprint('openstack');
    const spec = blueprintToSpecSchema('small', bp).parse({ name: 'plain' });
    expect(spec.blueprint).toBe('small');
    expect({ ...spec, name: 'example', blueprint: undefined }).toEqual({
      ...bp.cluster,
      blueprint: undefined,
    });
  });

  it('merges additional labels without changing the blueprint labels (FP34-F-05)', () => {
    const toSpec = blueprintToSpecSchema('small', blueprint('openstack'));
    expect(toSpec.parse({ name: 'a', labels: { team: 'x', addons: 'base' } }).labels).toEqual({
      team: 'x',
      addons: 'base',
    });
    const r = toSpec.safeParse({ name: 'a', labels: { addons: 'none' } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['labels', 'addons']);
    expect(toSpec.safeParse({ name: 'a', labels: { 'capi-navigator.io/x': '1' } }).success).toBe(
      false,
    );
  });

  it('refuses parameters outside the limits and unknown parameters (FP34-F-02)', () => {
    const toSpec = blueprintToSpecSchema('small', blueprint('aws'));
    const bad = [
      { workerPools: { default: { replicas: 6 } } },
      { workerPools: { default: { replicas: 0 } } },
      { workerPools: { default: { machineSize: 'm5.24xlarge' } } },
      { workerPools: { other: { replicas: 1 } } },
      { kubernetesVersion: 'v1.36.5+k0s.0' },
      { controlPlane: { replicas: 3 } },
    ];
    for (const parameters of bad) {
      expect(toSpec.safeParse({ name: 'a', parameters }).success, JSON.stringify(parameters)).toBe(
        false,
      );
    }
    expect(toSpec.safeParse({ name: 'Not_A_Name' }).success).toBe(false);
  });

  it('applies a Kubernetes version from the choices', () => {
    const bp = blueprint('openstack', {
      parameters: { kubernetesVersions: ['v1.35.9+rke2r1', 'v1.36.5+rke2r1'] },
    });
    expect(
      blueprintToSpecSchema('small', bp).parse({
        name: 'a',
        parameters: { kubernetesVersion: 'v1.36.5+rke2r1' },
      }).kubernetes.version,
    ).toBe('v1.36.5+rke2r1');
  });

  it('checks that the parameters fit the base spec (FP34-F-02)', () => {
    const issues = (parameters: ClusterBlueprintSpecInput['parameters']) =>
      ClusterBlueprintSpecSchema.safeParse({
        displayName: 'x',
        connection: 'home',
        cluster: SPECS.openstack!.cluster,
        parameters,
      }).error?.issues.map((i) => i.message) ?? [];
    expect(issues({ workerCounts: [{ pool: 'gpu', min: 1, max: 2 }] })).toEqual([
      'The cluster has no worker pool "gpu"',
    ]);
    expect(issues({ workerCounts: [{ pool: 'default', min: 3, max: 5 }] })).toEqual([
      "The pool's 2 workers must lie between minimum and maximum",
    ]);
    expect(issues({ workerCounts: [{ pool: 'default', min: 3, max: 1 }] })).toContain(
      'At least the minimum',
    );
    expect(issues({ machineSizes: [{ pool: 'default', choices: ['other'] }] })).toEqual([
      "The pool's size a2-ram4-disk50-perf1 must be one of the choices",
    ]);
    expect(issues({ kubernetesVersions: ['v1.36.5+rke2r1'] })).toEqual([
      "The cluster's version v1.35.9+rke2r1 must be one of the choices",
    ]);
    expect(
      issues({
        workerCounts: [
          { pool: 'default', min: 1, max: 3 },
          { pool: 'default', min: 1, max: 3 },
        ],
      }),
    ).toEqual(['Worker pool "default" is listed twice']);
  });

  it('offers no versions for air-gapped clusters (FP34-F-02)', () => {
    const r = ClusterBlueprintSpecSchema.safeParse({
      displayName: 'x',
      connection: 'home',
      cluster: {
        ...SPECS.proxmox!.cluster,
        airGapped: {
          registry: {
            host: 'registry.internal:5000',
            mirrors: [{ upstream: 'docker.io' }],
            artifactsPath: 'library',
          },
        },
      },
      parameters: { kubernetesVersions: ['v1.35.9+rke2r1'] },
    });
    expect(r.error?.issues.map((i) => i.message)).toContain(
      'Air-gapped clusters cannot offer versions: their artifacts are pinned per version',
    );
  });

  it('finds versions outside the catalog', () => {
    // A version of the current catalog, so the test survives patch updates of versions.yaml.
    const known = distributionCatalog('rke2')!.versions[0]!.version;
    const { cluster } = SPECS.openstack!;
    const bp = blueprint('openstack', {
      cluster: { ...cluster, kubernetes: { ...cluster.kubernetes, version: known } },
      parameters: { kubernetesVersions: [known, 'v1.30.0+rke2r1'] },
    });
    expect(versionsOutsideCatalog(bp)).toEqual(['v1.30.0+rke2r1']);
  });

  it('describes the parameters as JSON Schema draft-04 (FP34-F-03)', () => {
    const bp = blueprint('openstack', {
      parameters: {
        workerCounts: [{ pool: 'default', min: 1, max: 5 }],
        machineSizes: [{ pool: 'default', choices: SPECS.openstack!.sizes }],
        kubernetesVersions: ['v1.35.9+rke2r1', 'v1.36.5+rke2r1'],
      },
    });
    expect(blueprintParametersJsonSchema(bp)).toMatchSnapshot();
    expect(blueprintParametersJsonSchema(blueprint('aws', { parameters: {} }))).toEqual({
      $schema: 'http://json-schema.org/draft-04/schema#',
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  describe('address pool for providers where clusters need own addresses (FP34-F-14)', () => {
    it('gives every cluster free addresses of the pool', () => {
      const bp = blueprint('proxmox');
      const used = ['10.20.0.100', '10.20.0.102-10.20.0.103'];
      const spec = blueprintToSpecSchema('small', bp, used).parse({
        name: 'a',
        parameters: { workerPools: { default: { replicas: 2 } } },
      });
      // API address, 1 control plane + 2 workers + 1 for rollouts.
      expect(spec.infrastructure).toMatchObject({
        apiEndpoint: '10.20.0.101',
        network: { addresses: ['10.20.0.104-10.20.0.107'] },
      });
    });

    it('takes LoadBalancer addresses as many as the base spec has', () => {
      const cluster = structuredClone(SPECS.proxmox!.cluster) as {
        infrastructure: { network: Record<string, unknown> };
      };
      cluster.infrastructure.network.loadBalancerAddresses = ['10.20.0.90-10.20.0.91'];
      const bp = blueprint('proxmox', { cluster: cluster as ClusterSpecInput });
      const spec = blueprintToSpecSchema('small', bp).parse({ name: 'a' });
      expect(spec.infrastructure).toMatchObject({
        apiEndpoint: '10.20.0.100',
        network: {
          addresses: ['10.20.0.101-10.20.0.104'],
          loadBalancerAddresses: ['10.20.0.105-10.20.0.106'],
        },
      });
    });

    it('refuses an order when the pool is used up', () => {
      const bp = blueprint('proxmox', { addressPool: ['10.20.0.100-10.20.0.104'] });
      const r = blueprintToSpecSchema('small', bp, ['10.20.0.100']).safeParse({ name: 'a' });
      expect(r.error?.issues[0]?.message).toBe(
        'The address pool has 4 free address(es); the cluster needs 5: the API address, 4 node addresses (including 1 for rollouts).',
      );
    });

    it('requires a pool on Proxmox VE, inside the node network, and none elsewhere', () => {
      const issues = (provider: string, addressPool?: string[]) =>
        ClusterBlueprintSpecSchema.safeParse({
          displayName: 'x',
          connection: 'home',
          cluster: SPECS[provider]!.cluster,
          ...(addressPool ? { addressPool } : {}),
        }).error?.issues.map((i) => i.message) ?? [];
      expect(issues('proxmox')).toEqual([
        'Every cluster needs addresses of its own: give an address pool for the blueprint',
      ]);
      expect(issues('proxmox', ['10.30.0.1-10.30.0.9'])).toEqual([
        '10.30.0.1-10.30.0.9 not in the node network 10.20.0.0/24',
      ]);
      expect(issues('aws', POOL)).toEqual(['Clusters on aws need no address pool']);
      expect(issues('gcp', POOL)).toEqual(['Clusters on gcp need no address pool']);
      expect(issues('proxmox', POOL)).toEqual([]);
    });
  });

  describe('node network pool on OpenStack (FP34-F-15)', () => {
    const NETS = ['10.7.0.0/16'];
    const issues = (addressPool?: string[], cluster = SPECS.openstack!.cluster) =>
      ClusterBlueprintSpecSchema.safeParse({
        displayName: 'x',
        connection: 'home',
        cluster,
        ...(addressPool ? { addressPool } : {}),
      }).error?.issues.map((i) => i.message) ?? [];

    it('gives every cluster the first network of the base size that nobody uses', () => {
      const bp = blueprint('openstack', { addressPool: NETS });
      // A subnet of the project (made by hand) and the network of another cluster.
      const used = ['10.7.0.0/24', '10.7.1.128/25'];
      const spec = blueprintToSpecSchema('small', bp, used).parse({ name: 'a' });
      expect(spec.infrastructure).toMatchObject({ network: { nodeCidr: '10.7.2.0/24' } });
    });

    it('hands out the size of the base spec and walks the pool in its order', () => {
      const cluster = structuredClone(SPECS.openstack!.cluster) as {
        infrastructure: Record<string, unknown>;
      };
      cluster.infrastructure.network = { nodeCidr: '10.6.0.0/26' };
      const bp = blueprint('openstack', {
        cluster: cluster as ClusterSpecInput,
        addressPool: ['10.9.0.0/25', '10.8.0.0/24'],
      });
      const spec = blueprintToSpecSchema('small', bp, ['10.9.0.0/25']).parse({ name: 'a' });
      expect(spec.infrastructure).toMatchObject({ network: { nodeCidr: '10.8.0.0/26' } });
    });

    it('refuses an order when the pool is used up', () => {
      const bp = blueprint('openstack', { addressPool: ['10.7.0.0/23'] });
      const r = blueprintToSpecSchema('small', bp, ['10.7.0.0/24', '10.7.1.0/24']).safeParse({
        name: 'a',
      });
      expect(r.error?.issues[0]).toMatchObject({
        path: ['addressPool'],
        message:
          'The node network pool 10.7.0.0/23 has no free /24 network left: every one overlaps a subnet of the project or the node network of another OpenStack cluster.',
      });
    });

    it('suggests the /16 of the node network for a new blueprint, nothing on Proxmox VE', () => {
      const suggest = (nodeCidr: string) =>
        INFRA_PLUGINS.openstack.addressPool!.suggest!({
          ...(blueprint('openstack').cluster.infrastructure as OpenStackInfra),
          network: { nodeCidr, dnsNameservers: ['1.1.1.1'] },
        });
      expect(suggest('10.6.3.0/24')).toEqual(['10.6.0.0/16']);
      expect(suggest('10.4.0.0/14')).toEqual(['10.4.0.0/14']);
      expect(INFRA_PLUGINS.proxmox.addressPool!.suggest).toBeUndefined();
    });

    it('keeps the fixed network of a blueprint without pool', () => {
      const bp = blueprint('openstack');
      const spec = blueprintToSpecSchema('small', bp, ['10.6.0.0/24']).parse({ name: 'a' });
      expect(spec.infrastructure).toMatchObject({ network: { nodeCidr: '10.6.0.0/24' } });
      expect(issues()).toEqual([]);
    });

    it('takes only networks at least as large as the node network, apart from pods and services', () => {
      expect(issues(NETS)).toEqual([]);
      expect(issues(['10.7.0.5-10.7.0.9', '10.7.0.0/25', '10.42.0.0/20'])).toEqual([
        '10.7.0.5-10.7.0.9 is no network: give networks like 10.7.0.0/16',
        '10.7.0.0/25 is smaller than the node network of the base spec (/24)',
        '10.42.0.0/20 overlaps the pod network (10.42.0.0/16)',
      ]);
    });

    it('applies to hosted control planes too, unlike Proxmox VE', () => {
      const hosted = (provider: string) => {
        const cluster = structuredClone(SPECS[provider]!.cluster) as Record<string, unknown>;
        cluster.kubernetes = { flavor: 'k0s', version: 'v1.35.9+k0s.0' };
        cluster.topology = {
          mode: 'hosted',
          controlPlane: { replicas: 1, machineSize: 'unused' },
          workerPools: [{ name: 'default', replicas: 2, machineSize: 'medium' }],
          hosted: { host: 'host' },
        };
        return cluster as ClusterSpecInput;
      };
      expect(issues(NETS, hosted('openstack'))).toEqual([]);
      expect(
        ClusterBlueprintSpecSchema.safeParse({
          displayName: 'x',
          connection: 'home',
          cluster: hosted('proxmox'),
          addressPool: POOL,
        }).error?.issues.map((i) => i.message),
      ).toContain('Blueprints of hosted control planes are not supported on this provider');
    });
  });

  it('stores the cluster spec opaque in the CRD (STATE-02)', () => {
    const crd = buildCrd(ClusterBlueprintCrd) as {
      spec: {
        versions: {
          schema: {
            openAPIV3Schema: { properties: { spec: { properties: Record<string, unknown> } } };
          };
        }[];
      };
    };
    expect(crd.spec.versions[0]!.schema.openAPIV3Schema.properties.spec.properties.cluster).toEqual(
      {
        type: 'object',
        'x-kubernetes-preserve-unknown-fields': true,
      },
    );
  });
});
