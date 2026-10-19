import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CreateUserRequestSchema } from '@capi-navigator/shared';
import { AppModule } from '../app.module.js';
import { collectControllers, describeRoutes } from './openapi.js';
import { renderOpenApi as render } from './render.js';

const renderOpenApi = () => render('0.0.0-dev');

type Json = Record<string, unknown>;
const COMMITTED = new URL('../../../../docs/api/openapi.json', import.meta.url);

describe('OpenAPI document (FP-23, ADR-0016)', () => {
  const routes = describeRoutes(collectControllers(AppModule));
  const doc = JSON.parse(renderOpenApi()) as {
    openapi: string;
    paths: Record<string, Record<string, Json>>;
    components: { schemas: Record<string, Json> };
  };
  const operations = Object.values(doc.paths).flatMap((p) => Object.values(p));

  it('describes every endpoint with summary, access rule and response (FP23-F-02)', () => {
    expect(routes.length).toBeGreaterThan(90);
    const problems = routes.flatMap((r) => {
      const id = `${r.method.toUpperCase()} ${r.path}`;
      return [
        ...(r.doc?.summary ? [] : [`${id}: no @Api summary`]),
        ...(r.doc?.response ? [] : [`${id}: no response`]),
        ...(r.isPublic || r.rule ? [] : [`${id}: no access rule`]),
      ];
    });
    expect(problems).toEqual([]);
    expect(operations).toHaveLength(routes.length);
  });

  it('is OpenAPI 3.1 with unique operation ids and resolvable references (FP23-F-01)', () => {
    expect(doc.openapi).toBe('3.1.0');
    const ids = operations.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/@input|#\/\$defs\//);
    const refs = [...text.matchAll(/"\$ref":"#\/components\/(schemas|parameters)\/([^"]+)"/g)];
    const missing = refs.filter(([, kind, name]) =>
      kind === 'schemas' ? !doc.components.schemas[name!] : name !== 'Csrf',
    );
    expect(missing.map((m) => m[2])).toEqual([]);
  });

  it('documents the schema the validation uses (FP23-F-01, hard rule 2)', () => {
    const create = routes.find((r) => r.operationId === 'Users_create')!;
    expect(create.body).toBe(CreateUserRequestSchema);
    const op = doc.paths['/api/users']!.post!;
    const ref = ((op.requestBody as Json).content as Json)['application/json'] as Json;
    const name = ((ref.schema as Json).$ref as string).split('/').pop()!;
    expect(Object.keys(doc.components.schemas[name]!.properties as Json)).toEqual(
      Object.keys(CreateUserRequestSchema.shape),
    );
  });

  it('names permission, scope, CSRF header and public endpoints (FP23-F-02, FP23-F-03)', () => {
    const change =
      doc.paths['/api/connections/{connection}/clusters/{namespace}/{name}/changes']!.post!;
    expect(change['x-permission']).toEqual(['clusters.change']);
    expect(change.description).toContain('Checked in the connection and namespace of the route.');
    expect(JSON.stringify(change.parameters)).toContain('#/components/parameters/Csrf');
    const create = doc.paths['/api/connections/{connection}/clusters']!.post!;
    expect(create.description).toContain('the namespace in `spec.namespace`');
    const login = doc.paths['/api/auth/login']!.post!;
    expect(login.security).toEqual([]);
    // The CSRF check also applies to public mutating requests (security middleware).
    expect(JSON.stringify(login.parameters)).toContain('#/components/parameters/Csrf');
    expect(login['x-permission']).toBe('public');
  });

  it('is committed and current: run pnpm openapi:generate (FP23-F-05)', () => {
    expect(readFileSync(COMMITTED, 'utf8')).toBe(renderOpenApi());
  });
});
