import { describe, expect, it } from 'vitest';
import { logLines } from './log-lines.js';

const text = [
  '2026-11-04T08:00:00.123456789Z starting server',
  '2026-11-04T08:00:01Z level=warn msg="slow disk"',
  '2026-11-04T08:00:02Z {"level":"error","msg":"connection refused"}',
  'panic: runtime error',
  '',
].join('\n');

describe('log lines (FP18-F-07)', () => {
  it('splits timestamps off and shows them only on request', () => {
    const lines = logLines(text, '', true);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({
      n: 1,
      time: '2026-11-04T08:00:00.123456789Z',
      text: 'starting server',
      level: 'info',
      match: true,
    });
    expect(logLines(text, '', false)[0]?.time).toBeUndefined();
    // A line without a timestamp stays as it is.
    expect(lines[3]?.text).toBe('panic: runtime error');
  });

  it('marks warnings and errors in plain, logfmt and JSON logs', () => {
    expect(logLines(text, '', false).map((l) => l.level)).toEqual([
      'info',
      'warn',
      'error',
      'error',
    ]);
  });

  it('filters case-insensitively in the text, keeping line numbers', () => {
    const lines = logLines(text, 'CONNECTION', false).filter((l) => l.match);
    expect(lines.map((l) => l.n)).toEqual([3]);
    expect(logLines('', 'x', false)).toEqual([]);
  });
});
