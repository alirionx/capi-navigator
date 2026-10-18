import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `.kube/` of the repository, where `pnpm kind:up` writes the kubeconfig of its kind clusters. */
const KIND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.kube');

/**
 * Integration tests run only against a kind cluster created by the repository scripts
 * (`pnpm kind:up`, any KIND_CLUSTER_NAME), never against a cluster from the user's environment.
 */
export function requireKindCluster(): void {
  const kc = resolve(process.env.KUBECONFIG ?? '');
  if (dirname(kc) !== KIND_DIR || !/^kind-[a-z0-9-]+\.yaml$/.test(kc.slice(KIND_DIR.length + 1))) {
    throw new Error(
      'Refusing to run: KUBECONFIG must point to the local kind cluster (pnpm test:int)',
    );
  }
}
