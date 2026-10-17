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
