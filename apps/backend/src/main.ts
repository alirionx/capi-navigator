import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/config.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  // NF-18: structured JSON logs.
  const logger = new ConsoleLogger({
    json: config.LOG_JSON,
    logLevels: logLevels(config.LOG_LEVEL),
  });
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
  app.enableShutdownHooks();

  if (config.STATIC_DIR) serveFrontend(app, resolve(config.STATIC_DIR), logger);

  await app.listen(config.PORT, config.HOST);
  logger.log(`CAPI Navigator backend listening on ${config.HOST}:${config.PORT}`, 'Bootstrap');
}

/** Single image: the backend serves the built SPA, with fallback to index.html (section 4). */
function serveFrontend(app: NestExpressApplication, dir: string, logger: ConsoleLogger): void {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) {
    logger.warn(`STATIC_DIR set but ${index} not found; frontend not served`, 'Bootstrap');
    return;
  }
  app.use(express.static(dir, { index: false }));
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const isApi = req.path.startsWith('/api/') || req.path === '/healthz' || req.path === '/readyz';
    if (req.method !== 'GET' || isApi) return next();
    res.sendFile(index);
  });
}

function logLevels(level: string): ('error' | 'warn' | 'log' | 'debug' | 'verbose')[] {
  const all = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
  return all.slice(0, all.indexOf(level as (typeof all)[number]) + 1);
}

void bootstrap();
