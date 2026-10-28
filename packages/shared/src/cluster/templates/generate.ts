/** Node script templates as TypeScript modules (FP20-F-07): no file reads at runtime. */
export function renderTemplateModule(constName: string, source: string, template: string): string {
  return [
    `// Generated from ${source} by \`pnpm templates:generate\` (FP-20). Do not edit.`,
    `export const ${constName} = ${JSON.stringify(template)};`,
    '',
  ].join('\n');
}

/** Replaces @@NAME@@ placeholders; every placeholder must get a value and every value be used. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  const missing = [...template.matchAll(/@@([A-Z0-9_]+)@@/g)]
    .map((m) => m[1]!)
    .filter((name) => !(name in values));
  if (missing.length > 0)
    throw new Error(`Template placeholders without value: ${missing.join(', ')}`);
  return template.replace(/@@([A-Z0-9_]+)@@/g, (_m, name: string) => values[name]!);
}

/** Templates and the modules generated from them. */
export const TEMPLATES = [
  {
    source: 'kubeadm-install.sh.tmpl',
    module: 'kubeadm-install.generated.ts',
    constName: 'KUBEADM_INSTALL_TEMPLATE',
  },
  {
    source: 'fetch-artifact.py.tmpl',
    module: 'fetch-artifact.generated.ts',
    constName: 'FETCH_ARTIFACT_SCRIPT',
  },
];
