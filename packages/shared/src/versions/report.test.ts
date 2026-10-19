import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseVersionsFile } from './generate.js';
import { renderVersionsReport, type RenovateReport } from './report.js';

const versions = parseVersionsFile(
  readFileSync(new URL('../../../../versions.yaml', import.meta.url), 'utf8'),
);

const report: RenovateReport = {
  repositories: {
    local: {
      packageFiles: {
        jsonata: [
          {
            packageFile: 'versions.yaml',
            deps: [
              {
                depName: 'providers.rke2',
                currentValue: 'v0.26.0',
                updates: [
                  {
                    newValue: 'v0.27.0',
                    updateType: 'minor',
                    newVersionAgeInDays: 0,
                    pendingChecks: true,
                  },
                ],
              },
              { depName: 'providers.aws', currentValue: 'v2.13.1', updates: [] },
              {
                // Patch of its own minor: shown.
                depName: 'kubernetes.kubeadm 1.35',
                currentValue: 'v1.35.9',
                updates: [
                  { newValue: 'v1.35.10', updateType: 'patch' },
                  { newValue: 'v1.37.1', updateType: 'minor' },
                ],
              },
              {
                // Only a minor the catalog already has: noise, not shown.
                depName: 'kubernetes.kubeadm 1.34',
                currentValue: 'v1.34.12',
                updates: [{ newValue: 'v1.37.1', updateType: 'minor' }],
              },
              {
                // A minor the catalog does not have yet: shown.
                depName: 'kubernetes.kubeadm 1.37',
                currentValue: 'v1.37.1',
                updates: [{ newValue: 'v1.38.0', updateType: 'minor' }],
              },
              {
                depName: 'cni.calico',
                currentValue: 'v3.33.0',
                skipReason: 'github-token-required',
              },
            ],
          },
        ],
        'github-actions': [
          {
            packageFile: '.github/workflows/ci.yaml',
            deps: [
              {
                depName: 'actions/checkout',
                currentValue: 'v5',
                updates: [{ newValue: 'v7', updateType: 'major' }],
              },
              {
                depName: 'actions/checkout',
                currentValue: 'v5',
                updates: [{ newValue: 'v7', updateType: 'major' }],
              },
              { depName: 'ubuntu', currentValue: 'latest', skipReason: 'invalid-version' },
            ],
          },
        ],
      },
    },
  },
};

describe('version report (FP20-F-05)', () => {
  const md = renderVersionsReport(report, versions, {
    date: '2026-10-19',
    renovateVersion: '44.133.0',
    tokenUsed: true,
  });
  const row = (name: string) => md.split('\n').find((l) => l.startsWith(`| ${name} `));

  it('lists app versions with the newest version and where to change them', () => {
    expect(md).toContain('Generated on 2026-10-19 by `pnpm versions:report` (Renovate 44.133.0');
    expect(row('providers.rke2')).toContain(
      '| v0.27.0 | **minor** (released today; wait for the minimum release age) | versions.yaml → providers.rke2 |',
    );
    expect(row('providers.aws')).toContain('| – | up to date |');
    expect(md).toContain('npm packages are not part of this report: run `pnpm outdated -r`.');
  });

  it('shows patches of a catalog minor and new minors, not minors the catalog has', () => {
    expect(row('kubernetes.kubeadm 1.35')).toContain('| v1.35.10 | **patch** |');
    expect(row('kubernetes.kubeadm 1.34')).toContain('| – | up to date |');
    expect(row('kubernetes.kubeadm 1.37')).toContain('| v1.38.0 | **minor** |');
    expect(row('kubernetes.kubeadm 1.35')).toContain('versions.yaml → kubernetes.kubeadm.versions');
    expect(md).toContain('3 with a newer version (0 major, 2 minor, 1 patch)');
  });

  it('merges repeated workflow references and lists only app entries as not checked', () => {
    expect(row('actions/checkout (×2)')).toContain(
      '| v5 | v7 | **major** | .github/workflows/ci.yaml |',
    );
    expect(md).toContain('- cni.calico: github-token-required');
    expect(md).not.toContain('- ubuntu:');
  });

  it('notes missing GitHub lookups without a gh login (FP20-F-06)', () => {
    const without = renderVersionsReport(report, versions, {
      date: '2026-10-19',
      renovateVersion: '44.133.0',
      tokenUsed: false,
    });
    expect(without).toContain('Without a GitHub login (`gh auth login`)');
  });
});
