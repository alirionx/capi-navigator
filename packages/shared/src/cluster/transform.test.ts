import { describe, expect, it } from 'vitest';
import { renderManifests } from '../operator-manifests.js';
import { ClusterSpecSchema, type ClusterSpecInput } from './spec.js';
import { kubeadmInstallScript } from './kubeadm.js';
import { transform, type TransformContext } from './transform.js';

const ctx: TransformContext = { credential: { cloudName: 'infomaniak' } };

const openstack = (over: Partial<ClusterSpecInput> = {}): ClusterSpecInput => ({
  name: 'demo',
  namespace: 'team-a',
  labels: { env: 'test' },
  kubernetes: { version: 'v1.35.9+rke2r1' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 3, machineSize: 'a2-ram4-disk0', rootVolumeSizeGB: 50 },
    workerPools: [
      { name: 'default', replicas: 2, machineSize: 'a4-ram8-disk50-perf1' },
      {
        name: 'gpu',
        replicas: 1,
        machineSize: 'a8-ram32-disk80-perf1',
        nodeLabels: { 'example.com/gpu': 'true' },
      },
    ],
  },
  infrastructure: {
    provider: 'openstack',
    credentialRef: 'infomaniak',
    image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
    externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    sshKeyName: 'my-keys',
  },
  ...over,
});

const aws = (over: Partial<ClusterSpecInput> = {}): ClusterSpecInput => ({
  name: 'demo-aws',
  kubernetes: { version: 'v1.35.9+rke2r1' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 3, machineSize: 't3.large' },
    workerPools: [{ name: 'default', replicas: 2, machineSize: 't3.large' }],
  },
  infrastructure: {
    provider: 'aws',
    credentialRef: 'aws-dev',
    region: 'eu-central-1',
    image: 'ami-0e27250725fa51794',
    sshKeyName: 'ops',
  },
  ...over,
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

const render = (input: ClusterSpecInput) =>
  renderManifests(transform(ClusterSpecSchema.parse(input), ctx));

describe('transformation snapshots (FP5-F-01, NF-14)', () => {
  it('OpenStack standard (3 control plane + 2 pools) with CCM and CSI', () => {
    expect(render(openstack())).toMatchSnapshot();
  });
  it('OpenStack all-in-one', () => {
    expect(render(allInOne(openstack()))).toMatchSnapshot();
  });
  it('OpenStack without add-ons', () => {
    expect(
      render(openstack({ addons: { cloudControllerManager: false, csiDriver: false } })),
    ).toMatchSnapshot();
  });
  it('AWS standard with CCM and CSI', () => {
    expect(render(aws())).toMatchSnapshot();
  });
  it('AWS all-in-one', () => {
    expect(render(allInOne(aws()))).toMatchSnapshot();
  });
  it('AWS without add-ons', () => {
    expect(
      render(aws({ addons: { cloudControllerManager: false, csiDriver: false } })),
    ).toMatchSnapshot();
  });
  it('node customization and SSH keys (FP5-F-13)', () => {
    const spec = openstack({
      sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample admin@example'],
    });
    spec.topology.workerPools![0]!.customization = {
      files: [
        { path: '/etc/motd', content: 'managed by CAPI Navigator\n', permissions: '0644' },
        {
          path: '/etc/app/token',
          contentFromSecret: { name: 'app-token', key: 'token' },
          permissions: '0600',
        },
      ],
      preCommands: ['echo before'],
      postCommands: ['echo after'],
    };
    expect(render(spec)).toMatchSnapshot();
  });
});

describe('root disks (FP5-F-19)', () => {
  const templates = (input: ClusterSpecInput) =>
    renderManifests(
      transform(ClusterSpecSchema.parse(input), ctx).filter((o) =>
        o.kind.endsWith('MachineTemplate'),
      ),
    );

  it('OpenStack: Cinder root volume with type, also for flavors with local disk', () => {
    const spec = openstack();
    spec.topology.controlPlane.rootVolumeType = 'CEPH_1_perf1';
    spec.topology.workerPools![0]!.rootVolumeSizeGB = 120;
    spec.topology.workerPools![0]!.rootVolumeType = 'CEPH_1_perf1';
    expect(templates(spec)).toMatchSnapshot();
  });

  it('AWS: EBS root volume with size and type', () => {
    const spec = aws();
    spec.topology.controlPlane.rootVolumeSizeGB = 80;
    spec.topology.workerPools![0]!.rootVolumeSizeGB = 200;
    spec.topology.workerPools![0]!.rootVolumeType = 'gp2';
    expect(templates(spec)).toMatchSnapshot();
  });

  it('rejects a volume type without size on OpenStack and unknown EBS types', () => {
    const os = openstack();
    os.topology.workerPools![0]!.rootVolumeType = 'CEPH_1_perf1';
    expect(ClusterSpecSchema.safeParse(os).error?.issues[0]?.path.join('.')).toBe(
      'topology.workerPools.0.rootVolumeType',
    );
    const a = aws();
    a.topology.controlPlane.rootVolumeType = 'st1';
    expect(ClusterSpecSchema.safeParse(a).error?.issues[0]?.message).toMatch(/gp3, gp2/);
  });
});

describe('bastion host (FP5-F-20)', () => {
  const infraCluster = (input: ClusterSpecInput) =>
    renderManifests(
      transform(ClusterSpecSchema.parse(input), ctx).filter((o) =>
        /(OpenStack|AWS)Cluster$/.test(o.kind),
      ),
    );

  it('OpenStack: CAPO bastion with flavor, cluster image and key pair; disabled keeps the spec', () => {
    const on = openstack();
    (on.infrastructure as Record<string, unknown>).bastion = {
      enabled: true,
      machineSize: 'a1-ram2-disk20-perf1',
    };
    expect(infraCluster(on)).toMatchSnapshot();
    const off = openstack();
    (off.infrastructure as Record<string, unknown>).bastion = {
      enabled: false,
      machineSize: 'a1-ram2-disk20-perf1',
    };
    expect(infraCluster(off)).toMatch(/bastion:\n {4}enabled: false\n {4}spec:/);
  });

  it('AWS: CAPA bastion restricted to the allowed networks', () => {
    const on = aws();
    (on.infrastructure as Record<string, unknown>).bastion = {
      enabled: true,
      allowedCidrs: ['203.0.113.7/32'],
      machineSize: 't3.micro',
    };
    expect(infraCluster(on)).toMatchSnapshot();
  });

  it('validates key pair, flavor and networks per provider', () => {
    const msgs = (input: ClusterSpecInput) =>
      (ClusterSpecSchema.safeParse(input).error?.issues ?? []).map(
        (i) => `${i.path.join('.')}: ${i.message}`,
      );
    const os = openstack();
    delete (os.infrastructure as Record<string, unknown>).sshKeyName;
    (os.infrastructure as Record<string, unknown>).bastion = {
      enabled: true,
      allowedCidrs: ['203.0.113.7/32'],
    };
    expect(msgs(os)).toEqual([
      'infrastructure.sshKeyName: The bastion needs an SSH key pair of the cloud',
      'infrastructure.bastion.machineSize: Required for the bastion',
      'infrastructure.bastion.allowedCidrs: OpenStack (CAPO) cannot restrict SSH to the bastion; remove the networks',
    ]);
    const a = aws();
    (a.infrastructure as Record<string, unknown>).bastion = { enabled: true };
    expect(msgs(a)).toEqual([
      'infrastructure.bastion.allowedCidrs: Add at least one network allowed to connect via SSH',
    ]);
  });
});

describe('transformation rules', () => {
  it('is deterministic: same input, byte-identical YAML (hard rule 3)', () => {
    expect(render(openstack())).toBe(render(openstack()));
  });

  it('rotates only the templates of a changed group (hard rule 5)', () => {
    const names = (input: ClusterSpecInput) =>
      transform(ClusterSpecSchema.parse(input), ctx)
        .filter((o) => /Template$/.test(o.kind))
        .map((o) => o.metadata.name);
    const before = names(openstack());
    const changed = openstack();
    changed.topology.workerPools![0]!.machineSize = 'a8-ram16-disk50-perf1';
    const after = names(changed);
    const differ = after.filter((n) => !before.includes(n));
    expect(differ).toHaveLength(1);
    expect(differ[0]).toMatch(/^demo-default-[0-9a-f]{8}$/);
    // A replica change does not rotate anything.
    const scaled = openstack();
    scaled.topology.workerPools![0]!.replicas = 5;
    expect(names(scaled)).toEqual(before);
  });

  it('keeps generated names within 63 characters', () => {
    const long = openstack({ name: 'a'.repeat(40) });
    long.topology.workerPools![0]!.name = 'b'.repeat(12);
    for (const obj of transform(ClusterSpecSchema.parse(long), ctx)) {
      expect(obj.metadata.name.length).toBeLessThanOrEqual(63);
    }
  });

  it('labels every object and stores the spec on the Cluster (FP5-F-06, FP5-F-07)', () => {
    const objects = transform(ClusterSpecSchema.parse(openstack()), ctx);
    for (const o of objects)
      expect(o.metadata.labels?.['capi-navigator.io/managed-by']).toBe('capi-navigator');
    const cluster = objects.find((o) => o.kind === 'Cluster')!;
    const stored = JSON.parse(cluster.metadata.annotations!['capi-navigator.io/cluster-spec']!);
    expect(ClusterSpecSchema.parse(stored)).toEqual(ClusterSpecSchema.parse(openstack()));
  });

  it('never sets owner references or finalizers (POS-02)', () => {
    for (const o of transform(ClusterSpecSchema.parse(aws()), ctx)) {
      expect(o.metadata).not.toHaveProperty('ownerReferences');
      expect(o.metadata).not.toHaveProperty('finalizers');
    }
  });
});

describe('spec validation (acceptance FP-5)', () => {
  const issues = (input: ClusterSpecInput) => {
    const r = ClusterSpecSchema.safeParse(input);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it('accepts the fixtures', () => {
    expect(issues(openstack())).toEqual([]);
    expect(issues(aws())).toEqual([]);
    expect(issues(allInOne(aws()))).toEqual([]);
  });

  it('reports overlapping CIDRs before anything is created', () => {
    const r = issues(
      openstack({ kubernetes: { version: 'v1.35.9+rke2r1', podCidr: '10.6.0.0/16' } }),
    );
    expect(r.join('\n')).toMatch(/infrastructure.network.nodeCidr: Overlaps with the pod network/);
    expect(
      issues(
        openstack({ kubernetes: { version: 'v1.35.9+rke2r1', serviceCidr: '10.42.128.0/17' } }),
      ).join(),
    ).toMatch(/serviceCidr: Overlaps/);
  });

  it('enforces topology rules', () => {
    const noPools = openstack();
    noPools.topology.workerPools = [];
    expect(issues(noPools).join()).toMatch(/at least one worker pool/);
    const aio = allInOne(openstack());
    aio.topology.controlPlane.replicas = 3;
    expect(issues(aio).join()).toMatch(/exactly one node/);
    const dup = openstack();
    dup.topology.workerPools![1]!.name = 'default';
    expect(issues(dup).join()).toMatch(/used twice/);
    const noLb = openstack();
    (noLb.infrastructure as { apiServerLoadBalancer?: boolean }).apiServerLoadBalancer = false;
    expect(issues(noLb).join()).toMatch(/load balancer/);
  });

  it('rejects invalid values', () => {
    expect(issues(openstack({ name: 'Demo_1' })).join()).toMatch(/name/);
    expect(issues(openstack({ kubernetes: { version: 'v1.35.9+k0s.0' } })).join()).toMatch(
      /RKE2 version/,
    );
    expect(issues(aws({ sshPublicKeys: ['not a key'] })).join()).toMatch(/OpenSSH/);
    expect(
      issues(
        openstack({ kubernetes: { version: 'v1.35.9+rke2r1', podCidr: '10.42.0.1/16' } }),
      ).join(),
    ).toMatch(/CIDR/);
  });
});

describe('AWS specifics', () => {
  it('sets an empty sshKeyName without key pair, since CAPA defaults it to "default"', () => {
    const spec = aws();
    delete (spec.infrastructure as { sshKeyName?: string }).sshKeyName;
    const objects = transform(ClusterSpecSchema.parse(spec), ctx);
    const cluster = objects.find((o) => o.kind === 'AWSCluster')!;
    expect((cluster.spec as { sshKeyName?: string }).sshKeyName).toBe('');
    for (const t of objects.filter((o) => o.kind === 'AWSMachineTemplate')) {
      expect(
        (t.spec as { template: { spec: { sshKeyName?: string } } }).template.spec.sshKeyName,
      ).toBe('');
    }
  });
});

describe('k0s flavor (FP-9)', () => {
  const k0s = (base: ClusterSpecInput): ClusterSpecInput => ({
    ...base,
    name: `${base.name}-k0s`,
    kubernetes: { flavor: 'k0s', version: 'v1.35.8+k0s.1' },
  });

  it('OpenStack standard with CCM and CSI (FP9-F-02, FP9-F-04)', () => {
    expect(render(k0s(openstack()))).toMatchSnapshot();
  });
  it('OpenStack all-in-one', () => {
    expect(render(allInOne(k0s(openstack())))).toMatchSnapshot();
  });
  it('AWS standard', () => {
    expect(render(k0s(aws()))).toMatchSnapshot();
  });
  it('node customization and SSH keys (FP9-F-03)', () => {
    const spec = k0s(
      openstack({ sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample admin@example'] }),
    );
    spec.topology.workerPools![0]!.customization = {
      files: [{ path: '/etc/motd', content: 'managed by CAPI Navigator\n', permissions: '0644' }],
      preCommands: ['echo before'],
      postCommands: ['echo after'],
    };
    const objects = transform(ClusterSpecSchema.parse(spec), ctx);
    expect(
      renderManifests(objects.filter((o) => o.kind === 'K0sWorkerConfigTemplate')),
    ).toMatchSnapshot();
  });
  it('rotates templates on upgrade and keeps workers until the control plane is done', () => {
    const base = ClusterSpecSchema.parse(k0s(openstack()));
    const upgraded = ClusterSpecSchema.parse({
      ...k0s(openstack()),
      kubernetes: { flavor: 'k0s', version: 'v1.36.4+k0s.1', workerVersion: 'v1.35.8+k0s.1' },
    });
    const names = (s: typeof base) =>
      transform(s, ctx)
        .filter((o) => o.kind === 'K0sWorkerConfigTemplate')
        .map((o) => o.metadata.name);
    // Worker templates stay while workerVersion pins the old version (FP7-F-08).
    expect(names(upgraded)).toEqual(names(base));
    const cp = transform(upgraded, ctx).find((o) => o.kind === 'K0sControlPlane')!;
    expect((cp.spec as { version: string }).version).toBe('v1.36.4+k0s.1');
  });
  it('accepts only k0s versions for k0s', () => {
    const bad = ClusterSpecSchema.safeParse({
      ...k0s(openstack()),
      kubernetes: { flavor: 'k0s', version: 'v1.35.9+rke2r1' },
    });
    expect(bad.error?.issues[0]?.path.join('.')).toBe('kubernetes.version');
  });
});

describe('kubeadm flavor (FP-10)', () => {
  const kubeadm = (base: ClusterSpecInput): ClusterSpecInput => ({
    ...base,
    name: `${base.name}-kubeadm`,
    kubernetes: { flavor: 'kubeadm', version: 'v1.35.9' },
  });

  it('OpenStack standard with CNI, CCM and CSI (FP10-F-01, FP10-F-04, FP10-F-06)', () => {
    expect(render(kubeadm(openstack()))).toMatchSnapshot();
  });
  it('OpenStack all-in-one: no control plane taint', () => {
    const objects = transform(ClusterSpecSchema.parse(allInOne(kubeadm(openstack()))), ctx);
    const kcp = objects.find((o) => o.kind === 'KubeadmControlPlane')!;
    const reg = (
      kcp.spec as {
        kubeadmConfigSpec: { initConfiguration: { nodeRegistration: { taints?: unknown[] } } };
      }
    ).kubeadmConfigSpec.initConfiguration.nodeRegistration;
    expect(reg.taints).toEqual([]);
    expect(render(allInOne(kubeadm(openstack())))).toMatchSnapshot();
  });
  it('AWS standard', () => {
    expect(render(kubeadm(aws()))).toMatchSnapshot();
  });
  it('install script with mirrors (FP10-F-02, FP10-F-09)', () => {
    const spec = ClusterSpecSchema.parse({
      ...kubeadm(openstack()),
      kubernetes: {
        flavor: 'kubeadm',
        version: 'v1.34.12',
        packageRepository: 'https://mirror.example/k8s/',
        binaryDownloads: 'https://mirror.example/github',
      },
    });
    const script = kubeadmInstallScript(spec, spec.kubernetes.version);
    expect(script).toContain('PKGS="https://mirror.example/k8s/core:/stable:/v1.34"');
    expect(script).toContain('DOWNLOADS="https://mirror.example/github"');
    expect(script).toContain('K8S_VERSION="1.34.12"');
    expect(script).toMatchSnapshot();
  });
  it('node customization runs after the install script (FP10-F-05)', () => {
    const spec = kubeadm(openstack());
    spec.topology.workerPools![0]!.customization = {
      files: [{ path: '/etc/motd', content: 'managed\n', permissions: '0644' }],
      preCommands: ['echo before'],
      postCommands: ['echo after'],
    };
    const t = transform(ClusterSpecSchema.parse(spec), ctx).find(
      (o) => o.kind === 'KubeadmConfigTemplate' && o.metadata.name.includes('-default-'),
    )!;
    const s = (t.spec as { template: { spec: Record<string, string[]> } }).template.spec;
    expect(s.preKubeadmCommands).toEqual([
      '/usr/local/bin/capi-navigator-install-kubernetes.sh',
      'echo before',
    ]);
    expect(s.postKubeadmCommands).toEqual(['echo after']);
  });
  it('labels the cluster for the Calico preset unless the CNI is switched off', () => {
    const labels = (input: ClusterSpecInput) =>
      transform(ClusterSpecSchema.parse(input), ctx).find((o) => o.kind === 'Cluster')!.metadata
        .labels!;
    expect(labels(kubeadm(openstack()))['capi-navigator.io/cni']).toBe('calico');
    expect(
      labels({ ...kubeadm(openstack()), addons: { cni: 'none' } })['capi-navigator.io/cni'],
    ).toBeUndefined();
    // RKE2 brings its own CNI.
    expect(labels(openstack())['capi-navigator.io/cni']).toBeUndefined();
  });
  it('rotates worker templates on upgrade (FP10-F-07)', () => {
    const names = (version: string) =>
      transform(
        ClusterSpecSchema.parse({
          ...kubeadm(openstack()),
          kubernetes: { flavor: 'kubeadm', version },
        }),
        ctx,
      )
        .filter((o) => o.kind === 'KubeadmConfigTemplate')
        .map((o) => o.metadata.name);
    expect(names('v1.36.5')).not.toEqual(names('v1.35.9'));
  });
});

describe('kubeadm install script runs in bash (FP10-F-02)', () => {
  it('is valid bash and picks the package version without breaking the pipe', async () => {
    const { execFileSync } = await import('node:child_process');
    const spec = ClusterSpecSchema.parse({
      ...openstack(),
      kubernetes: { flavor: 'kubeadm', version: 'v1.35.9' },
    });
    const script = kubeadmInstallScript(spec, 'v1.35.9');
    execFileSync('bash', ['-n'], { input: script });
    // The version lookup under pipefail with a long package list (an early awk exit broke the
    // pipe and ended the script silently, seen live on Infomaniak).
    const program = /awk -v v="\$\{K8S_VERSION\}-" '([^']+)'/.exec(script)![1]!;
    const list =
      'for i in $(seq 1 5000); do echo "   kubeadm | 1.35.8-1.1 | x"; done; echo "   kubeadm | 1.35.9-1.1 | x"; for i in $(seq 1 5000); do echo "   kubeadm | 1.35.7-1.1 | x"; done';
    const out = execFileSync('bash', [
      '-c',
      `set -euo pipefail; pkg=$( { ${list}; } | awk -v v="1.35.9-" '${program}'); echo "$pkg"`,
    ]).toString();
    expect(out.trim()).toBe('1.35.9-1.1');
  });
});
