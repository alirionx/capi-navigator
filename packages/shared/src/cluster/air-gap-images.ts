import type { InternalRegistry } from '../connections.js';
import { REBOOT_DAEMON_LABEL, presetsFor, type AddonPresetOverrides } from './addons.js';
import { artifactPushCommands, artifactRepository, type AirGapArtifact } from './air-gap.js';
import { AIR_GAP_IMAGES } from './air-gap-images.generated.js';
import { KUBE_VIP_IMAGE } from './kube-vip.js';
import type { BootstrapFlavorPlugin, InfraTransformPlugin } from './plugins.js';
import type { ClusterSpec } from './spec.js';
import type { RegistryContentsView } from './api.js';
import { FLAVOR_PLUGINS, INFRA_PLUGINS } from './transform.js';

/**
 * FP29-F-17: what the internal registry must hold for an air-gapped cluster: the binaries of its
 * versions, the images of the distribution and of the add-ons the app rolls out. The image lists
 * are generated from versions.yaml by `pnpm airgap:images` (no lookups at runtime).
 */

/** Fully qualified image name: docker.io and library/ made explicit, as containerd does. */
export function normalizeImage(ref: string): string {
  const [first, ...rest] = ref.split('/');
  if (rest.length > 0 && (first!.includes('.') || first!.includes(':') || first === 'localhost'))
    return ref;
  return rest.length === 0 ? `docker.io/library/${ref}` : `docker.io/${ref}`;
}

/** Images in rendered manifests (`image:` fields), sorted and without duplicates. */
export function imagesInManifests(yaml: string): string[] {
  const found = [...yaml.matchAll(/^\s*(?:-\s+)?image:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm)].map(
    (m) => normalizeImage(m[1]!),
  );
  return [...new Set(found)].sort();
}

export interface RegistryImage {
  source: string;
  /** Name in the internal registry; unset when its upstream registry is not mirrored. */
  target?: string;
  /** Why the cluster needs it, e.g. "RKE2 v1.35.9+rke2r1" or a preset's name. */
  usedBy: string;
}

export interface RegistryContents {
  artifacts: { artifact: AirGapArtifact; commands: string }[];
  images: RegistryImage[];
  /** Add-ons whose images are not known, e.g. a preset changed to another chart version. */
  unknown: string[];
}

/** The internal registry's name of an upstream image, through the mirror of its registry. */
export function mirroredImage(registry: InternalRegistry, image: string): string | undefined {
  const [upstream, ...repo] = image.split('/');
  const mirror = registry.mirrors.find((m) => m.upstream === upstream);
  if (!mirror) return undefined;
  return `${registry.host}/${mirror.path ? `${mirror.path}/` : ''}${repo.join('/')}`;
}

/** Everything an air-gapped cluster pulls from the internal registry (FP29-F-17). */
export function registryContents(
  spec: ClusterSpec,
  flavor: BootstrapFlavorPlugin,
  infra: InfraTransformPlugin,
  overrides: AddonPresetOverrides = {},
): RegistryContents {
  const registry = spec.airGapped?.registry;
  if (!registry || !flavor.airGap) return { artifacts: [], images: [], unknown: [] };
  const versions = [
    ...new Set([spec.kubernetes.version, spec.kubernetes.workerVersion].filter((v) => !!v)),
  ] as string[];
  const unknown: string[] = [];
  const wanted: { image: string; usedBy: string }[] = [];
  const lists = AIR_GAP_IMAGES.distributions as Record<string, Record<string, readonly string[]>>;
  for (const v of versions) {
    const list = lists[spec.kubernetes.flavor]?.[v];
    if (list)
      wanted.push(...list.map((image) => ({ image, usedBy: `${flavor.displayName} ${v}` })));
    else unknown.push(`${flavor.displayName} ${v}`);
  }
  if (infra.apiVip?.(spec.infrastructure))
    wanted.push({ image: normalizeImage(KUBE_VIP_IMAGE), usedBy: 'kube-vip (API address)' });
  const labels = {
    ...infra.addonLabels(spec),
    ...(spec.addons.rebootDaemon ? Object.fromEntries([REBOOT_DAEMON_LABEL]) : {}),
  };
  const presets = AIR_GAP_IMAGES.presets as Record<
    string,
    { version: string; images: readonly string[] }
  >;
  for (const preset of presetsFor(labels, overrides)) {
    const known = presets[preset.id];
    if (known && known.version === preset.version)
      wanted.push(...known.images.map((image) => ({ image, usedBy: preset.displayName })));
    else unknown.push(`${preset.displayName} ${preset.version}`);
  }
  const seen = new Set<string>();
  const images = wanted
    .filter(({ image }) => !seen.has(image) && !!seen.add(image))
    .map(({ image, usedBy }) => {
      const target = mirroredImage(registry, image);
      return { source: image, ...(target ? { target } : {}), usedBy };
    });
  return {
    // ADR-0032: kubeadm has no artifacts, its binaries are in the Cluster API image.
    artifacts: flavor.airGap.artifact
      ? versions.map((v) => {
          const artifact = flavor.airGap!.artifact!(v);
          return { artifact, commands: artifactPushCommands(registry, artifact) };
        })
      : [],
    images,
    unknown,
  };
}

/**
 * `skopeo copy` per image for a machine with internet access (FP29-F-17): the linux/amd64 image
 * the nodes run, whatever the machine is; images pinned by digest with all platforms, since only
 * the unchanged index keeps that digest.
 */
export function imageCopyCommands(images: RegistryImage[]): string {
  return images
    .filter((i) => i.target)
    .map((i) =>
      i.source.includes('@')
        ? `skopeo copy --all docker://${i.source} docker://${i.target}`
        : `skopeo copy --override-os linux --override-arch amd64 docker://${i.source} docker://${i.target}`,
    )
    .join('\n');
}

/** The registry contents of a cluster as the API returns them (FP29-F-17). */
export function registryContentsView(
  spec: ClusterSpec,
  overrides: AddonPresetOverrides = {},
): RegistryContentsView | undefined {
  const flavor = FLAVOR_PLUGINS[spec.kubernetes.flavor];
  const registry = spec.airGapped?.registry;
  if (!registry || !flavor?.airGap) return undefined;
  const c = registryContents(spec, flavor, INFRA_PLUGINS[spec.infrastructure.provider], overrides);
  return {
    artifacts: c.artifacts.map(({ artifact, commands }) => ({
      reference: `${registry.host}/${artifactRepository(registry, artifact)}:${artifact.tag}`,
      commands,
    })),
    images: c.images,
    imageCommands: imageCopyCommands(c.images),
    unknown: c.unknown,
  };
}
