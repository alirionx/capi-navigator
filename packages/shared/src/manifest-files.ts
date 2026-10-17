import {
  MANAGEMENT_ACCESS_MANIFEST,
  MANAGEMENT_ACCESS_MINIMAL_MANIFEST,
} from './management-access.js';

/** Generated manifest files under deploy/, keyed by path relative to the repository root. */
export const ACCESS_MANIFEST_FILES: Record<string, string> = {
  'deploy/management-cluster/capi-navigator-access.yaml': MANAGEMENT_ACCESS_MANIFEST,
  'deploy/management-cluster/capi-navigator-access-minimal.yaml':
    MANAGEMENT_ACCESS_MINIMAL_MANIFEST,
};
