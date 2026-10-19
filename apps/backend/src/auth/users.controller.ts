import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  UserSchema,
  CreateUserRequestSchema,
  ResetPasswordRequestSchema,
  UpdateUserRequestSchema,
  type CreateUserRequest,
  type ResetPasswordRequest,
  type UpdateUserRequest,
  type User,
} from '@capi-navigator/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Audit, CurrentUser, Requires } from './decorators.js';
import type { Principal } from './principal.js';
import { UsersService } from './users.service.js';
import { Api } from '../openapi/api.decorator.js';
import { z } from 'zod';

/** User management for admins (FP1-F-05). */
@Controller('api/users')
@Requires('users.manage')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Api({ summary: 'List users (never password data)', response: z.array(UserSchema) })
  @Get()
  list(): User[] {
    return this.users.list();
  }

  @Api({ summary: 'Get a user', response: UserSchema })
  @Get(':username')
  get(@Param('username') username: string): User {
    return this.users.get(username);
  }

  @Api({
    summary: 'Create a user with role assignments and an initial password',
    description: 'The user must change the password at the first sign-in.',
    response: UserSchema,
  })
  @Post()
  @Audit({ action: 'user.create', targetKind: 'NavigatorUser', targetParam: 'username' })
  create(
    @Body(new ZodValidationPipe(CreateUserRequestSchema)) body: CreateUserRequest,
  ): Promise<User> {
    return this.users.create(body);
  }

  @Api({
    summary: 'Change role assignments or disable a user',
    description:
      'Changes end the sessions of the user. At least one enabled user keeps an unlimited assignment with users.manage.',
    response: UserSchema,
  })
  @Patch(':username')
  @Audit({ action: 'user.update', targetKind: 'NavigatorUser', targetParam: 'username' })
  update(
    @Param('username') username: string,
    @Body(new ZodValidationPipe(UpdateUserRequestSchema)) body: UpdateUserRequest,
    @CurrentUser() actor: Principal,
  ): Promise<User> {
    return this.users.update(username, body, actor);
  }

  @Api({ summary: 'Delete a user and the password Secret', response: 'empty' })
  @Delete(':username')
  @HttpCode(204)
  @Audit({ action: 'user.delete', targetKind: 'NavigatorUser', targetParam: 'username' })
  delete(@Param('username') username: string, @CurrentUser() actor: Principal): Promise<void> {
    return this.users.delete(username, actor);
  }

  @Api({ summary: 'Set a temporary password; the user must change it', response: UserSchema })
  @Post(':username/reset-password')
  @HttpCode(200)
  @Audit({ action: 'user.reset-password', targetKind: 'NavigatorUser', targetParam: 'username' })
  resetPassword(
    @Param('username') username: string,
    @Body(new ZodValidationPipe(ResetPasswordRequestSchema)) body: ResetPasswordRequest,
  ): Promise<User> {
    return this.users.resetPassword(username, body.password);
  }
}
