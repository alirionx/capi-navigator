import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** PVC, Deployment writing into it and a LoadBalancer Service: CSI and CCM in one go. */
export const WORKLOAD = `apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: data }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 1Gi } } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: docker.io/library/nginx:1.29-alpine
          volumeMounts: [{ name: data, mountPath: /usr/share/nginx/html }]
      volumes: [{ name: data, persistentVolumeClaim: { claimName: data } }]
---
apiVersion: v1
kind: Service
metadata: { name: web }
spec: { type: LoadBalancer, selector: { app: web }, ports: [{ port: 80 }] }
`;

const NS = 'release-matrix';

export interface CheckResult {
  notes: string[];
  failed: boolean;
  /** Images the pods run (air-gap proof `images`). */
  images?: string[];
}

/** kubectl against the workload cluster; the kubeconfig lives in a private temp dir only. */
export class Workload {
  readonly #dir: string;
  readonly #kubeconfig: string;

  constructor(kubeconfig: string) {
    this.#dir = mkdtempSync(join(tmpdir(), 'release-matrix-'));
    this.#kubeconfig = join(this.#dir, 'kubeconfig');
    writeFileSync(this.#kubeconfig, kubeconfig, { mode: 0o600 });
  }

  dispose(): void {
    rmSync(this.#dir, { recursive: true, force: true });
  }

  k(args: string[], input?: string): Promise<{ ok: boolean; out: string }> {
    return new Promise((resolve) => {
      const child = execFile(
        'kubectl',
        ['--kubeconfig', this.#kubeconfig, '--request-timeout=20s', ...args],
        { maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ ok: !err, out: err ? `${stdout}${stderr}` : stdout }),
      );
      if (input !== undefined) child.stdin?.end(input);
    });
  }

  async json<T>(args: string[]): Promise<T | undefined> {
    const r = await this.k([...args, '-o', 'json']);
    if (!r.ok) return undefined;
    try {
      return JSON.parse(r.out) as T;
    } catch {
      return undefined;
    }
  }
}

interface NodeList {
  items: {
    metadata: { name: string };
    spec: { providerID?: string };
    status: {
      conditions: { type: string; status: string }[];
      nodeInfo: { kubeletVersion: string };
    };
  }[];
}
interface PodList {
  items: {
    metadata: { namespace: string; name: string };
    spec: { containers: { image: string }[]; initContainers?: { image: string }[] };
    status: { phase: string };
  }[];
}

/** Waits up to `seconds` for `test`, every 10 s; returns the last value. */
async function until<T>(
  seconds: number,
  get: () => Promise<T>,
  test: (v: T) => boolean,
): Promise<T> {
  let v = await get();
  for (let waited = 0; !test(v) && waited < seconds; waited += 10) {
    await sleep(10_000);
    v = await get();
  }
  return v;
}

export interface CheckOptions {
  expectedNodes: number;
  version: string;
  caseId: string;
  proof?: 'blocked' | 'images';
}

/** The checks of one cluster: nodes, version, provider IDs, pods, CSI, LoadBalancer, air gap. */
export async function checkWorkload(w: Workload, o: CheckOptions): Promise<CheckResult> {
  const notes: string[] = [];
  let failed = false;
  const ok = (n: string) => notes.push(n);
  const bad = (n: string) => {
    notes.push(`❌ ${n}`);
    failed = true;
  };

  const ready = (l?: NodeList) =>
    (l?.items ?? []).filter((n) =>
      n.status.conditions.some((c) => c.type === 'Ready' && c.status === 'True'),
    ).length;
  const nodes = await until(
    600,
    () => w.json<NodeList>(['get', 'nodes']),
    (l) => ready(l) >= o.expectedNodes,
  );
  const r = ready(nodes);
  if (r >= o.expectedNodes) ok(`${r}/${o.expectedNodes} Nodes Ready`);
  else bad(`only ${r}/${o.expectedNodes} nodes Ready`);
  const kubelets = [...new Set((nodes?.items ?? []).map((n) => n.status.nodeInfo.kubeletVersion))];
  const short = o.version.split('+')[0]!;
  if (kubelets.length && kubelets.every((v) => v.startsWith(short)))
    ok(`kubelet ${kubelets.join(' ')}`);
  else bad(`kubelet ${kubelets.join(' ') || '(none)'} instead of ${short}`);
  const withoutId = (nodes?.items ?? [])
    .filter((n) => !n.spec.providerID)
    .map((n) => n.metadata.name);
  if (nodes?.items.length && !withoutId.length) ok('provider ID set (CCM)');
  else bad(`provider ID missing (${withoutId.join(' ')})`);

  const notRunning = (l?: PodList) =>
    l
      ? l.items
          .filter((p) => !['Running', 'Succeeded'].includes(p.status.phase))
          .map((p) => `${p.metadata.namespace}/${p.metadata.name}(${p.status.phase})`)
      : ['(pods not readable)'];
  const pods = await until(
    360,
    () => w.json<PodList>(['get', 'pods', '-A']),
    (l) => !notRunning(l).length,
  );
  const stuck = notRunning(pods);
  if (!stuck.length) ok('all pods running');
  else bad(`pods: ${stuck.join(' ').slice(0, 300)}`);

  await w.k(['create', 'namespace', NS]);
  await w.k(['apply', '-n', NS, '-f', '-'], WORKLOAD);
  const deployed = await w.k([
    'wait',
    '-n',
    NS,
    'deploy/web',
    '--for=condition=Available',
    '--timeout=420s',
  ]);
  if (deployed.ok) {
    const pvc = (
      await w.k([
        'get',
        'pvc',
        '-n',
        NS,
        'data',
        '-o',
        'jsonpath={.status.phase}/{.spec.storageClassName}',
      ])
    ).out;
    ok(`PVC ${pvc}`);
    const body = `ok-${o.caseId}`;
    await w.k([
      'exec',
      '-n',
      NS,
      'deploy/web',
      '--',
      'sh',
      '-c',
      `echo ${body} > /usr/share/nginx/html/index.html`,
    ]);
    let addr = '';
    let answer = '';
    for (let i = 0; i < 60 && answer !== body; i++) {
      addr = (
        await w.k([
          'get',
          'svc',
          '-n',
          NS,
          'web',
          '-o',
          'jsonpath={.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}',
        ])
      ).out.trim();
      if (addr) {
        answer = await fetch(`http://${addr}/`, { signal: AbortSignal.timeout(4000) })
          .then((res) => res.text())
          .then((t) => t.trim())
          .catch(() => '');
      }
      if (answer !== body) await sleep(10_000);
    }
    if (answer === body) ok(`LoadBalancer ${addr} answers`);
    else {
      const events = (
        await w.k([
          'get',
          'events',
          '-n',
          NS,
          '--field-selector',
          'involvedObject.name=web,involvedObject.kind=Service',
          '-o',
          'jsonpath={range .items[*]}{.reason}: {.message} | {end}',
        ])
      ).out.slice(-400);
      bad(
        `LoadBalancer ${addr || 'without address'} does not answer (events: ${events || 'none'})`,
      );
    }
  } else {
    const pvc = (await w.k(['get', 'pvc', '-n', NS, 'data', '-o', 'jsonpath={.status.phase}'])).out;
    bad(`test workload not ready (PVC ${pvc || '?'})`);
  }

  let images: string[] | undefined;
  if (o.proof === 'blocked') {
    await w.k([
      'run',
      '-n',
      NS,
      'inet',
      '--image=docker.io/library/busybox:1.37',
      '--restart=Never',
      '--command',
      '--',
      'wget',
      '-q',
      '-T',
      '5',
      '-O',
      '/dev/null',
      'http://1.1.1.1',
    ]);
    const phase = await until(
      90,
      async () =>
        (await w.k(['get', 'pod', '-n', NS, 'inet', '-o', 'jsonpath={.status.phase}'])).out,
      (p) => p === 'Succeeded' || p === 'Failed',
    );
    if (phase === 'Failed') ok('no internet from a pod (wget 1.1.1.1 fails)');
    else bad(`a pod reaches the internet or did not run (${phase || 'no phase'})`);
  } else if (o.proof === 'images') {
    const all = await w.json<PodList>(['get', 'pods', '-A']);
    images = [
      ...new Set(
        (all?.items ?? []).flatMap((p) =>
          [...p.spec.containers, ...(p.spec.initContainers ?? [])].map((c) => c.image),
        ),
      ),
    ].sort();
    ok(`${images.length} images running (compare with the registry log)`);
  }
  await w.k(['delete', 'namespace', NS, '--wait=false']);
  return { notes, failed, ...(images ? { images } : {}) };
}
