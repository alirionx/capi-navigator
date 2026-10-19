import { SetMetadata } from '@nestjs/common';
import { z } from 'zod';

export const API_DOC_KEY = 'capi-navigator:api-doc';

/** What an endpoint returns, for the OpenAPI description (FP23-F-02). */
export type ApiResponseDoc =
  /** JSON body described by a Zod schema from packages/shared. */
  | z.ZodType
  /** Server-sent events whose `data` has this schema. */
  | { events: z.ZodType }
  /** A non-JSON body, e.g. a kubeconfig or YAML download. */
  | { contentType: string; description: string }
  /** No body (e.g. 204). */
  | 'empty';

export interface ApiDoc {
  /** One line: what the endpoint does. */
  summary: string;
  /** Optional details, e.g. preview/apply semantics or side effects. */
  description?: string;
  response: ApiResponseDoc;
}

/**
 * Describes an endpoint for the OpenAPI document (FP23-F-02). Path, method, permission and the
 * request schemas come from the route metadata; this adds what only the author knows.
 */
export const Api = (doc: ApiDoc) => SetMetadata(API_DOC_KEY, doc);

/**
 * Data of the live update events (server-sent events): `state` with the current state after every
 * change, `error` with a message; `ping` events (empty data) keep the connection open.
 */
export const liveEvents = (state: z.ZodType) =>
  z.union([
    z.object({ type: z.literal('state'), state }),
    z.object({ type: z.literal('error'), message: z.string() }),
  ]);
