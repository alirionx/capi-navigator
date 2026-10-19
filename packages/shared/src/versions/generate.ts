import { parse } from 'yaml';
import { VersionsFileSchema, type VersionsFile } from './schema.js';

/** Parses and validates versions.yaml; throws with the path of the first problem. */
export function parseVersionsFile(text: string): VersionsFile {
  const result = VersionsFileSchema.safeParse(parse(text));
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`versions.yaml: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  return result.data;
}

/** TypeScript module with the validated versions (FP20-F-02); deterministic output. */
export function renderVersionsModule(versions: VersionsFile): string {
  return [
    '// Generated from versions.yaml by `pnpm versions:generate` (FP-20). Do not edit.',
    "import type { VersionsFile } from './versions/schema.js';",
    '',
    `export const VERSIONS: VersionsFile = ${JSON.stringify(versions, null, 2)};`,
    '',
  ].join('\n');
}

/** Shell variables for the kind scripts (scripts/lib.sh), so they hold no own copy. */
export function renderScriptEnv(versions: VersionsFile): string {
  return [
    '# Generated from versions.yaml by `pnpm versions:generate` (FP-20). Do not edit.',
    `CERT_MANAGER_VERSION_DEFAULT=${versions.prerequisites['cert-manager'].version}`,
    `CAPI_OPERATOR_VERSION_DEFAULT=${versions.prerequisites['capi-operator'].version.replace(/^v/, '')}`,
    '',
  ].join('\n');
}
