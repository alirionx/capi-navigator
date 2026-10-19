import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  CreatedTokenSchema,
  CreateTokenRequestSchema,
  TokenInfoSchema,
  type CreatedToken,
  type CreateTokenRequest,
  type TokenInfo,
} from '@capi-navigator/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Api } from '../openapi/api.decorator.js';
import { Audit, CurrentUser, Requires } from './decorators.js';
import type { Principal } from './principal.js';
import { TokensService } from './tokens.service.js';

/** API tokens of technical users (FP22-F-02); never reachable with a token (FP22-F-05). */
@Controller('api/users/:username/tokens')
@Requires('users.manage')
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Api({
    summary: 'List the API tokens of a technical user (never the token values)',
    response: z.array(TokenInfoSchema),
  })
  @Get()
  list(@Param('username') username: string): TokenInfo[] {
    return this.tokens.list(username);
  }

  @Api({
    summary: 'Generate an API token for a technical user',
    description:
      'The response is the only time the token is returned; only its SHA-256 hash is stored. Use it as `Authorization: Bearer <token>`.',
    response: CreatedTokenSchema,
  })
  @Post()
  @Audit({ action: 'token.create', targetKind: 'NavigatorUser', targetParam: 'username' })
  create(
    @Param('username') username: string,
    @Body(new ZodValidationPipe(CreateTokenRequestSchema)) body: CreateTokenRequest,
    @CurrentUser() actor: Principal,
  ): Promise<CreatedToken> {
    return this.tokens.create(username, body, actor);
  }

  @Api({ summary: 'Revoke an API token; it stops working at once', response: 'empty' })
  @Delete(':id')
  @HttpCode(204)
  @Audit({ action: 'token.revoke', targetKind: 'NavigatorUser', targetParam: 'username' })
  revoke(@Param('username') username: string, @Param('id') id: string): Promise<void> {
    return this.tokens.revoke(username, id);
  }
}
