import { NAMESPACE_QUOTA_RESOURCES } from '@capi-navigator/shared';

/** Key of the quota field in the translations, or undefined for an unknown resource. */
export const quotaKey = (resource: string): string | undefined =>
  Object.entries(NAMESPACE_QUOTA_RESOURCES).find(([, r]) => r === resource)?.[0];

/** The GiB of the form label would double the unit of a value like "4Gi". */
export const withoutUnit = (label: string): string => label.replace(/ \(GiB\)$/, '');
