import {
  Controller,
  Get,
  Header,
  Module,
  Param,
  Query,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import type { Dashboard, WorkloadLogs } from '@capi-navigator/shared';
import { interval, map, merge, type Observable } from 'rxjs';
import { Audit, Requires } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ClustersModule } from '../clusters/clusters.module.js';
import { DashboardService } from './dashboard.service.js';
import { Api, liveEvents } from '../openapi/api.decorator.js';
import {
  DashboardSchema,
  WorkloadLogsQuerySchema,
  WorkloadLogsSchema,
} from '@capi-navigator/shared';
import type { LogsRequest } from './workload-logs.js';

const HEARTBEAT_MS = 25_000;

/** Read-only dashboard of a workload cluster (FP-18); viewers may read it. */
@Controller('api/connections/:connection/clusters/:namespace/:name/dashboard')
export class DashboardController {
  constructor(private readonly dashboards: DashboardService) {}

  @Requires('view')
  @Api({
    summary: 'Read-only dashboard of a workload cluster: nodes, workloads, services, events',
    description:
      'Read with the cluster kubeconfig; Secrets and ConfigMaps are never read (ADR-0009).',
    response: DashboardSchema,
  })
  @Get()
  get(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Promise<Dashboard> {
    return this.dashboards.dashboard(connection, namespace, name);
  }

  @Requires('view')
  @Api({
    summary: 'Dashboard refreshed every 15 seconds while open',
    response: { events: liveEvents(DashboardSchema) },
  })
  @Sse('events')
  stream(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Observable<MessageEvent> {
    return merge(
      this.dashboards
        .stream(connection, namespace, name)
        .pipe(map((e) => ({ type: e.type, data: e }))),
      interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'ping', data: {} }))),
    );
  }
}

/**
 * FP18-F-07: logs of a workload. Logs may contain secrets, so they need their own permission
 * and every read is audited like the kubeconfig (ADR-0036).
 */
@Controller('api/connections/:connection/clusters/:namespace/:name/logs')
export class WorkloadLogsController {
  constructor(private readonly dashboards: DashboardService) {}

  @Requires('clusters.logs')
  @Api({
    summary: 'Logs of a workload in a workload cluster (one container, newest lines)',
    description:
      'Pods are found through the selector of the workload; without pod and container the most interesting pod (not ready, most restarts) and its default container are read. Every access is audited (ADR-0036); not cached.',
    response: WorkloadLogsSchema,
  })
  @Get()
  @Header('Cache-Control', 'no-store')
  @Audit({
    action: 'cluster.logs.view',
    sensitiveRead: true,
    managementClusterParam: 'connection',
    targetKind: 'Cluster',
    targetParam: 'name',
  })
  logs(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Query(new ZodValidationPipe(WorkloadLogsQuerySchema)) query: LogsRequest,
  ): Promise<WorkloadLogs> {
    return this.dashboards.logs(connection, namespace, name, query);
  }
}

/** FP-18: read-only cluster dashboard. */
@Module({
  imports: [ClustersModule],
  controllers: [DashboardController, WorkloadLogsController],
  providers: [DashboardService],
})
export class DashboardModule {}
