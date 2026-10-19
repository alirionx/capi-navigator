import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_CONFIG, loadConfig } from '../config/config.js';
import { ConfigModule } from '../config/config.module.js';
import { configureApp } from '../configure-app.js';
import { OpenApiModule } from './openapi.module.js';

describe('API documentation over HTTP (FP23-F-04, FP23-F-06)', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(enabled: string) {
    const config = loadConfig({ API_DOCS_ENABLED: enabled, LOG_JSON: 'false' });
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, OpenApiModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app, config);
    await app.init();
    return request(app.getHttpServer());
  }

  it('serves the document and Swagger UI without external sources', async () => {
    const http = await start('true');
    const doc = await http.get('/api/openapi.json').expect(200);
    expect(doc.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(doc.text).openapi).toBe('3.1.0');
    await http.get('/api/docs').expect(301).expect('location', '/api/docs/');
    const page = await http.get('/api/docs/').expect(200);
    expect(page.text).toContain('vendor/swagger-ui-bundle.js');
    expect(page.text).not.toMatch(/https?:\/\//);
    expect(page.text).not.toMatch(/<script>[^<]/);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    await http.get('/api/docs/vendor/swagger-ui-bundle.js').expect(200);
    await http.get('/api/docs/init.js').expect(200);
  });

  it('answers 404 on both paths when switched off', async () => {
    const http = await start('false');
    await http.get('/api/openapi.json').expect(404);
    await http.get('/api/docs/').expect(404);
    await http.get('/api/docs/vendor/swagger-ui-bundle.js').expect(404);
  });
});
