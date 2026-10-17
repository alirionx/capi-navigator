import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/config.js';
import { configureApp } from './configure-app.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  // NF-18: structured JSON logs.
  const logger = new ConsoleLogger({
    json: config.LOG_JSON,
    logLevels: logLevels(config.LOG_LEVEL),
  });
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
  app.enableShutdownHooks();
  configureApp(app, config);

  await app.listen(config.PORT, config.HOST);
  logger.log(`CAPI Navigator backend listening on ${config.HOST}:${config.PORT}`, 'Bootstrap');
}

function logLevels(level: string): ('error' | 'warn' | 'log' | 'debug' | 'verbose')[] {
  const all = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
  return all.slice(0, all.indexOf(level as (typeof all)[number]) + 1);
}

void bootstrap();
