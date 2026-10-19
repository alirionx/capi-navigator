import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ConnectionSchema,
  KubeconfigContextsSchema,
  CreateConnectionRequestSchema,
  KubeconfigContextsRequestSchema,
  MANAGEMENT_ACCESS_MANIFEST,
  MANAGEMENT_ACCESS_MINIMAL_MANIFEST,
  UpdateConnectionRequestSchema,
  type Connection,
  type CreateConnectionRequest,
  type KubeconfigContexts,
  type UpdateConnectionRequest,
} from '@capi-navigator/shared';
import { Audit, Requires } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ConnectionsService } from './connections.service.js';
import { Api } from '../openapi/api.decorator.js';
import { z } from 'zod';

const AUDIT = {
  targetKind: 'ManagementCluster',
  targetParam: 'name',
  managementClusterParam: 'name',
};

/** Management cluster connections (FP-2). Viewers see them, admins manage them. */
@Controller('api/connections')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Requires('view')
  @Api({ summary: 'List management cluster connections', response: z.array(ConnectionSchema) })
  @Get()
  list(): Connection[] {
    return this.connections.list();
  }

  /** FP2-F-07: manifest that prepares a management cluster (full or minimal permissions). */
  @Requires('connections.manage')
  @Api({
    summary: 'Access manifest (ServiceAccount, RBAC) for a management cluster',
    description: 'Query parameter variant: full (default) or minimal.',
    response: { contentType: 'application/yaml', description: 'YAML manifest' },
  })
  @Get('access-manifest')
  @Header('Content-Type', 'application/yaml; charset=utf-8')
  accessManifest(@Query('variant') variant?: string): string {
    return variant === 'minimal' ? MANAGEMENT_ACCESS_MINIMAL_MANIFEST : MANAGEMENT_ACCESS_MANIFEST;
  }

  @Requires('view')
  @Api({ summary: 'Get a connection', response: ConnectionSchema })
  @Get(':name')
  get(@Param('name') name: string): Connection {
    return this.connections.get(name);
  }

  /** Lists the contexts of a kubeconfig before saving; returns no credentials. */
  @Requires('connections.manage')
  @Api({
    summary: 'List the contexts of a kubeconfig before connecting',
    description: 'The kubeconfig is only parsed, never stored.',
    response: KubeconfigContextsSchema,
  })
  @Post('kubeconfig-contexts')
  @HttpCode(200)
  @Audit({ action: 'connection.parse-kubeconfig', skip: true })
  contexts(
    @Body(new ZodValidationPipe(KubeconfigContextsRequestSchema)) body: { kubeconfig: string },
  ): KubeconfigContexts {
    return this.connections.listContexts(body.kubeconfig);
  }

  @Requires('connections.manage')
  @Api({
    summary: 'Connect a management cluster (kubeconfig or service account token)',
    description: 'Credentials are stored in a Secret of the home cluster and never returned.',
    response: ConnectionSchema,
  })
  @Post()
  @Audit({ action: 'connection.create', ...AUDIT })
  create(
    @Body(new ZodValidationPipe(CreateConnectionRequestSchema)) body: CreateConnectionRequest,
  ): Promise<Connection> {
    return this.connections.create(body);
  }

  @Requires('connections.manage')
  @Api({ summary: 'Change a connection', response: ConnectionSchema })
  @Patch(':name')
  @Audit({ action: 'connection.update', ...AUDIT })
  update(
    @Param('name') name: string,
    @Body(new ZodValidationPipe(UpdateConnectionRequestSchema)) body: UpdateConnectionRequest,
  ): Promise<Connection> {
    return this.connections.update(name, body);
  }

  @Requires('connections.manage')
  @Api({ summary: 'Remove a connection and its Secret', response: 'empty' })
  @Delete(':name')
  @HttpCode(204)
  @Audit({ action: 'connection.delete', ...AUDIT })
  delete(@Param('name') name: string): Promise<void> {
    return this.connections.delete(name);
  }

  @Requires('connections.manage')
  @Api({
    summary: 'Test a connection: reachability, version, permissions',
    response: ConnectionSchema,
  })
  @Post(':name/test')
  @HttpCode(200)
  @Audit({ action: 'connection.test', ...AUDIT })
  test(@Param('name') name: string): Promise<Connection> {
    return this.connections.test(name);
  }
}
