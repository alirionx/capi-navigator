import { catalogEntry, type InstalledProvider } from '@capi-navigator/shared';

/** The catalog wants the outbound proxy for this provider's controller (FP-29). */
function wantsProxy(provider: InstalledProvider): boolean {
  return !!(provider.catalogId && catalogEntry(provider.catalogId)?.outboundProxyDefault);
}

/** Installed providers that need the internet but do not use the outbound proxy yet. */
export function providersWithoutProxy(providers: InstalledProvider[]): InstalledProvider[] {
  return providers.filter((p) => wantsProxy(p) && !p.outboundProxy);
}

/** Default of the proxy switch when updating a provider: its current use, or the catalog's. */
export function proxySwitchDefault(provider: InstalledProvider): boolean {
  return !!provider.outboundProxy || wantsProxy(provider);
}
