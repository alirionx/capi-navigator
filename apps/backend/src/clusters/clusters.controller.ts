import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Injectable,
  Param,
  Post,
  Res,
  Sse,
  type MessageEvent,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  ClusterCreateRequestSchema,
  type ClusterPreview,
  type ClusterStatus,
  type ClusterSummary,
} from '@capi-navigator/shared';
import type { Response } from 'express';
import { interval, map, merge, type Observable } from 'rxjs';
import type { z } from 'zod';
import { Audit, Roles } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { LiveChannels } from '../kube/live-channels.js';
import { ClustersService, listWatchPaths, namespaceWatchPaths } from './clusters.service.js';

type CreateBody = z.output<typeof ClusterCreateRequestSchema>;
const HEARTBEAT_MS = 25_000;

/** Live status of one cluster via watches (US-07, NF-11). Key: connection/namespace/name. */
@Injectable()
export class ClusterEventsService implements OnApplicationShutdown {
  readonly live: LiveChannels<ClusterStatus>;

  constructor(clusters: ClustersService, clients: ManagementClusterClients) {
    const parse = (key: string) => key.split('/') as [string, string, string];
    this.live = new LiveChannels('cluster', {
      kubeConfig: (key) => clients.forConnection(parse(key)[0]),
      paths: (key) => namespaceWatchPaths(parse(key)[1]),
      compute: (key) => {
        const [connection, ns, name] = parse(key);
        return clusters.status(connection, ns, name);
      },
    });
  }

  onApplicationShutdown(): void {
    this.live.stopAll();
  }
}

/** Live cluster list of one management cluster (FP6-F-01, NF-11). Key: connection. */
@Injectable()
export class ClusterListEventsService implements OnApplicationShutdown {
  readonly live: LiveChannels<ClusterSummary[]>;

  constructor(clusters: ClustersService, clients: ManagementClusterClients) {
    this.live = new LiveChannels('cluster-list', {
      kubeConfig: (connection) => clients.forConnection(connection),
      paths: () => listWatchPaths(),
      compute: (connection) => clusters.list(connection),
    });
  }

  onApplicationShutdown(): void {
    this.live.stopAll();
  }
}

const AUDIT = { managementClusterParam: 'connection', targetKind: 'Cluster' };

/** Workload clusters of one management cluster (FP-5). */
@Controller('api/connections/:connection/clusters')
export class ClustersController {
  constructor(
    private readonly clusters: ClustersService,
    private readonly events: ClusterEventsService,
    private readonly listEvents: ClusterListEventsService,
  ) {}

  @Roles('viewer')
  @Get()
  list(@Param('connection') connection: string): Promise<ClusterSummary[]> {
    return this.clusters.list(connection);
  }

  /** Live list (FP6-F-01); registered before ':namespace/:name' so "events" is not a namespace. */
  @Roles('viewer')
  @Sse('events')
  listStream(@Param('connection') connection: string): Observable<MessageEvent> {
    return merge(
      this.listEvents.live.stream(connection).pipe(map((e) => ({ type: e.type, data: e }))),
      interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'ping', data: {} }))),
    );
  }

  /** Preview: generated YAML, dry run and blockers (hard rule 6, FP5-F-08). */
  @Roles('operator')
  @Post('preview')
  @HttpCode(200)
  @Audit({ action: 'cluster.preview', skip: true })
  preview(
    @Param('connection') connection: string,
    @Body(new ZodValidationPipe(ClusterCreateRequestSchema)) body: CreateBody,
  ): Promise<ClusterPreview> {
    return this.clusters.preview(connection, body.spec, body.grantCredentialNamespace);
  }

  /** FP-5 step 8; node customization is recorded with the request (FP5-F-14). */
  @Roles('operator')
  @Post()
  @Audit({ action: 'cluster.create', ...AUDIT })
  create(
    @Param('connection') connection: string,
    @Body(new ZodValidationPipe(ClusterCreateRequestSchema)) body: CreateBody,
  ): Promise<ClusterSummary> {
    return this.clusters.create(connection, body.spec, body.grantCredentialNamespace);
  }

  @Roles('viewer')
  @Get(':namespace/:name')
  status(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Promise<ClusterStatus> {
    return this.clusters.status(connection, namespace, name);
  }

  /** FP6-F-04 / ADR-0005: shown in a dialog; operator and admin only, audited, not cached. */
  @Roles('operator')
  @Get(':namespace/:name/kubeconfig')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Audit({ action: 'cluster.kubeconfig.view', sensitiveRead: true, ...AUDIT, targetParam: 'name' })
  kubeconfig(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Promise<string> {
    return this.clusters.kubeconfig(connection, namespace, name);
  }

  /** FP6-F-04 / ADR-0005: download as `<cluster>.kubeconfig`. */
  @Roles('operator')
  @Get(':namespace/:name/kubeconfig/download')
  @Header('Content-Type', 'application/octet-stream')
  @Header('Cache-Control', 'no-store')
  @Audit({
    action: 'cluster.kubeconfig.download',
    sensitiveRead: true,
    ...AUDIT,
    targetParam: 'name',
  })
  async downloadKubeconfig(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const value = await this.clusters.kubeconfig(connection, namespace, name);
    res.setHeader('Content-Disposition', `attachment; filename="${name}.kubeconfig"`);
    return value;
  }

  @Roles('viewer')
  @Sse(':namespace/:name/events')
  stream(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Observable<MessageEvent> {
    return merge(
      this.events.live
        .stream(`${connection}/${namespace}/${name}`)
        .pipe(map((e) => ({ type: e.type, data: e }))),
      interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'ping', data: {} }))),
    );
  }
}
