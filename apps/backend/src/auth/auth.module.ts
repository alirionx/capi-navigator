import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AUTH_PROVIDER } from './auth-provider.js';
import { AuthController } from './auth.controller.js';
import { AuthSettingsController } from './auth-settings.controller.js';
import { AuthSettingsService } from './auth-settings.service.js';
import { AuthGuard } from './auth.guard.js';
import { GroupsController } from './groups.controller.js';
import { GroupsService } from './groups.service.js';
import { LocalAuthProvider } from './local-auth.provider.js';
import { OidcController } from './oidc.controller.js';
import { OidcService } from './oidc.service.js';
import { SessionService } from './session.service.js';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';
import { TokensController } from './tokens.controller.js';
import { TokensService } from './tokens.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

/** FP-1: local users, sessions and roles; FP-14: OpenID Connect sign-in and group mappings. */
@Module({
  controllers: [
    AuthController,
    OidcController,
    UsersController,
    RolesController,
    TokensController,
    GroupsController,
    AuthSettingsController,
  ],
  providers: [
    AuthSettingsService,
    GroupsService,
    OidcService,
    RolesService,
    SessionService,
    TokensService,
    UsersService,
    { provide: AUTH_PROVIDER, useClass: LocalAuthProvider },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService, UsersService],
})
export class AuthModule {}
