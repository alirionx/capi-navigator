import type { Case } from './cases.js';
import type { MatrixConfig } from './config.js';

export type RunCase = (c: Case, slot: Record<string, unknown> | undefined) => Promise<void>;

/**
 * Runs the cases of one platform: at most `parallel` at a time, each with a slot of its own
 * (addresses, networks) that no other running case holds; hosted control plane pairs afterwards,
 * alone, since host and tenant use addresses of several slots.
 */
async function runPlatform(
  cases: Case[],
  parallel: number,
  slots: Record<string, unknown>[],
  run: RunCase,
): Promise<void> {
  const single = cases.filter((c) => c.mode !== 'hcp');
  const free = slots.map((_, i) => i);
  const workers = slots.length ? Math.min(parallel, slots.length) : parallel;
  let next = 0;
  const worker = async () => {
    while (next < single.length) {
      const c = single[next++]!;
      const i = slots.length ? free.shift() : undefined;
      try {
        await run(c, i === undefined ? undefined : slots[i]);
      } finally {
        if (i !== undefined) free.push(i);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  for (const c of cases.filter((x) => x.mode === 'hcp')) await run(c, undefined);
}

/** Platforms run side by side; each keeps its own limits. */
export async function runAll(config: MatrixConfig, cases: Case[], run: RunCase): Promise<void> {
  const platforms = [...new Set(cases.map((c) => c.platform))];
  await Promise.all(
    platforms.map((platform) => {
      const p = config.platforms[platform]!;
      return runPlatform(
        cases.filter((c) => c.platform === platform),
        p.parallel,
        p.slots,
        run,
      );
    }),
  );
}
