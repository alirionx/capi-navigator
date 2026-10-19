import { Module } from '@nestjs/common';
import { OpenApiController } from './openapi.controller.js';

/** OpenAPI description and Swagger UI (FP-23). */
@Module({ controllers: [OpenApiController] })
export class OpenApiModule {}
