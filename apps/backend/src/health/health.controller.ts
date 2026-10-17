import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@capi-navigator/shared';
import { HealthService } from './health.service.js';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

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

  /** NF-20: readiness – later packs add informer sync checks here. */
  @Get('readyz')
  readiness(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
