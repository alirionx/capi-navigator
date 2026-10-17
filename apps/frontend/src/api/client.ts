import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** GET a JSON endpoint of the backend and validate the response with the shared Zod schema. */
export async function getJson<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
  const res = await fetch(path, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  return schema.parse(await res.json());
}
