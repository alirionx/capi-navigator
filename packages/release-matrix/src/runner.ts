import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppApi, Condition } from './api.js';
import { buildBodies, type Case, type CreateBody } from './cases.js';
import { checkWorkload, Workload } from './checks.js';
import type { MatrixConfig } from './config.js';

export interface RunOptions {
  config: MatrixConfig;
  api: AppApi;
  registry?: Record<string, unknown>;
  /** Only the preview: blockers and warnings, nothing is created. */
  previewOnly?: boolean;
  /** Keep the clusters (for debugging); hosted control plane hosts are always kept for the tenant. */
  keep?: boolean;
  log?: (line: string) => void;
  /** Wait between status polls; shorter in tests. */
  pollMs?: number;
}

export interface ClusterResult {
  name: string;
  version: string;
  ok: boolean;
  notes: string[];
}

const time = () => new Date().toISOString().slice(11, 19);

/** One line of the protocol, a checkbox per cluster. */
export function protocolLine(caseId: string, r: ClusterResult): string {
  return `- [${r.ok ? 'x' : ' '}] **${caseId}** (${r.name}, ${r.version}) – ${r.notes.join(' · ')}`;
}

function expectedNodes(spec: CreateBody['spec']): number {
  const t = spec.topology as {
    mode: string;
    controlPlane: { replicas: number };
    workerPools?: { replicas: number }[];
  };
  const cp = t.mode === 'hosted' ? 0 : t.controlPlane.replicas;
  return cp + (t.workerPools ?? []).reduce((s, p) => s + p.replicas, 0);
}

const unhealthy = (conditions: Condition[]) =>
  conditions
    .filter((c) => c.status === 'False')
    .map((c) => `${c.type}: ${c.message ?? c.reason ?? ''}`.trim())
    .join('; ')
    .slice(0, 400);

async function runCluster(
  c: Case,
  body: CreateBody,
  o: RunOptions,
  keep: boolean,
): Promise<ClusterResult> {
  const { name, namespace } = body.spec;
  const version = (body.spec.kubernetes as { version: string }).version;
  const log = (l: string) => o.log?.(`[${time()}] ${name}: ${l}`);
  const result = (ok: boolean, notes: string[]) => ({ name, version, ok, notes });
  const poll = o.pollMs ?? 10_000;

  const preview = await o.api.preview(body);
  if (preview.blockers.length)
    return result(false, [`❌ preview blocked: ${preview.blockers.join('; ')}`]);
  if (o.previewOnly) {
    return result(true, [
      'preview without blockers',
      ...preview.warnings.map((w) => `⚠️ ${w.length > 160 ? `${w.slice(0, 157)}...` : w}`),
    ]);
  }
  await o.api.create(body);
  log('created');
  const notes: string[] = [];
  let failed = false;
  const t0 = Date.now();
  let available = false;
  let conditions: Condition[] = [];
  while (Date.now() - t0 < o.config.availableMinutes * 60_000) {
    conditions = (await o.api.conditions(namespace, name)) ?? [];
    if (conditions.some((c) => c.type === 'Available' && c.status === 'True')) {
      available = true;
      break;
    }
    await sleep(poll);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  if (available) notes.push(`Available after ${elapsed} s`);
  else {
    notes.push(
      `❌ not Available after ${o.config.availableMinutes} min (${unhealthy(conditions)})`,
    );
    failed = true;
  }

  if (available) {
    const w = new Workload(await o.api.kubeconfig(namespace, name));
    try {
      const proof = c.airGapped ? o.config.platforms[c.platform]?.airGapped?.proof : undefined;
      const r = await checkWorkload(w, {
        expectedNodes: expectedNodes(body.spec),
        version,
        caseId: name,
        ...(proof ? { proof } : {}),
      });
      notes.push(...r.notes);
      failed ||= r.failed;
      if (r.images) {
        const file = join(dirname(o.config.protocol), `${name}.images`);
        writeFileSync(file, `${r.images.join('\n')}\n`);
        log(`images in ${file}`);
      }
    } finally {
      w.dispose();
    }
  }

  if (keep) notes.push('kept');
  else notes.push(...(await deleteCluster(o, namespace, name)));
  failed ||= notes.some((n) => n.startsWith('❌'));
  log(failed ? 'FAILED' : 'ok');
  return result(!failed, notes);
}

async function deleteCluster(o: RunOptions, namespace: string, name: string): Promise<string[]> {
  await o.api.delete(namespace, name);
  const t0 = Date.now();
  while (Date.now() - t0 < 20 * 60_000) {
    if (!(await o.api.conditions(namespace, name))) {
      return [`deleted after ${Math.round((Date.now() - t0) / 1000)} s`];
    }
    await sleep(o.pollMs ?? 10_000);
  }
  return ['❌ not deleted after 20 min'];
}

function record(o: RunOptions, line: string): void {
  mkdirSync(dirname(o.config.protocol), { recursive: true });
  appendFileSync(o.config.protocol, `${line}\n`);
}

/** Runs one case (a hosted control plane case as host, tenant, host deletion) and records it. */
export async function runCase(
  c: Case,
  slot: Record<string, unknown> | undefined,
  o: RunOptions,
): Promise<boolean> {
  let bodies: CreateBody[];
  try {
    bodies = buildBodies(c, {
      config: o.config,
      ...(o.registry ? { registry: o.registry } : {}),
      ...(slot ? { slot } : {}),
    });
  } catch (err) {
    record(o, `- [ ] **${c.id}** – ❌ ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  let ok = true;
  const run = async (body: CreateBody, keep: boolean) => {
    try {
      const r = await runCluster(c, body, o, keep);
      record(o, protocolLine(c.id, r));
      ok &&= r.ok;
      return r;
    } catch (err) {
      record(
        o,
        `- [ ] **${c.id}** (${body.spec.name}) – ❌ ${err instanceof Error ? err.message : String(err)}`,
      );
      ok = false;
      return undefined;
    }
  };
  if (bodies.length === 1) {
    await run(bodies[0]!, !!o.keep);
    return ok;
  }
  // Hosted control planes: the host stays for the tenant, then goes.
  const [host, tenant] = bodies as [CreateBody, CreateBody];
  const h = await run(host, true);
  if (o.previewOnly) {
    record(o, `  - ${tenant.spec.name}: preview needs the host, not built`);
    return ok;
  }
  if (h?.notes[0]?.startsWith('Available')) await run(tenant, !!o.keep);
  if (!o.keep && h) {
    const gone = await deleteCluster(o, host.spec.namespace, host.spec.name);
    record(o, `  - ${host.spec.name}: host ${gone.join(' ')}`);
    ok &&= !gone[0]!.startsWith('❌');
  }
  return ok;
}
