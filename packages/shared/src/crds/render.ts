import { stringify } from 'yaml';
import { buildCrd } from './generate.js';
import { NAVIGATOR_GROUP, type CrdDefinition } from './types.js';

const HEADER = '# Generated from packages/shared/src/crds by `pnpm crds:generate`. Do not edit.\n';

export function crdFileName(def: CrdDefinition): string {
  return `${NAVIGATOR_GROUP}_${def.plural}.yaml`;
}

export function renderCrd(def: CrdDefinition): string {
  return HEADER + stringify(buildCrd(def), { lineWidth: 0 });
}
