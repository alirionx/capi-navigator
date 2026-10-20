import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import {
  AuthSettingsSchema,
  OidcTestRequestSchema,
  OidcTestResultSchema,
  UpdateOidcSettingsRequestSchema,
  type AuthSettings,
  type OidcTestRequest,
  type OidcTestResult,
  type UpdateOidcSettingsRequest,
} from '@capi-navigator/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Api } from '../openapi/api.decorator.js';
import { AuthSettingsService } from './auth-settings.service.js';
import { Audit, Requires } from './decorators.js';

/** Authentication page (FP14-F-12, ADR-0020): settings of the OpenID Connect provider. */
@Controller('api/auth-settings')
@Requires('users.manage')
export class AuthSettingsController {
  constructor(private readonly settings: AuthSettingsService) {}

  @Api({
    summary: 'OpenID Connect settings, public URL and redirect URI',
    description: 'The client secret is never returned, only whether one is set (FP14-F-14).',
    response: AuthSettingsSchema,
  })
  @Get()
  get(): Promise<AuthSettings> {
    return this.settings.get();
  }

  @Api({
    summary: 'Save the OpenID Connect settings; applies without restart',
    description: 'Without `clientSecret` the stored secret is kept.',
    response: AuthSettingsSchema,
  })
  @Put('oidc')
  @Audit({ action: 'auth-settings.update', targetKind: 'NavigatorAuthSettings' })
  update(
    @Body(new ZodValidationPipe(UpdateOidcSettingsRequestSchema)) body: UpdateOidcSettingsRequest,
  ): Promise<AuthSettings> {
    return this.settings.update(body);
  }

  @Api({
    summary: 'Test an issuer: run the discovery and show what the provider offers',
    response: OidcTestResultSchema,
  })
  @Post('oidc/test')
  @HttpCode(200)
  @Audit({ action: 'auth-settings.test', skip: true })
  test(
    @Body(new ZodValidationPipe(OidcTestRequestSchema)) body: OidcTestRequest,
  ): Promise<OidcTestResult> {
    return this.settings.test(body.issuerUrl);
  }
}
