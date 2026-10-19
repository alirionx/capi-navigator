// Writes docs/api/openapi.json (FP23-F-05). Run with `pnpm openapi:generate`.
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { renderOpenApi } from './render.js';

// The committed document carries the development version; released apps report their own.
const target = new URL('../../../../docs/api/openapi.json', import.meta.url);
writeFileSync(target, renderOpenApi('0.0.0-dev'));
console.log(`wrote ${target.pathname}`);
