import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The person the test provider signs in next, and how it should misbehave. */
export interface TestPerson {
  sub: string;
  name?: string;
  email?: string;
  groups?: unknown;
  /** Put the groups into the UserInfo response only, not into the ID token. */
  groupsInUserInfoOnly?: boolean;
}
export interface Tamper {
  issuer?: string;
  audience?: string;
  /** Seconds relative to now; negative = expired. */
  expiresIn?: number;
  nonce?: string;
  /** Sign with a key that is not in the JWKS. */
  foreignKey?: boolean;
}

/**
 * Minimal OpenID Connect provider for tests (FP-14): discovery, authorization endpoint that
 * signs in `person` without a form, token endpoint with PKCE and client secret checks, JWKS,
 * UserInfo and end-session. Tokens are RS256 JWTs signed with node:crypto.
 */
export class TestOidcProvider {
  person: TestPerson = { sub: 'user-1', name: 'jane', groups: [] };
  tamper: Tamper = {};
  readonly clientId = 'capi-navigator';
  readonly clientSecret = 'test-client-secret';
  /** Codes handed out, for replay tests. */
  readonly issuedCodes: string[] = [];

  private server?: Server;
  private readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly foreignKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly kid = 'test-key';
  private readonly codes = new Map<
    string,
    { person: TestPerson; nonce: string; challenge: string; redirectUri: string; tamper: Tamper }
  >();
  private readonly accessTokens = new Map<string, TestPerson>();

  issuer = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.issuer);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          userinfo_endpoint: `${this.issuer}/userinfo`,
          end_session_endpoint: `${this.issuer}/logout`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        });
      }
      if (url.pathname === '/jwks') {
        return json(200, {
          keys: [
            {
              ...this.key.publicKey.export({ format: 'jwk' }),
              kid: this.kid,
              alg: 'RS256',
              use: 'sig',
            },
          ],
        });
      }
      if (url.pathname === '/authorize') {
        const q = url.searchParams;
        if (q.get('client_id') !== this.clientId || q.get('code_challenge_method') !== 'S256') {
          return json(400, { error: 'invalid_request' });
        }
        const code = randomBytes(16).toString('hex');
        this.codes.set(code, {
          person: this.person,
          nonce: q.get('nonce') ?? '',
          challenge: q.get('code_challenge') ?? '',
          redirectUri: q.get('redirect_uri') ?? '',
          tamper: { ...this.tamper },
        });
        this.issuedCodes.push(code);
        const back = new URL(q.get('redirect_uri') ?? '');
        back.searchParams.set('code', code);
        back.searchParams.set('state', q.get('state') ?? '');
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          const form = new URLSearchParams(body);
          const grant = this.codes.get(form.get('code') ?? '');
          this.codes.delete(form.get('code') ?? ''); // single use
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (
            !grant ||
            form.get('client_id') !== this.clientId ||
            form.get('client_secret') !== this.clientSecret ||
            form.get('redirect_uri') !== grant.redirectUri ||
            challenge !== grant.challenge
          ) {
            return json(400, { error: 'invalid_grant' });
          }
          const accessToken = randomBytes(16).toString('hex');
          this.accessTokens.set(accessToken, grant.person);
          return json(200, {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 300,
            id_token: this.idToken(grant.person, grant.nonce, grant.tamper),
          });
        });
        return;
      }
      if (url.pathname === '/userinfo') {
        const person = this.accessTokens.get(
          (req.headers.authorization ?? '').replace(/^Bearer /, ''),
        );
        if (!person) return json(401, { error: 'invalid_token' });
        return json(200, { sub: person.sub, groups: person.groups });
      }
      json(404, { error: 'not_found' });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  private idToken(person: TestPerson, nonce: string, tamper: Tamper): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: tamper.issuer ?? this.issuer,
      aud: tamper.audience ?? this.clientId,
      sub: person.sub,
      iat: now,
      exp: now + (tamper.expiresIn ?? 300),
      nonce: tamper.nonce ?? nonce,
      ...(person.name ? { preferred_username: person.name } : {}),
      ...(person.email ? { email: person.email } : {}),
      ...(person.groups !== undefined && !person.groupsInUserInfoOnly
        ? { groups: person.groups }
        : {}),
    };
    const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const input = `${encode({ alg: 'RS256', kid: this.kid, typ: 'JWT' })}.${encode(claims)}`;
    const key = tamper.foreignKey ? this.foreignKey.privateKey : this.key.privateKey;
    return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`;
  }
}
