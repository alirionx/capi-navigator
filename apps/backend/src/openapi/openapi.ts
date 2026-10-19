import { RequestMethod, type Type } from '@nestjs/common';
import * as shared from '@capi-navigator/shared';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@capi-navigator/shared';
import { z } from 'zod';
import { PERMISSION_KEY, PUBLIC_KEY, type PermissionRule } from '../auth/decorators.js';
import { SESSION_COOKIE } from '../auth/session.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { API_DOC_KEY, type ApiDoc, type ApiResponseDoc } from './api.decorator.js';

// NestJS metadata keys and parameter types (@nestjs/common constants and RouteParamtypes).
const PATH = 'path';
const METHOD = 'method';
const HTTP_CODE = '__httpCode__';
const SSE = '__sse__';
const ROUTE_ARGS = '__routeArguments__';
const PARAM_BODY = 3;
const PARAM_QUERY = 4;

type Json = Record<string, unknown>;
type ZodSchema = z.ZodType;

/** Controllers of a module tree, from the static @Module metadata (no app instance needed). */
export function collectControllers(root: unknown): Type[] {
  const seen = new Set<unknown>();
  const controllers: Type[] = [];
  const visit = (mod: unknown) => {
    if (!mod || seen.has(mod)) return;
    seen.add(mod);
    const dynamic = typeof mod === 'object' ? (mod as { module?: unknown } & Json) : undefined;
    const cls = dynamic?.module ?? mod;
    const list = (key: string) => [
      ...((Reflect.getMetadata(key, cls as object) as unknown[] | undefined) ?? []),
      ...((dynamic?.[key] as unknown[] | undefined) ?? []),
    ];
    for (const c of list('controllers') as Type[])
      if (!controllers.includes(c)) controllers.push(c);
    for (const m of list('imports')) visit(m);
  };
  visit(root);
  return controllers;
}

/** Name of a schema exported from packages/shared ("UserSchema" → "User"). */
const SHARED_NAMES = new Map<unknown, string>(
  Object.entries(shared)
    .filter(([name, value]) => name.endsWith('Schema') && value instanceof z.ZodType)
    .map(([name, value]) => [value, name.slice(0, -'Schema'.length)] as const)
    .reverse(), // the first export of a schema wins
);

const join = (...parts: string[]) =>
  '/' +
  parts
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/');

interface Route {
  method: string;
  path: string;
  operationId: string;
  tag: string;
  doc?: ApiDoc;
  rule?: PermissionRule;
  isPublic: boolean;
  status: number;
  sse: boolean;
  body?: ZodSchema;
  query?: ZodSchema;
  pathParams: string[];
}

/** All routes of the controllers with what the metadata says about them (FP23-F-01). */
export function describeRoutes(controllers: Type[]): Route[] {
  const routes: Route[] = [];
  for (const ctrl of controllers) {
    const base = (Reflect.getMetadata(PATH, ctrl) as string | undefined) ?? '';
    const tag = ctrl.name.replace(/Controller$/, '');
    const proto = ctrl.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH, handler) as string | undefined;
      const method = Reflect.getMetadata(METHOD, handler) as RequestMethod | undefined;
      if (path === undefined || method === undefined) continue;
      const meta = <T>(key: string) =>
        (Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, ctrl)) as T | undefined;
      const fullPath = join(base, path);
      const zodOf = (type: number) => {
        const arg = Object.entries(
          (Reflect.getMetadata(ROUTE_ARGS, ctrl, name) as
            Record<string, { data?: string; pipes?: unknown[] }> | undefined) ?? {},
        ).find(([key, a]) => Number(key.split(':')[0]) === type && a.data === undefined);
        const pipe = arg?.[1].pipes?.find(
          (p): p is ZodValidationPipe<ZodSchema> => p instanceof ZodValidationPipe,
        );
        return pipe?.schema;
      };
      const verb = RequestMethod[method];
      routes.push({
        method: verb.toLowerCase(),
        path: fullPath,
        operationId: `${tag}_${name}`,
        tag,
        doc: meta<ApiDoc>(API_DOC_KEY),
        rule: meta<PermissionRule>(PERMISSION_KEY),
        isPublic: meta<boolean>(PUBLIC_KEY) === true,
        status: meta<number>(HTTP_CODE) ?? (verb === 'POST' ? 201 : 200),
        sse: Reflect.getMetadata(SSE, handler) === true,
        body: zodOf(PARAM_BODY),
        query: zodOf(PARAM_QUERY),
        pathParams: [...fullPath.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!),
      });
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** Converts Zod schemas to OpenAPI components and references (Zod 4, JSON Schema 2020-12). */
class SchemaSet {
  private readonly input = z.registry<{ id: string }>();
  private readonly output = z.registry<{ id: string }>();
  private readonly used = { input: new Set<string>(), output: new Set<string>() };

  constructor() {
    for (const [schema, id] of SHARED_NAMES) {
      this.input.add(schema as ZodSchema, { id });
      this.output.add(schema as ZodSchema, { id });
    }
  }

  /** A schema as JSON Schema: `$ref` for named shared schemas, inline otherwise. */
  ref(schema: ZodSchema, io: 'input' | 'output'): Json {
    const name = SHARED_NAMES.get(schema);
    if (name) {
      this.used[io].add(name);
      return { $ref: `#/components/schemas/${io === 'input' ? `${name}@input` : name}` };
    }
    return this.inline(schema, io);
  }

  /** Always inline at the top level (e.g. a query object, whose properties become parameters). */
  inline(schema: ZodSchema, io: 'input' | 'output'): Json {
    const json = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io,
      metadata: io === 'input' ? this.input : this.output,
      unrepresentable: 'any',
    }) as Json;
    const defs = (json.$defs ?? {}) as Json;
    for (const id of Object.keys(defs)) this.used[io].add(id);
    delete json.$defs;
    delete json.$schema;
    return rewriteRefs(json, io) as Json;
  }

  /**
   * Components for every schema referenced: the output shape under its name, the input shape
   * under "<name>Input" where it differs (e.g. fields with defaults are optional on input).
   */
  components(): { schemas: Record<string, Json>; inputName: (id: string) => string } {
    const convert = (registry: z.core.$ZodRegistry<{ id: string }>, io: 'input' | 'output') =>
      (
        z.toJSONSchema(registry, {
          target: 'draft-2020-12',
          io,
          unrepresentable: 'any',
          uri: (id) => `#/components/schemas/${io === 'input' ? `${id}@input` : id}`,
        }) as { schemas: Record<string, Json> }
      ).schemas;
    const out = convert(this.output, 'output');
    const inp = convert(this.input, 'input');
    // Close over references between components.
    const needed = { input: new Set<string>(), output: new Set<string>() };
    const walk = (id: string, io: 'input' | 'output') => {
      if (needed[io].has(id)) return;
      needed[io].add(id);
      const s = (io === 'input' ? inp : out)[id];
      for (const m of JSON.stringify(s ?? {}).matchAll(
        /#\/components\/schemas\/([A-Za-z0-9]+)(@input)?/g,
      ))
        walk(m[1]!, m[2] ? 'input' : 'output');
    };
    this.used.output.forEach((id) => walk(id, 'output'));
    this.used.input.forEach((id) => walk(id, 'input'));
    const clean = (s: Json) => {
      const rest = { ...s };
      delete rest.$schema;
      delete rest.$id;
      return rest;
    };
    const result: Record<string, Json> = {};
    const same = (id: string) =>
      JSON.stringify(clean(inp[id]!)).replaceAll('@input', '') === JSON.stringify(clean(out[id]!));
    for (const id of [...needed.output].sort()) result[id] = clean(out[id]!);
    for (const id of [...needed.input].sort()) {
      if (needed.output.has(id) && same(id)) continue;
      result[`${id}Input`] = clean(inp[id]!);
    }
    // "<id>@input" becomes "<id>Input", or "<id>" where both shapes are the same.
    const inputName = (id: string) => (result[`${id}Input`] ? `${id}Input` : id);
    return { schemas: rewriteRefs(result, 'input', inputName) as Record<string, Json>, inputName };
  }
}

/** `#/$defs/X` (single conversions) and `X@input` placeholders become component references. */
function rewriteRefs(
  value: unknown,
  io: 'input' | 'output',
  inputName?: (id: string) => string,
): unknown {
  const text = JSON.stringify(value).replace(
    /"#\/\$defs\/([A-Za-z0-9]+)"/g,
    (_m, id: string) => `"#/components/schemas/${io === 'input' ? `${id}@input` : id}"`,
  );
  if (!inputName) return JSON.parse(text);
  return JSON.parse(
    text.replace(
      /#\/components\/schemas\/([A-Za-z0-9]+)@input/g,
      (_m, id: string) => `#/components/schemas/${inputName(id)}`,
    ),
  );
}

/** Human-readable access rule of an operation (FP23-F-02). */
function accessText(route: Route): string {
  if (route.isPublic) return 'Public: no session needed.';
  const rule = route.rule;
  if (!rule) return 'Not reachable: the endpoint has no access rule.';
  if (rule.signedIn) return 'Any signed-in user.';
  const perms = rule.anyOf.map((p) => `\`${p}\``).join(' or ');
  const scoped = rule.anyOf.some(shared.isScopable);
  const where = !scoped
    ? 'This permission needs an unlimited role assignment.'
    : rule.namespaceFromBody
      ? `Checked in the connection of the route and the namespace in \`${rule.namespaceFromBody}\`.`
      : route.pathParams.includes('namespace')
        ? 'Checked in the connection and namespace of the route.'
        : 'Checked in the connection of the route (any namespace).';
  return `Requires permission ${perms}. ${where}`;
}

const MUTATING = new Set(['post', 'put', 'patch', 'delete']);

/** The OpenAPI 3.1 document of the REST API (FP23-F-01..03). */
export function buildOpenApi(controllers: Type[], opts: { version: string }): Json {
  const schemas = new SchemaSet();
  const error = schemas.ref(shared.ApiErrorBodySchema, 'output');
  const paths: Record<string, Json> = {};
  for (const route of describeRoutes(controllers)) {
    const doc = route.doc;
    const parameters: Json[] = route.pathParams.map((p) => ({
      name: p,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (route.query) {
      const q = schemas.inline(route.query, 'input');
      const props = (q.properties ?? {}) as Record<string, Json>;
      const required = new Set((q.required as string[] | undefined) ?? []);
      for (const [name, schema] of Object.entries(props)) {
        parameters.push({ name, in: 'query', required: required.has(name), schema });
      }
    }
    // The CSRF check applies to every mutating /api request, also public ones like the login.
    if (MUTATING.has(route.method) && route.path.startsWith('/api/')) {
      parameters.push({ $ref: '#/components/parameters/Csrf' });
    }
    const responses: Json = {};
    const response: ApiResponseDoc | undefined = doc?.response;
    const ok = String(route.status);
    if (route.sse) {
      const events =
        response && typeof response === 'object' && 'events' in response
          ? response.events
          : undefined;
      responses[ok] = {
        description:
          'Server-sent events: one `state` event with the current state, then one per change.',
        content: {
          'text/event-stream': {
            schema: events ? schemas.ref(events, 'output') : { type: 'string' },
          },
        },
      };
    } else if (response === 'empty' || route.status === 204) {
      responses[ok] = { description: 'Done; no body.' };
    } else if (response && typeof response === 'object' && 'contentType' in response) {
      responses[ok] = {
        description: response.description,
        content: { [response.contentType]: { schema: { type: 'string' } } },
      };
    } else if (response instanceof z.ZodType) {
      responses[ok] = {
        description: 'OK',
        content: { 'application/json': { schema: schemas.ref(response, 'output') } },
      };
    } else {
      responses[ok] = { description: 'OK' };
    }
    responses.default = {
      description: 'Error with message and hint (400 invalid input, 401, 403, 404, 409, 502).',
      content: { 'application/json': { schema: error } },
    };
    const operation: Json = {
      operationId: route.operationId,
      tags: [route.tag],
      summary: doc?.summary ?? '',
      description: [doc?.description, accessText(route)].filter(Boolean).join('\n\n'),
      ...(parameters.length ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: schemas.ref(route.body, 'input') } },
            },
          }
        : {}),
      responses,
      ...(route.isPublic ? { security: [] } : {}),
      'x-permission': route.isPublic
        ? 'public'
        : route.rule?.signedIn
          ? 'signed-in'
          : (route.rule?.anyOf ?? []),
    };
    const openApiPath = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    paths[openApiPath] = { ...paths[openApiPath], [route.method]: operation };
  }
  const components = schemas.components();
  return {
    openapi: '3.1.0',
    info: {
      title: 'CAPI Navigator API',
      version: opts.version,
      description:
        'REST API of CAPI Navigator. Sign in with `POST /api/auth/login`; the session cookie authenticates later requests. Mutating requests need the header `x-capi-navigator: 1` (CSRF protection). Every operation names the permission it needs; changes are audited.',
    },
    servers: [{ url: '/' }],
    security: [{ session: [] }],
    paths: rewriteRefs(paths, 'input', components.inputName),
    components: {
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE,
          description: 'Session cookie set by POST /api/auth/login.',
        },
      },
      parameters: {
        Csrf: {
          name: CSRF_HEADER,
          in: 'header',
          required: true,
          description: 'CSRF protection for mutating requests.',
          // enum + default: Swagger UI prefills the field (FP23-F-04).
          schema: { type: 'string', enum: [CSRF_HEADER_VALUE], default: CSRF_HEADER_VALUE },
        },
      },
      schemas: components.schemas,
    },
  };
}
