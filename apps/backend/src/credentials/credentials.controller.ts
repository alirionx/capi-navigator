import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
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
import { Audit, Roles } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CredentialsService } from './credentials.service.js';

const AUDIT = {
  managementClusterParam: 'connection',
  targetKind: 'Credential',
  targetParam: 'name',
};

/** Infrastructure credentials of one management cluster (FP-4). */
@Controller('api/connections/:connection/credentials')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Roles('viewer')
  @Get()
  list(@Param('connection') connection: string): Promise<Credential[]> {
    return this.credentials.list(connection);
  }

  /** Lists the clouds of an uploaded clouds.yaml; returns no secrets. */
  @Roles('admin')
  @Post('clouds-yaml-info')
  @HttpCode(200)
  @Audit({ action: 'credential.parse-clouds-yaml', skip: true })
  cloudsYamlInfo(
    @Body(new ZodValidationPipe(CloudsYamlInfoRequestSchema)) body: { cloudsYaml: string },
  ): CloudsYamlInfo {
    return this.credentials.cloudsYamlInfo(body.cloudsYaml);
  }

  @Roles('admin')
  @Post('preview')
  @HttpCode(200)
  @Audit({ action: 'credential.preview', skip: true })
  preview(
    @Param('connection') connection: string,
    @Body(new ZodValidationPipe(CreateCredentialRequestSchema)) body: CreateCredentialRequest,
  ): Promise<ManifestPreview> {
    return this.credentials.preview(connection, body);
  }

  @Roles('admin')
  @Post()
  @Audit({ action: 'credential.create', ...AUDIT })
  create(
    @Param('connection') connection: string,
    @Body(new ZodValidationPipe(CreateCredentialRequestSchema)) body: CreateCredentialRequest,
  ): Promise<Credential> {
    return this.credentials.create(connection, body);
  }

  @Roles('viewer')
  @Get(':provider/:name')
  get(
    @Param('connection') connection: string,
    @Param('provider') provider: string,
    @Param('name') name: string,
  ): Promise<Credential> {
    return this.credentials.get(connection, provider, name);
  }

  @Roles('admin')
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

  @Roles('admin')
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

  @Roles('admin')
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
  @Roles('operator')
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
