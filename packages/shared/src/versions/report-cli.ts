// Turns Renovate's file report into docs/versions-report.md (FP20-F-05). Called by
// scripts/versions-report.sh: node report-cli.js <report.json> <renovate version> <token used>
import { readFileSync, writeFileSync } from 'node:fs';
import { parseVersionsFile } from './generate.js';
import { renderVersionsReport, type RenovateReport } from './report.js';

const [reportPath, renovateVersion = 'unknown', tokenUsed = 'false'] = process.argv.slice(2);
if (!reportPath)
  throw new Error('usage: report-cli <renovate report.json> [renovate version] [token used]');
const root = new URL('../../../../', import.meta.url);
const markdown = renderVersionsReport(
  JSON.parse(readFileSync(reportPath, 'utf8')) as RenovateReport,
  parseVersionsFile(readFileSync(new URL('versions.yaml', root), 'utf8')),
  { date: new Date().toISOString().slice(0, 10), renovateVersion, tokenUsed: tokenUsed === 'true' },
);
const target = new URL('docs/versions-report.md', root);
writeFileSync(target, markdown);
console.log(`wrote ${target.pathname}`);
