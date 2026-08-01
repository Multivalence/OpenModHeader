/* OpenModHeader — passphrase-encrypted credential vault.

   AES-GCM secrets, keys derived from the user's passphrase with PBKDF2.
   No plaintext passphrase and no derived key is ever written to
   storage.local; the derived key lives in storage.session only while the
   vault is unlocked, and is dropped on lock.

   Everything here is browser-native Web Crypto. No dependencies. */

export const VAULT_FORMAT_VERSION = 1;

/* Centralised KDF parameters. Bump PBKDF2_ITERATIONS together with
   VAULT_FORMAT_VERSION; existing records carry their own iteration count so
   they keep decrypting after a change. */
export const KDF = {
  name: 'PBKDF2',
  hash: 'SHA-256',
  iterations: 600000,
  saltBytes: 16,
  keyBits: 256
};

export const CIPHER = { name: 'AES-GCM', ivBytes: 12, tagBits: 128 };

/* Any correct decryption of this constant proves the passphrase is right,
   so a wrong passphrase is detected once rather than per profile. */
const CHECK_PLAINTEXT = 'openmodheader-vault-check-v1';

const enc = new TextEncoder();
const dec = new TextDecoder();

function crypto_() {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('Web Crypto is unavailable in this context');
  return c;
}

/* ---------------------------------------------------------------- *
 * Base64 helpers with validation
 * ---------------------------------------------------------------- */

export function toB64(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* Throws on anything that is not well-formed base64 of the expected length.
   Callers validate before handing data to decrypt, so malformed or hostile
   imported records fail early with a generic message. */
export function fromB64(value, { expectedBytes = null, label = 'data' } = {}) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid ${label}: not a string`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`Invalid ${label}: not valid base64`);
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`Invalid ${label}: could not decode`);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  if (expectedBytes != null && out.length !== expectedBytes) {
    throw new Error(`Invalid ${label}: expected ${expectedBytes} bytes, got ${out.length}`);
  }
  return out;
}

export function randomBytes(count) {
  const out = new Uint8Array(count);
  crypto_().getRandomValues(out);
  return out;
}

/* ---------------------------------------------------------------- *
 * Key derivation
 * ---------------------------------------------------------------- */

export async function deriveKey(passphrase, saltBytes, iterations = KDF.iterations) {
  if (typeof passphrase !== 'string' || !passphrase) {
    throw new Error('A passphrase is required');
  }
  const material = await crypto_().subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto_().subtle.deriveKey(
    { name: KDF.name, salt: saltBytes, iterations, hash: KDF.hash },
    material,
    { name: CIPHER.name, length: KDF.keyBits },
    /* extractable: the key is cached in storage.session so the service
       worker can be suspended and revived without re-prompting. It is
       removed on lock and never written to storage.local. */
    true,
    ['encrypt', 'decrypt']
  );
}

export async function exportKey(key) {
  return toB64(new Uint8Array(await crypto_().subtle.exportKey('raw', key)));
}

export async function importKey(rawB64) {
  const raw = fromB64(rawB64, { expectedBytes: KDF.keyBits / 8, label: 'session key' });
  return crypto_().subtle.importKey('raw', raw, { name: CIPHER.name }, true, ['encrypt', 'decrypt']);
}

/* ---------------------------------------------------------------- *
 * Records
 * ---------------------------------------------------------------- */

/* A fresh IV per encryption is what makes two encryptions of the same
   plaintext produce different ciphertext. Never reuse one under a key. */
export async function encryptSecret(key, plaintext) {
  const iv = randomBytes(CIPHER.ivBytes);
  const ct = await crypto_().subtle.encrypt(
    { name: CIPHER.name, iv, tagLength: CIPHER.tagBits },
    key,
    enc.encode(String(plaintext ?? ''))
  );
  return {
    version: VAULT_FORMAT_VERSION,
    algorithm: CIPHER.name,
    kdf: KDF.name,
    iterations: KDF.iterations,
    iv: toB64(iv),
    ciphertext: toB64(new Uint8Array(ct))
  };
}

export function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new Error('Malformed secret record');
  if (record.version !== VAULT_FORMAT_VERSION) {
    throw new Error(`Unsupported vault record version: ${record.version}`);
  }
  if (record.algorithm !== CIPHER.name) throw new Error('Unsupported cipher');
  if (record.kdf !== KDF.name) throw new Error('Unsupported key derivation');
  const iv = fromB64(record.iv, { expectedBytes: CIPHER.ivBytes, label: 'IV' });
  /* AES-GCM output is at least the 16-byte tag. */
  const ct = fromB64(record.ciphertext, { label: 'ciphertext' });
  if (ct.length < CIPHER.tagBits / 8) throw new Error('Ciphertext too short to be authentic');
  return { iv, ct };
}

/* Returns null rather than throwing on an authentication failure: a tampered
   or wrong-key record is an expected condition, not a crash. The plaintext
   never appears in any error raised here. */
export async function decryptSecret(key, record) {
  let parts;
  try {
    parts = validateRecord(record);
  } catch {
    return null;
  }
  try {
    const buf = await crypto_().subtle.decrypt(
      { name: CIPHER.name, iv: parts.iv, tagLength: CIPHER.tagBits },
      key,
      parts.ct
    );
    return dec.decode(buf);
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- *
 * Vault lifecycle
 * ---------------------------------------------------------------- */

export function emptyVault() {
  return null;
}

export async function createVault(passphrase) {
  const salt = randomBytes(KDF.saltBytes);
  const key = await deriveKey(passphrase, salt);
  const check = await encryptSecret(key, CHECK_PLAINTEXT);
  return {
    vault: {
      version: VAULT_FORMAT_VERSION,
      kdf: KDF.name,
      hash: KDF.hash,
      iterations: KDF.iterations,
      salt: toB64(salt),
      check,
      records: {},
      createdAt: Date.now()
    },
    key
  };
}

export function validateVault(vault) {
  if (!vault || typeof vault !== 'object') throw new Error('No vault present');
  if (vault.version !== VAULT_FORMAT_VERSION) {
    throw new Error(`Unsupported vault version: ${vault.version}`);
  }
  if (vault.kdf !== KDF.name) throw new Error('Unsupported key derivation');
  const iterations = Number(vault.iterations);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 10000000) {
    throw new Error('Unsupported iteration count');
  }
  fromB64(vault.salt, { expectedBytes: KDF.saltBytes, label: 'salt' });
  validateRecord(vault.check);
  if (vault.records && typeof vault.records !== 'object') throw new Error('Malformed records');
  return true;
}

/* Derives the key and verifies it against the check value. Returns null for
   a wrong passphrase so callers can distinguish that from a broken vault. */
export async function unlockVault(vault, passphrase) {
  validateVault(vault);
  const salt = fromB64(vault.salt, { expectedBytes: KDF.saltBytes, label: 'salt' });
  const key = await deriveKey(passphrase, salt, Number(vault.iterations));
  const check = await decryptSecret(key, vault.check);
  if (check !== CHECK_PLAINTEXT) return null;
  return key;
}

/* Decrypts one record straight from the vault ciphertext using a key derived
   from the supplied passphrase. Deliberately takes no cached state: the only
   way to get a value out of this function is to supply a passphrase that
   produces a key which passes AES-GCM authentication on that record.

   There is no boolean "was the passphrase correct" step to patch out — a
   wrong passphrase yields a wrong key, and a wrong key yields an
   authentication failure inside the cipher. */
export async function decryptOne(vault, passphrase, secretId) {
  validateVault(vault);
  const record = vault.records?.[secretId];
  if (!record) return { ok: false, error: 'no-such-secret' };

  const salt = fromB64(vault.salt, { expectedBytes: KDF.saltBytes, label: 'salt' });
  const key = await deriveKey(passphrase, salt, Number(vault.iterations));

  const value = await decryptSecret(key, record);
  if (value == null) {
    /* Indistinguishable outcomes: a wrong passphrase and a corrupt record
       both fail authentication, and neither is reported differently. */
    return { ok: false, error: 'decrypt-failed' };
  }
  return { ok: true, value };
}

export async function decryptAll(vault, key) {
  const out = {};
  const corrupt = [];
  for (const [secretId, record] of Object.entries(vault.records || {})) {
    const value = await decryptSecret(key, record);
    if (value == null) corrupt.push(secretId);
    else out[secretId] = value;
  }
  return { values: out, corrupt };
}

/* Rebuilds the whole vault under a new passphrase. The caller persists the
   returned object in a single write, so an interrupted change leaves the
   original vault untouched rather than a half-migrated one. */
export async function changePassphrase(vault, currentPassphrase, nextPassphrase) {
  const currentKey = await unlockVault(vault, currentPassphrase);
  if (!currentKey) return { ok: false, error: 'incorrect-passphrase' };

  const { values, corrupt } = await decryptAll(vault, currentKey);

  const salt = randomBytes(KDF.saltBytes);
  const key = await deriveKey(nextPassphrase, salt);
  const check = await encryptSecret(key, CHECK_PLAINTEXT);

  const records = {};
  for (const [secretId, value] of Object.entries(values)) {
    records[secretId] = await encryptSecret(key, value);
  }
  /* Records that would not decrypt are carried over untouched rather than
     dropped, so a single corrupt entry cannot destroy the rest. */
  for (const secretId of corrupt) {
    records[secretId] = vault.records[secretId];
  }

  return {
    ok: true,
    corrupt,
    key,
    vault: {
      version: VAULT_FORMAT_VERSION,
      kdf: KDF.name,
      hash: KDF.hash,
      iterations: KDF.iterations,
      salt: toB64(salt),
      check,
      records,
      createdAt: vault.createdAt ?? Date.now(),
      rotatedAt: Date.now()
    }
  };
}

/* ---------------------------------------------------------------- *
 * Encrypted backups
 * ---------------------------------------------------------------- */

export const BACKUP_KIND = 'openmodheader-encrypted-backup';

/* A backup is encrypted under its own passphrase-derived key rather than
   the live vault key, so it can be restored on another machine. */
export async function createBackup(passphrase, payload) {
  const salt = randomBytes(KDF.saltBytes);
  const key = await deriveKey(passphrase, salt);
  const record = await encryptSecret(key, JSON.stringify(payload));
  return {
    kind: BACKUP_KIND,
    version: VAULT_FORMAT_VERSION,
    kdf: KDF.name,
    hash: KDF.hash,
    iterations: KDF.iterations,
    salt: toB64(salt),
    createdAt: new Date().toISOString(),
    payload: record
  };
}

export async function readBackup(backup, passphrase) {
  if (!backup || backup.kind !== BACKUP_KIND) throw new Error('Not an OpenModHeader backup');
  if (backup.version !== VAULT_FORMAT_VERSION) {
    throw new Error(`Unsupported backup version: ${backup.version}`);
  }
  if (backup.kdf !== KDF.name) throw new Error('Unsupported key derivation');
  const iterations = Number(backup.iterations);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 10000000) {
    throw new Error('Unsupported iteration count');
  }
  const salt = fromB64(backup.salt, { expectedBytes: KDF.saltBytes, label: 'salt' });
  const key = await deriveKey(passphrase, salt, iterations);
  const json = await decryptSecret(key, backup.payload);
  if (json == null) return null;
  try {
    return JSON.parse(json);
  } catch {
    throw new Error('Backup contents are not valid JSON');
  }
}
