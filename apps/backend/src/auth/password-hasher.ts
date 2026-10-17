import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

/** OWASP recommendation for Argon2id: m=19 MiB, t=2, p=1 (FP1-F-01). */
export const DEFAULT_PARAMS = { memory: 19456, passes: 2, parallelism: 1 } as const;
const TAG_LENGTH = 32;
const SALT_LENGTH = 16;

type Params = { memory: number; passes: number; parallelism: number };

/**
 * Hashes a password with Argon2id from Node's built-in crypto module and returns a PHC string:
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` (base64 without padding).
 */
export async function hashPassword(
  password: string,
  params: Params = DEFAULT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, params);
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(hash)}`;
}

/** Verifies a password against a PHC string in constant time. Returns false for malformed hashes. */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const parsed = parsePhc(phc);
  if (!parsed) return false;
  const actual = await derive(password, parsed.salt, parsed.params, parsed.hash.length);
  return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
}

/**
 * A fixed hash used to spend the same time on unknown usernames as on known ones, so login
 * timing does not reveal which usernames exist.
 */
let dummyHash: Promise<string> | undefined;
export async function burnVerifyTime(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
}

function derive(password: string, salt: Buffer, params: Params, tagLength = TAG_LENGTH) {
  return argon2Async('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    parallelism: params.parallelism,
    tagLength,
    memory: params.memory,
    passes: params.passes,
  });
}

function parsePhc(phc: string): { params: Params; salt: Buffer; hash: Buffer } | undefined {
  const match =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
  if (!match) return undefined;
  const [, m, t, p, salt, hash] = match;
  return {
    params: { memory: Number(m), passes: Number(t), parallelism: Number(p) },
    salt: Buffer.from(salt!, 'base64'),
    hash: Buffer.from(hash!, 'base64'),
  };
}

function b64(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '');
}
