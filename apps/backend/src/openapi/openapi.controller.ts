import { Controller, Get, Header, Inject, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../auth/decorators.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { APP_VERSION } from '../version.js';
import { Api } from './api.decorator.js';
import { renderOpenApi } from './render.js';

/**
 * The OpenAPI document (FP23-F-04): public by decision of the product owner (ADR-0016), off with
 * API_DOCS_ENABLED=false. Swagger UI under /api/docs is served as static files (configure-app.ts).
 */
@Controller('api')
export class OpenApiController {
  private document?: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Api({
    summary: 'This OpenAPI 3.1 document',
    description: 'Generated from the route metadata and the Zod schemas of the validation.',
    response: z.record(z.string(), z.unknown()),
  })
  @Public()
  @Get('openapi.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  openApi(): string {
    if (!this.config.API_DOCS_ENABLED) throw new NotFoundException();
    // Built once per process: the routes do not change at runtime.
    this.document ??= renderOpenApi(APP_VERSION);
    return this.document;
  }
}
