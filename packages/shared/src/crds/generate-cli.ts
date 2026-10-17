// Writes generated manifests: CRDs to deploy/crds and the Helm chart (STATE-02), and the
// management cluster access manifests (FP2-F-07, NF-03).
// Usage: pnpm crds:generate
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCESS_MANIFEST_FILES } from '../manifest-files.js';
import { ALL_CRDS } from './index.js';
import { crdFileName, renderCrd } from './render.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function write(relPath: string, content: string): void {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`wrote ${relPath}`);
}

for (const dir of ['deploy/crds', 'deploy/helm/capi-navigator/crds']) {
  for (const def of ALL_CRDS) write(join(dir, crdFileName(def)), renderCrd(def));
}
for (const [path, content] of Object.entries(ACCESS_MANIFEST_FILES)) write(path, content);
