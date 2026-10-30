import type { Credential } from '@capi-navigator/shared';

/**
 * UX-08: where a cluster runs, from its credentials entry: "infomaniak · dc4-a" (OpenStack: the
 * credential's region), "aws · eu-central-1" (AWS, Google Cloud: the spec's region), "pve · node1"
 * (Proxmox VE: the node). Without access to the credentials only the name and the spec's location.
 */
export function infraLocation(
  c: { provider?: string; credential?: string; location?: string },
  credentials: readonly Credential[],
): string | undefined {
  if (!c.credential) return undefined;
  const cred = credentials.find((x) => x.provider === c.provider && x.name === c.credential);
  const where = c.location ?? cred?.summary.region ?? cred?.summary.projectId;
  return where ? `${c.credential} · ${where}` : c.credential;
}
