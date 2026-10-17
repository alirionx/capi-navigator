import { AuditEventCrd } from './audit-event.js';
import { ManagementClusterCrd } from './management-cluster.js';
import { NavigatorUserCrd } from './navigator-user.js';
import type { CrdDefinition } from './types.js';

export * from './types.js';
export * from './navigator-user.js';
export * from './audit-event.js';
export * from './management-cluster.js';
export { buildCrd } from './generate.js';

/** All CRDs of the app, in a stable order. */
export const ALL_CRDS: CrdDefinition[] = [NavigatorUserCrd, AuditEventCrd, ManagementClusterCrd];
