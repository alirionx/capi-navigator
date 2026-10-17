import {
  CustomObjectsApi,
  PatchStrategy,
  setHeaderOptions,
  type KubeConfig,
} from '@kubernetes/client-node';
import {
  NAVIGATOR_API_VERSION,
  NAVIGATOR_GROUP,
  NAVIGATOR_VERSION,
  type CrdDefinition,
  type NavigatorResource,
} from '@capi-navigator/shared';
import type { z } from 'zod';

export const FIELD_MANAGER = 'capi-navigator';

const MERGE_PATCH = setHeaderOptions('Content-Type', PatchStrategy.MergePatch);

/** Typed CRUD access to one of the app's own namespaced CRDs in the home cluster. */
export class CustomResourceClient<TSchema extends z.ZodType> {
  private readonly api: CustomObjectsApi;

  constructor(
    kc: KubeConfig,
    readonly namespace: string,
    readonly def: CrdDefinition<TSchema>,
  ) {
    this.api = kc.makeApiClient(CustomObjectsApi);
  }

  private get coords() {
    return {
      group: NAVIGATOR_GROUP,
      version: NAVIGATOR_VERSION,
      namespace: this.namespace,
      plural: this.def.plural,
    };
  }

  /** API path used by watches, e.g. /apis/navigator.capi-navigator.io/v1alpha1/namespaces/x/navigatorusers */
  get path(): string {
    return `/apis/${NAVIGATOR_GROUP}/${NAVIGATOR_VERSION}/namespaces/${this.namespace}/${this.def.plural}`;
  }

  async list(
    params: { labelSelector?: string; limit?: number; _continue?: string } = {},
  ): Promise<{ items: NavigatorResource<z.infer<TSchema>>[]; continue?: string }> {
    const res = (await this.api.listNamespacedCustomObject({ ...this.coords, ...params })) as {
      items: NavigatorResource<z.infer<TSchema>>[];
      metadata?: { continue?: string };
    };
    return { items: res.items, continue: res.metadata?.continue || undefined };
  }

  async create(
    metadata: { name?: string; generateName?: string; labels?: Record<string, string> },
    spec: z.infer<TSchema>,
  ): Promise<NavigatorResource<z.infer<TSchema>>> {
    const body = {
      apiVersion: NAVIGATOR_API_VERSION,
      kind: this.def.kind,
      metadata: { ...metadata, namespace: this.namespace },
      spec: this.def.spec.parse(spec),
    };
    return (await this.api.createNamespacedCustomObject({
      ...this.coords,
      body,
      fieldManager: FIELD_MANAGER,
    })) as NavigatorResource<z.infer<TSchema>>;
  }

  /** JSON merge patch of `spec`, optionally guarded by resourceVersion (optimistic locking). */
  async patchSpec(
    name: string,
    spec: Partial<z.infer<TSchema>>,
    resourceVersion?: string,
  ): Promise<NavigatorResource<z.infer<TSchema>>> {
    const body = { metadata: resourceVersion ? { resourceVersion } : {}, spec };
    return (await this.api.patchNamespacedCustomObject(
      { ...this.coords, name, body, fieldManager: FIELD_MANAGER },
      MERGE_PATCH,
    )) as NavigatorResource<z.infer<TSchema>>;
  }

  /** JSON merge patch of the status subresource. */
  async patchStatus(name: string, status: unknown): Promise<NavigatorResource<z.infer<TSchema>>> {
    return (await this.api.patchNamespacedCustomObjectStatus(
      { ...this.coords, name, body: { status }, fieldManager: FIELD_MANAGER },
      MERGE_PATCH,
    )) as NavigatorResource<z.infer<TSchema>>;
  }

  async delete(name: string): Promise<void> {
    await this.api.deleteNamespacedCustomObject({ ...this.coords, name });
  }
}
