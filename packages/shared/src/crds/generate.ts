import { z } from 'zod';
import { NAVIGATOR_GROUP, NAVIGATOR_VERSION, type CrdDefinition } from './types.js';

type JsonSchema = Record<string, unknown>;

/**
 * Builds a CustomResourceDefinition from a {@link CrdDefinition} (STATE-02). The OpenAPI schema
 * of `spec` is generated from the Zod schema, so the Zod schema stays the single source of truth.
 * Pure function: same input, same output.
 */
export function buildCrd(def: CrdDefinition): Record<string, unknown> {
  const spec = toStructuralSchema(
    z.toJSONSchema(def.spec, { target: 'openapi-3.0', io: 'input', unrepresentable: 'throw' }),
  );
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: {
      name: `${def.plural}.${NAVIGATOR_GROUP}`,
      labels: { 'app.kubernetes.io/part-of': 'capi-navigator' },
    },
    spec: {
      group: NAVIGATOR_GROUP,
      names: {
        kind: def.kind,
        listKind: `${def.kind}List`,
        plural: def.plural,
        singular: def.singular,
        ...(def.shortNames ? { shortNames: def.shortNames } : {}),
        categories: ['capi-navigator'],
      },
      scope: def.scope,
      versions: [
        {
          name: NAVIGATOR_VERSION,
          served: true,
          storage: true,
          ...(def.printerColumns ? { additionalPrinterColumns: def.printerColumns } : {}),
          schema: {
            openAPIV3Schema: {
              type: 'object',
              required: ['spec'],
              properties: {
                apiVersion: { type: 'string' },
                kind: { type: 'string' },
                metadata: { type: 'object' },
                spec,
              },
            },
          },
        },
      ],
    },
  };
}

/**
 * Removes JSON Schema keywords that Kubernetes structural schemas reject or that add only noise:
 * `$schema`, `additionalProperties: false` (unknown fields are pruned anyway) and the
 * safe-integer bounds Zod adds to `z.int()`.
 */
function toStructuralSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema') continue;
    if (key === 'additionalProperties' && value === false) continue;
    if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === 'minimum' && value === Number.MIN_SAFE_INTEGER) continue;
    if (key === 'properties' && isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, toStructuralSchema(v as JsonSchema)]),
      );
    } else if ((key === 'items' || key === 'additionalProperties') && isObject(value)) {
      out[key] = toStructuralSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
