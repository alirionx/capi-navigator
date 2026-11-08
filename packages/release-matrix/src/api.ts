import { readFileSync } from 'node:fs';
import type { CreateBody } from './cases.js';
import { expandHome, type MatrixConfig } from './config.js';

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The app's REST API with an API token (FP-22); the token never leaves this object. */
export class AppApi {
  readonly #token: string;
  readonly #base: string;

  constructor(config: MatrixConfig) {
    this.#token = readFileSync(expandHome(config.app.tokenFile), 'utf8').trim();
    this.#base = `${config.app.url.replace(/\/$/, '')}/api/connections/${encodeURIComponent(config.app.connection)}`;
  }

  async #call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${this.#base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        const j = JSON.parse(text) as { message?: unknown; hint?: unknown };
        message = [j.message, j.hint].filter(Boolean).map(String).join(' – ');
      } catch {
        // not JSON
      }
      throw new ApiError(
        `${method} ${path}: HTTP ${res.status} ${message.slice(0, 400)}`,
        res.status,
      );
    }
    return res;
  }

  /** The connection's internal registry (FP29-F-10), if any. */
  async internalRegistry(): Promise<Record<string, unknown> | undefined> {
    const c = (await (await this.#call('GET', '')).json()) as {
      internalRegistry?: Record<string, unknown>;
    };
    return c.internalRegistry;
  }

  async preview(body: CreateBody): Promise<{ blockers: string[]; warnings: string[] }> {
    const p = (await (await this.#call('POST', '/clusters/preview', body)).json()) as {
      blockers?: string[];
      warnings?: string[];
    };
    return { blockers: p.blockers ?? [], warnings: p.warnings ?? [] };
  }

  async create(body: CreateBody): Promise<void> {
    await this.#call('POST', '/clusters', body);
  }

  /** Conditions of the Cluster; undefined once it is gone. */
  async conditions(namespace: string, name: string): Promise<Condition[] | undefined> {
    try {
      const s = (await (await this.#call('GET', `/clusters/${namespace}/${name}`)).json()) as {
        conditions: Condition[];
      };
      return s.conditions;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** Admin kubeconfig of the workload cluster (audited by the app, ADR-0005). */
  async kubeconfig(namespace: string, name: string): Promise<string> {
    return (await this.#call('GET', `/clusters/${namespace}/${name}/kubeconfig`)).text();
  }

  /** Deletes the cluster with the cleanup of its cloud resources (FP-6). */
  async delete(namespace: string, name: string): Promise<void> {
    await this.#call('POST', `/clusters/${namespace}/${name}/delete`, {
      confirmName: name,
      cleanup: true,
    });
  }
}
