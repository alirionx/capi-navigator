// Writes the CRD manifests to deploy/crds and the Helm chart (STATE-02).
// Usage: pnpm crds:generate
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_CRDS } from './index.js';
import { crdFileName, renderCrd } from './render.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const targets = [join(root, 'deploy/crds'), join(root, 'deploy/helm/capi-navigator/crds')];

for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  for (const def of ALL_CRDS) {
    const file = join(dir, crdFileName(def));
    writeFileSync(file, renderCrd(def));
    console.log(`wrote ${file.slice(root.length + 1)}`);
  }
}
