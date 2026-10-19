import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  CloudsYamlInfoSchema,
  CredentialSchema,
  LookupResponseSchema,
  ManifestPreviewSchema,
  CloudsYamlInfoRequestSchema,
  CreateCredentialRequestSchema,
  UpdateCredentialRequestSchema,
  type CloudsYamlInfo,
  type CreateCredentialRequest,
  type Credential,
  type LookupResponse,
  type ManifestPreview,
  type UpdateCredentialRequest,
} from '@capi-navigator/shared';
import { Audit, Requires } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CredentialsService } from './credentials.service.js';
import { Api } from '../openapi/api.decorator.js';
import { z } from 'zod';

const AUDIT = {
  managementClusterParam: 'connection',
  targetKind: 'Credential',
  targetParam: 'name',
};

/** Infrastructure credentials of one management cluster (FP-4). */
@Controller('api/connections/:connection/credentials')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Requires('view')
  @Api({
    summary: 'List cloud credentials (never secret values)',
    response: z.array(CredentialSchema),
  })
  @Get()
  list(@Param('connection') connection: string): Promise<Credential[]> {
    return this.credentials.list(connection);
  }

  /** Lists the clouds of an uploaded clouds.yaml; returns no secrets. */
  @Requires('credentials.manage')
  @Api({
    summary: 'Clouds and settings found in a clouds.yaml, before storing it',
    description: 'The file is only parsed, never stored or returned.',
    response: CloudsYamlInfoSchema,
  })
  @Post('clouds-yaml-info')
  @HttpCode(200)
  @Audit({ action: 'credential.parse-clouds-yaml', skip: true })
  cloudsYamlInfo(
    @Body(new ZodValidationPipe(CloudsYamlInfoRequestSchema)) body: { cloudsYaml: string },
  ): CloudsYamlInfo {
    return this.credentials.cloudsYamlInfo(body.cloudsYaml);
  }

  @Requires('credentials.manage')
  @Api({
    summary: 'Preview storing a credential (secret values masked)',
    description:
      'Dry run on the management cluster; nothing is changed. Shows the generated objects or diff first (hard rule 6).',
    response: ManifestPreviewSchema,
  })
  @Post('preview')
  @HttpCode(200)
  @Audit({ action: 'credential.preview', skip: true })
  preview(
    @Param('connection') connection: string,
    @Body(new ZodValidationPipe(CreateCredentialRequestSchema)) body: CreateCredentialRequest,
  ): Promise<ManifestPreview> {
    return this.credentials.preview(connection, body);
  }

  @Requires('credentials.manage')
  @Api({
    summary: 'Store a credential as Secret plus cluster-scoped identity and test it',
    description: 'Server-side apply with field manager capi-navigator; recorded as AuditEvent.',
    response: CredentialSchema,
  })
  @Post()
  @Audit({ action: 'credential.create', ...AUDIT })
  create(
    @Param('connection') connection: string,
    @Body(new ZodValidationPipe(CreateCredentialRequestSchema)) body: CreateCredentialRequest,
  ): Promise<Credential> {
    return this.credentials.create(connection, body);
  }

  @Requires('view')
  @Api({ summary: 'Get a credential (never secret values)', response: CredentialSchema })
  @Get(':provider/:name')
  get(
    @Param('connection') connection: string,
    @Param('provider') provider: string,
    @Param('name') name: string,
  ): Promise<Credential> {
    return this.credentials.get(connection, provider, name);
  }

  @Requires('credentials.manage')
  @Api({
    summary: 'Change allowed namespaces or replace the secret values',
    response: CredentialSchema,
  })
  @Patch(':provider/:name')
  @Audit({ action: 'credential.update', ...AUDIT })
  update(
    @Param('connection') connection: string,
    @Param('provider') provider: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(UpdateCredentialRequestSchema)) body: UpdateCredentialRequest,
  ): Promise<Credential> {
    return this.credentials.update(connection, provider, name, body);
  }

  @Requires('credentials.manage')
  @Api({
    summary: 'Delete a credential (Secret and identity)',
    description: 'Refused while workload clusters use it.',
    response: 'empty',
  })
  @Delete(':provider/:name')
  @HttpCode(204)
  @Audit({ action: 'credential.delete', ...AUDIT })
  remove(
    @Param('connection') connection: string,
    @Param('provider') provider: string,
    @Param('name') name: string,
  ): Promise<void> {
    return this.credentials.remove(connection, provider, name);
  }

  @Requires('credentials.manage')
  @Api({ summary: 'Test a credential against the cloud', response: CredentialSchema })
  @Post(':provider/:name/test')
  @HttpCode(200)
  @Audit({ action: 'credential.test', ...AUDIT })
  test(
    @Param('connection') connection: string,
    @Param('provider') provider: string,
    @Param('name') name: string,
  ): Promise<Credential> {
    return this.credentials.test(connection, provider, name);
  }

  /** Selection lists for the cluster wizard; operators create clusters (FP-5). */
  @Requires(['clusters.create', 'clusters.change'])
  @Api({
    summary: 'Selection lists from the cloud (images, sizes, networks, ...)',
    description: 'Used by the wizard and day-2 forms; the credential never leaves the backend.',
    response: LookupResponseSchema,
  })
  @Get(':provider/:name/lookups/:kind')
  lookup(
    @Param('connection') connection: string,
    @Param('provider') provider: string,
    @Param('name') name: string,
    @Param('kind') kind: string,
    @Query('region') region?: string,
  ): Promise<LookupResponse> {
    return this.credentials.lookup(connection, provider, name, kind, region);
  }
}
