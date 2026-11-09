import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  blueprintParametersJsonSchema,
  blueprintToSpecSchema,
  ClusterBlueprintSpecSchema,
  INFRA_PLUGINS,
  versionsOutsideCatalog,
  type BlueprintClusterRequest,
  type ClusterBlueprint,
  type ClusterBlueprintSpec,
  type ClusterBlueprintStorage,
  type ClusterPreview,
  type ClusterSummary,
  type NavigatorResource,
} from '@capi-navigator/shared';
import { z } from 'zod';
import { ClustersService } from '../clusters/clusters.service.js';
import { isNotFound } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';

const issuesOf = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || '(request)'}: ${i.message}`).join('; ');

/**
 * Cluster blueprints (FP-34, ADR-0035): reviewed cluster specs with a few parameters. Saving a
 * blueprint checks it like a new cluster; clusters are created from it without a preview.
 */
@Injectable()
export class BlueprintsService {
  /** Last order per connection; orders run one after another (FP34-F-14). */
  private readonly orders = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: StoreService,
    private readonly clusterService: ClustersService,
  ) {}

  list(): ClusterBlueprint[] {
    return this.store.blueprintCache
      .list()
      .flatMap((r) => {
        const spec = ClusterBlueprintSpecSchema.safeParse(r.spec);
        return spec.success ? [toApi(r.metadata.name, spec.data)] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): ClusterBlueprint {
    return toApi(name, this.spec(name));
  }

  /**
   * FP34-F-04: the check when saving, like a new cluster with the default parameters: the YAML,
   * a dry run on the management cluster and the blockers of the wizard. With a pool (FP34-F-14,
   * FP34-F-15) the example gets free addresses or a free network of the pool, like every order.
   */
  async preview(name: string, spec: ClusterBlueprintSpec): Promise<ClusterPreview> {
    const outside = versionsOutsideCatalog(spec);
    if (outside.length > 0) {
      throw new BadRequestException({
        message: `Not in the version catalog of ${spec.cluster.kubernetes.flavor}: ${outside.join(', ')}`,
        hint: 'Offer only versions of the catalog (versions.yaml).',
      });
    }
    const example = await this.toSpec(name, spec, { name: spec.cluster.name });
    if (!example.success) {
      return {
        yaml: '',
        objects: [],
        warnings: [],
        blockers: example.error.issues.map((i) => i.message),
        credentialNamespaceMissing: false,
      };
    }
    return this.clusterService.preview(spec.connection, example.data, false);
  }

  async create(name: string, spec: ClusterBlueprintSpec): Promise<ClusterBlueprint> {
    if (this.store.blueprintCache.get(name)) {
      throw new ConflictException(`Blueprint ${name} already exists`);
    }
    await this.check(name, spec);
    const created = await this.store.blueprints.create({ name }, storage(spec));
    this.store.blueprintCache.upsert(created);
    return this.get(name);
  }

  /** FP34-F-08: changes apply only to clusters created afterwards. */
  async update(name: string, spec: ClusterBlueprintSpec): Promise<ClusterBlueprint> {
    const current = this.resource(name);
    await this.check(name, spec);
    const updated = await this.store.blueprints.replaceSpec(current, storage(spec));
    this.store.blueprintCache.upsert(updated);
    return toApi(name, spec);
  }

  /** FP34-F-09: refused while clusters created from the blueprint exist. */
  async delete(name: string): Promise<void> {
    const spec = this.resource(name).spec;
    const users = await this.clustersOf(name, spec.connection);
    if (users.length > 0) {
      throw new ConflictException({
        message: `Blueprint ${name} is used by ${users.length} cluster(s)`,
        hint: `Delete these clusters first: ${users.map((c) => `${c.namespace}/${c.name}`).join(', ')}`,
      });
    }
    try {
      await this.store.blueprints.delete(name);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    this.store.blueprintCache.remove(name);
  }

  /** Clusters created from a blueprint, from the annotation on the Cluster (FP34-F-06). */
  async clusters(name: string): Promise<ClusterSummary[]> {
    return this.clustersOf(name, this.resource(name).spec.connection);
  }

  /** FP34-F-05: builds the spec from blueprint and request and creates it without a preview. */
  async createCluster(name: string, req: BlueprintClusterRequest): Promise<ClusterSummary> {
    const bp = this.spec(name);
    // FP34-F-14, FP34-F-15: one order per connection at a time, so two orders never get the same
    // addresses or network.
    const previous = this.orders.get(bp.connection) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const spec = await this.toSpec(name, bp, req);
        if (!spec.success) {
          const pool = spec.error.issues.find((i) => i.path[0] === 'addressPool');
          if (pool) {
            const hint =
              INFRA_PLUGINS[bp.cluster.infrastructure.provider].addressPool?.exhaustedHint;
            throw new ConflictException({ message: pool.message, hint });
          }
          throw new BadRequestException({
            message: 'The request does not fit the blueprint',
            details: issuesOf(spec.error),
          });
        }
        return this.clusterService.create(bp.connection, spec.data, false);
      });
    this.orders.set(bp.connection, run);
    return run;
  }

  /** The cluster spec of an order, with a free part of the pool if the blueprint has one. */
  private async toSpec(name: string, bp: ClusterBlueprintSpec, req: BlueprintClusterRequest) {
    const infra = bp.cluster.infrastructure;
    const used = bp.addressPool
      ? await this.clusterService.usedAddresses(bp.connection, infra.provider, infra.credentialRef)
      : [];
    return blueprintToSpecSchema(name, bp, used).safeParse(req);
  }

  private async check(name: string, spec: ClusterBlueprintSpec): Promise<void> {
    const preview = await this.preview(name, spec);
    if (preview.blockers.length > 0) {
      throw new ConflictException({
        message: preview.blockers[0],
        hint: preview.blockers.slice(1).join(' ') || undefined,
      });
    }
  }

  private async clustersOf(name: string, connection: string): Promise<ClusterSummary[]> {
    return (await this.clusterService.list(connection)).filter((c) => c.blueprint === name);
  }

  private resource(name: string): NavigatorResource<ClusterBlueprintStorage> {
    const r = this.store.blueprintCache.get(name);
    if (!r) throw new NotFoundException(`Blueprint ${name} not found`);
    return r;
  }

  /** The stored blueprint, checked; a blueprint that no longer fits the schema is refused. */
  private spec(name: string): ClusterBlueprintSpec {
    const parsed = ClusterBlueprintSpecSchema.safeParse(this.resource(name).spec);
    if (!parsed.success) {
      throw new ConflictException({
        message: `Blueprint ${name} is no longer valid`,
        hint: `Open and save it again on the Blueprints page. ${issuesOf(parsed.error)}`,
      });
    }
    return parsed.data;
  }
}

/** The base spec without a blueprint reference, as checked when saving. */
function baseSpec(spec: ClusterBlueprintSpec): ClusterBlueprintSpec['cluster'] {
  const cluster = { ...spec.cluster };
  delete cluster.blueprint;
  return cluster;
}

function storage(spec: ClusterBlueprintSpec): ClusterBlueprintStorage {
  return { ...spec, cluster: baseSpec(spec) };
}

function toApi(name: string, spec: ClusterBlueprintSpec): ClusterBlueprint {
  return { name, spec, parametersSchema: blueprintParametersJsonSchema(spec) };
}
