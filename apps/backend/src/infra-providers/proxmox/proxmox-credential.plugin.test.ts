import { PROXMOX_REQUIRED_PRIVILEGES } from '@capi-navigator/shared';
import { describe, expect, it } from 'vitest';
import type { HttpFn } from '../https-client.js';
import { CredentialInputError } from '../credential-plugin.js';
import { ProxmoxCredentialPlugin, templateWarning } from './proxmox-credential.plugin.js';

const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
const ALL = Object.fromEntries(PROXMOX_REQUIRED_PRIVILEGES.map((p) => [p.privilege, 1]));

/** Fake Proxmox API: routes by path; records the requests. */
function fakeApi(
  routes: Record<string, unknown>,
  seen: { url: string; auth?: string; ca?: string }[] = [],
): HttpFn {
  return async (url, init) => {
    seen.push({ url, auth: init.headers?.Authorization, ...(init.ca ? { ca: init.ca } : {}) });
    const path = url.replace(/^https:\/\/pve\.example:8006\/api2\/json/, '');
    if (path in routes) {
      const value = routes[path];
      if (value instanceof Error) throw value;
      return { status: 200, headers: {}, body: JSON.stringify({ data: value }) };
    }
    return { status: 404, headers: {}, body: '{}' };
  };
}

const input = {
  url: 'https://pve.example:8006/api2/json/',
  tokenId: 'capmox@pve!capi',
  tokenSecret: 'f00d-secret',
  caCert: CA,
};

describe('Proxmox VE credentials (FP31-F-02..05)', () => {
  it('stores the token in the format CAPMOX reads, with defaults for the sizes', () => {
    const { data, summary } = new ProxmoxCredentialPlugin().normalize(input);
    expect(data).toEqual({
      url: 'https://pve.example:8006',
      token: 'capmox@pve!capi',
      secret: 'f00d-secret',
      'ca.crt': `${CA}\n`,
    });
    expect(summary).toMatchObject({
      url: 'https://pve.example:8006',
      tokenId: 'capmox@pve!capi',
      hasCaCert: true,
    });
    expect(summary.machineSizes?.map((s) => s.name)).toEqual([
      'small',
      'medium',
      'large',
      'xlarge',
    ]);
    expect(JSON.stringify(summary)).not.toContain('f00d-secret');
  });

  it('refuses a malformed token ID with the field', () => {
    expect(() => new ProxmoxCredentialPlugin().normalize({ ...input, tokenId: 'root' })).toThrow(
      CredentialInputError,
    );
  });

  it('tests version over TLS with the CA and the privileges (FP31-F-03)', async () => {
    const seen: { url: string; auth?: string; ca?: string }[] = [];
    const plugin = new ProxmoxCredentialPlugin(
      fakeApi(
        {
          '/version': { version: '9.2.21' },
          '/access/permissions': { '/': { ...ALL, 'VM.GuestAgent.Audit': 0 }, '/vms': {} },
          '/nodes': [{ node: 'pve1', status: 'online' }],
        },
        seen,
      ),
    );
    const { data, summary } = plugin.normalize(input);
    const ok = await plugin.test(data, summary);
    expect(ok).toMatchObject({ ok: true, identity: 'Proxmox VE 9.2.21 (capmox@pve!capi)' });
    expect(seen[0]).toMatchObject({
      url: 'https://pve.example:8006/api2/json/version',
      auth: 'PVEAPIToken=capmox@pve!capi=f00d-secret',
      ca: `${CA}\n`,
    });

    const pve8: Record<string, number> = { ...ALL, 'VM.Monitor': 1 };
    delete pve8['Datastore.Allocate'];
    delete pve8['VM.GuestAgent.Audit'];
    const lacking = new ProxmoxCredentialPlugin(
      fakeApi({
        '/version': { version: '9.2.21' },
        // Proxmox VE 8 grants VM.Monitor instead of VM.GuestAgent.Audit.
        '/access/permissions': {
          '/': pve8,
        },
        '/nodes': [{ node: 'pve1', status: 'online' }],
      }),
    );
    const missing = await lacking.test(data, summary);
    expect(missing.ok).toBe(false);
    expect(missing.checks.find((c) => c.name.startsWith('Privileges'))?.message).toBe(
      'Missing: Datastore.Allocate (CSI)',
    );
  });

  it('explains an untrusted certificate', async () => {
    const tls = Object.assign(new Error('self-signed certificate in certificate chain'), {
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
    });
    const plugin = new ProxmoxCredentialPlugin(fakeApi({ '/version': tls }));
    const { data, summary } = plugin.normalize({ ...input, caCert: undefined });
    const res = await plugin.test(data, summary);
    expect(res).toMatchObject({
      ok: false,
      message: 'The certificate of the Proxmox API is not trusted (SELF_SIGNED_CERT_IN_CHAIN)',
    });
    expect(res.hint).toContain('pve-root-ca.pem');
  });

  it('lists nodes, templates with warnings, bridges, storages and sizes (FP31-F-05)', async () => {
    const plugin = new ProxmoxCredentialPlugin(
      fakeApi({
        '/nodes': [{ node: 'pve1', status: 'online', maxcpu: 14, maxmem: 64 * 2 ** 30 }],
        '/cluster/resources?type=vm': [
          { vmid: 7112, name: 'capi-ubuntu-26', node: 'pve1', template: 1 },
          { vmid: 7111, name: 'capi-debian-13', node: 'pve1', template: 1 },
          { vmid: 100, name: 'running-vm', node: 'pve1' },
        ],
        '/nodes/pve1/qemu/7111/config': {
          agent: '1,fstrim_cloned_disks=1',
          virtio0: 'local-zfs:x',
        },
        '/nodes/pve1/qemu/7112/config': { ide2: 'local-zfs:vm-7112-cloudinit,media=cdrom' },
        '/nodes/pve1/network': [
          { iface: 'vmbr0', type: 'bridge', cidr: '192.168.10.100/24' },
          { iface: 'nic0', type: 'eth' },
        ],
        '/nodes/pve1/storage?enabled=1': [
          {
            storage: 'local-zfs',
            type: 'zfspool',
            content: 'images,rootdir',
            avail: 700 * 2 ** 30,
          },
        ],
      }),
    );
    const { data, summary } = plugin.normalize(input);
    const look = (kind: Parameters<typeof plugin.lookup>[2]) =>
      plugin.lookup(data, summary, kind, {});
    expect(await look('nodes')).toEqual([
      { value: 'pve1', label: 'pve1', details: { status: 'online', vcpus: 14, ramGiB: 64 } },
    ]);
    const templates = await look('templates');
    expect(templates.map((t) => t.value)).toEqual(['7111', '7112']);
    expect(templates[0]!.details).toEqual({ node: 'pve1' });
    expect(String(templates[1]!.details?.warning)).toMatch(
      /cloud-init drive \(ide2\).*guest agent disabled/,
    );
    expect((await look('bridges')).map((b) => b.value)).toEqual(['vmbr0']);
    expect((await look('storages'))[0]).toMatchObject({
      value: 'local-zfs',
      details: { type: 'zfspool', shared: false, availGiB: 700 },
    });
    expect((await look('machineSizes'))[1]).toEqual({
      value: 'medium',
      label: 'medium – 4 vCPU / 8 GiB',
      details: { vcpus: 4, ramGiB: 8 },
    });
    expect(await plugin.imageNames(data, summary, ['7112', '999'])).toEqual({
      '7112': 'capi-ubuntu-26',
    });
  });

  it('finds the clusters of a credential by the annotation on the copy (FP31-F-09)', () => {
    const uses = new ProxmoxCredentialPlugin().clusterKind.usesCredential;
    const cluster = { metadata: { annotations: { 'capi-navigator.io/credential': 'home' } } };
    const cred = { name: 'home', secret: { name: 'x', namespace: 'capmox-system' } };
    expect(uses(cluster, cred)).toBe(true);
    expect(uses(cluster, { ...cred, name: 'other' })).toBe(false);
  });

  it('accepts templates without cloud-init drive and with the guest agent', () => {
    expect(templateWarning({ agent: 'enabled=1', virtio0: 'local-zfs:disk' })).toBeUndefined();
  });
});
