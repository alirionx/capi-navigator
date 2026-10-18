import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import {
  AddonApplyRequestSchema,
  AddonPresetOverrideSchema,
  AddonSpecSchema,
  LabelsSchema,
  type AddonDeletePreview,
  type AddonPresetOverride,
  type AddonPresetView,
  type AddonOverview,
  type AddonPreview,
  type AddonSpec,
} from '@capi-navigator/shared';
import { interval, map, merge, type Observable } from 'rxjs';
import { z } from 'zod';
import { Audit, Requires } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AddonPresetsService } from './addon-presets.service.js';
import { AddonsService } from './addons.service.js';

const HEARTBEAT_MS = 25_000;
const AUDIT = {
  managementClusterParam: 'connection',
  targetKind: 'HelmChartProxy',
  targetParam: 'name',
};
/** Exported: used only in parameter decorators, which no-useless-assignment does not see. */
export const MatchingRequestSchema = z.object({
  namespace: z.string().min(1).max(63),
  selector: LabelsSchema,
});
export const PreviewRequestSchema = z.object({ spec: AddonSpecSchema });

/**
 * Helm add-ons of one management cluster (FP-8): viewers read, operators assign (section 3).
 */
@Controller('api/connections/:connection/addons')
export class AddonsController {
  constructor(private readonly addons: AddonsService) {}

  @Requires('view')
  @Get()
  overview(@Param('connection') connection: string): Promise<AddonOverview> {
    return this.addons.overview(connection);
  }

  /** Live via watches on HelmChartProxies, HelmReleaseProxies and Clusters (NF-11). */
  @Requires('view')
  @Sse('events')
  stream(@Param('connection') connection: string): Observable<MessageEvent> {
    return merge(
      this.addons.live.stream(connection).pipe(map((e) => ({ type: e.type, data: e }))),
      interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'ping', data: {} }))),
    );
  }

  /** FP8-F-07: clusters matching a selector while the form is edited; changes nothing. */
  @Requires('addons.manage', { namespaceFromBody: 'namespace' })
  @Post('matching')
  @HttpCode(200)
  @Audit({ action: 'addon.matching', skip: true })
  matching(
    @Param('connection') connection: string,
    @Body(new ZodValidationPipe(MatchingRequestSchema))
    body: { namespace: string; selector: Record<string, string> },
  ): Promise<string[]> {
    return this.addons.matching(connection, body.namespace, body.selector);
  }

  @Requires('addons.manage', { namespaceFromBody: 'spec.namespace' })
  @Post('preview')
  @HttpCode(200)
  @Audit({ action: 'addon.preview', skip: true })
  preview(
    @Param('connection') connection: string,
    @Body(new ZodValidationPipe(PreviewRequestSchema)) body: { spec: AddonSpec },
  ): Promise<AddonPreview> {
    return this.addons.preview(connection, body.spec);
  }

  /** Creates or updates the HelmChartProxy after the preview (FP8-F-05, FP8-F-13). */
  @Requires('addons.manage')
  @Put(':namespace/:name')
  @Audit({ action: 'addon.apply', ...AUDIT })
  apply(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(AddonApplyRequestSchema))
    body: { spec: AddonSpec; takeOver: boolean },
  ): Promise<AddonPreview> {
    if (body.spec.namespace !== namespace || body.spec.name !== name) {
      throw new BadRequestException('Name and namespace must match the URL');
    }
    return this.addons.apply(connection, body.spec, body.takeOver);
  }

  @Requires('addons.manage')
  @Get(':namespace/:name/delete-preview')
  deletePreview(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Promise<AddonDeletePreview> {
    return this.addons.deletePreview(connection, namespace, name);
  }

  @Requires('addons.manage')
  @Delete(':namespace/:name')
  @HttpCode(204)
  @Audit({ action: 'addon.delete', ...AUDIT })
  delete(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Promise<void> {
    return this.addons.delete(connection, namespace, name);
  }
}

export const PresetOverrideBodySchema = z.object({
  override: AddonPresetOverrideSchema.nullable(),
});

/** CCM/CSI presets (FP8-F-14): viewers read, admins change defaults and roll them out. */
@Controller('api')
export class AddonPresetsController {
  constructor(private readonly presets: AddonPresetsService) {}

  @Requires('view')
  @Get('connections/:connection/addon-presets')
  list(@Param('connection') connection: string): Promise<AddonPresetView[]> {
    return this.presets.list(connection);
  }

  @Requires('presets.manage')
  @Put('addon-presets/:id')
  @HttpCode(204)
  @Audit({ action: 'addon-preset.update', targetKind: 'AddonPreset', targetParam: 'id' })
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PresetOverrideBodySchema))
    body: { override: AddonPresetOverride | null },
  ): Promise<void> {
    return this.presets.update(id, body.override);
  }

  @Requires('presets.manage')
  @Post('connections/:connection/addon-presets/:id/rollout/preview')
  @HttpCode(200)
  @Audit({ action: 'addon-preset.rollout-preview', skip: true })
  rolloutPreview(
    @Param('connection') connection: string,
    @Param('id') id: string,
  ): Promise<AddonPreview> {
    return this.presets.rolloutPreview(connection, id);
  }

  @Requires('presets.manage')
  @Post('connections/:connection/addon-presets/:id/rollout')
  @HttpCode(200)
  @Audit({
    action: 'addon-preset.rollout',
    targetKind: 'AddonPreset',
    targetParam: 'id',
    managementClusterParam: 'connection',
  })
  rollout(@Param('connection') connection: string, @Param('id') id: string): Promise<AddonPreview> {
    return this.presets.rollout(connection, id);
  }
}
