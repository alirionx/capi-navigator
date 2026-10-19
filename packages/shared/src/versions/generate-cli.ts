// Writes the generated versions module and script variables (FP20-F-02). Run with
// `pnpm versions:generate`.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseVersionsFile, renderScriptEnv, renderVersionsModule } from './generate.js';

const root = new URL('../../../../', import.meta.url);
const versions = parseVersionsFile(readFileSync(new URL('versions.yaml', root), 'utf8'));
const targets: [URL, string][] = [
  [new URL('packages/shared/src/versions.generated.ts', root), renderVersionsModule(versions)],
  [new URL('scripts/versions.generated.env', root), renderScriptEnv(versions)],
];
for (const [target, content] of targets) {
  writeFileSync(target, content);
  console.log(`wrote ${target.pathname}`);
}
