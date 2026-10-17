import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_CRDS, buildCrd, NavigatorUserCrd } from './index.js';
import { crdFileName, renderCrd } from './render.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('CRD generation (STATE-02)', () => {
  it('generates the NavigatorUser schema from Zod', () => {
    expect(renderCrd(NavigatorUserCrd)).toMatchSnapshot();
  });

  it('never emits keywords that structural schemas reject', () => {
    for (const def of ALL_CRDS) {
      const json = JSON.stringify(buildCrd(def));
      expect(json).not.toContain('"additionalProperties":false');
      expect(json).not.toContain('$schema');
    }
  });

  it.each(ALL_CRDS.map((d) => [d.kind, d] as const))(
    'committed %s CRDs are up to date (run `pnpm crds:generate`)',
    (_kind, def) => {
      for (const dir of ['deploy/crds', 'deploy/helm/capi-navigator/crds']) {
        const committed = readFileSync(join(root, dir, crdFileName(def)), 'utf8');
        expect(committed).toBe(renderCrd(def));
      }
    },
  );
});
