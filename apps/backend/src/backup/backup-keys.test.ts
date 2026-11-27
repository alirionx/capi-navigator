import * as openpgp from 'openpgp';
import { describe, expect, it } from 'vitest';
import {
  BackupKeyError,
  describeRecipientKey,
  encryptTo,
  readRecipientKey,
} from './backup-keys.js';

async function key(opts: { expires?: number; date?: Date } = {}) {
  return openpgp.generateKey({
    type: 'curve25519',
    userIDs: [{ name: 'Backup Test', email: 'backup@example.com' }],
    keyExpirationTime: opts.expires ?? 0,
    ...(opts.date ? { date: opts.date } : {}),
    format: 'armored',
  });
}

describe('recipient keys (FP38-F-02)', () => {
  it('accepts a public key and describes it', async () => {
    const { publicKey } = await key();
    const parsed = await readRecipientKey(publicKey);
    const info = await describeRecipientKey(publicKey);
    expect(info).toMatchObject({
      fingerprint: parsed.getFingerprint().toUpperCase(),
      userIds: ['Backup Test <backup@example.com>'],
      expiresAt: null,
      expiresSoon: false,
    });
    expect(info.problem).toBeUndefined();
  });

  it('refuses private keys, several keys in one block and garbage', async () => {
    const a = await key();
    const b = await key();
    await expect(readRecipientKey(a.privateKey)).rejects.toThrow(/private key/);
    await expect(readRecipientKey(`${a.publicKey}\n${b.publicKey}`)).rejects.toThrow(/several/);
    await expect(readRecipientKey('-----BEGIN PGP PUBLIC KEY BLOCK-----\nnope')).rejects.toThrow(
      BackupKeyError,
    );
  });

  it('refuses expired keys and flags keys that expire soon', async () => {
    const { publicKey } = await key({ expires: 10 * 24 * 3600 });
    const soon = await describeRecipientKey(publicKey);
    expect(soon.expiresSoon).toBe(true);
    expect(soon.expiresAt).not.toBeNull();
    const later = new Date(Date.now() + 11 * 24 * 3600 * 1000);
    await expect(readRecipientKey(publicKey, later)).rejects.toThrow(/expired or revoked/);
    const expired = await describeRecipientKey(publicKey, later);
    expect(expired).toMatchObject({
      expiresSoon: false,
      problem: 'The key is expired or revoked.',
    });
  });

  it('encrypts to every recipient, each decrypts alone', async () => {
    const a = await key();
    const b = await key();
    const keys = [await readRecipientKey(a.publicKey), await readRecipientKey(b.publicKey)];
    const data = new TextEncoder().encode('secret payload');
    const encrypted = await encryptTo(data, keys);
    expect(Buffer.from(encrypted).includes('secret payload')).toBe(false);
    for (const k of [a, b]) {
      const message = await openpgp.readMessage({ binaryMessage: encrypted });
      const decryptionKeys = await openpgp.readPrivateKey({ armoredKey: k.privateKey });
      const { data: out } = await openpgp.decrypt({ message, decryptionKeys, format: 'binary' });
      expect(new TextDecoder().decode(out as Uint8Array)).toBe('secret payload');
    }
  });
});
