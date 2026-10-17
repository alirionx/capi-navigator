import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { SecurityMiddleware } from './common/security.middleware.js';
import type { AppConfig } from './config/config.js';

/** HTTP setup shared by main.ts and the integration tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');
  // Registered before static files, so security headers (NF-04) also cover the SPA.
  const security = new SecurityMiddleware();
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) =>
    security.use(req, res, next),
  );
  if (config.STATIC_DIR) serveFrontend(app, resolve(config.STATIC_DIR));
}

/** Single image: the backend serves the built SPA, with fallback to index.html (section 4). */
function serveFrontend(app: NestExpressApplication, dir: string): void {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) {
    new Logger('Bootstrap').warn(`STATIC_DIR set but ${index} not found; frontend not served`);
    return;
  }
  app.use(express.static(dir, { index: false }));
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const isApi = req.path.startsWith('/api/') || req.path === '/healthz' || req.path === '/readyz';
    if (req.method !== 'GET' || isApi) return next();
    res.sendFile(index);
  });
}
