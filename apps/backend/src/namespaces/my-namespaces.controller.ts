import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import {
  MyNamespacesSchema,
  NamespaceDashboardSchema,
  NamespaceTokenRequestSchema,
  NamespaceTokenResponseSchema,
  type MyNamespaces,
  type NamespaceDashboard,
  type NamespaceTokenResponse,
} from '@capi-navigator/shared';
import type { z } from 'zod';
import { Audit, CurrentUser, SignedIn } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Api } from '../openapi/api.decorator.js';
import { MyNamespacesService } from './my-namespaces.service.js';

const ONE = ':connection/:namespace/:name/:workloadNamespace';

/**
 * The namespaces of the signed-in person (FP-37): no permission, what is returned follows from the
 * assignments (ADR-0041). API tokens are refused.
 */
@Controller('api/my/namespaces')
export class MyNamespacesController {
  constructor(private readonly mine: MyNamespacesService) {}

  @SignedIn({ peopleOnly: true })
  @Api({
    summary: 'Namespaces assigned to the signed-in person',
    description:
      'Only the assigned namespaces, the accounts of the person and the tokens issued by the person (FP37-F-03).',
    response: MyNamespacesSchema,
  })
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentUser() user: Principal): Promise<MyNamespaces> {
    return this.mine.list(user);
  }

  @SignedIn({ peopleOnly: true })
  @Api({
    summary: 'Read-only dashboard of an assigned namespace',
    description:
      'Workloads, pods and events, read with the rights of the assigned account; nothing about nodes or other namespaces (FP37-F-08).',
    response: NamespaceDashboardSchema,
  })
  @Get(`${ONE}/dashboard`)
  @Header('Cache-Control', 'no-store')
  dashboard(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Param('workloadNamespace') workloadNamespace: string,
    @CurrentUser() user: Principal,
  ): Promise<NamespaceDashboard> {
    return this.mine.dashboard(user, { connection, namespace, name, workloadNamespace });
  }

  @SignedIn({ peopleOnly: true })
  @Api({
    summary: 'Issue a token or kubeconfig for an assigned account',
    description:
      'Returned once and never stored; 10 minutes to 7 days, at most five valid tokens per person and account (FP37-F-04, F-06).',
    response: NamespaceTokenResponseSchema,
  })
  @Post(`${ONE}/accounts/:account/tokens`)
  @Header('Cache-Control', 'no-store')
  @Audit({
    action: 'my-namespace.token-issue',
    targetKind: 'ServiceAccount',
    targetParam: 'account',
    managementClusterParam: 'connection',
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
    return this.mine.issueToken(
      user,
      { connection, namespace, name, workloadNamespace },
      account,
      body,
    );
  }

  @SignedIn({ peopleOnly: true })
  @Api({
    summary: 'Revoke a token the signed-in person issued',
    description: 'The API server refuses it within seconds.',
    response: 'empty',
  })
  @Delete(`${ONE}/tokens/:token`)
  @HttpCode(204)
  @Audit({
    action: 'my-namespace.token-revoke',
    targetKind: 'Secret',
    targetParam: 'token',
    managementClusterParam: 'connection',
  })
  revokeToken(
    @Param('connection') connection: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Param('workloadNamespace') workloadNamespace: string,
    @Param('token') token: string,
    @CurrentUser() user: Principal,
  ): Promise<void> {
    return this.mine.revokeToken(user, { connection, namespace, name, workloadNamespace }, token);
  }
}
