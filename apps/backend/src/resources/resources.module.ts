import { Controller, Get, Module, Param, Query, Sse, type MessageEvent } from '@nestjs/common';
import {
  ResourceRefSchema,
  type ClusterResourceList,
  type ResourceRef,
  type ResourceYaml,
} from '@capi-navigator/shared';
import { from, interval, map, merge, mergeMap, type Observable } from 'rxjs';
import { z } from 'zod';
import { Requires } from '../auth/decorators.js';
import { ClustersModule } from '../clusters/clusters.module.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ConnectionsModule } from '../connections/connections.module.js';
import { ResourcesService } from './resources.service.js';

const HEARTBEAT_MS = 25_000;

/** Query of the YAML endpoints: the object reference flattened into query parameters. */
const YamlQuerySchema = z
  .object({
    apiVersion: z.string(),
    kind: z.string(),
    namespace: z.string().optional(),
    name: z.string(),
    clusterNamespace: z.string().optional(),
    clusterName: z.string().optional(),
    managedFields: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  })
  .transform((q) => ({
    ref: ResourceRefSchema.parse({
      apiVersion: q.apiVersion,
      kind: q.kind,
      ...(q.namespace ? { namespace: q.namespace } : {}),
      name: q.name,
      ...(q.clusterNamespace && q.clusterName
        ? { cluster: { namespace: q.clusterNamespace, name: q.clusterName } }
        : {}),
    }),
    managedFields: q.managedFields,
  }));
type YamlQuery = { ref: ResourceRef; managedFields: boolean };

/** Read-only YAML of resources (FP7-F-01 to F-05); viewers may read. */
@Controller('api/connections/:connection')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Requires('view')
  @Get('resources/yaml')
  yaml(
    @Param('connection') connection: string,
    @Query(new ZodValidationPipe(YamlQuerySchema)) q: YamlQuery,
  ): Promise<ResourceYaml> {
    return this.resources.yaml(connection, q.ref, q.managedFields);
  }

  /** FP7-F-02: live via watch on the object. */
  @Requires('view')
  @Sse('resources/yaml/events')
  stream(
    @Param('connection') connection: string,
    @Query(new ZodValidationPipe(YamlQuerySchema)) q: YamlQuery,
  ): Observable<MessageEvent> {
    return merge(
      from(this.resources.stream(connection, q.ref, q.managedFields)).pipe(
        mergeMap((s) => s),
        map((e) => ({ type: e.type, data: e })),
      ),
      interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'ping', data: {} }))),
    );
  }

  @Requires('view')
  @Get('clusters/:namespace/:name/resources')
  clusterResources(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Promise<ClusterResourceList> {
    return this.resources.clusterResources(connection, namespace, name);
  }
}

/** FP-7: read-only YAML view of resources. */
@Module({
  imports: [ConnectionsModule, ClustersModule],
  controllers: [ResourcesController],
  providers: [ResourcesService],
})
export class ResourcesModule {}
