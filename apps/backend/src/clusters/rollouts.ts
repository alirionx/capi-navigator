import { stableStringify, type RolloutPlan } from '@capi-navigator/shared';

/** One object of a change: its live and its dry-run (after apply) state, both normalized. */
export interface PlannedObject {
  kind: string;
  name: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

interface MachineLike {
  metadata: { name: string; labels?: Record<string, string> };
}

const CP_LABEL = 'cluster.x-k8s.io/control-plane';
const MD_LABEL = 'cluster.x-k8s.io/deployment-name';
const SET_LABEL = 'cluster.x-k8s.io/set-name';
const POOL_LABEL = 'capi-navigator.io/pool';

const spec = (o?: Record<string, unknown>) => (o?.spec ?? {}) as Record<string, unknown>;
const without = (o: Record<string, unknown>, key: string) => {
  const c = { ...o };
  delete c[key];
  return c;
};

/**
 * Which machines a change replaces and in which order (FP7-F-16): the control plane first, then
 * worker pools; pools removed from the spec lose their machines. Also reports rollouts that are
 * still running, since only one rollout per cluster is allowed (FP7-F-17).
 */
export function analyzeRollouts(args: {
  controlPlaneKinds: string[];
  objects: PlannedObject[];
  removedDeployments: { name: string; before: Record<string, unknown> }[];
  machines: MachineLike[];
  workerVersionPending: boolean;
  /** Control plane kinds whose version upgrades run in place (ADR-0013). */
  inPlaceVersionKinds?: string[];
}): { rollouts: RolloutPlan[]; running: string[] } {
  const rollouts: RolloutPlan[] = [];
  const running: string[] = [];
  /**
   * A MachineDeployment rolls while machines of more than one MachineSet exist or machines are
   * missing. Machines that are ready but never count as up to date (e.g. a kubelet version
   * mismatch) do not block further changes, so the fix can be applied.
   */
  const deploymentRolling = (
    name: string,
    status: Record<string, number | undefined>,
    replicas: number,
  ) => {
    const own = args.machines.filter((m) => m.metadata.labels?.[MD_LABEL] === name);
    const sets = new Set(own.map((m) => m.metadata.labels?.[SET_LABEL]));
    return (
      sets.size > 1 ||
      (status.replicas ?? replicas) !== replicas ||
      (status.readyReplicas ?? replicas) < replicas
    );
  };
  const machinesOf = (pred: (m: MachineLike) => boolean) =>
    args.machines
      .filter(pred)
      .map((m) => m.metadata.name)
      .sort();

  for (const o of args.objects) {
    const isCp = args.controlPlaneKinds.includes(o.kind);
    if (!isCp && o.kind !== 'MachineDeployment') continue;
    const status = (o.before?.status ?? {}) as Record<string, number | undefined>;
    const replicas = Number(spec(o.before).replicas ?? 0);
    const behind = (status.upToDateReplicas ?? replicas) < replicas;
    const cpRolling = behind || (status.replicas ?? replicas) !== replicas;
    if (o.before && (isCp ? cpRolling : behind && deploymentRolling(o.name, status, replicas))) {
      running.push(`${o.kind} ${o.name}`);
    }
    if (!o.before || !o.after) continue;
    if (isCp) {
      // Everything but the replica count rolls the control plane machines, except version-only
      // changes of providers that upgrade in place (ADR-0013).
      const before = without(spec(o.before), 'replicas');
      const after = without(spec(o.after), 'replicas');
      if (stableStringify(before) !== stableStringify(after)) {
        const inPlace =
          (args.inPlaceVersionKinds ?? []).includes(o.kind) &&
          stableStringify(without(before, 'version')) ===
            stableStringify(without(after, 'version'));
        rollouts.push({
          order: 0,
          kind: o.kind,
          name: o.name,
          group: 'control plane',
          machines: machinesOf((m) => CP_LABEL in (m.metadata.labels ?? {})),
          strategy: inPlace ? 'in place, one node at a time' : 'one node at a time (maxSurge 1)',
          action: inPlace ? 'inPlace' : 'replace',
        });
      }
      continue;
    }
    const b = spec(o.before);
    const a = spec(o.after);
    const rollB = (b.rollout ?? {}) as {
      after?: string;
      strategy?: { rollingUpdate?: Record<string, unknown> };
    };
    const rollA = (a.rollout ?? {}) as typeof rollB;
    if (
      stableStringify(b.template) !== stableStringify(a.template) ||
      rollB.after !== rollA.after
    ) {
      const ru = rollA.strategy?.rollingUpdate ?? {};
      rollouts.push({
        order: 1,
        kind: o.kind,
        name: o.name,
        group:
          (a.template as { metadata?: { labels?: Record<string, string> } })?.metadata?.labels?.[
            POOL_LABEL
          ] ?? o.name,
        machines: machinesOf((m) => m.metadata.labels?.[MD_LABEL] === o.name),
        strategy: `maxSurge ${String(ru.maxSurge ?? 1)}, maxUnavailable ${String(ru.maxUnavailable ?? 0)}`,
        action: 'replace',
      });
    }
  }
  for (const r of args.removedDeployments) {
    rollouts.push({
      order: 2,
      kind: 'MachineDeployment',
      name: r.name,
      group: r.name,
      machines: machinesOf((m) => m.metadata.labels?.[MD_LABEL] === r.name),
      strategy: 'all at once',
      action: 'remove',
    });
  }
  if (args.workerVersionPending) {
    for (const o of args.objects.filter((x) => x.kind === 'MachineDeployment')) {
      if (rollouts.some((r) => r.name === o.name)) continue;
      rollouts.push({
        order: 1,
        kind: o.kind,
        name: o.name,
        group: o.name,
        machines: machinesOf((m) => m.metadata.labels?.[MD_LABEL] === o.name),
        strategy: 'after the control plane runs the new version (automatic)',
        action: 'later',
      });
    }
  }
  return {
    rollouts: rollouts.sort((x, y) => x.order - y.order || x.name.localeCompare(y.name)),
    running,
  };
}
