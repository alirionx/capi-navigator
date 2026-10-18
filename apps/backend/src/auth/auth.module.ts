import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AUTH_PROVIDER } from './auth-provider.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { LocalAuthProvider } from './local-auth.provider.js';
import { SessionService } from './session.service.js';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

/** FP-1: local users, sessions and roles. */
@Module({
  controllers: [AuthController, UsersController, RolesController],
  providers: [
    RolesService,
    SessionService,
    UsersService,
    { provide: AUTH_PROVIDER, useClass: LocalAuthProvider },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService, UsersService],
})
export class AuthModule {}
