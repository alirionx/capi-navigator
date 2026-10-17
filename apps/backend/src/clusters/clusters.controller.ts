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
  applySpecChange,
  ChangeRequestSchema,
  BastionRequestSchema,
  setBastion,
  ClusterCreateRequestSchema,
  DeleteRequestSchema,
  type DeletePreview,
  type DeletionStatus,
  LabelsRequestSchema,
  ScaleRequestSchema,
  scalePool,
  setLabels,
  type ClusterChangePreview,
  type ClusterSpec,
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
import { ClusterDeletionService } from './cluster-deletion.service.js';
import { ClustersService, listWatchPaths, namespaceWatchPaths } from './clusters.service.js';

type CreateBody = z.output<typeof ClusterCreateRequestSchema>;
type ScaleBody = z.output<typeof ScaleRequestSchema>;
type LabelsBody = z.output<typeof LabelsRequestSchema>;
type DeleteBody = z.output<typeof DeleteRequestSchema>;
type BastionBody = z.output<typeof BastionRequestSchema>;
type ChangeBody = z.output<typeof ChangeRequestSchema>;
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
    private readonly deletion: ClusterDeletionService,
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

  // ---- spec changes: preview first, then apply (hard rule 6) ----

  /** The stored cluster spec for day-2 forms (FP-7); operators only (node customization). */
  @Roles('operator')
  @Get(':namespace/:name/spec')
  spec(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Promise<ClusterSpec> {
    return this.clusters.storedSpec(connection, namespace, name);
  }

  /** FP-7: every day-2 change of the stored spec (scale, pools, machines, upgrade, rebuild, …). */
  @Roles('operator')
  @Post(':namespace/:name/changes/preview')
  @HttpCode(200)
  @Audit({ action: 'cluster.change.preview', skip: true })
  changesPreview(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(ChangeRequestSchema)) body: ChangeBody,
  ): Promise<ClusterChangePreview> {
    const now = new Date();
    return this.clusters.changePreview(
      connection,
      namespace,
      name,
      (s) => applySpecChange(s, body.change, now),
      { upgrade: body.change.type === 'upgrade' },
    );
  }

  @Roles('operator')
  @Post(':namespace/:name/changes')
  @HttpCode(200)
  @Audit({
    action: 'cluster.change',
    actionSuffixFromBody: 'change.type',
    ...AUDIT,
    targetParam: 'name',
  })
  changes(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(ChangeRequestSchema)) body: ChangeBody,
  ): Promise<ClusterChangePreview> {
    const now = new Date();
    return this.clusters.applyChange(
      connection,
      namespace,
      name,
      (s) => applySpecChange(s, body.change, now),
      body.takeOver,
      { upgrade: body.change.type === 'upgrade' },
    );
  }

  @Roles('operator')
  @Post(':namespace/:name/scale/preview')
  @HttpCode(200)
  @Audit({ action: 'cluster.scale.preview', skip: true })
  scalePreview(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(ScaleRequestSchema)) body: ScaleBody,
  ): Promise<ClusterChangePreview> {
    return this.clusters.changePreview(connection, namespace, name, (s) =>
      scalePool(s, body.pool, body.replicas),
    );
  }

  /** FP6-F-05. */
  @Roles('operator')
  @Post(':namespace/:name/scale')
  @HttpCode(200)
  @Audit({ action: 'cluster.scale', ...AUDIT, targetParam: 'name' })
  scale(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(ScaleRequestSchema)) body: ScaleBody,
  ): Promise<ClusterChangePreview> {
    return this.clusters.applyChange(
      connection,
      namespace,
      name,
      (s) => scalePool(s, body.pool, body.replicas),
      body.takeOver,
    );
  }

  @Roles('operator')
  @Post(':namespace/:name/labels/preview')
  @HttpCode(200)
  @Audit({ action: 'cluster.labels.preview', skip: true })
  labelsPreview(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(LabelsRequestSchema)) body: LabelsBody,
  ): Promise<ClusterChangePreview> {
    return this.clusters.changePreview(connection, namespace, name, (s) =>
      setLabels(s, body.labels),
    );
  }

  /** FP6-F-07. */
  @Roles('operator')
  @Post(':namespace/:name/labels')
  @HttpCode(200)
  @Audit({ action: 'cluster.labels', ...AUDIT, targetParam: 'name' })
  labels(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(LabelsRequestSchema)) body: LabelsBody,
  ): Promise<ClusterChangePreview> {
    return this.clusters.applyChange(
      connection,
      namespace,
      name,
      (s) => setLabels(s, body.labels),
      body.takeOver,
    );
  }

  // ---- deletion (FP6-F-06) ----

  /** What a deletion removes, shown before confirming (hard rule 6). */
  @Roles('operator')
  @Get(':namespace/:name/delete-preview')
  deletePreview(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Promise<DeletePreview> {
    return this.deletion.preview(connection, namespace, name);
  }

  /** Confirmed by typing the cluster name; cleanup inside the cluster first (default). */
  @Roles('operator')
  @Post(':namespace/:name/delete')
  @HttpCode(202)
  @Audit({ action: 'cluster.delete', ...AUDIT, targetParam: 'name' })
  delete(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(DeleteRequestSchema)) body: DeleteBody,
  ): Promise<DeletionStatus> {
    return this.deletion.delete(connection, namespace, name, body);
  }

  @Roles('operator')
  @Post(':namespace/:name/bastion/preview')
  @HttpCode(200)
  @Audit({ action: 'cluster.bastion.preview', skip: true })
  bastionPreview(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(BastionRequestSchema)) body: BastionBody,
  ): Promise<ClusterChangePreview> {
    return this.clusters.changePreview(connection, namespace, name, (s) =>
      setBastion(s, body.bastion),
    );
  }

  /** FP5-F-20: enable, disable or reconfigure the bastion host. */
  @Roles('operator')
  @Post(':namespace/:name/bastion')
  @HttpCode(200)
  @Audit({ action: 'cluster.bastion', ...AUDIT, targetParam: 'name' })
  bastion(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(BastionRequestSchema)) body: BastionBody,
  ): Promise<ClusterChangePreview> {
    return this.clusters.applyChange(
      connection,
      namespace,
      name,
      (s) => setBastion(s, body.bastion),
      body.takeOver,
    );
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
