import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ApiErrorBody } from '@capi-navigator/shared';
import type { z } from 'zod';

/** Validates request input with the shared Zod schema (single source of truth, hard rule 2). */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  /** Also read by the OpenAPI generator (FP23-F-01). */
  constructor(readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.map(String).join('.') || '_';
      (fieldErrors[key] ??= []).push(issue.message);
    }
    const body: ApiErrorBody = {
      statusCode: 400,
      message: 'The input is invalid',
      hint: 'Correct the marked fields.',
      fieldErrors,
    };
    throw new BadRequestException(body);
  }
}
