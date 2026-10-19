// Writes the TypeScript modules of the node script templates (FP20-F-07). Run with
// `pnpm templates:generate`.
import { readFileSync, writeFileSync } from 'node:fs';
import { renderTemplateModule, TEMPLATES } from './generate.js';

const dir = new URL('../../../src/cluster/templates/', import.meta.url);
for (const t of TEMPLATES) {
  const target = new URL(t.module, dir);
  writeFileSync(
    target,
    renderTemplateModule(t.constName, t.source, readFileSync(new URL(t.source, dir), 'utf8')),
  );
  console.log(`wrote ${target.pathname}`);
}
