# ADR-0044: Encrypted backup of the home cluster

- Status: accepted
- Date: 2026-11-27
- Pack: FP-38, refines hard rule 8

## Context

A backup of the home cluster must contain every credential of the app: the kubeconfigs and tokens
of the management clusters, the password hashes, the OIDC client secret, the Helm repository
credentials and the session key. Hard rule 8 says credentials never appear in API responses or the
frontend. A backup that cannot leave the backend is of no use.

## Decision

- The backup leaves the backend only encrypted with OpenPGP to the public keys of its recipients,
  stored in `NavigatorBackupSettings` `default`. The app never holds a private key and cannot read
  a backup it made. Each recipient can decrypt alone.
- Only public keys that can encrypt are accepted (not revoked, not expired, with an encryption
  subkey); private keys are refused before anything is stored.
- The archive is built and encrypted in memory, never written to disk. It is buffered instead of
  streamed, so an error ends in an error response and the audit log records only finished backups.
  The size is small (kilobytes to a few megabytes, most of it audit events).
- The content is selected by name, not by "every Secret in the namespace": the Secret names follow
  from the app's own resources (connections, users, Helm repositories) plus the session key and the
  OIDC client secret. The initial admin password, Leases and the chart's objects are left out.
- The files are cleaned for `kubectl apply --server-side` (no namespace, status, uid,
  resourceVersion, creationTimestamp, managedFields, last-applied annotation). Restoring needs gpg
  and kubectl, not the app; `RESTORE.md` in the archive says how.
- `backup.manage` is a platform permission; the built-in admin has it. Whoever may change the keys
  can read every later backup, so API tokens may download backups but not change the keys (as
  FP22-F-05 keeps tokens away from users and roles). Every backup writes an `AuditEvent` with the
  number of objects and the key fingerprints.

## Consequences

- The backup page can show what a backup contains (counts by kind) but never its content.
- A lost private key means lost backups; the page asks for keys of the people allowed to restore.
- Not restored: status (connections show "Unknown" until tested), creation dates, the initial
  admin password. Sessions stay valid, because the session key is restored.
- A restore into another namespace works: the files name none.
- Verified on 2026-11-27: a backup of the development app (1115 objects) restored into a new kind
  cluster; a second backend against it signed in the admin with the old password, refused a wrong
  one, accepted an existing API token, and reached the connection after a test. No initial admin
  password was created.
