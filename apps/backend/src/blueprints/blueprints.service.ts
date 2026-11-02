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
   * a dry run on the management cluster and the blockers of the wizard.
   */
  async preview(spec: ClusterBlueprintSpec): Promise<ClusterPreview> {
    const outside = versionsOutsideCatalog(spec);
    if (outside.length > 0) {
      throw new BadRequestException({
        message: `Not in the version catalog of ${spec.cluster.kubernetes.flavor}: ${outside.join(', ')}`,
        hint: 'Offer only versions of the catalog (versions.yaml).',
      });
    }
    return this.clusterService.preview(spec.connection, baseSpec(spec), false);
  }

  async create(name: string, spec: ClusterBlueprintSpec): Promise<ClusterBlueprint> {
    if (this.store.blueprintCache.get(name)) {
      throw new ConflictException(`Blueprint ${name} already exists`);
    }
    await this.check(spec);
    const created = await this.store.blueprints.create({ name }, storage(spec));
    this.store.blueprintCache.upsert(created);
    return this.get(name);
  }

  /** FP34-F-08: changes apply only to clusters created afterwards. */
  async update(name: string, spec: ClusterBlueprintSpec): Promise<ClusterBlueprint> {
    const current = this.resource(name);
    await this.check(spec);
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
    const spec = blueprintToSpecSchema(name, bp).safeParse(req);
    if (!spec.success) {
      throw new BadRequestException({
        message: 'The request does not fit the blueprint',
        details: issuesOf(spec.error),
      });
    }
    return this.clusterService.create(bp.connection, spec.data, false);
  }

  private async check(spec: ClusterBlueprintSpec): Promise<void> {
    const preview = await this.preview(spec);
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
