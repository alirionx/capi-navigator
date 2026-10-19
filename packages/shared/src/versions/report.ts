import type { VersionsFile } from './schema.js';

/** The parts of Renovate's file report (`--report-type=file`) the version report uses. */
export interface RenovateReport {
  repositories: Record<
    string,
    {
      problems?: { message?: string; level?: number }[];
      packageFiles: Record<
        string,
        {
          packageFile: string;
          deps: {
            depName?: string;
            currentValue?: string;
            datasource?: string;
            skipReason?: string;
            updates?: {
              newValue?: string;
              newVersion?: string;
              updateType?: string;
              newVersionAgeInDays?: number;
              pendingChecks?: boolean;
            }[];
          }[];
        }[]
      >;
    }
  >;
}

type Dep = RenovateReport['repositories'][string]['packageFiles'][string][number]['deps'][number];
type Update = NonNullable<Dep['updates']>[number];

const GROUPS: [prefix: string, title: string][] = [
  ['providers.', 'Cluster API providers'],
  ['prerequisites.', 'Prerequisites'],
  ['kubernetes.', 'Kubernetes versions'],
  ['addonPresets.', 'Add-on preset charts'],
  ['kubeadmRuntime.', 'kubeadm node runtime'],
  ['cni.', 'CNI'],
  ['images.', 'Images'],
];
const RANK: Record<string, number> = { major: 3, minor: 2, patch: 1 };

const newest = (updates: Update[]) =>
  [...updates].sort((a, b) => (RANK[b.updateType ?? ''] ?? 0) - (RANK[a.updateType ?? ''] ?? 0))[0];

/**
 * Updates that matter for a Kubernetes catalog entry: patches of its own minor, and a newer
 * minor only if the catalog has no entry for it yet (one entry per minor, FP3-F-07a).
 */
function kubernetesUpdates(dep: Dep, catalogMinors: Set<string>): Update[] {
  return (dep.updates ?? []).filter((u) => {
    if (u.updateType === 'patch') return true;
    const minor = /^v(\d+\.\d+)\./.exec(u.newValue ?? u.newVersion ?? '')?.[1];
    return minor !== undefined && !catalogMinors.has(minor);
  });
}

function status(update: Update | undefined): string {
  if (!update) return 'up to date';
  const age = update.newVersionAgeInDays;
  const waiting = update.pendingChecks
    ? ` (released ${age === 0 ? 'today' : `${age} days ago`}; wait for the minimum release age)`
    : '';
  return `**${update.updateType}**${waiting}`;
}

/** Where to change an entry of versions.yaml, e.g. "versions.yaml → providers.rke2". */
function location(depName: string): string {
  const kube = /^kubernetes\.(\w+) /.exec(depName);
  if (kube) return `versions.yaml → kubernetes.${kube[1]}.versions`;
  const orc = /^prerequisites\.orc/.test(depName);
  return `versions.yaml → ${orc ? 'prerequisites.orc.byCapoMinor' : depName}`;
}

const cell = (value: string) => value.replace(/\|/g, '\\|');

/**
 * Markdown version report (FP20-F-05): the entries of versions.yaml with newer versions, and an
 * appendix for the repository's GitHub Actions and Docker images. npm packages are left to
 * `pnpm outdated -r`.
 */
export function renderVersionsReport(
  report: RenovateReport,
  versions: VersionsFile,
  meta: { date: string; renovateVersion: string; tokenUsed: boolean },
): string {
  const repo = Object.values(report.repositories)[0];
  const files = repo?.packageFiles ?? {};
  const appDeps = (files.jsonata ?? []).flatMap((f) => f.deps);
  const minors = (flavor: string) =>
    new Set(
      (versions.kubernetes[flavor as keyof VersionsFile['kubernetes']]?.versions ?? []).map(
        (v) => /^v(\d+\.\d+)\./.exec(v.version)?.[1] ?? '',
      ),
    );

  const rows = appDeps.map((dep) => {
    const name = dep.depName ?? '';
    const flavor = /^kubernetes\.(\w+) /.exec(name)?.[1];
    const updates = flavor ? kubernetesUpdates(dep, minors(flavor)) : (dep.updates ?? []);
    return { dep, name, update: newest(updates) };
  });
  const withUpdates = rows.filter((r) => r.update);
  const count = (type: string) => withUpdates.filter((r) => r.update!.updateType === type).length;
  // Workflow runners (ubuntu-latest) and node-version-file are expected skips; report app entries only.
  const skipped = appDeps.filter((d) => d.skipReason);

  const out: string[] = [
    '# Version report',
    '',
    `Generated on ${meta.date} by \`pnpm versions:report\` (Renovate ${meta.renovateVersion}, lookups only). ` +
      'How to update a version: [maintenance.md](maintenance.md).',
    '',
    `**${rows.length} app versions** in [versions.yaml](../versions.yaml): ${withUpdates.length} with a newer version ` +
      `(${count('major')} major, ${count('minor')} minor, ${count('patch')} patch).`,
    '',
    'npm packages are not part of this report: run `pnpm outdated -r`.',
    '',
    '## App versions (versions.yaml)',
  ];
  for (const [prefix, title] of GROUPS) {
    const group = rows.filter((r) => r.name.startsWith(prefix));
    if (group.length === 0) continue;
    out.push(
      '',
      `### ${title}`,
      '',
      '| Entry | Current | Newest | Update | Change in |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const r of group) {
      const newer = r.update ? (r.update.newValue ?? r.update.newVersion ?? '') : '–';
      out.push(
        `| ${cell(r.name)} | ${cell(r.dep.currentValue ?? '')} | ${cell(newer)} | ${status(r.update)} | ${cell(location(r.name))} |`,
      );
    }
  }

  const tooling = Object.entries(files)
    .filter(([manager]) => manager !== 'jsonata')
    .flatMap(([, list]) => list.flatMap((f) => f.deps.map((dep) => ({ file: f.packageFile, dep }))))
    .map((x) => ({ ...x, update: newest(x.dep.updates ?? []) }));
  // The same action appears in several jobs of a workflow: one row per file and version.
  const outdated = [
    ...tooling
      .filter((t) => t.update)
      .reduce((rows, t) => {
        const key = `${t.file}|${t.dep.depName}|${t.dep.currentValue}`;
        const row = rows.get(key);
        if (row) row.count++;
        else rows.set(key, { ...t, count: 1 });
        return rows;
      }, new Map<string, (typeof tooling)[number] & { count: number }>())
      .values(),
  ];
  out.push(
    '',
    '## Appendix: GitHub Actions and Docker images',
    '',
    `${tooling.length} references in workflows, Dockerfile and .nvmrc; ${outdated.reduce((n, t) => n + t.count, 0)} of them have a newer version.`,
  );
  if (outdated.length > 0) {
    out.push(
      '',
      '| Dependency | Current | Newest | Update | Change in |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const t of outdated) {
      out.push(
        `| ${cell(t.dep.depName ?? '')}${t.count > 1 ? ` (×${t.count})` : ''} | ${cell(t.dep.currentValue ?? '')} | ${cell(t.update!.newValue ?? t.update!.newVersion ?? '')} | ${status(t.update)} | ${cell(t.file)} |`,
      );
    }
  }

  if (skipped.length > 0 || !meta.tokenUsed) {
    out.push('', '## Not checked', '');
    if (!meta.tokenUsed) {
      out.push(
        '- Without a GitHub login (`gh auth login`) GitHub release lookups are limited; some entries may be missing.',
      );
    }
    for (const d of skipped) out.push(`- ${cell(d.depName ?? '')}: ${d.skipReason}`);
  }
  return `${out.join('\n')}\n`;
}
