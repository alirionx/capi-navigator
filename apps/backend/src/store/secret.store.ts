import { CoreV1Api, type KubeConfig, type V1Secret } from '@kubernetes/client-node';
import { isNotFound } from '../kube/errors.js';
import { FIELD_MANAGER } from './custom-resource.client.js';

/**
 * Access to Secrets in the app namespace of the home cluster (NF-01). Secret contents are never
 * cached in memory longer than a request and never logged.
 */
export class SecretStore {
  private readonly api: CoreV1Api;

  constructor(
    kc: KubeConfig,
    readonly namespace: string,
  ) {
    this.api = kc.makeApiClient(CoreV1Api);
  }

  /** Decoded data of a Secret, or undefined if it does not exist. */
  async get(name: string): Promise<Record<string, string> | undefined> {
    try {
      const secret = await this.api.readNamespacedSecret({ name, namespace: this.namespace });
      return decode(secret);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async create(
    name: string,
    data: Record<string, string>,
    labels: Record<string, string> = {},
  ): Promise<void> {
    await this.api.createNamespacedSecret({
      namespace: this.namespace,
      fieldManager: FIELD_MANAGER,
      body: {
        metadata: { name, namespace: this.namespace, labels: { ...BASE_LABELS, ...labels } },
        type: 'Opaque',
        data: encode(data),
      },
    });
  }

  /** Creates or fully replaces the data of a Secret. */
  async put(
    name: string,
    data: Record<string, string>,
    labels: Record<string, string> = {},
  ): Promise<void> {
    try {
      await this.api.replaceNamespacedSecret({
        name,
        namespace: this.namespace,
        fieldManager: FIELD_MANAGER,
        body: {
          metadata: { name, namespace: this.namespace, labels: { ...BASE_LABELS, ...labels } },
          type: 'Opaque',
          data: encode(data),
        },
      });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.create(name, data, labels);
    }
  }

  async delete(name: string): Promise<void> {
    try {
      await this.api.deleteNamespacedSecret({ name, namespace: this.namespace });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

const BASE_LABELS = { 'app.kubernetes.io/part-of': 'capi-navigator' };

function encode(data: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, Buffer.from(v, 'utf8').toString('base64')]),
  );
}

function decode(secret: V1Secret): Record<string, string> {
  return Object.fromEntries(
    Object.entries(secret.data ?? {}).map(([k, v]) => [
      k,
      Buffer.from(v, 'base64').toString('utf8'),
    ]),
  );
}
