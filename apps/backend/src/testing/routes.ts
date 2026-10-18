/// <reference types="vite/client" />
import { RequestMethod } from '@nestjs/common';

// Metadata keys of @Controller and the route decorators (@nestjs/common/constants).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

export interface RouteInfo {
  /** e.g. "POST /api/connections/:connection/clusters" */
  route: string;
  handler: (...args: unknown[]) => unknown;
  controller: abstract new (...args: never[]) => unknown;
}

const join = (...parts: (string | undefined)[]) =>
  '/' +
  parts
    .flatMap((p) => (p ?? '').split('/'))
    .filter(Boolean)
    .join('/');

/** All HTTP routes of the backend's controllers, from the NestJS metadata (FP19-F-05). */
export async function listRoutes(): Promise<RouteInfo[]> {
  const modules = import.meta.glob<Record<string, unknown>>(
    ['../**/*.controller.ts', '../**/*.module.ts'],
    { eager: true },
  );
  const routes: RouteInfo[] = [];
  const seen = new Set<unknown>();
  for (const exports of Object.values(modules)) {
    for (const value of Object.values(exports)) {
      if (typeof value !== 'function' || seen.has(value)) continue;
      const base = Reflect.getMetadata(PATH_METADATA, value) as string | undefined;
      if (base === undefined) continue;
      seen.add(value);
      const proto = (value as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (path === undefined || method === undefined) continue;
        routes.push({
          route: `${RequestMethod[method]} ${join(base, path)}`,
          handler: handler as RouteInfo['handler'],
          controller: value as RouteInfo['controller'],
        });
      }
    }
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}
