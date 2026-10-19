import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fillTemplate, renderTemplateModule, TEMPLATES } from './generate.js';

const dir = new URL('./', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');

describe('node script templates (FP20-F-07)', () => {
  it.each(TEMPLATES)('$module is current: run pnpm templates:generate', (t) => {
    expect(read(t.module)).toBe(renderTemplateModule(t.constName, t.source, read(t.source)));
  });

  it('fills every placeholder and refuses missing values', () => {
    expect(fillTemplate('A="@@X@@" B="@@Y@@"', { X: '1', Y: '2' })).toBe('A="1" B="2"');
    expect(() => fillTemplate('A="@@X@@" B="@@Y@@"', { X: '1' })).toThrow(
      'Template placeholders without value: Y',
    );
  });
});
