import { CoreV1Api, KubernetesObjectApi, type KubeConfig } from '@kubernetes/client-node';
import { fetchOrcManifest } from '../../src/operator/orc-manifest.js';

/**
 * Removes ORC installed by a test and waits until its namespace is gone, so the next test can
 * install ORC again (applying into a terminating namespace fails).
 */
export async function removeOrc(kc: KubeConfig, version: string, timeoutMs = 3 * 60_000) {
  const objects = KubernetesObjectApi.makeApiClient(kc);
  for (const obj of (await fetchOrcManifest(version)).reverse()) {
    await objects.delete(obj).catch(() => undefined);
  }
  const core = kc.makeApiClient(CoreV1Api);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ns = await core.readNamespace({ name: 'orc-system' }).catch(() => undefined);
    if (!ns) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('orc-system was not deleted in time');
}
