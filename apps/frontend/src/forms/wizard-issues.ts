import type { InfraForm } from '@capi-navigator/shared';

/** Problems of the cluster wizard per step, from the shared schema (FP5-F-02). */
export interface StepIssue {
  /** Dotted path in the cluster spec, e.g. "topology.workerPools.0.name". */
  path: string;
  message: string;
  step: number;
  /** i18n key of the field label, if known. */
  labelKey?: string;
}

/** Wizard step of a spec path; unknown paths belong to step 1. */
export const STEP_OF: [RegExp, number][] = [
  [/^(name|namespace|labels|kubernetes\.(version|flavor)|infrastructure\.credentialRef)/, 1],
  [/customization/, 5],
  [/^topology/, 2],
  [/^infrastructure/, 3],
  [/^addons/, 4],
  [/^(kubernetes\.(podCidr|serviceCidr)|sshPublicKeys|rollout)/, 6],
];

/** Field labels of the wizard for spec paths; the first match wins. */
const LABELS: [RegExp, string][] = [
  [/^name$/, 'wizard.name'],
  [/^namespace$/, 'wizard.namespace'],
  [/^labels/, 'wizard.labels'],
  [/^kubernetes\.version$/, 'wizard.version'],
  [/^kubernetes\.flavor$/, 'wizard.distribution'],
  [/^kubernetes\.packageRepository/, 'wizard.packageRepository'],
  [/^kubernetes\.binaryDownloads/, 'wizard.binaryDownloads'],
  [/^kubernetes\.podCidr$/, 'wizard.podCidr'],
  [/^kubernetes\.serviceCidr$/, 'wizard.serviceCidr'],
  [/^infrastructure\.credentialRef$/, 'wizard.credential'],
  // Without a form; with one, the provider's labels win (FP25-F-05).
  [/^infrastructure\.image$/, 'wizard.image'],
  [/^topology\.workerPools\.\d+\.name$/, 'wizard.poolName'],
  [/^topology\.workerPools\.\d+\.replicas$/, 'wizard.replicas'],
  [/rootVolumeSizeGB$/, 'wizard.rootVolume'],
  [/^sshPublicKeys/, 'wizard.sshPublicKeys'],
];

/**
 * Issues from a schema validation, one per field: Zod reports e.g. "Required" and a pattern
 * mismatch for an empty name; the first one is enough.
 */
export function stepIssues(
  issues: { path: PropertyKey[]; message: string }[],
  /** Labels of the infrastructure fields come from the provider's form (FP25-F-05). */
  form?: InfraForm,
): StepIssue[] {
  const seen = new Set<string>();
  const result: StepIssue[] = [];
  for (const i of issues) {
    const path = i.path.map(String).join('.');
    if (seen.has(path)) continue;
    seen.add(path);
    const labelKey =
      form?.fields.find((f) => path === `infrastructure.${f.path}`)?.label ??
      LABELS.find(([re]) => re.test(path))?.[1];
    result.push({
      path,
      message: i.message,
      step: STEP_OF.find(([re]) => re.test(path))?.[1] ?? 1,
      ...(labelKey ? { labelKey } : {}),
    });
  }
  return result;
}

/**
 * Issues shown below a step: only once the user has left the step once (Next, Back, or the
 * jump to the first invalid step), so an empty form does not open with errors. The issues still
 * block the preview in the meantime.
 */
export function visibleIssues(
  issues: StepIssue[],
  step: number,
  visited: ReadonlySet<number>,
): StepIssue[] {
  return visited.has(step) ? issues.filter((i) => i.step === step) : [];
}
