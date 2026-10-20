import { Controller, Get, NotFoundException, Query, Req, Res } from '@nestjs/common';
import { AuthOptionsSchema, type AuthOptions } from '@capi-navigator/shared';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service.js';
import { Api } from '../openapi/api.decorator.js';
import { Public } from './decorators.js';
import { GroupsService } from './groups.service.js';
import { message, OidcService } from './oidc.service.js';
import { SessionService } from './session.service.js';

/** Why a sign-in failed; the login page shows a text for each (no details in the URL). */
type OidcError = 'oidc_failed' | 'oidc_no_access' | 'oidc_cancelled';

/** OpenID Connect sign-in (FP-14, ADR-0019). The provider's tokens never leave the backend. */
@Controller('api/auth')
export class OidcController {
  constructor(
    private readonly oidc: OidcService,
    private readonly groups: GroupsService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Api({
    summary: 'Sign-in options for the login page (local form, OpenID Connect button)',
    response: AuthOptionsSchema,
  })
  @Get('options')
  options(): AuthOptions {
    return this.oidc.options();
  }

  @Public()
  @Api({
    summary: 'Start the OpenID Connect sign-in; redirects to the provider',
    description: '`redirect` is the app path to return to after sign-in. 404 without OIDC.',
    response: 'redirect',
  })
  @Get('oidc/login')
  async login(
    @Query('redirect') redirect: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.oidc.enabled) throw new NotFoundException('OpenID Connect is not configured');
    try {
      const { url, flow } = await this.oidc.begin(safeReturnPath(redirect));
      this.sessions.issueFlow(res, flow);
      res.redirect(302, url);
    } catch (err) {
      await this.record('anonymous', 'failure', `Provider not reachable: ${message(err)}`);
      res.redirect(302, loginPage('oidc_failed'));
    }
  }

  @Public()
  @Api({
    summary: 'Return from the OpenID Connect provider; sets the session cookie',
    description: 'Validates state, nonce, PKCE and the ID token, then redirects into the app.',
    response: 'redirect',
  })
  @Get('oidc/callback')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!this.oidc.enabled) throw new NotFoundException('OpenID Connect is not configured');
    const flow = this.sessions.takeFlow(req, res);
    const query = new URLSearchParams(req.originalUrl.split('?')[1] ?? '');
    const providerError = query.get('error');
    if (providerError) {
      await this.record('anonymous', 'failure', `Provider answered ${providerError}`);
      res.redirect(
        302,
        loginPage(providerError === 'access_denied' ? 'oidc_cancelled' : 'oidc_failed'),
      );
      return;
    }
    if (!flow) {
      await this.record('anonymous', 'failure', 'Sign-in expired or not started here');
      res.redirect(302, loginPage('oidc_failed'));
      return;
    }
    let person;
    try {
      person = await this.oidc.complete(query, flow);
    } catch (err) {
      await this.record('anonymous', 'failure', message(err));
      res.redirect(302, loginPage('oidc_failed'));
      return;
    }
    const mapped = this.groups.mapped(person.groups);
    const actor = `${person.name} (oidc)`;
    if (this.groups.bindings(mapped).length === 0) {
      // FP14-F-05: no mapped group and no default role.
      await this.record(actor, 'failure', "No role for the person's groups", person.subject);
      res.redirect(302, loginPage('oidc_no_access'));
      return;
    }
    this.sessions.issueOidc(res, { subject: person.subject, name: person.name, groups: mapped });
    await this.record(actor, 'success', undefined, person.subject);
    res.redirect(302, flow.r);
  }

  private record(
    actor: string,
    outcome: 'success' | 'failure',
    reason?: string,
    subject?: string,
  ): Promise<void> {
    return this.audit.record({
      actor,
      action: 'auth.oidc.login',
      outcome,
      request: { method: 'GET', path: '/api/auth/oidc/callback' },
      ...(subject ? { subject } : {}),
      ...(reason ? { message: reason.slice(0, 300) } : {}),
    });
  }
}

/** Only paths inside the app; anything else (other hosts, "//host") goes to the start page. */
export function safeReturnPath(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/';
  }
  return value.startsWith('/api/') ? '/' : value;
}

function loginPage(error: OidcError): string {
  return `/login?error=${error}`;
}
