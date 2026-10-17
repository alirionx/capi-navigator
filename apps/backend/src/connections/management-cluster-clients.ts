import { Injectable, NotFoundException } from '@nestjs/common';
import { KubeConfig } from '@kubernetes/client-node';
import { connectionSecretName } from '@capi-navigator/shared';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { StoreService } from '../store/store.service.js';
import { extractTarget, type ConnectionTarget } from './kubeconfig.js';

/**
 * Kubernetes clients for management clusters. Every operation runs with exactly the stored
 * credentials of its connection (NF-02). Clients are cached per connection and rebuilt when the
 * credentials change (spec.credentialsRevision), also on other replicas.
 */
@Injectable()
export class ManagementClusterClients {
  private readonly cache = new Map<string, { revision: number; kc: KubeConfig }>();

  constructor(
    private readonly store: StoreService,
    private readonly kube: KubeClientFactory,
  ) {}

  async forConnection(name: string): Promise<KubeConfig> {
    const conn = this.store.connectionCache.get(name);
    if (!conn) throw new NotFoundException(`Connection "${name}" not found`);
    if (conn.spec.authType === 'in-cluster') return this.kube.homeCluster();

    const cached = this.cache.get(name);
    if (cached && cached.revision === conn.spec.credentialsRevision) return cached.kc;

    const secret = await this.store.secrets.get(connectionSecretName(name));
    if (!secret?.kubeconfig) {
      throw new NotFoundException({
        statusCode: 404,
        message: `The credentials of connection "${name}" are missing`,
        hint: 'Edit the connection and enter the credentials again.',
      });
    }
    // Validate again: the Secret could have been edited outside the app.
    const kc = toKubeConfig(name, extractTarget(secret.kubeconfig));
    this.cache.set(name, { revision: conn.spec.credentialsRevision, kc });
    return kc;
  }

  /** Server URL of the home cluster, for the in-cluster connection. */
  homeServer(): string | undefined {
    return this.kube.homeCluster().getCurrentCluster()?.server;
  }

  forget(name: string): void {
    this.cache.delete(name);
  }
}

/** Builds a KubeConfig from validated settings only; no exec, auth-provider or file fields. */
export function toKubeConfig(name: string, t: ConnectionTarget): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [
      {
        name,
        server: t.server,
        caData: t.caData,
        tlsServerName: t.tlsServerName,
        skipTLSVerify: t.skipTlsVerify ?? false,
      },
    ],
    users: [
      {
        name,
        token: t.token,
        certData: t.certData,
        keyData: t.keyData,
        username: t.username,
        password: t.password,
      },
    ],
    contexts: [{ name, cluster: name, user: name }],
    currentContext: name,
  });
  return kc;
}
