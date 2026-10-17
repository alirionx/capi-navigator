import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  type ChangePasswordRequest,
  type LoginRequest,
  type Me,
} from '@capi-navigator/shared';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AUTH_PROVIDER, type AuthProvider } from './auth-provider.js';
import { AllowPendingPasswordChange, Audit, CurrentUser, Public, Roles } from './decorators.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import type { AuthenticatedRequest, Principal } from './principal.js';
import { SessionService } from './session.service.js';
import { UsersService } from './users.service.js';

@Controller('api/auth')
export class AuthController {
  private readonly limiter: LoginRateLimiter;

  constructor(
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.limiter = new LoginRateLimiter(
      config.LOGIN_RATE_LIMIT,
      config.LOGIN_RATE_WINDOW_MINUTES * 60_000,
    );
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @Audit({ action: 'auth.login' })
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() req: Request & AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Me> {
    req.auditActor = body.username;
    const ip = req.ip ?? 'unknown';
    const wait = this.limiter.retryAfter(ip, body.username);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      throw new HttpException(
        {
          statusCode: 429,
          message: 'Too many failed sign-in attempts',
          hint: `Try again in ${Math.ceil(wait / 60)} minute(s).`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const principal = await this.auth.authenticate(body);
    if (!principal) {
      this.limiter.recordFailure(ip, body.username);
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Wrong username or password',
      });
    }
    this.limiter.recordSuccess(ip, body.username);
    req.principal = principal;
    this.sessions.issue(res, principal.username, this.users.sessionGeneration(principal.username));
    return principal;
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @Audit({ action: 'auth.logout' })
  logout(@Res({ passthrough: true }) res: Response): void {
    this.sessions.clear(res);
  }

  @Roles('viewer')
  @AllowPendingPasswordChange()
  @Get('me')
  me(@CurrentUser() principal: Principal): Me {
    return principal;
  }

  @Roles('viewer')
  @AllowPendingPasswordChange()
  @Post('change-password')
  @HttpCode(200)
  @Audit({ action: 'auth.change-password' })
  async changePassword(
    @Body(new ZodValidationPipe(ChangePasswordRequestSchema)) body: ChangePasswordRequest,
    @CurrentUser() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Me> {
    const generation = await this.users.changeOwnPassword(
      principal.username,
      body.currentPassword,
      body.newPassword,
    );
    // All other sessions are invalidated; this one continues with a fresh cookie.
    this.sessions.issue(res, principal.username, generation);
    return { ...principal, mustChangePassword: false };
  }
}
