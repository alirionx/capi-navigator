/**
 * FP29-F-11, ADR-0032: air-gapped kubeadm nodes need a Cluster API image of exactly the cluster's
 * version. The app cannot look into an image, so it checks the name: Image Builder, osism and
 * capi-navigator-images put the version into it (`ubuntu-2404-kube-v1.36.5`, Proxmox VE templates
 * `debian-13-kube-v1-36-5`). A name without the version gets a warning, not a refusal.
 */
export function imageNameMatchesVersion(name: string, version: string): boolean {
  const [major, minor, patch] = version.replace(/^v/, '').split(/[.+]/);
  if (!major || !minor || !patch) return false;
  return new RegExp(`(^|[^0-9])${major}[._-]${minor}[._-]${patch}($|[^0-9])`).test(name);
}
