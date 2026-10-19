import { AuditEventCrd } from './audit-event.js';
import { HelmRepositoryCrd } from './helm-repository.js';
import { ManagementClusterCrd } from './management-cluster.js';
import { NavigatorRoleCrd } from './navigator-role.js';
import { NavigatorTokenCrd } from './navigator-token.js';
import { NavigatorUserCrd } from './navigator-user.js';
import type { CrdDefinition } from './types.js';

export * from './types.js';
export * from './navigator-user.js';
export * from './navigator-role.js';
export * from './navigator-token.js';
export * from './audit-event.js';
export * from './management-cluster.js';
export * from './helm-repository.js';
export { buildCrd } from './generate.js';

/** All CRDs of the app, in a stable order. */
export const ALL_CRDS: CrdDefinition[] = [
  NavigatorUserCrd,
  AuditEventCrd,
  ManagementClusterCrd,
  HelmRepositoryCrd,
  NavigatorRoleCrd,
  NavigatorTokenCrd,
];
