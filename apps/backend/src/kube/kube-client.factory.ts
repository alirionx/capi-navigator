import { Injectable } from '@nestjs/common';
import { KubeConfig } from '@kubernetes/client-node';

/**
 * Creates Kubernetes clients for the home cluster.
 *
 * Uses `KUBECONFIG` in local development and the in-cluster service account when running
 * inside Kubernetes (section 4, Operations). Connections to further management clusters
 * are added in FP-2.
 */
@Injectable()
export class KubeClientFactory {
  private homeConfig?: KubeConfig;

  homeCluster(): KubeConfig {
    if (!this.homeConfig) {
      const kc = new KubeConfig();
      kc.loadFromDefault();
      this.homeConfig = kc;
    }
    return this.homeConfig;
  }
}
