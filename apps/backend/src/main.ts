import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadConfig, type AppConfig } from './config/config.js';
import { configureApp } from './configure-app.js';
import { isKnownStartupProblem, startupMessage } from './startup-error.js';

async function bootstrap(config: AppConfig, logger: ConsoleLogger): Promise<void> {
  // Live views keep server-sent event streams open; close them on shutdown instead of waiting
  // forever (rolling updates, dev restarts). Browsers reconnect to the next instance (NF-11).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
    forceCloseConnections: true,
  });
  app.enableShutdownHooks();
  configureApp(app, config);

  await app.listen(config.PORT, config.HOST);
  logger.log(`CAPI Navigator backend listening on ${config.HOST}:${config.PORT}`, 'Bootstrap');
}

function logLevels(level: string): ('error' | 'warn' | 'log' | 'debug' | 'verbose')[] {
  const all = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
  return all.slice(0, all.indexOf(level as (typeof all)[number]) + 1);
}

let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
// NF-18: structured JSON logs.
const logger = new ConsoleLogger({ json: config.LOG_JSON, logLevels: logLevels(config.LOG_LEVEL) });
bootstrap(config, logger).catch((err: unknown) => {
  // Known problems (missing namespace, API errors) as one clear line instead of a stack trace with
  // the raw API response; unexpected errors keep their stack.
  logger.error(
    `Cannot start: ${startupMessage(err)}`,
    isKnownStartupProblem(err) ? undefined : (err as Error)?.stack,
    'Bootstrap',
  );
  process.exit(1);
});
