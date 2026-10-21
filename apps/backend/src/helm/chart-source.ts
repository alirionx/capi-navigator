import type {
  ChartSummary,
  ChartVersion,
  HelmRepositoryTestResult,
  HelmRepositoryType,
} from '@capi-navigator/shared';
import { parse } from 'yaml';
import { isTopLevelValues, readFromChartArchive } from './chart-archive.js';
import { FetchError, get, type FetchOptions, type FetchResult } from './fetch.js';

/** Everything needed to read a repository; credentials only in memory for one request. */
export interface RepoAccess {
  type: HelmRepositoryType;
  url: string;
  username?: string;
  password?: string;
  ca?: string;
  insecureSkipTLSVerify?: boolean;
}

interface IndexEntry {
  version: string;
  appVersion?: string;
  description?: string;
  icon?: string;
  created?: string;
  deprecated?: boolean;
  urls?: string[];
}
interface RepoIndex {
  entries?: Record<string, IndexEntry[]>;
}

const INDEX_TTL_MS = 5 * 60_000;
const INDEX_CACHE_SIZE = 20;
const HELM_CHART_LAYER = 'application/vnd.cncf.helm.chart.content.v1.tar+gzip';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

/** Newest first; prereleases after releases of the same core version. */
export function compareChartVersions(a: string, b: string): number {
  const parts = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split(/-(.*)/s);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pb.nums[i] ?? 0) - (pa.nums[i] ?? 0);
    if (d) return d;
  }
  if (pa.pre && !pb.pre) return 1;
  if (!pa.pre && pb.pre) return -1;
  return (pb.pre ?? '').localeCompare(pa.pre ?? '');
}

const isPrerelease = (v: string) => v.replace(/^v/, '').includes('-');

/**
 * Reads charts, versions and default values from HTTP repositories (index.yaml) and OCI
 * registries (distribution API) for the chart browser (FP8-F-04). The index is cached briefly in
 * memory (not state: rebuilt on demand).
 */
export class ChartSource {
  private readonly indexes = new Map<string, { at: number; index: RepoIndex }>();

  constructor(private readonly now: () => number = Date.now) {}

  async charts(repo: RepoAccess): Promise<ChartSummary[]> {
    if (repo.type === 'oci') {
      throw new FetchError('OCI registries cannot list their charts; enter the chart name');
    }
    const index = await this.index(repo);
    return Object.entries(index.entries ?? {})
      .map(([name, entries]) => {
        const sorted = [...entries].sort((a, b) => compareChartVersions(a.version, b.version));
        const latest = sorted.find((e) => !isPrerelease(e.version)) ?? sorted[0];
        return {
          name,
          ...(latest?.description ? { description: latest.description } : {}),
          ...(latest ? { latestVersion: latest.version } : {}),
          ...(latest?.appVersion ? { appVersion: String(latest.appVersion) } : {}),
          ...(latest?.icon ? { icon: latest.icon } : {}),
          ...(latest?.deprecated ? { deprecated: true } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async versions(repo: RepoAccess, chart: string): Promise<ChartVersion[]> {
    if (repo.type === 'oci') {
      // The tag list is paged (Link header, e.g. ghcr.io); at most 20 pages.
      const tags: string[] = [];
      let path: string | undefined = `/v2/${ociRepository(repo, chart)}/tags/list?n=1000`;
      for (let page = 0; path && page < 20; page++) {
        const res = await this.oci(repo, path, 'application/json', chart);
        tags.push(...((JSON.parse(res.body.toString('utf8')) as { tags?: string[] }).tags ?? []));
        const next = /<([^>]+)>;\s*rel="?next"?/.exec(String(res.headers.link ?? ''))?.[1];
        path = next
          ? new URL(next, httpsBase(repo)).pathname + new URL(next, httpsBase(repo)).search
          : undefined;
      }
      // Helm stores "+" of SemVer build metadata as "_" in OCI tags.
      return tags
        .map((t) => t.replace(/_/g, '+'))
        .sort(compareChartVersions)
        .map((version) => ({ version }));
    }
    const entries = (await this.index(repo)).entries?.[chart];
    if (!entries) throw new FetchError(`Chart ${chart} not found in ${repo.url}`, 404);
    return [...entries]
      .sort((a, b) => compareChartVersions(a.version, b.version))
      .map((e) => ({
        version: e.version,
        ...(e.appVersion ? { appVersion: String(e.appVersion) } : {}),
        ...(e.created ? { created: e.created } : {}),
      }));
  }

  /** Default values.yaml of one chart version. */
  async values(repo: RepoAccess, chart: string, version: string): Promise<string> {
    const archive =
      repo.type === 'oci'
        ? await this.ociArchive(repo, chart, version)
        : await this.httpArchive(repo, chart, version);
    return readFromChartArchive(archive, isTopLevelValues) ?? '';
  }

  /** Connection test for the repository form (FP8-F-02). */
  async test(repo: RepoAccess): Promise<HelmRepositoryTestResult> {
    try {
      if (repo.type === 'oci') {
        if (repo.username === undefined) {
          // Anonymous: a registry answers /v2/ with 200 or an auth challenge.
          const res = await get(`${httpsBase(repo)}/v2/`, {
            ...(repo.ca ? { ca: repo.ca } : {}),
            ...(repo.insecureSkipTLSVerify ? { insecureSkipTLSVerify: true } : {}),
          });
          if (res.status !== 200 && !(res.status === 401 && res.headers['www-authenticate'])) {
            throw new FetchError(`Not an OCI registry (HTTP ${res.status} for /v2/)`);
          }
          return {
            ok: true,
            message: `Registry ${new URL(httpsBase(repo)).host} answered (anonymous)`,
          };
        }
        await this.oci(repo, '/v2/', 'application/json');
        return {
          ok: true,
          message: `Registry ${new URL(httpsBase(repo)).host} answered${repo.username ? ' and accepted the credentials' : ''}`,
        };
      }
      this.indexes.delete(repo.url);
      const charts = await this.charts(repo);
      return { ok: true, message: `${charts.length} chart(s) in the index` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        hint:
          repo.type === 'oci'
            ? 'Check the URL (oci://host/path, without the chart name), the credentials and, for self-signed registries, the CA certificate.'
            : 'Check that <url>/index.yaml can be downloaded.',
      };
    }
  }

  private async index(repo: RepoAccess): Promise<RepoIndex> {
    const cached = this.indexes.get(repo.url);
    if (cached && this.now() - cached.at < INDEX_TTL_MS) return cached.index;
    const res = await get(`${repo.url}/index.yaml`, { timeoutMs: 30_000 });
    if (res.status !== 200) throw new FetchError(`index.yaml: HTTP ${res.status}`, res.status);
    const index = (parse(res.body.toString('utf8'), { maxAliasCount: -1 }) ?? {}) as RepoIndex;
    if (typeof index !== 'object' || !index.entries) {
      throw new FetchError(`${repo.url}/index.yaml is not a Helm repository index`);
    }
    if (this.indexes.size >= INDEX_CACHE_SIZE) {
      this.indexes.delete(this.indexes.keys().next().value!);
    }
    this.indexes.set(repo.url, { at: this.now(), index });
    return index;
  }

  private async httpArchive(repo: RepoAccess, chart: string, version: string): Promise<Buffer> {
    const entry = (await this.index(repo)).entries?.[chart]?.find((e) => e.version === version);
    const url = entry?.urls?.[0];
    if (!url) throw new FetchError(`${chart} ${version} not found in ${repo.url}`, 404);
    const res = await get(new URL(url, `${repo.url}/`).toString(), { timeoutMs: 30_000 });
    if (res.status !== 200) throw new FetchError(`Chart archive: HTTP ${res.status}`, res.status);
    return res.body;
  }

  private async ociArchive(repo: RepoAccess, chart: string, version: string): Promise<Buffer> {
    const name = ociRepository(repo, chart);
    const tag = version.replace(/\+/g, '_');
    const manifest = JSON.parse(
      (
        await this.oci(
          repo,
          `/v2/${name}/manifests/${encodeURIComponent(tag)}`,
          OCI_MANIFEST,
          chart,
        )
      ).body.toString('utf8'),
    ) as { layers?: { mediaType: string; digest: string }[] };
    const layer = manifest.layers?.find((l) => l.mediaType === HELM_CHART_LAYER);
    if (!layer) throw new FetchError(`${chart}:${version} is not a Helm chart`);
    return (await this.oci(repo, `/v2/${name}/blobs/${layer.digest}`, '*/*', chart)).body;
  }

  /**
   * GET against the registry with the token or basic auth flow of the distribution spec. With a
   * chart, refused access is explained for it: registries such as ghcr.io answer 403 instead of
   * 404 for a package that does not exist.
   */
  private async oci(
    repo: RepoAccess,
    path: string,
    accept: string,
    chart?: string,
  ): Promise<FetchResult> {
    const refused = (status: number, fallback: string) =>
      chart ? accessRefused(repo, chart, status) : new FetchError(fallback, status);
    const base = httpsBase(repo);
    const tls: FetchOptions = {
      ...(repo.ca ? { ca: repo.ca } : {}),
      ...(repo.insecureSkipTLSVerify ? { insecureSkipTLSVerify: true } : {}),
    };
    const basic =
      repo.username !== undefined
        ? `Basic ${Buffer.from(`${repo.username}:${repo.password ?? ''}`).toString('base64')}`
        : undefined;
    let res = await get(`${base}${path}`, { ...tls, headers: { accept } });
    if (res.status === 401) {
      const challenge = String(res.headers['www-authenticate'] ?? '');
      let authorization: string | undefined;
      if (/^bearer/i.test(challenge)) {
        const params = Object.fromEntries(
          [...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!.toLowerCase(), m[2]!]),
        );
        if (!params.realm) throw new FetchError('Registry sent no token endpoint');
        const tokenUrl = new URL(params.realm);
        if (params.service) tokenUrl.searchParams.set('service', params.service);
        if (params.scope) tokenUrl.searchParams.set('scope', params.scope);
        const tokenRes = await get(tokenUrl.toString(), {
          ...tls,
          headers: basic ? { authorization: basic } : {},
        });
        if (tokenRes.status !== 200) {
          throw tokenRes.status === 401 || tokenRes.status === 403
            ? refused(tokenRes.status, 'The registry refused the credentials')
            : new FetchError(`Token request: HTTP ${tokenRes.status}`, tokenRes.status);
        }
        const body = JSON.parse(tokenRes.body.toString('utf8')) as {
          token?: string;
          access_token?: string;
        };
        authorization = `Bearer ${body.token ?? body.access_token ?? ''}`;
      } else if (/^basic/i.test(challenge) && basic) {
        authorization = basic;
      } else {
        throw new FetchError('The registry needs credentials', 401);
      }
      res = await get(`${base}${path}`, { ...tls, headers: { accept, authorization } });
    }
    if (res.status === 401 || res.status === 403) {
      throw refused(res.status, 'The registry refused access; check the credentials');
    }
    if (res.status === 404) throw new FetchError(`Not found in the registry: ${path}`, 404);
    if (res.status !== 200)
      throw new FetchError(`Registry: HTTP ${res.status} for ${path}`, res.status);
    return res;
  }
}

function httpsBase(repo: RepoAccess): string {
  return `https://${repo.url.replace(/^oci:\/\//, '').split('/')[0]}`;
}

/**
 * Refused access to a chart: without credentials the chart may not exist or be private, with them
 * the credentials may lack access. A repository URL ending in the chart name is the common slip
 * (helm takes oci://host/path/chart, the repository only oci://host/path).
 */
function accessRefused(repo: RepoAccess, chart: string, status: number): FetchError {
  const where = `${repo.url.replace(/^oci:\/\//, '').replace(/\/$/, '')}/${chart}`;
  const doubled = repo.url.replace(/\/$/, '').endsWith(`/${chart}`);
  const message =
    repo.username === undefined
      ? `${where} cannot be read anonymously: the chart does not exist there, or it is private`
      : `The registry refused access to ${where}: the credentials lack access, or the chart does not exist there`;
  const hint = doubled
    ? `The repository URL already ends with the chart name "${chart}"; use ${repo.url.replace(/\/$/, '').slice(0, -chart.length - 1)} as repository URL.`
    : repo.username === undefined
      ? 'Check the repository URL (oci://host/path, without the chart name) and the chart name; for a private chart, add the registry login to the repository.'
      : 'Check the repository URL (oci://host/path, without the chart name), the chart name and the credentials.';
  return new FetchError(message, status, hint);
}

/** Repository name in the registry: URL path plus chart name. */
function ociRepository(repo: RepoAccess, chart: string): string {
  const path = repo.url.replace(/^oci:\/\/[^/]+\/?/, '');
  return path ? `${path}/${chart}` : chart;
}
