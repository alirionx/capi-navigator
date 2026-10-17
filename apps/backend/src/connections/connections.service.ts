import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  connectionSecretName,
  type Connection,
  type ConnectionCredentials,
  type CreateConnectionRequest,
  type KubeconfigContexts,
  type ManagementClusterSpec,
  type ManagementClusterStatus,
  type NavigatorResource,
  type UpdateConnectionRequest,
} from '@capi-navigator/shared';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';
import { testConnection } from './connection-tester.js';
import {
  extractTarget,
  KubeconfigError,
  listContexts,
  normalizedKubeconfig,
  pemToData,
  type ConnectionTarget,
} from './kubeconfig.js';
import { ManagementClusterClients } from './management-cluster-clients.js';

type ConnectionResource = NavigatorResource<ManagementClusterSpec, ManagementClusterStatus>;

/** Resolved credentials: what goes into the CR (display data) and into the Secret. */
interface ResolvedCredentials {
  authType: ManagementClusterSpec['authType'];
  server?: string;
  context?: string;
  target?: ConnectionTarget;
}

/** Management cluster connections (FP-2). */
@Injectable()
export class ConnectionsService {
  constructor(
    private readonly store: StoreService,
    private readonly clients: ManagementClusterClients,
  ) {}

  list(): Connection[] {
    return this.store.connectionCache.list().map((c) => toConnection(c as ConnectionResource));
  }

  get(name: string): Connection {
    return toConnection(this.require(name));
  }

  listContexts(kubeconfig: string): KubeconfigContexts {
    try {
      return listContexts(kubeconfig);
    } catch (err) {
      throw credentialError(err, 'credentials.kubeconfig');
    }
  }

  async create(req: CreateConnectionRequest): Promise<Connection> {
    if (this.store.connectionCache.get(req.name)) {
      throw new ConflictException(`Connection "${req.name}" already exists`);
    }
    const creds = this.resolve(req.name, req.credentials);
    const created = await this.kube(`Create connection ${req.name}`, () =>
      this.store.connections.create(
        { name: req.name, labels: { 'app.kubernetes.io/part-of': 'capi-navigator' } },
        {
          authType: creds.authType,
          credentialsRevision: 0,
          ...(req.displayName ? { displayName: req.displayName } : {}),
          ...(creds.server ? { server: creds.server } : {}),
          ...(creds.context ? { context: creds.context } : {}),
        },
      ),
    );
    this.store.connectionCache.upsert(created);
    try {
      await this.writeCredentials(req.name, creds);
    } catch (err) {
      await this.store.connections.delete(req.name).catch(() => undefined);
      this.store.connectionCache.remove(req.name);
      throw toHttpException(err, `Store credentials of ${req.name}`);
    }
    return this.test(req.name);
  }

  async update(name: string, req: UpdateConnectionRequest): Promise<Connection> {
    const conn = this.require(name);
    const patch: Record<string, unknown> = {};
    if (req.displayName !== undefined) patch.displayName = req.displayName || null;
    if (req.credentials) {
      const creds = this.resolve(name, req.credentials);
      await this.kube(`Store credentials of ${name}`, () => this.writeCredentials(name, creds));
      Object.assign(patch, {
        authType: creds.authType,
        server: creds.server ?? null,
        context: creds.context ?? null,
        credentialsRevision: conn.spec.credentialsRevision + 1,
      });
      this.clients.forget(name);
    }
    const updated = await this.kube(`Update connection ${name}`, () =>
      this.store.connections.patchSpec(name, patch as Partial<ManagementClusterSpec>),
    );
    this.store.connectionCache.upsert(updated);
    return req.credentials ? this.test(name) : toConnection(this.require(name));
  }

  async delete(name: string): Promise<void> {
    this.require(name);
    await this.kube(`Delete connection ${name}`, () => this.store.connections.delete(name));
    this.store.connectionCache.remove(name);
    this.clients.forget(name);
    await this.store.secrets.delete(connectionSecretName(name));
  }

  /** FP2-F-04: tests the connection and stores the result in the resource status. */
  async test(name: string): Promise<Connection> {
    this.require(name);
    const kc = await this.clients.forConnection(name);
    const status = await testConnection(kc);
    const updated = await this.kube(`Store test result of ${name}`, () =>
      this.store.connections.patchStatus(name, statusPatch(status)),
    );
    this.store.connectionCache.upsert(updated);
    return toConnection(this.require(name));
  }

  private resolve(name: string, credentials: ConnectionCredentials): ResolvedCredentials {
    try {
      switch (credentials.authType) {
        case 'kubeconfig': {
          const target = extractTarget(credentials.kubeconfig, credentials.context || undefined);
          return { authType: 'kubeconfig', server: target.server, context: target.context, target };
        }
        case 'token':
          return {
            authType: 'token',
            server: credentials.server,
            target: {
              server: credentials.server,
              token: credentials.token,
              ...(credentials.caCert ? { caData: pemToData(credentials.caCert) } : {}),
            },
          };
        case 'in-cluster': {
          const other = this.store.connectionCache
            .list()
            .find((c) => c.spec.authType === 'in-cluster' && c.metadata.name !== name);
          if (other) {
            throw new ConflictException({
              statusCode: 409,
              message: `The home cluster is already connected as "${other.metadata.name}"`,
            });
          }
          return { authType: 'in-cluster', server: this.clients.homeServer() };
        }
      }
    } catch (err) {
      throw credentialError(err, 'credentials.kubeconfig');
    }
  }

  private async writeCredentials(name: string, creds: ResolvedCredentials): Promise<void> {
    const secretName = connectionSecretName(name);
    if (!creds.target) {
      await this.store.secrets.delete(secretName);
      return;
    }
    await this.store.secrets.put(
      secretName,
      { kubeconfig: normalizedKubeconfig(name, creds.target) },
      { 'capi-navigator.io/connection': name },
    );
  }

  private require(name: string): ConnectionResource {
    const conn = this.store.connectionCache.get(name);
    if (!conn) throw new NotFoundException(`Connection "${name}" not found`);
    return conn as ConnectionResource;
  }

  private async kube<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isNotFound(err)) throw new NotFoundException(`${context}: not found`);
      throw toHttpException(err, context);
    }
  }
}

/** Merge patch that also clears fields of an earlier result (null removes a field). */
function statusPatch(status: ManagementClusterStatus): Record<string, unknown> {
  const keys = ['kubernetesVersion', 'message', 'hint', 'details', 'permissions'] as const;
  const patch: Record<string, unknown> = { ...status };
  for (const key of keys) if (status[key] === undefined) patch[key] = null;
  return patch;
}

function credentialError(err: unknown, field: string): unknown {
  if (err instanceof KubeconfigError) {
    return new BadRequestException({
      statusCode: 400,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      fieldErrors: { [field]: [err.message] },
    });
  }
  return err;
}

function toConnection(c: ConnectionResource): Connection {
  return {
    name: c.metadata.name,
    authType: c.spec.authType,
    ...(c.spec.displayName ? { displayName: c.spec.displayName } : {}),
    ...(c.spec.server ? { server: c.spec.server } : {}),
    ...(c.spec.context ? { context: c.spec.context } : {}),
    ...(c.metadata.creationTimestamp ? { createdAt: String(c.metadata.creationTimestamp) } : {}),
    status: c.status ?? { phase: 'Unknown' },
  };
}
