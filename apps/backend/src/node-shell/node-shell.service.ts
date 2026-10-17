import { randomBytes } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CoreV1Api, Exec, KubeConfig, type V1Pod } from '@kubernetes/client-node';
import {
  buildShellPod,
  SHELL_COMMAND,
  SHELL_IDLE_SECONDS,
  SHELL_LABEL,
  SHELL_MAX_SECONDS,
  SHELL_NAMESPACE,
  type ClusterNode,
  type ShellClientMessage,
  type ShellServerMessage,
} from '@capi-navigator/shared';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { ClustersService } from '../clusters/clusters.service.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { kubeStatus, toHttpException } from '../kube/errors.js';

/** Which node to open a shell on: in a workload cluster or in the management cluster itself. */
export type ShellTarget =
  | { kind: 'workload'; connection: string; namespace: string; cluster: string; node: string }
  | { kind: 'management'; connection: string; node: string };

/** The browser side of a session (the WebSocket), kept abstract for tests. */
export interface ShellPeer {
  sendOutput(data: Buffer): void;
  sendControl(msg: ShellServerMessage): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (msg: ShellClientMessage) => void): void;
  onClose(handler: () => void): void;
}

/** Terminal output stream with a size, so the Kubernetes exec forwards resizes. */
class TerminalOutput extends Writable {
  rows = 24;
  columns = 80;
  constructor(private readonly peer: ShellPeer) {
    super();
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, done: () => void): void {
    this.peer.sendOutput(chunk);
    done();
  }
  resize(cols: number, rows: number): void {
    this.columns = cols;
    this.rows = rows;
    this.emit('resize');
  }
}

const POD_READY_TIMEOUT_MS = 120_000;

/**
 * Node shell (FP-17, ADR-0008): creates a privileged pod on the node, runs `nsenter` into the
 * host namespaces with a TTY and connects it to the browser. The pod is deleted when the session
 * ends; `activeDeadlineSeconds` ends it even if the backend dies. Start and end are audited.
 */
@Injectable()
export class NodeShellService {
  private readonly logger = new Logger(NodeShellService.name);
  /** Timing; overridable in tests. */
  timing = { pollMs: 1000, idleMs: SHELL_IDLE_SECONDS * 1000 };

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clients: ManagementClusterClients,
    private readonly clusters: ClustersService,
    private readonly audit: AuditService,
  ) {}

  /** Nodes of the management cluster (FP-17). */
  async managementNodes(connection: string): Promise<ClusterNode[]> {
    const kc = await this.clients.forConnection(connection);
    try {
      const nodes = await kc.makeApiClient(CoreV1Api).listNode();
      return nodes.items.map((n) => {
        const labels = n.metadata?.labels ?? {};
        return {
          name: n.metadata!.name!,
          ready: !!n.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
          roles: Object.keys(labels)
            .filter((l) => l.startsWith('node-role.kubernetes.io/'))
            .map((l) => l.slice('node-role.kubernetes.io/'.length)),
          ...(n.status?.nodeInfo?.kubeletVersion
            ? { kubeletVersion: n.status.nodeInfo.kubeletVersion }
            : {}),
          ...(n.status?.nodeInfo?.osImage ? { osImage: n.status.nodeInfo.osImage } : {}),
          ...(n.status?.addresses?.find((a) => a.type === 'InternalIP')?.address
            ? { internalIP: n.status.addresses.find((a) => a.type === 'InternalIP')!.address }
            : {}),
        };
      });
    } catch (err) {
      throw toHttpException(err, 'List the nodes');
    }
  }

  /** Runs one session until the browser or the shell ends it. */
  async run(principal: Principal, target: ShellTarget, peer: ShellPeer): Promise<void> {
    const kc = await this.kubeConfigFor(target);
    const core = kc.makeApiClient(CoreV1Api);
    const id = randomBytes(4).toString('hex').slice(0, 5);
    const pod = buildShellPod({
      node: target.node,
      id,
      image: this.config.NODE_SHELL_IMAGE,
      user: principal.username,
    });
    const podName = pod.metadata.name;
    let closed = false;
    let idle: NodeJS.Timeout | undefined;
    const audit = (action: string, outcome: 'success' | 'failure', message?: string) =>
      this.audit
        .record({
          actor: principal.username,
          action,
          outcome,
          target: {
            kind: 'Node',
            name: target.node,
            ...(target.kind === 'workload'
              ? { namespace: `${target.namespace}/${target.cluster}` }
              : {}),
          },
          managementCluster: target.connection,
          ...(message ? { message } : {}),
        })
        .catch(() => undefined);

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      await core
        .deleteNamespacedPod({ name: podName, namespace: SHELL_NAMESPACE, gracePeriodSeconds: 0 })
        .catch(() => undefined);
      await audit('node.shell.end', 'success');
    };
    peer.onClose(() => void cleanup());

    try {
      peer.sendControl({ type: 'status', state: 'starting', message: `Starting ${podName}…` });
      await this.removeStalePods(core);
      await core.createNamespacedPod({ namespace: SHELL_NAMESPACE, body: pod as V1Pod });
      await this.waitRunning(core, podName, (message) =>
        peer.sendControl({ type: 'status', state: 'starting', message }),
      );
      if (closed) return;

      const stdin = new PassThrough();
      const stdout = new TerminalOutput(peer);
      const resetIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          peer.sendControl({ type: 'status', state: 'closed', message: 'Closed after inactivity' });
          peer.close(1000, 'idle');
        }, this.timing.idleMs);
      };
      peer.onMessage((msg) => {
        if (msg.type === 'input') {
          stdin.write(msg.data);
          resetIdle();
        } else {
          stdout.resize(msg.cols, msg.rows);
        }
      });
      resetIdle();
      await audit('node.shell.start', 'success');
      const socket = await new Exec(kc).exec(
        SHELL_NAMESPACE,
        podName,
        'shell',
        SHELL_COMMAND,
        stdout,
        stdout,
        stdin,
        true,
        (status) => {
          const message = status.status === 'Success' ? 'Shell ended' : (status.message ?? '');
          peer.sendControl({ type: 'status', state: 'closed', message });
          peer.close(1000, 'ended');
        },
      );
      peer.sendControl({ type: 'status', state: 'connected' });
      peer.onClose(() => socket.close());
    } catch (err) {
      const message = describe(err);
      this.logger.warn(`Node shell on ${target.node} failed: ${message}`);
      await audit('node.shell.start', 'failure', message.slice(0, 300));
      peer.sendControl({
        type: 'error',
        message: `The shell could not be started: ${message}`,
        hint: 'Check that the node is Ready and can pull the shell image (NODE_SHELL_IMAGE).',
      });
      peer.close(1011, 'failed');
      await cleanup();
    }
  }

  private async kubeConfigFor(target: ShellTarget): Promise<KubeConfig> {
    if (target.kind === 'management') return this.clients.forConnection(target.connection);
    const raw = await this.clusters.kubeconfig(target.connection, target.namespace, target.cluster);
    const kc = new KubeConfig();
    kc.loadFromString(raw);
    return kc;
  }

  private async waitRunning(
    core: CoreV1Api,
    name: string,
    report: (message: string) => void,
  ): Promise<void> {
    const deadline = Date.now() + POD_READY_TIMEOUT_MS;
    let last = '';
    while (Date.now() < deadline) {
      const pod = await core.readNamespacedPod({ name, namespace: SHELL_NAMESPACE });
      if (pod.status?.phase === 'Running') return;
      if (pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded') {
        throw new Error(`Shell pod ended (${pod.status.phase}): ${pod.status.message ?? ''}`);
      }
      const waiting = pod.status?.containerStatuses?.[0]?.state?.waiting;
      const message = waiting?.reason
        ? `${waiting.reason}${waiting.message ? `: ${waiting.message}` : ''}`
        : `Pod ${pod.status?.phase ?? 'Pending'}`;
      if (/ErrImagePull|ImagePullBackOff|InvalidImageName/.test(waiting?.reason ?? '')) {
        throw new Error(message);
      }
      if (message !== last) report(message);
      last = message;
      await new Promise((r) => setTimeout(r, this.timing.pollMs));
    }
    throw new Error('The shell pod did not start within 2 minutes');
  }

  /** Shell pods that outlived a session (backend restart) or their deadline. */
  private async removeStalePods(core: CoreV1Api): Promise<void> {
    const pods = await core
      .listNamespacedPod({ namespace: SHELL_NAMESPACE, labelSelector: `${SHELL_LABEL}=true` })
      .catch(() => ({ items: [] as V1Pod[] }));
    const now = Date.now();
    for (const p of pods.items) {
      const age = now - new Date(p.metadata?.creationTimestamp ?? now).getTime();
      const done = p.status?.phase === 'Failed' || p.status?.phase === 'Succeeded';
      if (done || age > SHELL_MAX_SECONDS * 1000) {
        await core
          .deleteNamespacedPod({ name: p.metadata!.name!, namespace: SHELL_NAMESPACE })
          .catch(() => undefined);
      }
    }
  }
}

function describe(err: unknown): string {
  const status = kubeStatus(err);
  if (status === 403) return 'missing permissions to create pods or exec in kube-system';
  if (err instanceof Error) return err.message;
  return String(err);
}
