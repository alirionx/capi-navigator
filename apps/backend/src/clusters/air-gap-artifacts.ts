import {
  artifactPushCommands,
  artifactRepository,
  FLAVOR_PLUGINS,
  type ArtifactPin,
  type ClusterSpec,
  type MissingArtifact,
} from '@capi-navigator/shared';
import { ChartSource, type RepoAccess } from '../helm/chart-source.js';
import { FetchError } from '../helm/fetch.js';

export interface PinnedArtifacts {
  /** The spec with the artifacts of its versions pinned. */
  spec: ClusterSpec;
  blockers: string[];
  missing: MissingArtifact[];
  /** All artifacts are pinned: the transformation can run. */
  ready: boolean;
}

/**
 * FP29-F-12, FP29-F-16: pins the artifacts of the versions an air-gapped cluster runs (the control
 * plane's and, during an upgrade, the workers') by their layer digests in the internal registry.
 * Pins already in the spec are kept, so the same spec gives the same manifests; versions no longer
 * in use are dropped. Missing artifacts are blockers with the commands that push them.
 */
export async function pinArtifacts(
  spec: ClusterSpec,
  source: Pick<ChartSource, 'ociLayers'> = new ChartSource(),
): Promise<PinnedArtifacts> {
  const airGapped = spec.airGapped;
  if (!airGapped) return { spec, blockers: [], missing: [], ready: true };
  const flavor = FLAVOR_PLUGINS[spec.kubernetes.flavor];
  if (!flavor?.airGap) {
    return {
      spec,
      blockers: [
        `${flavor?.displayName ?? spec.kubernetes.flavor} cannot be installed air-gapped; choose RKE2 or k0s, or switch air-gapped off.`,
      ],
      missing: [],
      ready: false,
    };
  }
  const { registry } = airGapped;
  const repo: RepoAccess = {
    type: 'oci',
    url: `oci://${registry.host}`,
    ...(registry.caCert ? { ca: registry.caCert } : {}),
  };
  const versions = [
    ...new Set([spec.kubernetes.version, spec.kubernetes.workerVersion].filter((v) => !!v)),
  ] as string[];
  const pins: ArtifactPin[] = [];
  const blockers: string[] = [];
  const missing: MissingArtifact[] = [];
  for (const version of versions) {
    const kept = airGapped.artifacts.find((a) => a.version === version);
    if (kept) {
      pins.push(kept);
      continue;
    }
    const artifact = flavor.airGap.artifact(version);
    const repository = artifactRepository(registry, artifact);
    const reference = `${registry.host}/${repository}:${artifact.tag}`;
    let layers: Awaited<ReturnType<ChartSource['ociLayers']>>;
    try {
      layers = await source.ociLayers(repo, repository, artifact.tag);
    } catch (err) {
      if (err instanceof FetchError && err.status === 404) {
        missing.push({ reference, commands: artifactPushCommands(registry, artifact) });
        blockers.push(
          `Artifact ${reference} is missing in the internal registry; push it with the commands shown.`,
        );
      } else {
        blockers.push(
          `The internal registry ${registry.host} could not be read: ${err instanceof Error ? err.message : String(err)}. The app must reach it (add it to NO_PROXY if the app uses a proxy); a registry with a private CA needs its CA certificate in the connection's registry settings.`,
        );
      }
      continue;
    }
    const files: ArtifactPin['files'] = [];
    const absent: string[] = [];
    for (const f of artifact.files) {
      // oras sets the file name as title; a single file may have been pushed under another name.
      const layer =
        layers.find((l) => l.title === f.name) ??
        (artifact.files.length === 1 && layers.length === 1 ? layers[0] : undefined);
      if (layer && /^sha256:[a-f0-9]{64}$/.test(layer.digest))
        files.push({ name: f.name, digest: layer.digest });
      else absent.push(f.name);
    }
    if (absent.length > 0) {
      missing.push({ reference, commands: artifactPushCommands(registry, artifact) });
      blockers.push(
        `Artifact ${reference} lacks ${absent.join(', ')}; push it again with the commands shown.`,
      );
      continue;
    }
    pins.push({ version, repository, files });
  }
  return {
    spec: { ...spec, airGapped: { ...airGapped, artifacts: pins } },
    blockers,
    missing,
    ready: blockers.length === 0,
  };
}
