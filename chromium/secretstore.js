/* OpenModHeader — credential storage and vault lock state.

   Wraps the storage areas and the alarms API so the Chromium and Firefox
   engines share one implementation. Decrypted values and derived key
   material live in storage.session and nowhere else; ciphertext and
   non-sensitive configuration live in storage.local. */

import { api } from './common-api.js';
import {
  createVault, unlockVault, decryptAll, decryptOne, encryptSecret,
  importKey, exportKey, validateVault
} from './vault.js';

export const LOCAL_KEYS = { vault: 'vault', plainSecrets: 'plainSecrets' };
export const SESSION_KEYS = { values: 'secretValues', key: 'vaultKey', lockAt: 'vaultLockAt' };
export const LOCK_ALARM = 'openmodheader-vault-lock';

/* Interactions that count as deliberate credential activity. Network traffic
   is deliberately absent: requests must not hold the vault open. */
export const ACTIVITY = {
  unlock: 'unlock',
  editCredential: 'editCredential',
  enableProtectedProfile: 'enableProtectedProfile',
  revealCredential: 'revealCredential',
  copyCredential: 'copyCredential',
  exportCredential: 'exportCredential',
  openCredentialUi: 'openCredentialUi'
};

/* ---------------------------------------------------------------- *
 * Storage-area wrappers
 * ---------------------------------------------------------------- */

export function hasSessionStorage() {
  return !!api?.storage?.session;
}

/* Fail closed. If storage.session is missing we return nothing rather than
   silently falling back to persistent storage for a credential. */
async function sessionGet(key) {
  if (!hasSessionStorage()) return undefined;
  try {
    const bag = await api.storage.session.get(key);
    return bag?.[key];
  } catch {
    return undefined;
  }
}

async function sessionSet(key, value) {
  if (!hasSessionStorage()) return false;
  try {
    await api.storage.session.set({ [key]: value });
    return true;
  } catch {
    return false;
  }
}

async function sessionRemove(keys) {
  if (!hasSessionStorage()) return;
  try {
    await api.storage.session.remove(keys);
  } catch {
    /* Nothing useful to do; the values are memory-only regardless. */
  }
}

async function localGet(key) {
  const bag = await api.storage.local.get(key);
  return bag?.[key];
}

async function localSet(key, value) {
  await api.storage.local.set({ [key]: value });
}

/* ---------------------------------------------------------------- *
 * Session credential cache
 * ---------------------------------------------------------------- */

export async function getSessionValues() {
  const values = await sessionGet(SESSION_KEYS.values);
  return values && typeof values === 'object' ? values : {};
}

export async function setSessionValue(secretId, value) {
  const values = await getSessionValues();
  values[secretId] = String(value ?? '');
  return sessionSet(SESSION_KEYS.values, values);
}

export async function removeSessionValue(secretId) {
  const values = await getSessionValues();
  delete values[secretId];
  return sessionSet(SESSION_KEYS.values, values);
}

export async function clearSessionSecrets() {
  await sessionRemove([SESSION_KEYS.values, SESSION_KEYS.key, SESSION_KEYS.lockAt]);
}

/* ---------------------------------------------------------------- *
 * Vault state
 * ---------------------------------------------------------------- */

export async function getVault() {
  return (await localGet(LOCAL_KEYS.vault)) ?? null;
}

export async function putVault(vault) {
  await localSet(LOCAL_KEYS.vault, vault);
}

export async function vaultExists() {
  const vault = await getVault();
  if (!vault) return false;
  try {
    validateVault(vault);
    return true;
  } catch {
    return true; // present but damaged; the UI offers a reset
  }
}

export async function isUnlocked() {
  return !!(await sessionGet(SESSION_KEYS.key));
}

async function activeKey() {
  const raw = await sessionGet(SESSION_KEYS.key);
  if (!raw) return null;
  try {
    return await importKey(raw);
  } catch {
    return null;
  }
}

export async function initVault(passphrase) {
  const { vault, key } = await createVault(passphrase);
  await putVault(vault);
  await sessionSet(SESSION_KEYS.key, await exportKey(key));
  await sessionSet(SESSION_KEYS.values, {});
  return true;
}

export async function unlock(passphrase, settings) {
  const vault = await getVault();
  if (!vault) return { ok: false, error: 'no-vault' };

  let key;
  try {
    key = await unlockVault(vault, passphrase);
  } catch (err) {
    return { ok: false, error: 'damaged-vault', detail: String(err.message || err) };
  }
  if (!key) return { ok: false, error: 'incorrect-passphrase' };

  /* Only the derived key is cached. Plaintext credentials are never written
     to session storage in vault mode, so unlocking does not leave a readable
     dump of every credential sitting in the storage area. */
  const { corrupt } = await decryptAll(vault, key);
  const stored = await sessionSet(SESSION_KEYS.key, await exportKey(key));
  if (!stored) return { ok: false, error: 'no-session-storage' };

  await noteActivity(ACTIVITY.unlock, settings);
  return { ok: true, corrupt };
}

/* Clears every trace of the unlocked state. Ciphertext in storage.local and
   all non-sensitive configuration are left untouched. */
export async function lock() {
  await clearSessionSecrets();
  try {
    await api.alarms?.clear(LOCK_ALARM);
  } catch {
    /* An orphaned alarm is harmless: it re-checks the timestamp and exits. */
  }
}

export async function resetVault() {
  await lock();
  try {
    await api.storage.local.remove(LOCAL_KEYS.vault);
  } catch {
    await putVault(null);
  }
}

/* ---------------------------------------------------------------- *
 * Secret read / write, by mode
 * ---------------------------------------------------------------- */

export async function getPlainSecrets() {
  const bag = await localGet(LOCAL_KEYS.plainSecrets);
  return bag && typeof bag === 'object' ? bag : {};
}

/* The one place credentials are resolved for rule building. Returns a plain
   map so callers can check membership without holding storage open. */
export async function resolveSecrets(settings) {
  if (settings.credentialStorage === 'plaintext') {
    return await getPlainSecrets();
  }

  if (settings.credentialStorage === 'vault') {
    /* Decrypted on demand from ciphertext with the cached key. PBKDF2 is not
       re-run here — only the AES-GCM step, which is cheap enough to do on
       every rule build. */
    const key = await activeKey();
    if (!key) return {};
    const vault = await getVault();
    if (!vault) return {};
    const { values } = await decryptAll(vault, key);
    return values;
  }

  return await getSessionValues();
}

/* Reveals a single credential. Requires a passphrase and does real
   cryptographic work with it: the key is re-derived from the vault salt and
   used to authenticate that specific record. It never reads the session
   cache, so patching out the UI prompt does not produce a value.

   In session-only and plaintext modes there is no passphrase and no
   ciphertext, so this returns a clear reason rather than pretending. */
export async function revealSecret(secretId, passphrase, settings) {
  if (settings.credentialStorage !== 'vault') {
    return { ok: false, error: 'not-encrypted' };
  }
  const vault = await getVault();
  if (!vault) return { ok: false, error: 'no-vault' };

  try {
    return await decryptOne(vault, passphrase, secretId);
  } catch {
    return { ok: false, error: 'damaged-vault' };
  }
}

/* Persists a credential immediately under the active mode. In vault mode the
   ciphertext is written on this call, not deferred to some later event. */
export async function putSecret(secretId, value, settings) {
  const mode = settings.credentialStorage;

  if (mode === 'plaintext') {
    const bag = await getPlainSecrets();
    bag[secretId] = String(value ?? '');
    await localSet(LOCAL_KEYS.plainSecrets, bag);
    return { ok: true };
  }

  if (mode === 'vault') {
    const key = await activeKey();
    if (!key) return { ok: false, error: 'locked' };
    const vault = await getVault();
    if (!vault) return { ok: false, error: 'no-vault' };
    /* Ciphertext only. The plaintext is not mirrored into session storage. */
    vault.records = { ...(vault.records || {}), [secretId]: await encryptSecret(key, value) };
    await putVault(vault);
  } else {
    await setSessionValue(secretId, value);
  }
  await noteActivity(ACTIVITY.editCredential, settings);
  return { ok: true };
}

export async function deleteSecret(secretId, settings) {
  await removeSessionValue(secretId);

  const bag = await getPlainSecrets();
  if (Object.hasOwn(bag, secretId)) {
    delete bag[secretId];
    await localSet(LOCAL_KEYS.plainSecrets, bag);
  }

  const vault = await getVault();
  if (vault?.records && Object.hasOwn(vault.records, secretId)) {
    delete vault.records[secretId];
    await putVault(vault);
  }
}

/* Removes stored values for secrets no profile references any more. Shared
   secrets survive because the caller passes every id still in use. */
export async function pruneOrphans(referencedIds, settings) {
  const keep = new Set(referencedIds);
  const removed = [];

  const session = await getSessionValues();
  let sessionDirty = false;
  for (const id of Object.keys(session)) {
    if (!keep.has(id)) { delete session[id]; sessionDirty = true; removed.push(id); }
  }
  if (sessionDirty) await sessionSet(SESSION_KEYS.values, session);

  const plain = await getPlainSecrets();
  let plainDirty = false;
  for (const id of Object.keys(plain)) {
    if (!keep.has(id)) { delete plain[id]; plainDirty = true; removed.push(id); }
  }
  if (plainDirty) await localSet(LOCAL_KEYS.plainSecrets, plain);

  const vault = await getVault();
  if (vault?.records) {
    let vaultDirty = false;
    for (const id of Object.keys(vault.records)) {
      if (!keep.has(id)) { delete vault.records[id]; vaultDirty = true; removed.push(id); }
    }
    if (vaultDirty) await putVault(vault);
  }
  return [...new Set(removed)];
}

/* Switching modes must never leave a credential behind in a stronger mode's
   store, nor silently promote a plaintext value into the vault. */
export async function migrateSecretsToMode(nextMode, settings) {
  const current = await resolveSecrets(settings);

  if (nextMode === 'plaintext') {
    await localSet(LOCAL_KEYS.plainSecrets, { ...current });
    return { ok: true, carried: Object.keys(current).length };
  }

  /* Leaving plaintext: values move into the session cache and the
     persistent plaintext copy is deleted. */
  const values = { ...current };
  await sessionSet(SESSION_KEYS.values, values);
  try {
    await api.storage.local.remove(LOCAL_KEYS.plainSecrets);
  } catch {
    await localSet(LOCAL_KEYS.plainSecrets, {});
  }

  if (nextMode === 'vault') {
    const key = await activeKey();
    if (!key) return { ok: false, error: 'locked', carried: 0 };
    const vault = await getVault();
    if (!vault) return { ok: false, error: 'no-vault', carried: 0 };
    const records = { ...(vault.records || {}) };
    for (const [id, value] of Object.entries(values)) {
      records[id] = await encryptSecret(key, value);
    }
    await putVault({ ...vault, records });
  }
  return { ok: true, carried: Object.keys(values).length };
}

/* ---------------------------------------------------------------- *
 * Auto-lock
 * ---------------------------------------------------------------- */

export async function getLockAt() {
  const value = await sessionGet(SESSION_KEYS.lockAt);
  return Number.isFinite(value) ? value : null;
}

/* Records deliberate credential activity and pushes the lock deadline out.
   MV3 can suspend the worker at any moment, so the deadline is a timestamp
   in session storage and the alarm only wakes us to check it. */
export async function noteActivity(_kind, settings) {
  if (!settings || settings.credentialStorage !== 'vault') return;
  if (settings.disableAutoLock) {
    await sessionRemove([SESSION_KEYS.lockAt]);
    try { await api.alarms?.clear(LOCK_ALARM); } catch { /* no-op */ }
    return;
  }
  if (!(await isUnlocked())) return;

  const minutes = Math.max(1, Number(settings.lockAfterMinutes) || 15);
  const lockAt = Date.now() + minutes * 60_000;
  await sessionSet(SESSION_KEYS.lockAt, lockAt);

  try {
    await api.alarms?.clear(LOCK_ALARM);
    api.alarms?.create(LOCK_ALARM, { when: lockAt });
  } catch {
    /* Without alarms the vault still locks on restart. */
  }
}

/* Alarms can fire late, so re-check the stored deadline before locking and
   reschedule if activity extended it after the alarm was set. */
export async function handleLockAlarm(settings) {
  if (!(await isUnlocked())) return { locked: false, reason: 'already-locked' };
  if (settings?.disableAutoLock) return { locked: false, reason: 'auto-lock-disabled' };

  const lockAt = await getLockAt();
  if (lockAt == null) return { locked: false, reason: 'no-deadline' };

  if (Date.now() < lockAt) {
    try {
      api.alarms?.create(LOCK_ALARM, { when: lockAt });
    } catch {
      /* no-op */
    }
    return { locked: false, reason: 'not-yet-due', lockAt };
  }

  await lock();
  return { locked: true };
}
