// Release test matrix: creates workload clusters through the app's API, checks them and deletes
// them again (docs/maintenance.md). Without --preview or --run it only lists the selected cases.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { AppApi } from './api.js';
import { allCases, FLAVORS, MODES, selectCases, type Flavor, type Mode } from './cases.js';
import { loadConfig, PLATFORMS, type Platform } from './config.js';
import { runCase } from './runner.js';
import { runAll } from './schedule.js';

const USAGE = `Usage: pnpm release:matrix [options]

  --config <file>     configuration (default: release-matrix.local.yaml, see
                      packages/release-matrix/matrix.example.yaml)
  --platform <list>   ${PLATFORMS.join(',')}
  --flavor <list>     ${FLAVORS.join(',')}
  --mode <list>       ${MODES.join(',')}  (aio: all-in-one, std: 1 control plane + 1 worker,
                      hcp: hosted control plane, k0s host + tenant)
  --network <n>       online | airgap | all (default: all)
  --case <list>       exact case IDs, e.g. mt-px-k-std-ag
  --preview           build the previews only (blockers, warnings); creates nothing
  --run               create, check and delete the clusters: real cloud resources and costs
  --keep              keep the clusters after the checks (for debugging; delete them yourself)
`;

const list = <T extends string>(
  v: string | undefined,
  allowed: readonly T[],
  what: string,
): T[] => {
  const items = (v ?? '').split(',').filter(Boolean);
  for (const i of items) {
    if (!allowed.includes(i as T))
      throw new Error(`Unknown ${what} "${i}"; one of ${allowed.join(', ')}`);
  }
  return items as T[];
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'release-matrix.local.yaml' },
      platform: { type: 'string' },
      flavor: { type: 'string' },
      mode: { type: 'string' },
      network: { type: 'string', default: 'all' },
      case: { type: 'string' },
      preview: { type: 'boolean', default: false },
      run: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!['online', 'airgap', 'all'].includes(values.network))
    throw new Error('--network: online, airgap or all');
  const config = loadConfig(values.config);
  const cases = selectCases(allCases(config), {
    platforms: list<Platform>(values.platform, PLATFORMS, 'platform'),
    flavors: list<Flavor>(values.flavor, FLAVORS, 'flavor'),
    modes: list<Mode>(values.mode, MODES, 'mode'),
    network: values.network as 'online' | 'airgap' | 'all',
    ids: (values.case ?? '').split(',').filter(Boolean),
  });
  if (!cases.length) {
    console.log('No case matches the selection.');
    return 1;
  }
  console.log(`${cases.length} case(s):\n${cases.map((c) => `  ${c.id}`).join('\n')}`);
  if (!values.preview && !values.run) {
    console.log('\nNothing created. --preview builds the previews, --run creates the clusters.');
    return 0;
  }

  const api = new AppApi(config);
  const registry = cases.some((c) => c.airGapped) ? await api.internalRegistry() : undefined;
  mkdirSync(dirname(config.protocol), { recursive: true });
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('--config'));
  appendFileSync(
    config.protocol,
    `\n## ${values.run ? 'Run' : 'Preview'} ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC (${argv.join(' ')})\n\n`,
  );
  let failed = 0;
  await runAll(config, cases, async (c, slot) => {
    const ok = await runCase(c, slot, {
      config,
      api,
      ...(registry ? { registry } : {}),
      previewOnly: !values.run,
      keep: values.keep,
      log: (l) => console.log(l),
    });
    console.log(`${ok ? '✓' : '✗'} ${c.id}`);
    if (!ok) failed++;
  });
  console.log(`\n${cases.length - failed}/${cases.length} passed; protocol: ${config.protocol}`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
