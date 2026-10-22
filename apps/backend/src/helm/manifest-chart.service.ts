import { Injectable } from '@nestjs/common';
import {
  DEFAULT_MANIFEST_CHART_REPOSITORY,
  MANIFEST_CHART_NAME,
  manifestChartMirrorCommands,
  type ManifestChartSource,
  type ManifestChartStatus,
} from '@capi-navigator/shared';
import { StoreService } from '../store/store.service.js';
import { APP_VERSION } from '../version.js';
import { FetchError } from './fetch.js';
import { HelmRepositoriesService } from './helm-repositories.service.js';

const TTL_MS = 60_000;
const RELEASE = /^\d+\.\d+\.\d+$/;

/**
 * Where the chart of the manifest add-ons comes from (FP30-F-02) and whether the needed version is
 * there (FP30-F-03). A release uses the chart of its own version; a development build the newest
 * released one at the source. Results are cached briefly in memory (not state).
 */
@Injectable()
export class ManifestChartService {
  private readonly cache = new Map<string, { at: number; status: ManifestChartStatus }>();
  /** Replaced in tests. */
  appVersion = APP_VERSION;
  now: () => number = Date.now;

  constructor(
    private readonly store: StoreService,
    private readonly repositories: HelmRepositoriesService,
  ) {}

  async status(connection: string): Promise<ManifestChartStatus> {
    const repository = this.store.connectionCache.get(connection)?.spec.manifestChartRepository;
    const key = `${repository ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < TTL_MS) return hit.status;
    const status = await this.check(repository);
    this.cache.set(key, { at: this.now(), status });
    return status;
  }

  /** The source for the HelmChartProxy builder, or the reason it cannot be used. */
  async source(
    connection: string,
  ): Promise<{ source?: ManifestChartSource; status: ManifestChartStatus }> {
    const status = await this.status(connection);
    if (!status.available || !status.version) return { status };
    return {
      status,
      source: {
        ...(status.repository ? { repository: this.repositories.ref(status.repository) } : {}),
        version: status.version,
      },
    };
  }

  private async check(repository: string | undefined): Promise<ManifestChartStatus> {
    const url = repository
      ? this.repositories.ref(repository).url
      : DEFAULT_MANIFEST_CHART_REPOSITORY.url;
    const release = RELEASE.test(this.appVersion);
    const base = {
      ...(repository ? { repository } : {}),
      repositoryUrl: url,
      chart: MANIFEST_CHART_NAME,
    };
    const mirror = (version: string) =>
      manifestChartMirrorCommands(version, repository ? url : undefined);
    let versions: string[];
    try {
      versions = await this.repositories.chartVersions(repository, url, MANIFEST_CHART_NAME);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        ...(release ? { version: this.appVersion } : {}),
        available: false,
        message: `The chart ${MANIFEST_CHART_NAME} cannot be read from ${url}: ${message}`,
        hint:
          (err instanceof FetchError ? err.hint : undefined) ??
          (repository
            ? `Push the chart into the mirror (commands below) or test the repository ${repository}.`
            : 'The backend needs access to ghcr.io; otherwise set a mirror as chart source of the connection.'),
        mirrorCommands: mirror(release ? this.appVersion : 'x.y.z'),
      };
    }
    // Newest first (ChartSource); development builds take the newest release.
    const version = release ? this.appVersion : versions.find((v) => RELEASE.test(v));
    const available = !!version && versions.includes(version);
    return {
      ...base,
      ...(version ? { version } : {}),
      available,
      ...(available
        ? {}
        : {
            message: version
              ? `Version ${version} of ${MANIFEST_CHART_NAME} is missing at ${url}`
              : `No released version of ${MANIFEST_CHART_NAME} at ${url}`,
            hint: repository
              ? 'Copy the chart of this app version into the mirror (commands below).'
              : 'The chart is published with every release; check the release or set a mirror as chart source.',
          }),
      mirrorCommands: mirror(version ?? 'x.y.z'),
    };
  }
}
