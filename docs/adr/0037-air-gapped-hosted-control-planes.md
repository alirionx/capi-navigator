# ADR-0037: Air-gapped hosted control planes

- Status: accepted
- Date: 2026-11-04
- Pack: FP-24 (FP24-F-14), FP-29
- Refines: ADR-0030 (air-gapped nodes), ADR-0034 (hosted control planes)

## Context

ADR-0034 left hosted control planes out of air-gapped setups. The parts are there: tenant workers
are k0s nodes and take the air-gap setup of k0s (pinned binary, containerd mirrors), and a host is
an ordinary workload cluster that can run air-gapped itself. What is new are the pods of the
tenant's control plane in the host. In k0smotron v2.3.1 (sources checked) they pull
`quay.io/k0sproject/k0s:<version>` (controller and the `dns-check` init container of etcd) and
`quay.io/k0sproject/etcd:v3.7.1`; monitoring, the etcd defragmentation job and the HAProxy ingress
would pull more but are off by default and not used by the app. For an existing StatefulSet
k0smotron keeps the init image, so the k0s image of the version a tenant was created with stays
in use after upgrades.

## Decision

- **An air-gapped tenant needs an air-gapped host with the same internal registry**: host, mirror
  paths, artifacts path and CA must match. The images of control plane and workers then come from
  one registry, and one list per cluster says what it must hold. The preview blocks otherwise. A
  host without internet may serve tenants with internet; mixed cases with two registries stay out
  until someone needs them.
- **The images of the control plane are pinned** in `K0smotronControlPlane` (`spec.image` without
  tag, k0smotron appends it; `storage.etcd.image` from `versions.yaml`), for every hosted cluster,
  not only air-gapped ones. The YAML and the image list then do not depend on the CRD defaults of
  the installed k0smotron. The etcd version follows k0smotron's default on updates; its webhook
  refuses to skip an etcd minor version.
- **The registry contents of a host** list, per tenant, the k0s image of its version, the etcd
  image and the images its control plane pods run now (read from the host, read-only). The
  registry contents of a tenant point to its host. The preview of a tenant on an air-gapped host
  names the images and, on an upgrade, that the earlier k0s image stays needed.
- The wizard keeps hosted mode for air-gapped clusters and lists only air-gapped hosts with the
  same registry host; the preview checks the remaining fields.

## Consequences

- The existing hosted clusters get `image` and `storage.etcd.image` with the values k0smotron
  defaulted them to, so applying the new YAML changes nothing in the host.
- Hosts with tenants of many versions keep several k0s images; a cleanup in the registry has to
  follow the list of the host, not only the current versions.
- Air-gapped AWS clusters remain untested (AWS is no target of FP-29); a test setup is planned.
