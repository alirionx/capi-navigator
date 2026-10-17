import { z } from 'zod';
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, type ManifestObject } from './operator-manifests.js';

/**
 * Node shell (FP-17, ADR-0008): a short-lived privileged pod on the node; the terminal runs
 * `nsenter` into the namespaces of the host's PID 1, like `kubectl debug node` or Lens.
 */
export const SHELL_LABEL = 'capi-navigator.io/node-shell';
export const SHELL_NAMESPACE = 'kube-system';
/** Default image; override with NODE_SHELL_IMAGE (e.g. for a registry mirror, FP-16). */
export const SHELL_DEFAULT_IMAGE = 'alpine:3.22';
/** Hard limit of a session; the pod ends even if the backend dies. */
export const SHELL_MAX_SECONDS = 3600;
/** A session without input ends after this time. */
export const SHELL_IDLE_SECONDS = 900;

/** Enters all host namespaces of PID 1 and starts a login shell (bash if present). */
export const SHELL_COMMAND = [
  'nsenter',
  '--target',
  '1',
  '--mount',
  '--uts',
  '--ipc',
  '--net',
  '--pid',
  '--',
  'sh',
  '-c',
  'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi',
];

export function shellPodName(node: string, id: string): string {
  // Node names can be long (AWS private DNS); pod names must stay within 63 characters.
  return `capi-navigator-shell-${node.slice(0, 30).replace(/[^a-z0-9-]/g, '-')}-${id}`.slice(0, 63);
}

export function buildShellPod(opts: {
  node: string;
  id: string;
  image: string;
  user: string;
}): ManifestObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: shellPodName(opts.node, opts.id),
      namespace: SHELL_NAMESPACE,
      labels: { [SHELL_LABEL]: 'true', [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
      annotations: { 'capi-navigator.io/user': opts.user },
    },
    spec: {
      nodeName: opts.node,
      hostPID: true,
      hostNetwork: true,
      hostIPC: true,
      restartPolicy: 'Never',
      activeDeadlineSeconds: SHELL_MAX_SECONDS,
      terminationGracePeriodSeconds: 0,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      // Also on control plane and not-ready nodes: that is where troubleshooting happens.
      tolerations: [{ operator: 'Exists' }],
      containers: [
        {
          name: 'shell',
          image: opts.image,
          command: ['sleep', String(SHELL_MAX_SECONDS)],
          securityContext: { privileged: true },
          stdin: true,
          tty: true,
        },
      ],
    },
  };
}

/** Messages from the browser over the WebSocket. */
export const ShellClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(64 * 1024) }),
  z.object({
    type: z.literal('resize'),
    cols: z.int().min(1).max(1000),
    rows: z.int().min(1).max(1000),
  }),
]);
export type ShellClientMessage = z.infer<typeof ShellClientMessageSchema>;

/** Control messages to the browser (terminal output is sent as binary frames). */
export const ShellServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
    state: z.enum(['starting', 'connected', 'closed']),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string(), hint: z.string().optional() }),
]);
export type ShellServerMessage = z.infer<typeof ShellServerMessageSchema>;

/** Nodes of the management cluster (for the node shell, FP-17). */
export const ClusterNodeSchema = z.object({
  name: z.string(),
  ready: z.boolean(),
  roles: z.array(z.string()),
  kubeletVersion: z.string().optional(),
  internalIP: z.string().optional(),
  osImage: z.string().optional(),
});
export type ClusterNode = z.infer<typeof ClusterNodeSchema>;
export const ClusterNodeListSchema = z.array(ClusterNodeSchema);
