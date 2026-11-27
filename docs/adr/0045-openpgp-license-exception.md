# ADR-0045: openpgp.js as named license exception

- Status: accepted
- Date: 2026-11-27
- Pack: FP-38

## Context

Backups are encrypted with OpenPGP (ADR-0044), so recipients decrypt them with `gpg -d`. The
license gate in `scripts/third-party-notices.mjs` allows only permissive licenses. The established
OpenPGP library for Node.js, openpgp.js (maintained by Proton), is licensed under LGPL-3.0+.
Alternatives considered:

- kbpgp (BSD-3-Clause): old cryptography, hardly maintained.
- The `gpg` binary in the image: a subprocess, a writable home directory despite
  `readOnlyRootFilesystem` (an extra `emptyDir`), about 10 MB more image, gpg in CI and tests.
- age instead of OpenPGP (BSD-3-Clause): existing GPG keys of the users would not work.

## Decision

- openpgp.js is allowed as a named exception in the license gate: package `openpgp` with license
  `LGPL-3.0+` exactly; every other LGPL package is still refused.
- It is used unmodified from `node_modules`, so the LGPL-3.0 allows shipping it with the
  Apache-2.0 app: the third-party notices carry its license and, because the LGPL-3.0 adds to the
  GPL-3.0, the GPL-3.0 text (`scripts/licenses/GPL-3.0.txt`).
- tar-stream (MIT) writes the archive; it was already in the image through
  `@kubernetes/client-node`, so no new package came with it.

## Consequences

- One copyleft dependency in the image, visible in the gate and the notices.
- Replacing openpgp.js later (e.g. with a permissive OpenPGP library) changes only
  `apps/backend/src/backup/backup-keys.ts`.
