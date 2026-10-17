/**
 * Cache of image names per credential (FP6-F-02). Found names are kept for 30 minutes, unknown
 * IDs for 5 minutes. A lookup that does not answer within 4 s is finished in the background, so
 * the live status never waits long; the next status update shows the names.
 */
export class ImageNameCache {
  private readonly entries = new Map<string, { name: string | null; expires: number }>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly ttl = { found: 30 * 60_000, missing: 5 * 60_000 },
    private readonly waitMs = 4000,
  ) {}

  /** Names by ID: a string if found, null if the cloud does not know it; absent if unknown yet. */
  async resolve(
    scope: string,
    ids: string[],
    lookup: (ids: string[]) => Promise<Record<string, string>>,
  ): Promise<Map<string, string | null>> {
    const now = Date.now();
    const missing = ids.filter((id) => {
      const e = this.entries.get(`${scope}|${id}`);
      return !e || e.expires < now;
    });
    if (missing.length > 0) {
      const key = `${scope}|${missing.sort().join(',')}`;
      let run = this.pending.get(key);
      if (!run) {
        run = lookup(missing)
          .then((names) => {
            const t = Date.now();
            for (const id of missing) {
              const name = names[id] ?? null;
              this.entries.set(`${scope}|${id}`, {
                name,
                expires: t + (name ? this.ttl.found : this.ttl.missing),
              });
            }
          })
          .catch(() => undefined) // cloud not reachable: show IDs, retry on the next update
          .finally(() => this.pending.delete(key));
        this.pending.set(key, run);
      }
      await Promise.race([run, new Promise((r) => setTimeout(r, this.waitMs))]);
    }
    const out = new Map<string, string | null>();
    for (const id of ids) {
      const e = this.entries.get(`${scope}|${id}`);
      if (e) out.set(id, e.name);
    }
    return out;
  }
}
