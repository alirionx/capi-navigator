import { describe, expect, it } from 'vitest';
import { AwsCredentialPlugin, type AwsClients } from './aws/aws-credential.plugin.js';
import { cloudsYamlInfo, normalizeOpenStack, readStoredCloud } from './openstack/clouds-yaml.js';
import type { HttpFn } from './openstack/openstack-client.js';
import { OpenStackCredentialPlugin } from './openstack/openstack-credential.plugin.js';

const CLOUDS = `clouds:
  infomaniak:
    auth:
      auth_url: https://api.example.cloud/identity
      application_credential_id: app-id
      application_credential_secret: app-secret
    region_name: dc4-a
    interface: public
    identity_api_version: 3
    auth_type: v3applicationcredential
  other:
    auth: { auth_url: https://other.example/v3, username: u, password: p, project_name: pr }
    region_name: r1
`;

describe('clouds.yaml handling (FP4-F-01, FP4-F-03)', () => {
  it('lists clouds without secrets', () => {
    const info = cloudsYamlInfo(CLOUDS);
    expect(info.clouds.map((c) => c.name)).toEqual(['infomaniak', 'other']);
    expect(JSON.stringify(info)).not.toMatch(/app-secret|"p"/);
  });

  it('stores only the selected cloud', () => {
    const n = normalizeOpenStack({
      source: 'clouds.yaml',
      cloudsYaml: CLOUDS,
      cloudName: 'infomaniak',
    });
    expect(n.cloudName).toBe('infomaniak');
    expect(readStoredCloud(n.cloudsYaml).cloudName).toBe('infomaniak');
    expect(n.cloudsYaml).not.toContain('other.example');
  });

  it('requires a choice when the file has several clouds', () => {
    expect(() => normalizeOpenStack({ source: 'clouds.yaml', cloudsYaml: CLOUDS })).toThrow(
      /2 clouds/,
    );
  });

  it('builds a clouds.yaml from the form, with application credential or password', () => {
    const app = normalizeOpenStack({
      source: 'form',
      authUrl: 'https://keystone.example/v3',
      region: 'RegionOne',
      auth: {
        type: 'applicationCredential',
        applicationCredentialId: 'i',
        applicationCredentialSecret: 's',
      },
      cacert: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----',
    });
    expect(app.cloud).toMatchObject({
      auth_type: 'v3applicationcredential',
      region_name: 'RegionOne',
    });
    expect(app.cacert).toContain('BEGIN CERTIFICATE');
    const pw = normalizeOpenStack({
      source: 'form',
      authUrl: 'https://keystone.example/v3',
      region: 'RegionOne',
      auth: {
        type: 'password',
        username: 'u',
        password: 'p',
        projectName: 'pr',
        projectDomainName: 'Default',
        userDomainName: 'Default',
      },
    });
    expect(pw.cloud.auth).toMatchObject({
      username: 'u',
      project_name: 'pr',
      user_domain_name: 'Default',
    });
  });

  it.each([
    ['not: [valid', /not valid YAML/],
    ['foo: bar', /no "clouds:"/],
    [
      'clouds:\n  x:\n    auth: { auth_url: "http://insecure" , username: u, password: p }',
      /https/,
    ],
    ['clouds:\n  x:\n    auth_type: token\n    auth: { auth_url: "https://a" }', /not supported/],
    [
      'clouds:\n  x:\n    auth_type: v3applicationcredential\n    auth: { auth_url: "https://a", application_credential_id: i }',
      /secret/,
    ],
  ])('rejects broken input clearly: %s', (yaml, message) => {
    expect(() => normalizeOpenStack({ source: 'clouds.yaml', cloudsYaml: yaml })).toThrow(message);
  });
});

/** Fake OpenStack: Keystone + catalog without version suffixes (like Infomaniak). */
function fakeOpenStack(
  opts: {
    authStatus?: number;
    noOctavia?: boolean;
    brokenPaging?: boolean;
    /** Kolla 2026.1 registers Cinder as block-storage. */
    cinderType?: 'volumev3' | 'block-storage';
  } = {},
): HttpFn {
  const catalog = [
    'compute',
    'network',
    'image',
    opts.cinderType ?? 'volumev3',
    ...(opts.noOctavia ? [] : ['load-balancer']),
  ].map((type) => ({
    type,
    endpoints: [{ interface: 'public', region_id: 'dc4-a', url: `https://api.example/${type}` }],
  }));
  const bodies: Record<string, unknown> = {
    'https://api.example/compute/flavors?limit=1': { flavors: [] },
    'https://api.example/compute/flavors/detail': {
      flavors: [
        { name: 'big', vcpus: 4, ram: 8192, disk: 40 },
        { name: 'small', vcpus: 1, ram: 2048, disk: 20 },
      ],
    },
    'https://api.example/image/v2/images?status=active&limit=200&sort=name:asc': {
      images: [{ id: 'img-1', name: 'Ubuntu 24.04', os_distro: 'ubuntu', os_version: '24.04' }],
      next: '/v2/images?marker=img-1',
    },
    'https://api.example/image/v2/images?marker=img-1': {
      images: [{ id: 'img-2', name: 'Debian 12' }],
    },
    'https://api.example/network/v2.0/networks?router:external=true': {
      networks: [{ id: 'net-1', name: 'ext-floating1' }],
    },
    'https://api.example/compute/os-availability-zone': {
      availabilityZoneInfo: [
        { zoneName: 'az-1', zoneState: { available: true } },
        { zoneName: 'az-x', zoneState: { available: false } },
      ],
    },
    'https://api.example/compute/os-keypairs': { keypairs: [{ keypair: { name: 'my-keys' } }] },
    'https://api.example/image/v2/images/img-1': { id: 'img-1', name: 'Ubuntu 24.04' },
    // Paging links like Infomaniak: without the endpoint path when broken.
    'https://api.example/network/v2.0/networks?limit=1': {
      networks: [{ id: 'net-1' }],
      networks_links: [
        {
          rel: 'next',
          href: opts.brokenPaging
            ? 'https://api.example/v2.0/networks?limit=1&marker=net-1'
            : 'https://api.example/network/v2.0/networks?limit=1&marker=net-1',
        },
      ],
    },
    [`https://api.example/${opts.cinderType ?? 'volumev3'}/types`]: {
      volume_types: [
        { id: 'vt-2', name: 'ssd', description: 'Fast' },
        { id: 'vt-1', name: 'hdd', description: null },
      ],
    },
  };
  return async (url, init) => {
    if (url.endsWith('/v3/auth/tokens')) {
      expect(JSON.parse(init.body!).auth.identity.methods).toEqual(['application_credential']);
      if (opts.authStatus)
        return { status: opts.authStatus, headers: {}, body: '{"error":{"message":"nope"}}' };
      return {
        status: 201,
        headers: { 'x-subject-token': 'tok' },
        body: JSON.stringify({
          token: { catalog, project: { id: 'p', name: 'PCP-1', domain: { name: 'Default' } } },
        }),
      };
    }
    expect(init.headers?.['X-Auth-Token']).toBe('tok');
    const body = bodies[url];
    return body
      ? { status: 200, headers: {}, body: JSON.stringify(body) }
      : { status: 404, headers: {}, body: '{}' };
  };
}

describe('OpenStack plugin (FP4-F-04, FP4-F-05)', () => {
  const input = { source: 'clouds.yaml' as const, cloudsYaml: CLOUDS, cloudName: 'infomaniak' };

  it('normalizes into the Secret format CAPO expects and builds the identity (ADR-0002)', () => {
    const plugin = new OpenStackCredentialPlugin(fakeOpenStack());
    const { data, summary } = plugin.normalize(input);
    expect(Object.keys(data)).toEqual(['clouds.yaml']);
    expect(summary).toMatchObject({
      cloudName: 'infomaniak',
      region: 'dc4-a',
      authType: 'v3applicationcredential',
    });
    const identity = plugin.identity('c', { name: 's', namespace: 'capo-system' }, [
      'team-b',
      'default',
    ]);
    expect(identity).toMatchObject({
      apiVersion: 'infrastructure.cluster.x-k8s.io/v1alpha1',
      kind: 'OpenStackClusterIdentity',
      spec: { secretRef: { name: 's', namespace: 'capo-system' } },
    });
    expect(plugin.allowedNamespaces(identity)).toEqual(['default', 'team-b']);
  });

  it('tests token, project and services', async () => {
    const plugin = new OpenStackCredentialPlugin(fakeOpenStack());
    const result = await plugin.test(plugin.normalize(input).data);
    expect(result).toMatchObject({ ok: true, identity: 'Project PCP-1 (domain Default)' });
    expect(result.checks.find((c) => c.id === 'neutron-paging-links')?.ok).toBe(true);
  });

  it('warns about broken Neutron paging links without failing the test (FP5-F-20)', async () => {
    const plugin = new OpenStackCredentialPlugin(fakeOpenStack({ brokenPaging: true }));
    const result = await plugin.test(plugin.normalize(input).data);
    const paging = result.checks.find((c) => c.id === 'neutron-paging-links');
    expect(result.ok).toBe(true);
    expect(paging).toMatchObject({ ok: false, warning: true });
    expect(paging?.message).toMatch(/bastion host would not get a floating IP/);
  });

  it('finds Cinder under its current service type block-storage (Kolla 2026.1)', async () => {
    const plugin = new OpenStackCredentialPlugin(fakeOpenStack({ cinderType: 'block-storage' }));
    const { data, summary } = plugin.normalize(input);
    const result = await plugin.test(data);
    expect(result.checks.find((c) => c.name === 'Block storage (Cinder)')?.ok).toBe(true);
    const types = await plugin.lookup(data, summary, 'volumeTypes');
    expect(types.map((t) => t.value)).toEqual(['hdd', 'ssd']);
  });

  it('reports a missing service and rejected credentials', async () => {
    const noLb = new OpenStackCredentialPlugin(fakeOpenStack({ noOctavia: true }));
    const r1 = await noLb.test(noLb.normalize(input).data);
    expect(r1.ok).toBe(false);
    expect(r1.checks.find((c) => c.name.startsWith('Load balancer'))?.ok).toBe(false);
    const denied = new OpenStackCredentialPlugin(fakeOpenStack({ authStatus: 401 }));
    const r2 = await denied.test(denied.normalize(input).data);
    expect(r2).toMatchObject({
      ok: false,
      message: 'Authentication: the cloud rejected the credentials',
    });
  });

  it('lists images (paged), flavors, external networks, AZs, key pairs and volume types', async () => {
    const plugin = new OpenStackCredentialPlugin(fakeOpenStack());
    const { data, summary } = plugin.normalize(input);
    const labels = async (kind: Parameters<typeof plugin.lookup>[2]) =>
      (await plugin.lookup(data, summary, kind)).map((o) => o.label);
    expect(await labels('images')).toEqual(['Ubuntu 24.04', 'Debian 12']);
    expect(await labels('flavors')).toEqual([
      'small (1 vCPU, 2 GiB RAM, 20 GB disk)',
      'big (4 vCPU, 8 GiB RAM, 40 GB disk)',
    ]);
    expect(await labels('externalNetworks')).toEqual(['ext-floating1']);
    expect(await labels('availabilityZones')).toEqual(['az-1']);
    expect(await labels('keyPairs')).toEqual(['my-keys']);
    // FP5-F-19: root disk volume types.
    expect(await labels('volumeTypes')).toEqual(['hdd', 'ssd']);
    // FP6-F-02: image names by ID; unknown IDs are left out.
    expect(await plugin.imageNames(data, summary, ['img-1', 'img-x'])).toEqual({
      'img-1': 'Ubuntu 24.04',
    });
  });
});

/** Fake AWS SDK clients dispatching on the command class. */
function fakeAws(
  opts: { stsError?: string; missing?: string[]; iamDenied?: boolean } = {},
): AwsClients {
  const err = (name: string) => Object.assign(new Error(name), { name });
  const send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    switch (cmd.constructor.name) {
      case 'GetCallerIdentityCommand':
        if (opts.stsError) throw err(opts.stsError);
        return { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/capi' };
      case 'GetRoleCommand':
      case 'GetInstanceProfileCommand': {
        if (opts.iamDenied) throw err('AccessDenied');
        const name = String(cmd.input.RoleName ?? cmd.input.InstanceProfileName);
        if (opts.missing?.some((m) => name.startsWith(m))) throw err('NoSuchEntity');
        return {};
      }
      case 'DescribeAvailabilityZonesCommand':
        return {
          AvailabilityZones: [
            { ZoneName: 'eu-central-1a', ZoneType: 'availability-zone' },
            { ZoneName: 'eu-central-1-ham-1a', ZoneType: 'local-zone' },
          ],
        };
      case 'DescribeRegionsCommand':
        return { Regions: [{ RegionName: 'us-east-1' }, { RegionName: 'eu-central-1' }] };
      case 'DescribeInstanceTypesCommand':
        return cmd.input.NextToken
          ? {
              InstanceTypes: [
                {
                  InstanceType: 't3.medium',
                  VCpuInfo: { DefaultVCpus: 2 },
                  MemoryInfo: { SizeInMiB: 4096 },
                },
              ],
            }
          : {
              InstanceTypes: [
                {
                  InstanceType: 'm5.large',
                  VCpuInfo: { DefaultVCpus: 2 },
                  MemoryInfo: { SizeInMiB: 8192 },
                },
              ],
              NextToken: 'n',
            };
      case 'DescribeImagesCommand':
        if (cmd.input.ImageIds) {
          const id = (cmd.input.ImageIds as string[])[0];
          if (id !== 'ami-new') throw err('InvalidAMIID.NotFound');
          return { Images: [{ ImageId: id, Name: 'ubuntu-noble-24.04-amd64-server-20261001' }] };
        }
        if ((cmd.input.Owners as string[])[0] !== '099720109477') return { Images: [] };
        return {
          Images: [
            {
              ImageId: 'ami-old',
              Name: 'ubuntu/images/x/ubuntu-noble-24.04-amd64-server-20260101',
              CreationDate: '2026-01-01',
            },
            {
              ImageId: 'ami-new',
              Name: 'ubuntu/images/x/ubuntu-noble-24.04-amd64-server-20261001',
              CreationDate: '2026-10-01',
            },
          ],
        };
      case 'DescribeKeyPairsCommand':
        return { KeyPairs: [{ KeyName: 'ops' }] };
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  };
  const client = { send: send as (cmd: unknown) => Promise<unknown> };
  return { sts: client, iam: client, ec2: client };
}

describe('AWS plugin (FP4-F-07..10)', () => {
  const input = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'eu-central-1',
  };

  it('normalizes into the Secret format CAPA expects and builds the static identity', () => {
    const plugin = new AwsCredentialPlugin(() => fakeAws());
    const { data, summary } = plugin.normalize(input);
    expect(data).toEqual({
      AccessKeyID: input.accessKeyId,
      SecretAccessKey: input.secretAccessKey,
    });
    expect(summary).toEqual({ region: 'eu-central-1', accessKeyIdSuffix: 'MPLE' });
    const identity = plugin.identity('a', { name: 's', namespace: 'capa-system' }, ['default']);
    expect(identity).toMatchObject({
      apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta2',
      kind: 'AWSClusterStaticIdentity',
      spec: { secretRef: 's', allowedNamespaces: { list: ['default'] } },
    });
    expect(plugin.allowedNamespaces(identity)).toEqual(['default']);
    expect(() => plugin.normalize({ ...input, accessKeyId: 'nope' })).toThrow(/AKIA/);
  });

  it('passes with caller identity, region and IAM prerequisites', async () => {
    const plugin = new AwsCredentialPlugin(() => fakeAws());
    const { data, summary } = plugin.normalize(input);
    const r = await plugin.test(data, summary);
    expect(r).toMatchObject({
      ok: true,
      identity: 'Account 123456789012 (arn:aws:iam::123456789012:user/capi)',
    });
    expect(r.checks).toHaveLength(8);
  });

  it('shows the clusterawsadm command when IAM prerequisites are missing (FP4-F-09)', async () => {
    const plugin = new AwsCredentialPlugin(() => fakeAws({ missing: ['nodes'] }));
    const { data, summary } = plugin.normalize(input);
    const r = await plugin.test(data, summary);
    expect(r.ok).toBe(false);
    expect(r.fixCommand).toBe(
      'clusterawsadm bootstrap iam create-cloudformation-stack --region eu-central-1',
    );
  });

  it('explains rejected keys and missing IAM read permissions', async () => {
    const bad = new AwsCredentialPlugin(() => fakeAws({ stsError: 'InvalidClientTokenId' }));
    const n = bad.normalize(input);
    expect(await bad.test(n.data, n.summary)).toMatchObject({
      ok: false,
      message: 'AWS rejected the access key',
    });
    const denied = new AwsCredentialPlugin(() => fakeAws({ iamDenied: true }));
    const r = await denied.test(n.data, n.summary);
    expect(r.fixCommand).toBeUndefined();
    expect(r.hint).toMatch(/iam:GetRole/);
  });

  it('lists regions, AZs, instance types (paged), newest Ubuntu AMIs and key pairs', async () => {
    const plugin = new AwsCredentialPlugin(() => fakeAws());
    const { data, summary } = plugin.normalize(input);
    const values = async (kind: Parameters<typeof plugin.lookup>[2]) =>
      (await plugin.lookup(data, summary, kind, {})).map((o) => o.value);
    expect(await values('regions')).toEqual(['eu-central-1', 'us-east-1']);
    expect(await values('availabilityZones')).toEqual(['eu-central-1a']);
    expect(await values('instanceTypes')).toEqual(['t3.medium', 'm5.large']);
    expect((await values('images')).slice(0, 2)).toEqual(['ami-new', 'ami-old']);
    expect(await values('keyPairs')).toEqual(['ops']);
  });

  it('resolves AMI names by ID and leaves unknown AMIs out (FP6-F-02)', async () => {
    const plugin = new AwsCredentialPlugin(() => fakeAws());
    const { data, summary } = plugin.normalize(input);
    expect(await plugin.imageNames(data, summary, ['ami-new', 'ami-gone'], {})).toEqual({
      'ami-new': 'ubuntu-noble-24.04-amd64-server-20261001',
    });
  });
});
