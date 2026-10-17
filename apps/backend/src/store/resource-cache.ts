import { Logger } from '@nestjs/common';
import {
  makeInformer,
  type Informer,
  type KubeConfig,
  type KubernetesObject,
} from '@kubernetes/client-node';
import type { NavigatorResource } from '@capi-navigator/shared';
import type { z } from 'zod';
import type { CustomResourceClient } from './custom-resource.client.js';

const RESTART_DELAY_MS = 5000;

/**
 * Informer-backed cache of one of the app's CRDs (STATE-03). Reads never hit the API server.
 * Dropped watches are re-established automatically (NF-11). Writes made through this process
 * are reflected immediately (write-through), so a read right after a write sees the change.
 */
export class ResourceCache<TSchema extends z.ZodType> {
  private readonly logger: Logger;
  private readonly items = new Map<string, NavigatorResource<z.infer<TSchema>>>();
  private informer?: Informer<KubernetesObject>;
  private stopped = false;
  private synced = false;

  constructor(
    private readonly kc: KubeConfig,
    private readonly client: CustomResourceClient<TSchema>,
  ) {
    this.logger = new Logger(`ResourceCache(${client.def.kind})`);
  }

  get isSynced(): boolean {
    return this.synced;
  }

  async start(): Promise<void> {
    type Obj = NavigatorResource<z.infer<TSchema>>;
    // NavigatorResource is a structural subset of KubernetesObject; the casts only bridge the
    // client's Date-typed metadata fields, which are plain strings on the wire.
    const informer = makeInformer<KubernetesObject>(this.kc, this.client.path, () =>
      this.client.list().then((r) => ({
        apiVersion: 'v1',
        kind: 'List',
        metadata: {},
        items: r.items as unknown as KubernetesObject[],
      })),
    );
    informer.on('add', (obj) => this.upsert(obj as unknown as Obj));
    informer.on('update', (obj) => this.upsert(obj as unknown as Obj));
    informer.on('delete', (obj) => obj.metadata?.name && this.items.delete(obj.metadata.name));
    informer.on('error', (err) => {
      this.synced = false;
      if (this.stopped) return;
      this.logger.warn(`Watch dropped (${describe(err)}); restarting in ${RESTART_DELAY_MS} ms`);
      setTimeout(() => void this.restart(), RESTART_DELAY_MS);
    });
    this.informer = informer;
    await informer.start();
    this.synced = true;
  }

  private async restart(): Promise<void> {
    if (this.stopped || !this.informer) return;
    try {
      await this.informer.start();
      this.synced = true;
      this.logger.log('Watch re-established');
    } catch (err) {
      this.logger.warn(`Restart failed (${describe(err)}); retrying in ${RESTART_DELAY_MS} ms`);
      setTimeout(() => void this.restart(), RESTART_DELAY_MS);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.informer?.stop();
  }

  get(name: string): NavigatorResource<z.infer<TSchema>> | undefined {
    return this.items.get(name);
  }

  list(): NavigatorResource<z.infer<TSchema>>[] {
    return [...this.items.values()].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }

  /** Write-through after a successful create or update by this process. */
  upsert(obj: NavigatorResource<z.infer<TSchema>>): void {
    const parsed = this.client.def.spec.safeParse(obj.spec);
    if (!parsed.success) {
      this.logger.warn(`Ignoring ${obj.metadata.name}: spec does not match the schema`);
      return;
    }
    const current = this.items.get(obj.metadata.name);
    if (current && isOlder(obj.metadata.resourceVersion, current.metadata.resourceVersion)) return;
    const statusSchema = this.client.def.status;
    const status =
      statusSchema && obj.status !== undefined ? statusSchema.safeParse(obj.status) : undefined;
    this.items.set(obj.metadata.name, {
      ...obj,
      spec: parsed.data,
      status: status?.success ? status.data : undefined,
    });
  }

  /** Write-through after a successful delete by this process. */
  remove(name: string): void {
    this.items.delete(name);
  }
}

/**
 * resourceVersions are opaque, but etcd-backed API servers use increasing integers. Only when
 * both are integers can a stale event be detected; otherwise the newer event wins.
 */
function isOlder(candidate?: string, current?: string): boolean {
  if (!candidate || !current || !/^\d+$/.test(candidate) || !/^\d+$/.test(current)) return false;
  return BigInt(candidate) < BigInt(current);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
