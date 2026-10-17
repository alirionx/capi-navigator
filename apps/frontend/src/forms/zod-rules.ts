import type { z } from 'zod';

/**
 * Turns a shared Zod schema into a Vuetify validation rule, so the frontend validates with the
 * same schema as the backend (FP5-F-02 pattern, hard rule 2).
 */
export function zodRule(schema: z.ZodType): (value: unknown) => true | string {
  return (value) => {
    const result = schema.safeParse(value);
    return result.success ? true : (result.error.issues[0]?.message ?? 'Invalid value');
  };
}

/** Field errors of an ApiError for a given field, for `:error-messages`. */
export function fieldErrors(errors: Record<string, string[]> | undefined, field: string): string[] {
  return errors?.[field] ?? [];
}
