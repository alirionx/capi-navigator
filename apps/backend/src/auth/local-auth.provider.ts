import { Injectable } from '@nestjs/common';
import type { AuthProvider } from './auth-provider.js';
import type { Principal } from './principal.js';
import { UsersService } from './users.service.js';

/** Local user accounts (FP1-F-01). */
@Injectable()
export class LocalAuthProvider implements AuthProvider {
  readonly id = 'local';

  constructor(private readonly users: UsersService) {}

  authenticate(credentials: {
    username: string;
    password: string;
  }): Promise<Principal | undefined> {
    return this.users.verifyCredentials(credentials.username, credentials.password);
  }
}
