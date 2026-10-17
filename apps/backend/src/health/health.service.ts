import { Injectable } from '@nestjs/common';
import { VersionApi } from '@kubernetes/client-node';
import type { HealthResponse, HomeClusterStatus } from '@capi-navigator/shared';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { APP_VERSION } from '../version.js';

const HOME_CLUSTER_TIMEOUT_MS = 3000;

@Injectable()
export class HealthService {
  constructor(private readonly kube: KubeClientFactory) {}

  async health(): Promise<HealthResponse> {
    return { status: 'ok', version: APP_VERSION, homeCluster: await this.homeCluster() };
  }

  async homeCluster(): Promise<HomeClusterStatus> {
    try {
      const api = this.kube.homeCluster().makeApiClient(VersionApi);
      const info = await withTimeout(api.getCode(), HOME_CLUSTER_TIMEOUT_MS);
      return { reachable: true, version: info.gitVersion };
    } catch (err) {
      return { reachable: false, message: describeError(err) };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Short reason without URLs or credentials (NF-01). */
function describeError(err: unknown): string {
  const code = (err as { code?: string }).code;
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ENOTFOUND') return 'API server host not found';
  if (err instanceof Error && err.message.startsWith('No answer')) return err.message;
  return 'Home cluster not reachable';
}
