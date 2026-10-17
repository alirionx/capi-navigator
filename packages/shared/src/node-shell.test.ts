import { describe, expect, it } from 'vitest';
import { buildShellPod, SHELL_MAX_SECONDS, shellPodName } from './node-shell.js';

describe('node shell pod (FP-17)', () => {
  it('runs privileged in the host namespaces, on the node, with a hard deadline', () => {
    const pod = buildShellPod({
      node: 'worker-1',
      id: 'abc12',
      image: 'alpine:3.22',
      user: 'otto',
    });
    const spec = pod.spec as Record<string, unknown>;
    expect(pod.metadata).toMatchObject({
      name: 'capi-navigator-shell-worker-1-abc12',
      namespace: 'kube-system',
      labels: { 'capi-navigator.io/node-shell': 'true' },
      annotations: { 'capi-navigator.io/user': 'otto' },
    });
    expect(spec).toMatchObject({
      nodeName: 'worker-1',
      hostPID: true,
      hostNetwork: true,
      activeDeadlineSeconds: SHELL_MAX_SECONDS,
      automountServiceAccountToken: false,
      tolerations: [{ operator: 'Exists' }],
    });
    expect((spec.containers as { securityContext: unknown }[])[0]!.securityContext).toEqual({
      privileged: true,
    });
  });

  it('keeps pod names valid for long node names', () => {
    const name = shellPodName('ip-10-0-189-64.eu-central-1.compute.internal', 'z9y8x');
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});
