import type { LookupOption } from '@capi-navigator/shared';

/**
 * FP7-F-12: a newer image of the same OS (same `os_distro` and `os_version`, later creation date)
 * than the one a group uses; undefined if none is known.
 */
export function newerImage(
  current: string | undefined,
  images: LookupOption[],
): LookupOption | undefined {
  if (!current) return undefined;
  const cur = images.find((i) => i.value === current);
  const d = cur?.details;
  if (!d?.os_distro || !d.created_at) return undefined;
  return images
    .filter(
      (i) =>
        i.value !== current &&
        i.details?.os_distro === d.os_distro &&
        i.details?.os_version === d.os_version &&
        String(i.details?.created_at ?? '') > String(d.created_at),
    )
    .sort((a, b) => String(b.details?.created_at).localeCompare(String(a.details?.created_at)))[0];
}
