import { describe, expect, it } from 'vitest';
import { catalogEntry } from './catalog/providers.js';
import { buildProviderManifests, renderManifests } from './operator-manifests.js';
import { ProviderInstallRequestSchema } from './operator.js';

const spec = (input: Record<string, unknown>) => ProviderInstallRequestSchema.parse(input);

describe('provider manifests (FP3-F-09, FP3-F-10)', () => {
  it('core provider: namespace + CoreProvider', () => {
    const objects = buildProviderManifests(
      catalogEntry('core')!,
      spec({ catalogId: 'core', version: 'v1.14.3', namespace: 'capi-system' }),
    );
    expect(renderManifests(objects)).toMatchSnapshot();
  });

  it('infrastructure provider with variables, feature gates and fetchConfig', () => {
    const objects = buildProviderManifests(
      catalogEntry('openstack')!,
      spec({
        catalogId: 'openstack',
        version: 'v0.15.0',
        namespace: 'capo-system',
        variables: { EXP_CLUSTER_RESOURCE_SET: 'true', SECRET_VALUE: 's3cr3t' },
        featureGates: { MachinePool: true, PriorityQueue: false },
        fetchConfigUrl: 'https://example.com/infrastructure-components.yaml',
      }),
    );
    expect(renderManifests(objects)).toMatchSnapshot();
  });

  it('Proxmox VE: TLS verification against a CA bundle from the credentials (FP31-F-01)', () => {
    const input = spec({ catalogId: 'proxmox', version: 'v0.9.1', namespace: 'capmox-system' });
    const ca = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    expect(
      renderManifests(buildProviderManifests(catalogEntry('proxmox')!, input, { caBundle: ca })),
    ).toMatchSnapshot();
    // Without CAs only the insecure default is switched off (system trust store).
    const plain = buildProviderManifests(catalogEntry('proxmox')!, input);
    expect(plain.map((o) => o.kind)).toEqual(['Namespace', 'InfrastructureProvider']);
    expect(plain[1]!.spec).toEqual({
      version: 'v0.9.1',
      deployment: {
        containers: [{ name: 'manager', env: [{ name: 'PROXMOX_INSECURE', value: 'false' }] }],
      },
    });
    // A changed bundle changes the manager's environment, so the pod restarts with it.
    const env = (caBundle: string) =>
      JSON.stringify(
        (
          buildProviderManifests(catalogEntry('proxmox')!, input, { caBundle })[2]!.spec as {
            deployment: unknown;
          }
        ).deployment,
      );
    expect(env(ca)).not.toEqual(env(ca + ca));
  });

  it('IPAM provider (FP31-F-01)', () => {
    const objects = buildProviderManifests(
      catalogEntry('ipam-in-cluster')!,
      spec({
        catalogId: 'ipam-in-cluster',
        version: 'v1.1.1',
        namespace: 'capi-ipam-in-cluster-system',
      }),
    );
    expect(objects[1]).toMatchObject({ kind: 'IPAMProvider', metadata: { name: 'in-cluster' } });
  });

  it('masks secret values for the preview', () => {
    const objects = buildProviderManifests(
      catalogEntry('helm')!,
      spec({
        catalogId: 'helm',
        version: 'v0.6.4',
        namespace: 'caaph-system',
        variables: { TOKEN: 'super-secret' },
      }),
    );
    const masked = renderManifests(objects, { maskSecrets: true });
    expect(masked).not.toContain('super-secret');
    expect(masked).toContain('TOKEN: "********"');
    expect(renderManifests(objects)).toContain('super-secret');
  });

  it('is deterministic: same input, byte-identical YAML (hard rule 3)', () => {
    const input = spec({
      catalogId: 'rke2-bootstrap',
      version: 'v0.26.0',
      namespace: 'rke2-bootstrap-system',
      variables: { B: '2', A: '1' },
      featureGates: { Zeta: true, Alpha: false },
    });
    const a = renderManifests(buildProviderManifests(catalogEntry('rke2-bootstrap')!, input));
    const b = renderManifests(
      buildProviderManifests(catalogEntry('rke2-bootstrap')!, { ...input }),
    );
    expect(a).toBe(b);
    expect(a.indexOf('A: "1"')).toBeLessThan(a.indexOf('B: "2"'));
  });
});

describe('ProviderUpdateRequestSchema', () => {
  it('keeps "variables omitted" distinct from "no variables" (FP3-F-12)', async () => {
    const { ProviderUpdateRequestSchema } = await import('./operator.js');
    expect(ProviderUpdateRequestSchema.parse({ version: 'v1.0.0' }).variables).toBeUndefined();
    expect(
      ProviderUpdateRequestSchema.parse({ version: 'v1.0.0', variables: {} }).variables,
    ).toEqual({});
  });
});
