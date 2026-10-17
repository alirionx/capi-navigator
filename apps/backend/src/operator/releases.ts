import { compareVersions } from '@capi-navigator/shared';

const CACHE_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const MAX_VERSIONS = 15;

interface CacheEntry {
  at: number;
  versions: string[];
}

/**
 * Release versions from GitHub (FP3-F-07). Results are cached for an hour per repository; if
 * GitHub is not reachable, only the given fallback version is offered (FP-3 decision).
 */
export class ReleaseFetcher {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async versions(
    repository: string,
    fallback: string,
  ): Promise<{ versions: string[]; live: boolean }> {
    const cached = this.cache.get(repository);
    if (cached && this.now() - cached.at < CACHE_MS) {
      return { versions: withFallback(cached.versions, fallback), live: true };
    }
    try {
      const res = await this.fetchFn(
        `https://api.github.com/repos/${repository}/releases?per_page=50`,
        {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'capi-navigator' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as {
        tag_name: string;
        draft: boolean;
        prerelease: boolean;
      }[];
      const versions = body
        .filter((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
        .map((r) => r.tag_name)
        .sort((a, b) => compareVersions(b, a))
        .slice(0, MAX_VERSIONS);
      this.cache.set(repository, { at: this.now(), versions });
      return { versions: withFallback(versions, fallback), live: true };
    } catch {
      return { versions: [fallback], live: false };
    }
  }
}

function withFallback(versions: string[], fallback: string): string[] {
  return versions.includes(fallback)
    ? versions
    : [...versions, fallback].sort((a, b) => compareVersions(b, a));
}
