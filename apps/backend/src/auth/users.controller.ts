import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
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

/** User management for admins (FP1-F-05). */
@Controller('api/users')
@Requires('users.manage')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(): User[] {
    return this.users.list();
  }

  @Get(':username')
  get(@Param('username') username: string): User {
    return this.users.get(username);
  }

  @Post()
  @Audit({ action: 'user.create', targetKind: 'NavigatorUser', targetParam: 'username' })
  create(
    @Body(new ZodValidationPipe(CreateUserRequestSchema)) body: CreateUserRequest,
  ): Promise<User> {
    return this.users.create(body);
  }

  @Patch(':username')
  @Audit({ action: 'user.update', targetKind: 'NavigatorUser', targetParam: 'username' })
  update(
    @Param('username') username: string,
    @Body(new ZodValidationPipe(UpdateUserRequestSchema)) body: UpdateUserRequest,
    @CurrentUser() actor: Principal,
  ): Promise<User> {
    return this.users.update(username, body, actor);
  }

  @Delete(':username')
  @HttpCode(204)
  @Audit({ action: 'user.delete', targetKind: 'NavigatorUser', targetParam: 'username' })
  delete(@Param('username') username: string, @CurrentUser() actor: Principal): Promise<void> {
    return this.users.delete(username, actor);
  }

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
