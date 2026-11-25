import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  AddonPreviewSchema,
  allows,
  AssignablePeopleSchema,
  ManagedNamespaceApplyRequestSchema,
  ManagedNamespaceDeleteRequestSchema,
  ManagedNamespacesSchema,
  NamespaceTokenRequestSchema,
  NamespaceTokenResponseSchema,
  type AddonPreview,
  type AssignablePeople,
  type ManagedNamespaces,
  type ManagedNamespaceSpec,
  type NamespaceTokenResponse,
} from '@capi-navigator/shared';
import type { z } from 'zod';
import { Audit, CurrentUser, Requires } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Api } from '../openapi/api.decorator.js';
import { StoreService } from '../store/store.service.js';
import { NamespacesService } from './namespaces.service.js';
import { PeopleService } from './people.service.js';

const AUDIT = { managementClusterParam: 'connection', targetParam: 'workloadNamespace' };

/** Managed namespaces of a workload cluster, their accounts and tokens (FP-36). */
@Controller('api/connections/:connection/clusters/:namespace/:name/namespaces')
export class NamespacesController {
  constructor(
    private readonly namespaces: NamespacesService,
    private readonly people: PeopleService,
    private readonly store: StoreService,
  ) {}

  @Requires('view')
  @Api({
    summary: 'Managed namespaces of a workload cluster with accounts, quota usage and drift',
    description:
      'Defined as add-ons, compared with the cluster through its kubeconfig. Tokens are listed without their content (ADR-0040).',
    response: ManagedNamespacesSchema,
  })
  @Get()
  list(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @CurrentUser() user: Principal,
  ): Promise<ManagedNamespaces> {
    // FP37-F-02: assigned people only for those who manage the access.
    const withAccess = allows(user.bindings, this.store.rolePermissions, 'clusters.access', {
      connection,
      namespace,
    });
    return this.namespaces.list({ connection, namespace, name }, withAccess);
  }

  @Requires('clusters.access')
  @Api({
    summary: 'People and groups that can be assigned to accounts',
    description:
      'Names of local users, mapped groups and OpenID Connect people; no roles and no technical users (FP37-F-02).',
    response: AssignablePeopleSchema,
  })
  @Get('people')
  assignable(): Promise<AssignablePeople> {
    return this.people.assignable();
  }

  @Requires('clusters.access')
  @Api({
    summary: 'Preview creating or changing a managed namespace',
    description: 'Dry run on the management cluster; nothing is changed (hard rule 6).',
    response: AddonPreviewSchema,
  })
  @Post('preview')
  @HttpCode(200)
  @Audit({ action: 'namespace.preview', skip: true })
  preview(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Body(new ZodValidationPipe(ManagedNamespaceApplyRequestSchema))
    body: z.output<typeof ManagedNamespaceApplyRequestSchema>,
  ): Promise<AddonPreview> {
    return this.namespaces.preview(connection, inScope(body.spec, namespace));
  }

  @Requires('clusters.access')
  @Api({
    summary: 'Create or change a managed namespace',
    description: 'One HelmChartProxy per namespace; applied by server-side apply (FP36-F-01).',
    response: AddonPreviewSchema,
  })
  @Put(':workloadNamespace')
  @Audit({ action: 'namespace.apply', targetKind: 'Namespace', ...AUDIT })
  apply(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('workloadNamespace') workloadNamespace: string,
    @Body(new ZodValidationPipe(ManagedNamespaceApplyRequestSchema))
    body: z.output<typeof ManagedNamespaceApplyRequestSchema>,
  ): Promise<AddonPreview> {
    const spec = inScope(body.spec, namespace);
    if (spec.name !== workloadNamespace) {
      throw new BadRequestException('The namespace in the path and in the body differ');
    }
    return this.namespaces.apply(connection, spec, body.takeOver);
  }

  @Requires('clusters.access')
  @Api({
    summary: 'End the access to a managed namespace (removes the add-on)',
    description:
      'Accounts and role bindings go on all matching clusters; the namespace stays with data, quota and isolation (FP36-F-04).',
    response: 'empty',
  })
  @Delete(':workloadNamespace')
  @HttpCode(204)
  @Audit({ action: 'namespace.remove', targetKind: 'Namespace', ...AUDIT })
  remove(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Param('workloadNamespace') workloadNamespace: string,
  ): Promise<void> {
    return this.namespaces.remove({ connection, namespace, name }, workloadNamespace);
  }

  @Requires('clusters.access')
  @Api({
    summary: 'Delete a left-over namespace with everything in it',
    description: 'Only after its add-on is gone and with the name typed (FP36-F-05).',
    response: 'empty',
  })
  @Post(':workloadNamespace/delete')
  @HttpCode(204)
  @Audit({ action: 'namespace.delete', targetKind: 'Namespace', ...AUDIT })
  deleteNamespace(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Param('workloadNamespace') workloadNamespace: string,
    @Body(new ZodValidationPipe(ManagedNamespaceDeleteRequestSchema))
    body: z.output<typeof ManagedNamespaceDeleteRequestSchema>,
  ): Promise<void> {
    return this.namespaces.deleteNamespace(
      { connection, namespace, name },
      workloadNamespace,
      body.confirmName,
    );
  }

  @Requires('clusters.access')
  @Api({
    summary: 'Issue a token or kubeconfig for an account of a managed namespace',
    description:
      'Returned once and never stored; 10 minutes to 7 days, revocable on its own (ADR-0040).',
    response: NamespaceTokenResponseSchema,
  })
  @Post(':workloadNamespace/accounts/:account/tokens')
  @Header('Cache-Control', 'no-store')
  @Audit({
    action: 'namespace.token-issue',
    targetKind: 'ServiceAccount',
    ...AUDIT,
    targetParam: 'account',
  })
  issueToken(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Param('workloadNamespace') workloadNamespace: string,
    @Param('account') account: string,
    @Body(new ZodValidationPipe(NamespaceTokenRequestSchema))
    body: z.output<typeof NamespaceTokenRequestSchema>,
    @CurrentUser() user: Principal,
  ): Promise<NamespaceTokenResponse> {
    return this.namespaces.issueToken(
      { connection, namespace, name },
      workloadNamespace,
      account,
      body,
      { name: user.username, id: this.people.identity(user) },
    );
  }

  @Requires('clusters.access')
  @Api({
    summary: 'Revoke one token of a managed namespace',
    description: 'The API server refuses it within seconds.',
    response: 'empty',
  })
  @Delete(':workloadNamespace/tokens/:token')
  @HttpCode(204)
  @Audit({ action: 'namespace.token-revoke', targetKind: 'Secret', ...AUDIT, targetParam: 'token' })
  revokeToken(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Param('workloadNamespace') workloadNamespace: string,
    @Param('token') token: string,
  ): Promise<void> {
    return this.namespaces.revokeToken({ connection, namespace, name }, workloadNamespace, token);
  }
}

/** The permission was checked for the namespace of the route; the body must not name another. */
function inScope(spec: ManagedNamespaceSpec, namespace: string): ManagedNamespaceSpec {
  if (spec.namespace !== namespace) {
    throw new BadRequestException(
      'The namespace of the cluster in the path and in the body differ',
    );
  }
  return spec;
}
