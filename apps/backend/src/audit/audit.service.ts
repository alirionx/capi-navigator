import { Injectable, Logger } from '@nestjs/common';
import type { AuditEventSpec } from '@capi-navigator/shared';
import { StoreService } from '../store/store.service.js';

/** Writes AuditEvent resources (FP1-F-06). */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly store: StoreService) {}

  async record(event: Omit<AuditEventSpec, 'timestamp'> & { timestamp?: string }): Promise<void> {
    const spec: AuditEventSpec = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    try {
      await this.store.auditEvents.create(
        {
          generateName: 'audit-',
          labels: {
            'app.kubernetes.io/part-of': 'capi-navigator',
            'capi-navigator.io/actor': labelValue(spec.actor),
            'capi-navigator.io/action': labelValue(spec.action),
          },
        },
        spec,
      );
    } catch (err) {
      // The action itself has already happened; losing the record must be visible in the logs.
      this.logger.error(
        `Failed to write AuditEvent ${spec.action} by ${spec.actor}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Label values: max. 63 characters of [A-Za-z0-9._-], starting and ending alphanumeric. */
function labelValue(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 63)
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  return cleaned || 'unknown';
}
