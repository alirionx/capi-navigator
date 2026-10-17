import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import type { HealthResponse } from '@capi-navigator/shared';
import { Public } from '../auth/decorators.js';
import { StoreService } from '../store/store.service.js';
import { HealthService } from './health.service.js';

@Controller()
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly store: StoreService,
  ) {}

  /** FP0-F-03: status for the start page. */
  @Get('api/health')
  getHealth(): Promise<HealthResponse> {
    return this.health.health();
  }

  /** NF-20: liveness – the process is up. */
  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** NF-20: readiness – informer caches of the home cluster are synced. */
  @Get('readyz')
  readiness(): { status: 'ok' } {
    if (!this.store.ready) throw new ServiceUnavailableException('Caches not synced');
    return { status: 'ok' };
  }
}
