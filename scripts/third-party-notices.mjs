#!/usr/bin/env node
// Third-party notices for the shipped app (Apache-2.0 section 4, MIT, OFL): the license texts of
// every production dependency of the workspace, plus the upstream manifests in
// apps/backend/assets and the container base. Also a license gate: an unknown or not explicitly
// allowed license fails the run, so a copyleft dependency cannot slip into the image unnoticed.
//
// Usage: node scripts/third-party-notices.mjs [output file]
//        (default: apps/frontend/public/third-party-notices.txt, served by the app)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'apps/frontend/public/third-party-notices.txt');

/** Permissive licenses compatible with distributing the app under Apache-2.0. */
const ALLOWED = new Set([
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'Python-2.0',
  'PSF-2.0',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'OFL-1.1',
  '(MPL-2.0 OR Apache-2.0)',
]);
const LICENSE_FILE = /^(licen[sc]e|copying|notice)(\.|-|$)/i;

const tree = JSON.parse(
  execFileSync('pnpm', ['list', '-r', '--prod', '--depth', 'Infinity', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);

/** @type {Map<string, {name: string, version: string, license: string, url?: string, texts: string[]}>} */
const packages = new Map();
const walk = (deps) => {
  for (const [name, info] of Object.entries(deps ?? {})) {
    const key = `${name}@${info.version}`;
    // Skipped: our own workspace packages, optional platform binaries not installed here.
    if (packages.has(key) || name.startsWith('@capi-navigator/') || !info.path) continue;
    if (!existsSync(join(info.path, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(join(info.path, 'package.json'), 'utf8'));
    // `license` (SPDX) or the legacy `licenses: [{ type }]` of older packages.
    let license = pkg.license ?? pkg.licenses ?? 'UNKNOWN';
    if (Array.isArray(license)) {
      license = license.map((l) => (typeof l === 'object' ? l.type : l)).join(' OR ');
    } else if (typeof license === 'object') license = license.type ?? 'UNKNOWN';
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const texts = readdirSync(info.path)
      .filter((f) => LICENSE_FILE.test(f))
      .sort()
      .map((f) => readFileSync(join(info.path, f), 'utf8').trim());
    packages.set(key, {
      name,
      version: info.version,
      license: String(license),
      url: pkg.homepage ?? repo,
      texts,
    });
    walk(info.dependencies);
  }
};
for (const project of tree) walk(project.dependencies);

const refused = [...packages.values()].filter((p) => !ALLOWED.has(p.license));
if (refused.length) {
  process.stderr.write('Licenses not on the allow list (scripts/third-party-notices.mjs):\n');
  for (const p of refused) process.stderr.write(`  ${p.name}@${p.version}: ${p.license}\n`);
  process.exit(1);
}

// Packages with the same license text share one copy of it.
const groups = new Map();
for (const p of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const text =
    p.texts.join('\n\n') ||
    `No license file in the package; licensed under ${p.license}: https://spdx.org/licenses/${p.license}.html`;
  if (!groups.has(text)) groups.set(text, []);
  groups.get(text).push(p);
}

const line = '='.repeat(100);
const parts = [
  'CAPI Navigator – third-party notices',
  '',
  'CAPI Navigator is licensed under the Apache License, Version 2.0 (see LICENSE and NOTICE in the',
  'source repository). It includes the following third-party software.',
  '',
  line,
  'Upstream Kubernetes manifests (apps/backend/assets), adapted before delivery to workload clusters',
  line,
  readFileSync(join(root, 'apps/backend/assets/README.md'), 'utf8').trim(),
  '',
  line,
  'Container image',
  line,
  'The image is based on the official node:24-bookworm-slim image: the Node.js runtime',
  '(https://github.com/nodejs/node/blob/main/LICENSE) on Debian GNU/Linux, whose packages carry their',
  'own licenses (including GPL); their sources are available from https://sources.debian.org.',
  '',
  line,
  `Packages (${packages.size}), grouped by license text`,
  line,
];
for (const [text, members] of groups) {
  parts.push('');
  for (const p of members)
    parts.push(`- ${p.name}@${p.version} (${p.license})${p.url ? ` ${p.url}` : ''}`);
  parts.push('', text, '', '-'.repeat(100));
}
parts.push(
  '',
  line,
  'Apache License, Version 2.0 (full text)',
  line,
  readFileSync(join(root, 'LICENSE'), 'utf8'),
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${parts.join('\n')}\n`);
process.stdout.write(`${packages.size} packages, ${groups.size} license texts → ${out}
`);
