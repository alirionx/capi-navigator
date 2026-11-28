# ADR-0047: Backup of the management clusters, restored with `clusterctl move`

- Status: proposed
- Date: 2026-11-28
- Pack: FP-39, refines the outlook entry FP-39

## Context

FP-38 backs up the app's own state in the home cluster. The workload clusters are managed from the
management clusters: their CAPI objects, the CA Secrets CAPI generated, the credentials and the
add-ons live there. If a management cluster is lost, the workload clusters keep running, but
without the CA Secrets a recreated cluster gets new CAs and cannot manage them anymore.

Upstream offers `clusterctl move`, with `--to-directory` and `--from-directory` for files. A spike
on 2026-11-28 checked the code of clusterctl v1.14.4 and tried it on kind with CAPD (kubeadm,
CAAPH, ClusterResourceSet):

- `--to-directory` writes one JSON file per object, including `uid`, owner references and status.
  It pauses the source Clusters while it reads and leaves them paused if writing fails. It reads
  one namespace per run.
- `--from-directory` reads every file of a directory as YAML, rebuilds the object graph from
  `metadata.uid` and `ownerReferences`, creates namespaces, creates the objects in order with new
  owner references, skips objects that exist, and unpauses the Clusters at the end. It never
  restores status. `--dry-run` is ignored in this mode.
- Restored into a new management cluster, the workload cluster was adopted: the same machines
  and containers, the same CA fingerprints, status rebuilt by the controllers, the Helm release of
  CAAPH not reinstalled. Scaling afterwards worked with the restored CAs. The same held for files
  written by our own writer in the app's style (YAML, one file, no status, the source not paused).
- clusterctl selects objects through the CRD label `clusterctl.cluster.x-k8s.io` and the owner
  chain. It misses the app's credential Secrets (no owner) and, under the CAPI Operator, Secrets in
  provider namespaces, because the operator keeps no clusterctl inventory. The CRDs of cert-manager
  carry the label too, so reading all namespaces would collect webhook certificates of the
  providers.
- The upstream documentation says `move` was "not designed for being used as a backup/restore
  solution" and removed the former `backup` and `restore` commands.
- k0smotron v2.3.1 keeps the etcd of a hosted control plane in a PVC and offers no backup for it.

## Decision

- **The app writes the backup itself** and restores nothing. It reads through the Kubernetes API
  with the connection's permissions, runs no `clusterctl` binary and pauses nothing. Restoring is
  done by a person with `clusterctl move --from-directory`, guided by `RESTORE.md` in the archive,
  as FP-38 is restored with `gpg`, `helm` and `kubectl`. We use `--from-directory` knowingly
  despite the upstream note: it does the hard parts (order, owner references, namespaces,
  unpausing), it is upstream, and the restore works without CAPI Navigator (hard rule 7). The
  limits it brings are documented instead of worked around.
- **One archive per management cluster**, encrypted like FP-38 to the same recipient keys:
  `capi-navigator-mgmt-<connection>-<UTC time>.tar.gz.gpg`. A management cluster that cannot be
  reached does not affect the others.
- **Content**, selected by a pure function from what the API returns:
  - all objects of CRDs labelled `clusterctl.cluster.x-k8s.io` (storage version) in the workload
    namespaces, that is namespaces holding a Cluster, ClusterClass, ClusterResourceSet or an object
    of a `move-hierarchy` type; cluster-scoped `move-hierarchy` objects such as identities;
  - Secrets and ConfigMaps of those namespaces that an included object owns, that carry a CAPI
    name (`<cluster>-kubeconfig`, `-ca`, `-etcd`, `-sa`, `-proxy`, `-apiserver-etcd-client`), or that
    the app created; the app's own ones get the label `clusterctl.cluster.x-k8s.io/move`, so
    clusterctl restores them although nothing owns them;
  - a separate provider part, applied with `kubectl apply --server-side` before `clusterctl` runs:
    the provider namespaces, the CAPI Operator provider resources with their configuration Secrets,
    the CA bundle and proxy CA Secrets, the credential Secrets (`capi-navigator-credential-<name>`,
    which live in the namespace of the infrastructure provider, e.g. `capa-system`), and the
    cluster-scoped identities (`OpenStackClusterIdentity`, `AWSClusterStaticIdentity`). This part
    is cleaned like the FP-38 archive (no `uid`, owner references or status), because clusterctl
    does not see these objects: the CAPI Operator keeps no clusterctl inventory.
  - The identities also go into the CAPI part, so that clusterctl finds every owner of the graph;
    as they exist by then, clusterctl skips them and takes their new `uid`.
  - Not in the backup: cert-manager, the CAPI Operator and ORC (the app only detects or applies
    them; the archive names their versions), the connection's access objects
    (`capi-navigator-access`, which a new management cluster gets anew), node shell pods, Events.
- **Format of the CAPI part:** YAML, one file per namespace plus one for cluster-scoped objects, in
  a folder that holds nothing else (clusterctl reads every file). `uid` and `ownerReferences` stay,
  because clusterctl builds the graph from them. `managedFields`, `resourceVersion`, `generation`,
  `creationTimestamp` and `status` are removed. Every Cluster gets `spec.paused: true` in the file,
  so nothing reconciles before the restore is complete.
- **Status is not backed up.** This corrects the outlook entry, which asked for it: clusterctl
  cannot restore it, and providers that support `move` rebuild it by contract.
- **Clusters with a hosted control plane are left out completely**, with every object of their
  hierarchy. The bootstrap flavor plugin names the control plane kinds that are hosted
  (`K0smotronControlPlane`, hard rule 10); the app's label `capi-navigator.io/hosted-on` marks
  them too. Without the etcd in the PVC such a cluster cannot be restored, and a half restore
  would create an empty control plane. Preview, archive and run list them by name.
- **No pause, but a warning:** clusters in the middle of a change (not provisioned, a machine
  without node, an object being deleted) are backed up as they are and listed as warnings, so a
  scheduled run never stops. clusterctl's own export would refuse them.
- **Schedule:** the FP-38 settings are reused: the same keys, S3 target, schedule and retention. The
  settings list the connections to include. A run backs up the home cluster and each listed
  management cluster; S3 objects go to `<prefix>mgmt/<connection>/`, the retention applies per
  folder, and a failing connection is recorded without stopping the others.
- **Permissions:** the backup reads Secrets and ConfigMaps and lists every selected kind with the
  connection's permissions. The minimal ClusterRole of the access manifests (NF-03) can already read
  Secrets and ConfigMaps; it gets read access to the further API groups whose CRDs carry the
  clusterctl label (`ipam.cluster.x-k8s.io`, `runtime.cluster.x-k8s.io`, `k0smotron.io`,
  `openstack.k-orc.cloud`). A kind the
  connection cannot read is named in the preview, and the backup of that connection is refused:
  a backup without some objects could lose whole parts of the graph on restore.

## Consequences

- No new tool in the image, no shell calls; the transformation is a pure function with snapshot
  tests like every other one.
- A restore needs a person with `clusterctl` of the matching CAPI minor version, the providers
  installed first, and an empty target. Afterwards the app's connection must point to the new
  management cluster (new kubeconfig or token); an in-cluster connection of an all-in-one
  installation needs nothing. The old management cluster must be gone or its clusters
  paused; otherwise two sets of controllers manage the same machines. `RESTORE.md` says so.
- Status is rebuilt by the controllers after the restore. For providers that keep important data
  only in status, this is verified live per provider before the pack is done.
- Hosted control planes stay without backup; an etcd snapshot is an outlook item.
- The backup contains every credential the app placed in the management cluster; it is protected
  only by the encryption, as in FP-38.
