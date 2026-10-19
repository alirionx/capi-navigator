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
  Query,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import {
  ManifestPreviewSchema,
  OperatorStateSchema,
  ProviderUsageSchema,
  ProviderVariablesSchema,
  ReleaseListSchema,
  OrcInstallRequestSchema,
  ProviderInstallRequestSchema,
  ProviderUpdateRequestSchema,
  type ManifestPreview,
  type OperatorState,
  type OrcInstallRequest,
  type ProviderInstallSpec,
  type ProviderUsage,
  type ReleaseList,
} from '@capi-navigator/shared';
import { interval, map, merge, type Observable } from 'rxjs';
import type { z } from 'zod';
import { Audit, Requires } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OperatorEventsService } from './operator-events.service.js';
import { isProviderKind, OperatorService, type ProviderRef } from './operator.service.js';
import { Api, liveEvents } from '../openapi/api.decorator.js';

const HEARTBEAT_MS = 25_000;
const MC = { managementClusterParam: 'connection' };
const PROVIDER_AUDIT = { ...MC, targetKind: 'Provider', targetParam: 'name' };

function ref(kind: string, namespace: string, name: string): ProviderRef {
  if (!isProviderKind(kind)) throw new BadRequestException(`Unknown provider kind "${kind}"`);
  return { kind, namespace, name };
}

/** CAPI Operator, ORC and providers of one management cluster (FP-3). */
@Controller('api/connections/:connection/operator')
export class OperatorController {
  constructor(
    private readonly operator: OperatorService,
    private readonly events: OperatorEventsService,
  ) {}

  @Requires('view')
  @Api({
    summary: 'Prerequisites, ORC and providers of a management cluster',
    response: OperatorStateSchema,
  })
  @Get()
  state(@Param('connection') connection: string): Promise<OperatorState> {
    return this.operator.state(connection);
  }

  /** FP3-F-13: live state via server-sent events. */
  @Requires('view')
  @Api({
    summary: 'Live updates of the provider state',
    response: { events: liveEvents(OperatorStateSchema) },
  })
  @Sse('events')
  stream(@Param('connection') connection: string): Observable<MessageEvent> {
    return merge(
      this.events.stream(connection).pipe(map((e) => ({ type: e.type, data: e }))),
      interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'ping', data: {} }))),
    );
  }

  @Requires('view')
  @Api({ summary: 'Available ORC releases', response: ReleaseListSchema })
  @Get('releases/orc')
  orcReleases(): Promise<ReleaseList> {
    return this.operator.orcReleases();
  }

  @Requires('view')
  @Api({ summary: 'Available releases of a catalog provider', response: ReleaseListSchema })
  @Get('releases/:catalogId')
  releases(@Param('catalogId') catalogId: string): Promise<ReleaseList> {
    return this.operator.providerReleases(catalogId);
  }

  @Requires('providers.manage')
  @Api({
    summary: 'Preview installing ORC',
    description:
      'Dry run on the management cluster; nothing is changed. Shows the generated objects or diff first (hard rule 6).',
    response: ManifestPreviewSchema,
  })
  @Post('orc/preview')
  @HttpCode(200)
  @Audit({ action: 'orc.preview', skip: true })
  previewOrc(
    @Param('connection') connection: string,
    @Body(new ZodValidationPipe(OrcInstallRequestSchema)) body: OrcInstallRequest,
  ): Promise<ManifestPreview> {
    return this.operator.previewOrc(connection, body.version);
  }

  @Requires('providers.manage')
  @Api({
    summary: 'Install ORC from its release manifest',
    description: 'Server-side apply with field manager capi-navigator; recorded as AuditEvent.',
    response: ManifestPreviewSchema,
  })
  @Post('orc')
  @HttpCode(200)
  @Audit({ action: 'orc.install', ...MC })
  installOrc(
    @Param('connection') connection: string,
    @Body(new ZodValidationPipe(OrcInstallRequestSchema)) body: OrcInstallRequest,
  ): Promise<ManifestPreview> {
    return this.operator.installOrc(connection, body.version);
  }

  @Requires('providers.manage')
  @Api({
    summary: 'Preview installing a provider',
    description:
      'Dry run on the management cluster; nothing is changed. Shows the generated objects or diff first (hard rule 6).',
    response: ManifestPreviewSchema,
  })
  @Post('providers/preview')
  @HttpCode(200)
  @Audit({ action: 'provider.preview', skip: true })
  previewInstall(
    @Param('connection') connection: string,
    @Body(new ZodValidationPipe(ProviderInstallRequestSchema)) body: ProviderInstallSpec,
  ): Promise<ManifestPreview> {
    return this.operator.previewInstall(connection, body);
  }

  @Requires('providers.manage')
  @Api({
    summary: 'Install a provider through the CAPI Operator',
    description: 'Server-side apply with field manager capi-navigator; recorded as AuditEvent.',
    response: ManifestPreviewSchema,
  })
  @Post('providers')
  @Audit({ action: 'provider.install', ...MC, targetKind: 'Provider', targetParam: 'catalogId' })
  install(
    @Param('connection') connection: string,
    @Body(new ZodValidationPipe(ProviderInstallRequestSchema)) body: ProviderInstallSpec,
  ): Promise<ManifestPreview> {
    return this.operator.install(connection, body);
  }

  @Requires('providers.manage')
  @Api({
    summary: 'Preview changing a provider (version, configuration)',
    description:
      'Dry run on the management cluster; nothing is changed. Shows the generated objects or diff first (hard rule 6).',
    response: ManifestPreviewSchema,
  })
  @Put('providers/:kind/:namespace/:name/preview')
  @HttpCode(200)
  @Audit({ action: 'provider.preview-update', skip: true })
  previewUpdate(
    @Param('connection') connection: string,
    @Param('kind') kind: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(ProviderUpdateRequestSchema))
    body: z.output<typeof ProviderUpdateRequestSchema>,
  ): Promise<ManifestPreview> {
    return this.operator.previewUpdate(connection, ref(kind, namespace, name), body);
  }

  @Requires('providers.manage')
  @Api({
    summary: 'Change a provider (version, configuration)',
    description: 'Server-side apply with field manager capi-navigator; recorded as AuditEvent.',
    response: ManifestPreviewSchema,
  })
  @Put('providers/:kind/:namespace/:name')
  @Audit({ action: 'provider.update', ...PROVIDER_AUDIT })
  update(
    @Param('connection') connection: string,
    @Param('kind') kind: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(ProviderUpdateRequestSchema))
    body: z.output<typeof ProviderUpdateRequestSchema>,
  ): Promise<ManifestPreview> {
    return this.operator.update(connection, ref(kind, namespace, name), body);
  }

  @Requires('view')
  @Api({ summary: 'Workload clusters that use a provider', response: ProviderUsageSchema })
  @Get('providers/:kind/:namespace/:name/usage')
  usage(
    @Param('connection') connection: string,
    @Param('kind') kind: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Promise<ProviderUsage> {
    return this.operator.usage(connection, ref(kind, namespace, name));
  }

  @Requires('providers.manage')
  @Api({
    summary: 'Names of the variables of a provider (no values)',
    response: ProviderVariablesSchema,
  })
  @Get('providers/:kind/:namespace/:name/variables')
  async variables(
    @Param('connection') connection: string,
    @Param('kind') kind: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ): Promise<{ names: string[] }> {
    return { names: await this.operator.variableNames(connection, ref(kind, namespace, name)) };
  }

  @Requires('providers.manage')
  @Api({
    summary: 'Remove a provider',
    description: 'Refused while workload clusters use it.',
    response: 'empty',
  })
  @Delete('providers/:kind/:namespace/:name')
  @HttpCode(204)
  @Audit({ action: 'provider.delete', ...PROVIDER_AUDIT })
  remove(
    @Param('connection') connection: string,
    @Param('kind') kind: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Query('force') force?: string,
  ): Promise<void> {
    return this.operator.remove(connection, ref(kind, namespace, name), force === 'true');
  }
}
