import { AppModule } from '../app.module.js';
import { buildOpenApi, collectControllers } from './openapi.js';

/** The OpenAPI document of this backend (FP23-F-01), as formatted JSON. */
export function renderOpenApi(version: string): string {
  return `${JSON.stringify(buildOpenApi(collectControllers(AppModule), { version }), null, 2)}\n`;
}
