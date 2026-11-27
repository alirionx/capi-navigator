# Backup of the home cluster

CAPI Navigator keeps all its data in the home cluster (no database). The backup page saves this
data as one encrypted file and restores it into a new home cluster, for example after losing the
cluster or when moving the app (FP-38,
[ADR-0044](adr/0044-encrypted-backup-download.md)).

## What a backup contains

- Users, password hashes, roles, OIDC group mappings and the OIDC settings with their client
  secret.
- API tokens (as hashes; the tokens themselves keep working after a restore).
- Connections to management clusters with their kubeconfigs or tokens.
- Helm repositories with their credentials, cluster blueprints, the preset overrides.
- The session key (signed-in people stay signed in) and the backup settings.
- The audit log, unless switched off on the backup page.

Not in it: the management clusters themselves. Providers, cloud credentials, workload clusters and
add-ons live there and need a backup of their own (outlook FP-39). Also not in it: the initial
admin password, Leases and what the Helm chart installs.

## Set up the keys

Every backup is encrypted with OpenPGP to the public keys on the backup page. Each recipient can
decrypt it alone; the app cannot. Use keys of the people allowed to restore the app, and keep the
private keys away from the cluster.

```sh
# A key without expiry for backups (or reuse an existing one).
gpg --quick-gen-key "Ops Backup <ops@example.com>" future-default default never
# Paste the output on the backup page.
gpg --armor --export ops@example.com
```

Only public keys that can encrypt are accepted. Keys that expire within 30 days are marked; an
expired key blocks backups until it is replaced. API tokens can download backups but cannot change
the keys. Every backup is recorded in the audit log.

## Download and check a backup

On the backup page, **Download backup** saves `capi-navigator-home-<UTC time>.tar.gz.gpg`. Check it:

```sh
gpg -d capi-navigator-home-20261127T101500Z.tar.gz.gpg | tar tz
```

The archive holds `manifest.json` (app version, namespace, number of objects and SHA-256 per
file), `RESTORE.md` and the resources in `resources/`, numbered in restore order. The decrypted
files contain the credentials in plain text: decrypt only when you need to.

## Restore

`RESTORE.md` in the archive has the commands with the namespace filled in. In short:

1. Install the chart of the same version (or a newer one with the same CRD version `v1alpha1`)
   into the new home cluster with `--set replicaCount=0`, so the backend does not create an initial
   admin before the restore.
2. Decrypt and apply:

   ```sh
   mkdir restore && gpg -d <file>.tar.gz.gpg | tar xz -C restore
   kubectl apply --server-side -n <namespace> -f restore/resources/
   rm -rf restore
   ```

3. Scale the backend up (`helm upgrade … --reuse-values --set replicaCount=1`).
4. Test each connection on the Connections page once; their status is not part of the backup.

Creation dates show the time of the restore. A connection of type "in-cluster" points to the
cluster the app now runs in.
