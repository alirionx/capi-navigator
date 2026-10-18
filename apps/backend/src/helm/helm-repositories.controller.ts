import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  CreateHelmRepositoryRequestSchema,
  UpdateHelmRepositoryRequestSchema,
  type ChartSummary,
  type ChartValues,
  type ChartVersion,
  type CreateHelmRepositoryRequest,
  type HelmRepository,
  type HelmRepositoryTestResult,
  type UpdateHelmRepositoryRequest,
} from '@capi-navigator/shared';
import { z } from 'zod';
import { Audit, Requires } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { HelmRepositoriesService } from './helm-repositories.service.js';

const AUDIT = { targetKind: 'HelmRepository', targetParam: 'name' };
export const ChartQuerySchema = z.object({ chart: z.string().min(1).max(253) });
/** Exported: used only in a parameter decorator, which no-useless-assignment does not see. */
export const ValuesQuerySchema = ChartQuerySchema.extend({ version: z.string().min(1).max(128) });
type Create = CreateHelmRepositoryRequest & { url: string };

/**
 * Helm repositories (FP8-F-02 to F-04): viewers see them, operators browse charts for their
 * add-ons, admins manage them (section 3).
 */
@Controller('api/helm-repositories')
export class HelmRepositoriesController {
  constructor(private readonly repos: HelmRepositoriesService) {}

  @Requires('view')
  @Get()
  list(): HelmRepository[] {
    return this.repos.list();
  }

  @Requires('helmRepositories.manage')
  @Post()
  @Audit({ action: 'helm-repository.create', ...AUDIT })
  create(
    @Body(new ZodValidationPipe(CreateHelmRepositoryRequestSchema)) body: Create,
  ): Promise<HelmRepository> {
    return this.repos.create(body);
  }

  /** Connection test from the form before saving; changes nothing. */
  @Requires('helmRepositories.manage')
  @Post('test')
  @HttpCode(200)
  @Audit({ action: 'helm-repository.test-draft', skip: true })
  testDraft(
    @Body(new ZodValidationPipe(CreateHelmRepositoryRequestSchema)) body: Create,
  ): Promise<HelmRepositoryTestResult> {
    return this.repos.testDraft(body);
  }

  @Requires('view')
  @Get(':name')
  get(@Param('name') name: string): HelmRepository {
    return this.repos.get(name);
  }

  @Requires('helmRepositories.manage')
  @Patch(':name')
  @Audit({ action: 'helm-repository.update', ...AUDIT })
  update(
    @Param('name') name: string,
    @Body(new ZodValidationPipe(UpdateHelmRepositoryRequestSchema))
    body: UpdateHelmRepositoryRequest,
  ): Promise<HelmRepository> {
    return this.repos.update(name, body);
  }

  @Requires('helmRepositories.manage')
  @Delete(':name')
  @HttpCode(204)
  @Audit({ action: 'helm-repository.delete', ...AUDIT })
  delete(@Param('name') name: string): Promise<void> {
    return this.repos.delete(name);
  }

  @Requires('helmRepositories.manage')
  @Post(':name/test')
  @HttpCode(200)
  @Audit({ action: 'helm-repository.test', ...AUDIT })
  test(@Param('name') name: string): Promise<HelmRepositoryTestResult> {
    return this.repos.test(name);
  }

  @Requires('addons.manage')
  @Get(':name/charts')
  charts(@Param('name') name: string): Promise<ChartSummary[]> {
    return this.repos.charts(name);
  }

  @Requires('addons.manage')
  @Get(':name/versions')
  versions(
    @Param('name') name: string,
    @Query(new ZodValidationPipe(ChartQuerySchema)) q: { chart: string },
  ): Promise<ChartVersion[]> {
    return this.repos.versions(name, q.chart);
  }

  @Requires('addons.manage')
  @Get(':name/values')
  values(
    @Param('name') name: string,
    @Query(new ZodValidationPipe(ValuesQuerySchema)) q: { chart: string; version: string },
  ): Promise<ChartValues> {
    return this.repos.values(name, q.chart, q.version);
  }
}
