# ADR-0030: Air-gapped nodes from an internal OCI registry

- Status: accepted
- Date: 2026-10-28
- Pack: FP-29 (part B)
- Refines: the artifact bundles of the earlier FP-29 outlook, FP-5 and FP-9 (RKE2 and k0s
  bootstrap), FP-31 (node preparation on Proxmox VE)

## Context

Nodes of air-gapped workload clusters reach no internet. They still need two things that normally
come from it: the container images (distribution, CNI, CCM, CSI, kube-vip, users' workloads) and
the binaries of the distribution (RKE2 tarball and install script, the k0s binary). The earlier
outlook planned bundles built and published by the project. That means a build pipeline, storage
and a second distribution channel to maintain, for a feature most users will not use.

What the node spike (2026-10-26 to 2026-10-28, Proxmox VE, Harbor as registry) showed:

- Both RKE2 and containerd in k0s can redirect every upstream registry to an internal one through
  their mirror configuration; image names stay unchanged, so manifests, Helm values and users'
  workloads need no change.
- `oras push` of files without a path gives one layer per file whose digest is the sha256 of the
  file, so a node can fetch a binary by digest and verify it with tools it already has.
- Registries such as Harbor answer anonymous pulls with `401` and a bearer challenge, even for
  public projects. k0smotron's `downloadURL` and its autopilot updates use a plain GET and fail
  there.
- RKE2 provider v0.27.0 has `airGapped` (install from local files) but its `airGappedChecksum`
  renders invalid YAML (rancher/cluster-api-provider-rke2#1128).
- On Proxmox VE, CAPMOX needs the QEMU guest agent, which the app otherwise installs on first boot.

## Decision

- **One internal OCI registry for images and binaries**, configured per management cluster
  connection (host, CA, a path per upstream registry, the path of the binary artifacts), without
  registry credentials at first. No HTTP server, no S3, no bundles of the project: the app shows
  the upstream download and `oras push` / `skopeo copy` commands, the user copies.
- **Images through the runtime's mirror configuration**: RKE2 `privateRegistriesConfig.mirrors`
  with `rewrite`, k0s a containerd drop-in plus one `hosts.toml` per upstream registry with
  `override_path`, in the format of the containerd the k0s version brings (containerd 2 from k0s
  1.36 on).
- **Binaries as OCI artifacts, pinned by layer digest.** The preview resolves the artifact of each
  version in the registry and stores the digests in the cluster spec; a missing artifact is a
  blocker with the push commands. Nodes fetch the blobs with a small Python script (anonymous
  token, retries, sha256 check) and stop the installation on any failure. RKE2 installs with
  `airGapped: true` from the fetched files (no `airGappedChecksum`), k0s with `preInstalledK0s`.
- **The registry settings are copied into the cluster spec**, so the transformation stays pure and
  a later change of the connection does not change existing clusters.
- **Upgrades replace machines** for both distributions, so new nodes fetch the new binary like at
  creation (k0s in-place upgrades through autopilot cannot reach the registry, ADR-0013).
- **Preparation that needs the internet is left out**; the wizard names what the image or template
  must contain instead (QEMU guest agent on Proxmox VE, `kernel-modules-extra` on RHEL 10).
- **The image lists are generated** from `versions.yaml` (`pnpm airgap:images`), not looked up at
  runtime, so the app shows per cluster what the registry must hold without internet access.
- **kubeadm is left out**: it installs from distribution packages, which would need a package
  mirror.

## Consequences

- The registry must allow anonymous pulls; registry credentials on nodes are a later extension.
- The user mirrors images and pushes binaries; a pull-through cache that reaches the internet
  fills itself, a registry without one needs the full list the app shows. Image lists must be
  regenerated after version or preset changes (maintenance checklist).
- Clusters pin their binaries: a changed tag in the registry affects only the next change that
  resolves it again, never running nodes.
- Templates of air-gapped clusters on Proxmox VE need the guest agent baked in.
- NTP servers for air-gapped nodes (FP29-F-18) are postponed; nodes use the time servers of their
  image or DHCP.
