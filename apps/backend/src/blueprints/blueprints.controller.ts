import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import {
  BlueprintClusterRequestSchema,
  BlueprintSaveRequestSchema,
  ClusterBlueprintSchema,
  ClusterBlueprintSpecSchema,
  ClusterPreviewSchema,
  ClusterSummarySchema,
  type BlueprintClusterRequest,
  type ClusterBlueprint,
  type ClusterBlueprintSpec,
  type ClusterPreview,
  type ClusterSummary,
} from '@capi-navigator/shared';
import { z } from 'zod';
import { Audit, Requires } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Api } from '../openapi/api.decorator.js';
import { BlueprintsService } from './blueprints.service.js';

const AUDIT = { targetKind: 'ClusterBlueprint', targetParam: 'name' };
const UpdateRequestSchema = z.object({ spec: ClusterBlueprintSpecSchema });

/**
 * Cluster blueprints (FP-34, ADR-0035): everyone reads them, admins manage them, and clusters are
 * created from them with `clusters.create` in the blueprint's namespace.
 */
@Controller('api/blueprints')
export class BlueprintsController {
  constructor(private readonly blueprints: BlueprintsService) {}

  @Requires('view')
  @Api({
    summary: 'List cluster blueprints with the JSON Schema of their parameters',
    response: z.array(ClusterBlueprintSchema),
  })
  @Get()
  list(): ClusterBlueprint[] {
    return this.blueprints.list();
  }

  /** FP34-F-04: the YAML and dry run of the base spec, shown before saving. */
  @Requires('blueprints.manage')
  @Api({
    summary: 'Preview a blueprint before saving',
    description:
      'Checks the base spec like a new cluster with the default parameters (dry run); nothing is changed.',
    response: ClusterPreviewSchema,
  })
  @Post('preview')
  @HttpCode(200)
  @Audit({ action: 'blueprint.preview', skip: true })
  preview(
    @Body(new ZodValidationPipe(BlueprintSaveRequestSchema))
    body: {
      spec: ClusterBlueprintSpec;
    },
  ): Promise<ClusterPreview> {
    return this.blueprints.preview(body.spec);
  }

  @Requires('blueprints.manage')
  @Api({
    summary: 'Save a new cluster blueprint',
    description: 'Refused while the check of the base spec fails (FP34-F-04).',
    response: ClusterBlueprintSchema,
  })
  @Post()
  @Audit({ action: 'blueprint.create', ...AUDIT })
  create(
    @Body(new ZodValidationPipe(BlueprintSaveRequestSchema))
    body: {
      name: string;
      spec: ClusterBlueprintSpec;
    },
  ): Promise<ClusterBlueprint> {
    return this.blueprints.create(body.name, body.spec);
  }

  @Requires('view')
  @Api({ summary: 'Get a cluster blueprint', response: ClusterBlueprintSchema })
  @Get(':name')
  get(@Param('name') name: string): ClusterBlueprint {
    return this.blueprints.get(name);
  }

  @Requires('blueprints.manage')
  @Api({
    summary: 'Change a cluster blueprint',
    description: 'Applies only to clusters created afterwards (FP34-F-08).',
    response: ClusterBlueprintSchema,
  })
  @Put(':name')
  @Audit({ action: 'blueprint.update', ...AUDIT })
  update(
    @Param('name') name: string,
    @Body(new ZodValidationPipe(UpdateRequestSchema)) body: { spec: ClusterBlueprintSpec },
  ): Promise<ClusterBlueprint> {
    return this.blueprints.update(name, body.spec);
  }

  @Requires('blueprints.manage')
  @Api({
    summary: 'Delete a cluster blueprint',
    description: 'Refused while clusters created from it exist (FP34-F-09).',
    response: 'empty',
  })
  @Delete(':name')
  @HttpCode(204)
  @Audit({ action: 'blueprint.delete', ...AUDIT })
  delete(@Param('name') name: string): Promise<void> {
    return this.blueprints.delete(name);
  }

  @Requires('view')
  @Api({
    summary: 'Clusters created from a blueprint',
    response: z.array(ClusterSummarySchema),
  })
  @Get(':name/clusters')
  clusters(@Param('name') name: string): Promise<ClusterSummary[]> {
    return this.blueprints.clusters(name);
  }

  /** FP34-F-05, ADR-0035: the blueprint is the reviewed preview, so this applies directly. */
  @Requires('clusters.create', { scopeFromBlueprint: 'blueprint' })
  @Api({
    summary: 'Create a cluster from a blueprint',
    description:
      'Builds the cluster spec from the blueprint, the parameters and additional labels, and applies it without a preview (ADR-0035). Needs clusters.create in the blueprint namespace.',
    response: ClusterSummarySchema,
  })
  @Post(':blueprint/clusters')
  @Audit({ action: 'cluster.create-from-blueprint', targetKind: 'Cluster', targetParam: 'name' })
  createCluster(
    @Param('blueprint') blueprint: string,
    @Body(new ZodValidationPipe(BlueprintClusterRequestSchema)) body: BlueprintClusterRequest,
  ): Promise<ClusterSummary> {
    return this.blueprints.createCluster(blueprint, body);
  }
}
