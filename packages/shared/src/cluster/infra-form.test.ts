import { describe, expect, it } from 'vitest';
import {
  bastionComplete,
  bastionRequest,
  infraFromValues,
  initialInfraValues,
} from './infra-form.js';
import { InfrastructureSchema, type ClusterSpec, type OpenStackInfra } from './spec.js';
import { INFRA_PLUGINS } from './transform.js';

const os = INFRA_PLUGINS.openstack.form;
const aws = INFRA_PLUGINS.aws.form;
const noBastion = { enabled: false, machineSize: '', allowedCidrs: [] };

describe('infrastructure forms of the plugins (FP25-F-05)', () => {
  it('builds the OpenStack infrastructure as the wizard did before', () => {
    const values = {
      ...initialInfraValues(os),
      image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
      externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      failureDomain: null,
      sshKeyName: 'ops',
    };
    const infra = infraFromValues('openstack', os, values, 'infomaniak', {
      enabled: true,
      machineSize: 'a1-ram2-disk20',
      allowedCidrs: ['10.0.0.0/8'],
    });
    expect(infra).toEqual({
      provider: 'openstack',
      credentialRef: 'infomaniak',
      image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
      externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      network: { nodeCidr: '10.6.0.0/24', dnsNameservers: ['1.1.1.1', '8.8.8.8'] },
      apiServerLoadBalancer: true,
      sshKeyName: 'ops',
      // CAPO opens SSH to everyone: no source networks.
      bastion: { enabled: true, machineSize: 'a1-ram2-disk20' },
      zoneBoundVolumes: true,
    });
    expect(InfrastructureSchema.safeParse(infra).success).toBe(true);
  });

  it('builds the AWS infrastructure as the wizard did before', () => {
    const values = {
      ...initialInfraValues(aws),
      region: 'eu-central-1',
      image: 'ami-0123456789abcdef0',
      'network.availabilityZoneCount': 2,
    };
    const infra = infraFromValues('aws', aws, values, 'demo', {
      enabled: true,
      machineSize: '',
      allowedCidrs: [' 203.0.113.0/24 '],
    });
    expect(infra).toEqual({
      provider: 'aws',
      credentialRef: 'demo',
      region: 'eu-central-1',
      image: 'ami-0123456789abcdef0',
      network: { vpcCidr: '10.0.0.0/16', availabilityZoneCount: 2 },
      bastion: { enabled: true, allowedCidrs: ['203.0.113.0/24'] },
    });
    expect(InfrastructureSchema.safeParse(infra).success).toBe(true);
    expect(infraFromValues('aws', aws, values, 'demo', noBastion)).not.toHaveProperty('bastion');
  });

  it('describes defaults, preselection and region dependencies', () => {
    const images = [
      { value: 'a', label: 'Debian 12' },
      { value: 'b', label: 'Ubuntu 24.04 LTS' },
    ];
    expect(os.fields.find((f) => f.path === 'image')?.preselect?.(images)).toBe('b');
    const nets = [
      { value: 'n1', label: 'ext-net1' },
      { value: 'n2', label: 'ext-floating1' },
    ];
    expect(os.fields.find((f) => f.path === 'externalNetwork')?.preselect?.(nets)).toBe('n2');
    const region = aws.fields.find((f) => f.path === 'region')!;
    expect(region.fromCredential?.({ region: 'eu-west-1' })).toBe('eu-west-1');
    expect(region.resets).toEqual(['image']);
  });

  it('checks and builds bastion changes per provider (FP5-F-20)', () => {
    const draft = { enabled: true, machineSize: '', allowedCidrs: [] as string[] };
    expect(bastionComplete(os, draft)).toBe(false);
    expect(bastionComplete(os, { ...draft, machineSize: 'small' })).toBe(true);
    expect(bastionComplete(aws, draft)).toBe(false);
    expect(bastionComplete(aws, { ...draft, allowedCidrs: ['10.0.0.0/8'] })).toBe(true);
    expect(bastionRequest(aws, { ...draft, allowedCidrs: ['10.0.0.0/8 '] })).toEqual({
      enabled: true,
      allowedCidrs: ['10.0.0.0/8'],
    });
    expect(bastionRequest(os, { ...draft, machineSize: 'small' })).toEqual({
      enabled: true,
      machineSize: 'small',
    });
  });
});

describe('air-gap warnings of infrastructure fields (FP-29)', () => {
  it('warns about public DNS servers on OpenStack and Proxmox VE, as list or text', () => {
    for (const provider of ['openstack', 'proxmox'] as const) {
      const dns = INFRA_PLUGINS[provider].form.fields.find(
        (f) => f.path === 'network.dnsNameservers',
      )!;
      expect(dns.airGapWarning?.('1.1.1.1, 8.8.8.8')).toBe('wizard.dnsPublicAirGapped');
      expect(dns.airGapWarning?.(['10.0.0.53', '9.9.9.9'])).toBe('wizard.dnsPublicAirGapped');
      expect(dns.airGapWarning?.('10.0.0.53 10.0.0.54')).toBeUndefined();
    }
  });
});

describe('node network of OpenStack clusters (FP5-F-21)', () => {
  const plugin = INFRA_PLUGINS.openstack;
  const spec = { name: 'b', namespace: 'default' } as ClusterSpec;
  const infra = {
    credentialRef: 'cloud',
    network: { nodeCidr: '10.6.0.0/24' },
  } as OpenStackInfra;
  const other = (name: string, credential: string, cidr: string) => ({
    metadata: { name, namespace: 'default' },
    spec: { identityRef: { name: credential }, managedSubnets: [{ cidr }] },
  });

  it('suggests the first free network and keeps the default without one', () => {
    const field = plugin.form.fields.find((f) => f.path === 'network.nodeCidr')!;
    expect(field.suggest?.([])).toBe('10.6.0.0/24');
    expect(field.suggest?.([{ value: '10.6.0.0/24', label: 'a' }])).toBe('10.6.1.0/24');
    expect(field.suggest?.([{ value: '10.0.0.0/8', label: 'a' }])).toBeUndefined();
  });

  it('warns about overlaps with other clusters of the same credentials', () => {
    const warnings = plugin.addressWarnings!(spec, infra, [
      other('a', 'cloud', '10.6.0.0/23'),
      other('b', 'cloud', '10.6.0.0/24'), // the cluster itself
      other('c', 'another-project', '10.6.0.0/24'),
      other('d', 'cloud', '10.6.1.0/24'),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('overlaps 10.6.0.0/23 of cluster default/a');
  });
});
