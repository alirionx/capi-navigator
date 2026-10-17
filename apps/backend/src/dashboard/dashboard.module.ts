import { Controller, Get, Module, Param, Sse, type MessageEvent } from '@nestjs/common';
import type { Dashboard } from '@capi-navigator/shared';
import { interval, map, merge, type Observable } from 'rxjs';
import { Roles } from '../auth/decorators.js';
import { ClustersModule } from '../clusters/clusters.module.js';
import { DashboardService } from './dashboard.service.js';

const HEARTBEAT_MS = 25_000;

/** Read-only dashboard of a workload cluster (FP-18); viewers may read it. */
@Controller('api/connections/:connection/clusters/:namespace/:name/dashboard')
export class DashboardController {
  constructor(private readonly dashboards: DashboardService) {}

  @Roles('viewer')
  @Get()
  get(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Promise<Dashboard> {
    return this.dashboards.dashboard(connection, namespace, name);
  }

  @Roles('viewer')
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

/** FP-18: read-only cluster dashboard. */
@Module({
  imports: [ClustersModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
