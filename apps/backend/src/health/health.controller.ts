import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import type { HealthResponse } from '@capi-navigator/shared';
import { Public } from '../auth/decorators.js';
import { StoreService } from '../store/store.service.js';
import { HealthService } from './health.service.js';
import { Api } from '../openapi/api.decorator.js';
import { HealthResponseSchema, ProbeStatusSchema } from '@capi-navigator/shared';

@Controller()
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly store: StoreService,
  ) {}

  /** FP0-F-03: status for the start page. */
  @Api({ summary: 'Version and home cluster status', response: HealthResponseSchema })
  @Get('api/health')
  getHealth(): Promise<HealthResponse> {
    return this.health.health();
  }

  /** NF-20: liveness – the process is up. */
  @Api({ summary: 'Liveness probe', response: ProbeStatusSchema })
  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** NF-20: readiness – informer caches of the home cluster are synced. */
  @Api({
    summary: 'Readiness probe: caches synced',
    description: 'Answers 503 until the caches of the home cluster are synced.',
    response: ProbeStatusSchema,
  })
  @Get('readyz')
  readiness(): { status: 'ok' } {
    if (!this.store.ready) throw new ServiceUnavailableException('Caches not synced');
    return { status: 'ok' };
  }
}
