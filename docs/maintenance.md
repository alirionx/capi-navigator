# Maintenance: keeping versions current

CAPI Navigator pins every version it installs or offers. Updates are a deliberate, manual step:
nobody reviews bot pull requests daily, and an untested provider update can break clusters (see
[ADR-0013](adr/0013-k0s-control-plane-replacement.md)). This page describes how to find newer
versions, decide, change, verify and release them ([ADR-0018](adr/0018-versions-yaml-and-update-report.md)).

## Where versions live

| What                                                                                                                                                                     | Where                                              | How to change                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------- |
| App versions: providers, cert-manager, CAPI Operator, ORC, Kubernetes versions, preset charts, containerd, runc, Calico, node shell image; local test tools (Dex, socat) | [versions.yaml](../versions.yaml)                  | Edit, then `pnpm versions:generate`             |
| npm packages                                                                                                                                                             | the four `package.json` files and `pnpm-lock.yaml` | `pnpm up -r --latest <package>` (never by hand) |
| GitHub Actions                                                                                                                                                           | `.github/workflows/*.yaml`                         | Edit the `uses:` version                        |
| Node.js                                                                                                                                                                  | `.nvmrc` and the `FROM` lines of the `Dockerfile`  | Edit both together                              |
| Node scripts (kubeadm install)                                                                                                                                           | `packages/shared/src/cluster/templates/*.sh.tmpl`  | Edit, then `pnpm templates:generate`            |
| The app's own version                                                                                                                                                    | `deploy/helm/capi-navigator/Chart.yaml`            | Only for a release (README, "Releases")         |

Code comments such as "Field names verified against CAPO v0.15.0" record what an implementation was
checked against; they are documentation, not pins, but must be reviewed when that version changes.

## 1. Find newer versions

```sh
pnpm versions:report   # needs Docker; uses your gh login for GitHub lookups if present
pnpm outdated -r       # npm packages
```

`pnpm versions:report` writes [versions-report.md](versions-report.md): every entry of
`versions.yaml` with the newest version, the update type and where to change it, plus GitHub
Actions and Docker images. It only looks up versions; nothing else in the repository changes.
Updates released less than three days ago are marked: wait for them (first bug fixes).

Run it before every release and otherwise about once a month; commit the report.

## 2. Decide what to update

| Kind of update                                                                                 | Risk   | What it needs                                                                             |
| ---------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| Patch of npm packages, Actions, preset charts, containerd, runc, Kubernetes patch in a catalog | low    | tests (step 4)                                                                            |
| Minor of CAPI, a provider, the CAPI Operator, cert-manager, ORC, CCM/CSI charts, Calico        | medium | release notes, upgrade notes, CRD changes; tests, a dry run on kind and a short live test |
| Major of anything, a new Kubernetes minor                                                      | high   | the upstream upgrade guide, a plan and possibly an ADR before changing anything           |

Couplings to keep in mind (the tests check most of them):

- **CAPI** (`providers.cluster-api`) and the **kubeadm catalog**: every Kubernetes version must be
  verified with the pinned provider version (`verifiedWithProvider`); check the CAPI support matrix.
- **RKE2 provider** and the **RKE2 catalog**, **k0smotron** and the **k0s catalog**: same rule.
  k0smotron: read [ADR-0013](adr/0013-k0s-control-plane-replacement.md) first; re-test a
  three-node control plane rollout with every release until the fix #1705 is in.
- **CAPO** and **ORC**: `prerequisites.orc.byCapoMinor` needs the ORC version of the CAPO minor
  (the ORC module version in CAPO's `go.mod`).
- **openstack-ccm** and **openstack-csi** are released together; keep them on one version.
- **Calico** is a shipped file with a checksum (step 3).
- **npm caps** in [renovate.json](../renovate.json): Vuetify `<4`; `typescript` is an alias of
  `@typescript/typescript6` (`<7`) for typescript-eslint and vue-tsc, `tsc` comes from
  `@typescript/native` = TypeScript 7 (ADR-0001).
  `@types/node` follows the Node.js major in `.nvmrc`, not the newest release.

## 3. Change

- **versions.yaml**: set `version`, set `verified` to today, update `note` if a caveat changed,
  then `pnpm versions:generate`. For a provider, also raise `verifiedWithProvider` of the
  Kubernetes versions you checked again.
- **Kubernetes catalog**: a new patch replaces the entry of its minor. A new minor gets a new entry
  (`untested: true` until the provider tests it); move `default: true` only deliberately; drop the
  oldest minor when the provider stops supporting it.
- **Calico**: download `manifests/calico-vxlan.yaml` of the release to
  `apps/backend/assets/calico/calico-vxlan-<version>.yaml`, delete the old file, set `manifest` and
  `sha256` (`sha256sum <file>`). The resource name of the ClusterResourceSet changes with the
  content, so new clusters get the new manifest; existing clusters keep theirs.
- **npm**: `pnpm up -r --latest <package>`; for several non-major updates `pnpm up -r`.
- **CRD fields**: for a new provider or CAPI version, compare the CRDs and API versions the app
  generates with the release ("Verify, don't guess" in [CLAUDE.md](../CLAUDE.md)).
- **Changeable infrastructure fields** (FP-33): for an infrastructure provider update, check that
  its update webhook still accepts every form field marked `day2` in the plugin and that the
  controller acts on it; check also the rules the webhook does not enforce (the plugin's `check`,
  e.g. Proxmox node addresses). The preview's dry run catches a newly immutable field as an error,
  but not a change the controller ignores.

## 4. Verify

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage
```

- **Generated files**: `pnpm test` also checks that every generated file is current and names the
  command to run if not: `pnpm versions:generate` (`versions.generated.ts`, script variables),
  `pnpm templates:generate` (node script templates), `pnpm openapi:generate`
  (`docs/api/openapi.json`) and `pnpm crds:generate` (CRDs, access manifests). No extra check is
  needed.
- **Images of air-gapped clusters** (FP29-F-17): after a change of an RKE2, k0s or kubeadm version,
  of Calico or of a preset chart, run `pnpm airgap:images` (needs the internet and `helm`; downloads
  each k0s and kubeadm binary once into `~/.cache/capi-navigator`, kubeadm checked against its
  sha256). It rewrites `air-gap-images.generated.ts` from the release image lists,
  `k0s airgap list-images`, `kubeadm config images list` plus the Calico manifest (ADR-0032) and
  `helm template` of the presets; the tests name every version and preset without a list. Review the diff: new images must be mirrored by users.
  A release without assets is skipped with a warning; fix the catalog instead.
- **Snapshot tests**: if generated manifests change, review the diff line by line. Update the
  snapshots (`pnpm --filter @capi-navigator/shared exec vitest run -u`) only when every change is
  intended.
  A changed machine or bootstrap template gets a new name (template rotation): existing clusters
  keep running unchanged, but their next change in the app rolls these machines, and the preview
  shows it. Say so in the release notes.
- **Medium and high risk**: `pnpm test:int` on a fresh kind cluster (installs and upgrades the
  providers), then a short live test on a cloud: create a cluster, check CCM and CSI, delete it.
- **UI**: `pnpm test:e2e` for frontend dependency updates. The provider spec installs and removes
  all providers; it runs only with `E2E_PROVIDERS=1` on a management cluster without providers.

## 5. Finish

- Run `pnpm versions:report` again and commit it with the change.
- Write an ADR if an update changes behaviour or needs a workaround.
- Release as described in the README ("Releases"); if CRDs of the app changed, say so in the
  release notes.

## Checklist

- [ ] Report run, updates chosen (minimum release age respected)
- [ ] Release notes and upgrade guides read for minor and major updates
- [ ] `versions.yaml` changed and `pnpm versions:generate` run (or `pnpm up` for npm)
- [ ] Couplings checked; `verifiedWithProvider` and `verified` updated
- [ ] Infrastructure provider updated: fields marked `day2` still changeable (FP-33)
- [ ] lint, typecheck, tests, coverage green; snapshot diffs reviewed
- [ ] kind and live test for medium and high risk updates
- [ ] Report regenerated and committed
- [ ] `pnpm secrets:scan` clean before pushing
