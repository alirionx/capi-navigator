import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  distributionCatalog,
  KUBERNETES_VERSIONS,
  orcVersionForCapo,
  PROVIDER_CATALOG,
} from '../catalog/index.js';
import { VERSIONS } from '../versions.generated.js';
import { parseVersionsFile, renderScriptEnv, renderVersionsModule } from './generate.js';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('versions.yaml (FP-20, ADR-0018)', () => {
  const file = parseVersionsFile(read('versions.yaml'));

  it('is current in the generated module and script variables: run pnpm versions:generate (FP20-F-02)', () => {
    expect(read('packages/shared/src/versions.generated.ts')).toBe(renderVersionsModule(file));
    expect(read('scripts/versions.generated.env')).toBe(renderScriptEnv(file));
  });

  it('reports schema problems with their path', () => {
    const broken = read('versions.yaml').replace('version: v0.15.0', 'versio: v0.15.0');
    expect(() => parseVersionsFile(broken)).toThrow(
      /versions\.yaml: providers\.openstack\.version/,
    );
  });

  it('gives provider pairs released together one version (FP20-F-04)', () => {
    const version = (id: string) => PROVIDER_CATALOG.find((p) => p.id === id)!.recommendedVersion;
    for (const [a, b] of [
      ['core', 'kubeadm-bootstrap'],
      ['core', 'kubeadm-control-plane'],
      ['rke2-bootstrap', 'rke2-control-plane'],
      ['k0smotron-bootstrap', 'k0smotron-control-plane'],
    ] as const) {
      expect(version(a), `${a} and ${b}`).toBe(version(b));
    }
    expect(VERSIONS.addonPresets['openstack-ccm'].version).toBe(
      VERSIONS.addonPresets['openstack-csi'].version,
    );
  });

  it('has an ORC version for the CAPO minor (FP20-F-04)', () => {
    const capo = VERSIONS.providers.openstack.version;
    expect(orcVersionForCapo(capo), `prerequisites.orc.byCapoMinor for CAPO ${capo}`).toBeDefined();
  });

  it('has one default and one entry per minor in each Kubernetes catalog (FP20-F-04)', () => {
    for (const catalog of KUBERNETES_VERSIONS) {
      expect(
        catalog.versions.filter((v) => v.default),
        catalog.flavor,
      ).toHaveLength(1);
      const minors = catalog.versions.map((v) => v.minor);
      expect(new Set(minors).size, `${catalog.flavor}: one entry per minor`).toBe(minors.length);
    }
  });

  it('verified every Kubernetes version with the pinned provider version (FP20-F-04)', () => {
    // Updating a provider means checking its Kubernetes versions again and raising
    // verifiedWithProvider (docs/maintenance.md).
    const stale = KUBERNETES_VERSIONS.flatMap((catalog) => {
      const provider = PROVIDER_CATALOG.find((p) => p.id === catalog.providers.bootstrap)!;
      return catalog.versions
        .filter((v) => v.verifiedWithProvider !== provider.recommendedVersion)
        .map(
          (v) =>
            `kubernetes.${catalog.flavor} ${v.version}: verified with ${v.verifiedWithProvider}, provider is ${provider.recommendedVersion}`,
        );
    });
    expect(stale).toEqual([]);
    expect(distributionCatalog('kubeadm')!.versions.length).toBeGreaterThan(0);
  });
});
