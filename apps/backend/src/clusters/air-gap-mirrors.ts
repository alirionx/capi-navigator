import type { InternalRegistry, RegistryImage } from '@capi-navigator/shared';
import { ChartSource, type RepoAccess } from '../helm/chart-source.js';
import { FetchError } from '../helm/fetch.js';

/** Splits `host/repository:tag` or `host/repository@digest` into its repository and reference. */
export function splitImage(ref: string): { repository: string; reference: string } {
  const path = ref.slice(ref.indexOf('/') + 1);
  const at = path.indexOf('@');
  if (at >= 0) return { repository: path.slice(0, at), reference: path.slice(at + 1) };
  const colon = path.lastIndexOf(':');
  return colon > path.lastIndexOf('/')
    ? { repository: path.slice(0, colon), reference: path.slice(colon + 1) }
    : { repository: path, reference: 'latest' };
}

const upstreamOf = (image: string) => image.split('/')[0]!;

/**
 * FP29-F-21: checks, before an air-gapped cluster is created, that the nodes can pull through each
 * mirror of the internal registry the cluster uses: one of its images per upstream, anonymously as
 * the nodes pull. A refused or missing image is a warning (the app's network may differ from the
 * nodes'); a registry the app cannot reach gives one hint, since the nodes may still reach it.
 */
export async function mirrorWarnings(
  registry: InternalRegistry,
  images: RegistryImage[],
  source: Pick<ChartSource, 'ociImageManifest'> = new ChartSource(),
): Promise<string[]> {
  const repo: RepoAccess = {
    type: 'oci',
    url: `oci://${registry.host}`,
    ...(registry.caCert ? { ca: registry.caCert } : {}),
  };
  const byUpstream = new Map<string, RegistryImage[]>();
  for (const image of images) {
    if (!image.target) continue;
    const upstream = upstreamOf(image.source);
    byUpstream.set(upstream, [...(byUpstream.get(upstream) ?? []), image]);
  }
  const results = await Promise.all(
    [...byUpstream].map(async ([upstream, list]) => {
      const probe = list[0]!;
      const { repository, reference } = splitImage(probe.target!);
      try {
        await source.ociImageManifest(repo, repository, reference);
        return undefined;
      } catch (err) {
        return { upstream, count: list.length, probe, err };
      }
    }),
  );
  const warnings: string[] = [];
  let unreachable: string | undefined;
  for (const r of results) {
    if (!r) continue;
    const mirror = registry.mirrors.find((m) => m.upstream === r.upstream);
    const where = `${registry.host}/${mirror?.path ? `${mirror.path}/` : ''}`;
    const status = r.err instanceof FetchError ? r.err.status : undefined;
    const others = r.count > 1 ? ` and ${r.count - 1} more image(s) from ${r.upstream}` : '';
    if (status === 401 || status === 403) {
      warnings.push(
        `The internal registry refuses anonymous pulls of ${r.probe.target} (HTTP ${status}); the nodes pull without credentials, so ${r.probe.source}${others} will not arrive. Make the project behind ${where} public, or correct the path for ${r.upstream} in the registry settings of the connection.`,
      );
    } else if (status === 404) {
      warnings.push(
        `${r.probe.target} is not in the internal registry; the nodes cannot pull ${r.probe.source}${others}. Mirror the images listed under "Registry contents", or, for a proxy cache, check that the project behind ${where} points to ${r.upstream}.`,
      );
    } else {
      unreachable ??= r.err instanceof Error ? r.err.message : String(r.err);
    }
  }
  if (unreachable) {
    warnings.push(
      `The app could not check the mirrors of the internal registry ${registry.host} (${unreachable}). The nodes may still reach it; if the app should, add the host to NO_PROXY or set the registry's CA certificate.`,
    );
  }
  return warnings;
}
