import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '@capi-navigator/shared';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { HealthModule } from './health.module.js';
import { KubeModule } from '../kube/kube.module.js';

describe('HealthController (FP0-F-03, NF-20)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [KubeModule, HealthModule] })
      .overrideProvider(KubeClientFactory)
      .useValue({
        homeCluster: () => ({
          makeApiClient: () => ({ getCode: () => Promise.resolve({ gitVersion: 'v1.34.0' }) }),
        }),
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health returns ok and the home cluster version', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    const body = HealthResponseSchema.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.homeCluster).toEqual({ reachable: true, version: 'v1.34.0' });
  });

  it('GET /healthz and /readyz return ok', async () => {
    await request(app.getHttpServer()).get('/healthz').expect(200, { status: 'ok' });
    await request(app.getHttpServer()).get('/readyz').expect(200, { status: 'ok' });
  });
});
