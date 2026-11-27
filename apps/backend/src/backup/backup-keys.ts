import { BACKUP_KEY_WARN_DAYS, type BackupKey } from '@capi-navigator/shared';
import * as openpgp from 'openpgp';

/** A recipient key that cannot be used, with a message for the backup page (FP38-F-02). */
export class BackupKeyError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads an ASCII-armored OpenPGP key and checks that it can encrypt now (FP38-F-02): exactly one
 * public key, not revoked, not expired, with a usable encryption (sub)key. Private keys are
 * refused, so a private key never gets stored.
 */
export async function readRecipientKey(armored: string, now = new Date()): Promise<openpgp.Key> {
  // openpgp reads only the first armor block; a second one would be silently ignored.
  if ((armored.match(/-----BEGIN PGP /g) ?? []).length > 1) {
    throw new BackupKeyError('Paste one key per entry; this block contains several.');
  }
  let keys: openpgp.Key[];
  try {
    keys = await openpgp.readKeys({ armoredKeys: armored });
  } catch {
    throw new BackupKeyError(
      'This is not a valid OpenPGP key. Export it with gpg --armor --export <key ID>.',
    );
  }
  if (keys.length !== 1) {
    throw new BackupKeyError('Paste one key per entry; this block contains several.');
  }
  const key = keys[0]!;
  if (key.isPrivate()) {
    throw new BackupKeyError(
      'This is a private key. Paste only the public key (gpg --armor --export <key ID>) and keep the private key offline.',
    );
  }
  try {
    await key.verifyPrimaryKey(now);
  } catch {
    throw new BackupKeyError('The key is expired or revoked.');
  }
  try {
    await key.getEncryptionKey(undefined, now);
  } catch {
    throw new BackupKeyError('The key has no valid encryption subkey.');
  }
  return key;
}

/** Public facts of a stored key for the backup page; a key that became unusable gets `problem`. */
export async function describeRecipientKey(armored: string, now = new Date()): Promise<BackupKey> {
  let key: openpgp.Key;
  let problem: string | undefined;
  try {
    key = await readRecipientKey(armored, now);
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
    try {
      [key] = (await openpgp.readKeys({ armoredKeys: armored })) as [openpgp.Key];
    } catch {
      return {
        publicKey: armored,
        fingerprint: '',
        userIds: [],
        createdAt: '',
        expiresAt: null,
        expiresSoon: false,
        problem,
      };
    }
  }
  const expiry = await expirationOf(key);
  return {
    publicKey: armored,
    fingerprint: key.getFingerprint().toUpperCase(),
    userIds: key.getUserIDs(),
    createdAt: key.getCreationTime().toISOString(),
    expiresAt: expiry?.toISOString() ?? null,
    expiresSoon:
      !!expiry && !problem && expiry.getTime() - now.getTime() < BACKUP_KEY_WARN_DAYS * DAY_MS,
    ...(problem ? { problem } : {}),
  };
}

/** Earliest of the primary key's and the encryption subkey's expiry; undefined if none. */
async function expirationOf(key: openpgp.Key): Promise<Date | undefined> {
  const dates: Date[] = [];
  const primary = await key.getExpirationTime().catch(() => null);
  if (primary instanceof Date) dates.push(primary);
  const sub = await key.getEncryptionKey().catch(() => undefined);
  if (sub && sub !== key) {
    const subExpiry = await (sub as openpgp.Subkey).getExpirationTime().catch(() => null);
    if (subExpiry instanceof Date) dates.push(subExpiry);
  }
  return dates.sort((a, b) => a.getTime() - b.getTime())[0];
}

/** Encrypts to every recipient (FP38-F-02): each can decrypt alone, e.g. with `gpg -d`. */
export async function encryptTo(data: Uint8Array, keys: openpgp.Key[]): Promise<Uint8Array> {
  const message = await openpgp.createMessage({ binary: data });
  return openpgp.encrypt({ message, encryptionKeys: keys, format: 'binary' });
}
