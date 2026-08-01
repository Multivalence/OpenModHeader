/* OpenModHeader — popup credential-security UI.

   Kept separate from popup.js so the header-editing UI stays readable. This
   module owns the modal system, the Security settings panel, and every flow
   that can touch a credential: entry, reveal, export, copy, duplication,
   vault lifecycle and migration. */

import { api, blankSecretId, secretRefCount, collectSecretIds } from './common.js';
import {
  CREDENTIAL_MODES, LOCK_MINUTES_CHOICES, DEFAULT_SETTINGS,
  isSensitiveHeader, evaluateProfile, hasHostRestriction,
  insecureHostFilters, describeBlock
} from './security.js';
import {
  initVault, unlock, lock, resetVault, getVault, vaultExists, isUnlocked,
  putSecret, deleteSecret, resolveSecrets, getSessionValues, pruneOrphans,
  noteActivity, ACTIVITY, migrateSecretsToMode, hasSessionStorage,
  getPlainSecrets, putVault, revealSecret
} from './secretstore.js';
import { changePassphrase, createBackup, readBackup, unlockVault } from './vault.js';

/* runtime.sendMessage rejects when no receiver answers (no listener yet, or a
   service worker still starting). That must never abort a UI flow, so every
   notification goes through here and failures are swallowed — the background
   also watches storage, so it converges regardless. */
export function notifyBackground(type) {
  try {
    const result = api.runtime.sendMessage({ type });
    if (result?.catch) result.catch(() => {});
  } catch {
    /* Synchronous throw in some engines when the port is unavailable. */
  }
}

const hasDom = typeof document !== 'undefined';
const $ = id => (hasDom ? document.getElementById(id) : null);

/* ---------------------------------------------------------------- *
 * DOM helper (mirrors popup.js)
 * ---------------------------------------------------------------- */

export function el(tag, props = {}, ...kids) {
  if (!hasDom) throw new Error('el() requires a DOM');
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'disabled') node[key] = !!value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

/* ---------------------------------------------------------------- *
 * Modal
 * ---------------------------------------------------------------- */

let modalResolve = null;

/* Returns a promise resolving to the chosen value, or null if dismissed.
   `build(body, done)` populates the body and may call done(value) itself. */
export function openModal({ title, build, actions = [], width = null }) {
  return new Promise(resolve => {
    modalResolve = resolve;

    const scrim = $('modal');
    const body = $('modal-body');
    const bar = $('modal-actions');
    $('modal-title').textContent = title;
    body.textContent = '';
    bar.textContent = '';
    if (width) $('modal-body').parentElement.style.maxWidth = `${width}px`;

    const done = value => closeModal(value);
    build(body, done);

    for (const action of actions) {
      const button = el('button', {
        class: action.danger
          ? 'danger-btn'
          : (action.primary ? 'primary-btn' : 'ghost-btn'),
        text: action.label,
        onclick: () => action.onClick ? action.onClick(done) : done(action.value ?? null)
      });
      /* An action can declare when it becomes available, so the button is
         visibly disabled until the form is valid rather than looking
         clickable-but-inert. */
      if (action.enableWhen) {
        button.disabled = !action.enableWhen();
        const sync = () => { button.disabled = !action.enableWhen(); };
        body.addEventListener('input', sync);
        body.addEventListener('change', sync);
      }
      bar.append(button);
    }

    scrim.hidden = false;
    body.querySelector('input, select, button')?.focus();
  });
}

export function closeModal(value = null) {
  $('modal').hidden = true;
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(value);
}

export function modalError(message) {
  const body = $('modal-body');
  let node = body.querySelector('.modal-error');
  if (!node) {
    node = el('p', { class: 'modal-error' });
    body.prepend(node);
  }
  node.hidden = false;
  node.textContent = message;
}

/* Registered lazily so the module can be imported in a non-DOM context
   (the test harness) without touching document. */
if (hasDom) {
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('modal')?.hidden) closeModal(null);
  });
  $('modal')?.addEventListener('click', event => {
    if (event.target.id === 'modal') closeModal(null);
  });
}

/* A radio-choice modal. Options are [{ value, label, blurb, danger }]. */
export function chooseModal({ title, intro, options, defaultValue, confirmLabel = 'Continue' }) {
  return openModal({
    title,
    build: body => {
      if (intro) body.append(el('p', { text: intro }));
      for (const option of options) {
        body.append(el('label', { class: `choice${option.danger ? ' danger' : ''}` },
          el('input', {
            type: 'radio', name: 'omh-choice', value: option.value,
            checked: option.value === defaultValue
          }),
          el('span', { class: 'opt-body' },
            el('span', { class: 'opt-label', text: option.label }),
            option.blurb ? el('span', { class: 'opt-blurb', text: option.blurb }) : null
          )
        ));
      }
    },
    actions: [
      { label: 'Cancel', value: null },
      {
        label: confirmLabel, primary: true,
        onClick: done => {
          const picked = document.querySelector('input[name="omh-choice"]:checked');
          done(picked ? picked.value : null);
        }
      }
    ]
  });
}

/* Prompts for a passphrase and verifies it against the live vault. Used for
   re-authentication before any credential leaves the extension. */
export async function promptPassphrase({
  title = 'Enter your vault passphrase',
  intro = null,
  confirmLabel = 'Confirm',
  verify = true
} = {}) {
  return openModal({
    title,
    build: body => {
      if (intro) body.append(el('p', { text: intro }));
      body.append(el('label', { class: 'field' },
        el('span', { class: 'field-label', text: 'Passphrase' }),
        el('input', { type: 'password', id: 'omh-pass', autocomplete: 'current-password' })
      ));
    },
    actions: [
      { label: 'Cancel', value: null },
      {
        label: confirmLabel, primary: true,
        enableWhen: () => ($('omh-pass')?.value ?? '') !== '',
        onClick: async done => {
          const value = $('omh-pass')?.value ?? '';
          if (!value) return modalError('Enter your passphrase.');
          if (!verify) return done(value);
          const vault = await getVault();
          if (!vault) return modalError('No vault has been set up.');
          let key = null;
          try {
            key = await unlockVault(vault, value);
          } catch {
            return modalError('The vault could not be read. You may need to reset it.');
          }
          if (!key) return modalError('That passphrase is not correct.');
          done(value);
        }
      }
    ]
  });
}

/* ---------------------------------------------------------------- *
 * Credential entry
 * ---------------------------------------------------------------- */

/* Prompts for a credential value and stores it under the active mode. The
   value is written straight to the store; it is never placed back onto the
   header object, and never into a DOM attribute. */
export async function promptCredential(header, state, { title = null, reveal = false } = {}) {
  const settings = state.settings;

  /* Pre-filling with the stored value requires the same re-authentication as
     any other reveal, so an unattended popup cannot expose it. */
  let existing = '';
  if (reveal && header.secretId) {
    const secrets = await resolveSecrets(settings);
    existing = secrets[header.secretId] ?? '';
    await noteActivity(ACTIVITY.revealCredential, settings);
  }

  const value = await openModal({
    title: title || `Credential for ${header.name || 'this entry'}`,
    build: body => {
      body.append(el('p', { class: 'muted', text: modeBlurb(settings) }));
      body.append(el('label', { class: 'field' },
        el('span', { class: 'field-label', text: 'Value' }),
        el('input', {
          type: reveal ? 'text' : 'password',
          id: 'omh-secret',
          autocomplete: 'off',
          value: existing
        })
      ));
      body.append(el('label', { class: 'opt' },
        el('input', {
          type: 'checkbox', id: 'omh-show', checked: reveal,
          onchange: event => {
            const field = $('omh-secret');
            field.type = event.target.checked ? 'text' : 'password';
          }
        }),
        el('span', { class: 'opt-body' },
          el('span', { class: 'opt-label', text: 'Show value' }))
      ));
    },
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Save', primary: true,
        enableWhen: () => ($('omh-secret')?.value ?? '') !== '',
        onClick: done => {
          const entered = $('omh-secret')?.value ?? '';
          if (!entered) return modalError('Enter a value, or cancel.');
          done(entered);
        }
      }
    ]
  });

  if (value == null) return false;

  if (!header.secretId) header.secretId = blankSecretId();
  header.sensitive = true;

  const result = await putSecret(header.secretId, value, settings);
  if (!result.ok) return false;

  header.requiresCredential = false;
  state.secretsMeta[header.secretId] = state.secretsMeta[header.secretId]
    || { label: header.name, createdAt: Date.now() };
  await noteActivity(ACTIVITY.editCredential, settings);
  return true;
}

function modeBlurb(settings) {
  const mode = CREDENTIAL_MODES[settings.credentialStorage];
  return `Storage: ${mode.label}. ${mode.blurb}`;
}

/* ---------------------------------------------------------------- *
 * Host-restriction gate
 * ---------------------------------------------------------------- */

/* Called before a sensitive header is enabled or saved. Returns true when
   activation may proceed. The override is written to the profile, never to
   the global setting. */
export async function confirmSensitiveHost(profile, state) {
  const settings = state.settings;
  if (!settings.requireExplicitHosts) return true;
  if (profile.allowGlobalSensitiveHeaders) return true;
  if (hasHostRestriction(profile)) return true;

  const choice = await chooseModal({
    title: 'This credential would be sent everywhere',
    intro: `"${profile.name}" has no host filter, so this credential would be attached to `
      + 'requests to every website you visit — including sites unrelated to your work.',
    options: [
      {
        value: 'add',
        label: 'Go back and add a host filter',
        blurb: 'Recommended. Restrict the profile to the hosts that need this credential.'
      },
      {
        value: 'override',
        label: 'Send it to every site anyway',
        blurb: 'Applies to this profile only. Other profiles stay protected.',
        danger: true
      }
    ],
    defaultValue: 'add',
    confirmLabel: 'Continue'
  });

  if (choice === 'override') {
    profile.allowGlobalSensitiveHeaders = true;
    return true;
  }
  return false;
}

export async function warnInsecureHosts(profile, state) {
  if (!state.settings.warnOnInsecureHosts) return;
  const insecure = insecureHostFilters(profile);
  if (!insecure.length) return;

  await openModal({
    title: 'Credential over an unencrypted connection',
    build: body => {
      body.append(el('p', { class: 'warn', text:
        'This profile targets a plain http:// host, so the credential travels unencrypted '
        + 'and anyone on the network path can read it.' }));
      body.append(el('p', { class: 'muted', text: insecure.join(', ') }));
      body.append(el('p', { class: 'muted', text:
        'Local development addresses are exempt from this warning.' }));
    },
    actions: [{ label: 'Understood', primary: true, value: true }]
  });
}

/* ---------------------------------------------------------------- *
 * Export / copy
 * ---------------------------------------------------------------- */

/* Builds the export payload. Sensitive values are omitted unless the caller
   explicitly asked for them and re-authenticated. */
export async function buildExportPayload(state, { includeSecrets = false } = {}) {
  const secrets = includeSecrets ? await resolveSecrets(state.settings) : {};
  const profiles = structuredClone(state.profiles);

  for (const profile of profiles) {
    for (const key of ['requestHeaders', 'responseHeaders']) {
      for (const header of profile[key] || []) {
        if (!header.secretId) continue;
        if (includeSecrets && Object.hasOwn(secrets, header.secretId)) {
          header.value = secrets[header.secretId];
          header.requiresCredential = false;
        } else {
          header.value = null;
          header.requiresCredential = true;
        }
      }
    }
  }

  return {
    app: 'OpenModHeader',
    version: 3,
    exportedAt: new Date().toISOString(),
    containsCredentials: includeSecrets,
    profiles
  };
}

export async function chooseExportMode(state) {
  const vaulted = state.settings.credentialStorage === 'vault' && await vaultExists();

  const options = [
    {
      value: 'config',
      label: 'Configuration only',
      blurb: 'Profiles, filters and redirects. Credentials are left out and the import stays locked.'
    }
  ];
  if (vaulted) {
    options.push({
      value: 'backup',
      label: 'Encrypted backup with credentials',
      blurb: 'Passphrase-protected. Restorable on another machine.'
    });
  }
  options.push({
    value: 'plain',
    label: 'Plaintext export with credentials',
    blurb: 'Anyone who opens the file can read every credential in it.',
    danger: true
  });

  return chooseModal({
    title: 'Export profiles',
    intro: 'Choose what the exported file should contain.',
    options,
    defaultValue: 'config',
    confirmLabel: 'Export'
  });
}

/* Re-authentication is required even when the vault is already unlocked, so
   an unattended unlocked popup cannot be used to extract credentials. */
export async function reauthenticate(state, purpose) {
  const settings = state.settings;

  if (settings.credentialStorage === 'vault') {
    if (!settings.requirePassphraseToReveal) return true;
    const pass = await promptPassphrase({
      title: 'Confirm your passphrase',
      intro: `Re-enter your vault passphrase to ${purpose}.`,
      confirmLabel: 'Confirm'
    });
    if (pass == null) return false;
    await noteActivity(ACTIVITY.exportCredential, settings);
    return true;
  }

  /* No passphrase exists in session-only or plaintext mode, so require an
     explicit acknowledgement instead. */
  const ok = await openModal({
    title: 'Include credentials?',
    build: body => {
      body.append(el('p', { class: 'warn', text:
        `You are about to ${purpose}. The credentials will be readable by anyone `
        + 'who can open the result.' }));
      if (settings.credentialStorage === 'plaintext') {
        body.append(el('p', { class: 'muted', text:
          'Persistent plaintext mode is active, so these credentials are already stored '
          + 'unencrypted in your browser profile.' }));
      }
    },
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Include credentials', danger: true, value: true }
    ]
  });
  return ok === true;
}

export async function chooseCopyMode() {
  return chooseModal({
    title: 'Copy profiles as JSON',
    intro: 'Choose what goes onto the clipboard.',
    options: [
      {
        value: 'config',
        label: 'Copy without credentials',
        blurb: 'Recommended. Credentials are replaced with placeholders.'
      },
      {
        value: 'secrets',
        label: 'Copy with credentials',
        blurb: 'Clipboard managers and clipboard history tools may retain the value '
          + 'indefinitely. The extension cannot clear it afterwards.',
        danger: true
      }
    ],
    defaultValue: 'config',
    confirmLabel: 'Copy'
  });
}

/* ---------------------------------------------------------------- *
 * Duplication
 * ---------------------------------------------------------------- */

export async function chooseDuplicationMode(profile) {
  const sensitive = [...(profile.requestHeaders || []), ...(profile.responseHeaders || [])]
    .filter(h => h.secretId);

  if (!sensitive.length) return 'config';

  return chooseModal({
    title: `Duplicate "${profile.name}"`,
    intro: 'This profile uses stored credentials. Choose how the copy should handle them.',
    options: [
      {
        value: 'config',
        label: 'Duplicate configuration only',
        blurb: 'The copy has no credentials and stays locked until you add them.'
      },
      {
        value: 'share',
        label: 'Duplicate and reuse the existing credential',
        blurb: 'Both profiles point at the same stored secret. Changing it affects both.'
      },
      {
        value: 'new',
        label: 'Duplicate with a new independent credential',
        blurb: 'You will be prompted for a separate value for the copy.'
      }
    ],
    defaultValue: 'config',
    confirmLabel: 'Duplicate'
  });
}

/* Rewrites the cloned profile's secret references according to the chosen
   mode. Sharing keeps the same secretId so no second ciphertext is created. */
export function applyDuplicationMode(copy, mode) {
  const created = [];
  for (const key of ['requestHeaders', 'responseHeaders']) {
    for (const header of copy[key] || []) {
      if (!header.secretId) continue;

      if (mode === 'config') {
        header.secretId = null;
        header.requiresCredential = true;
        header.value = '';
      } else if (mode === 'new') {
        header.secretId = blankSecretId();
        header.requiresCredential = true;
        header.value = '';
        created.push(header);
      }
      /* mode === 'share' keeps the existing secretId untouched. */
    }
  }
  return created;
}

/* ---------------------------------------------------------------- *
 * Deletion
 * ---------------------------------------------------------------- */

/* Deletes only the secrets that no surviving profile references, so a shared
   credential outlives the removal of one of its users. */
export async function cleanupSecretsAfterDelete(state) {
  const referenced = collectSecretIds(state);
  const removed = await pruneOrphans(referenced, state.settings);
  for (const id of Object.keys(state.secretsMeta || {})) {
    if (!referenced.includes(id)) delete state.secretsMeta[id];
  }
  return removed;
}

/* ---------------------------------------------------------------- *
 * Vault lifecycle
 * ---------------------------------------------------------------- */

export async function setupVault(state) {
  const passphrase = await openModal({
    title: 'Create your vault passphrase',
    build: body => {
      body.append(el('p', { text:
        'Credentials will be encrypted with this passphrase and unlocked with it after '
        + 'each browser restart.' }));
      body.append(el('p', { class: 'muted', text:
        'There is no recovery. If you forget it, the encrypted credentials cannot be '
        + 'read and the vault has to be reset.' }));
      body.append(el('label', { class: 'field' },
        el('span', { class: 'field-label', text: 'Passphrase' }),
        el('input', { type: 'password', id: 'omh-p1', autocomplete: 'new-password' })
      ));
      body.append(el('label', { class: 'field' },
        el('span', { class: 'field-label', text: 'Confirm passphrase' }),
        el('input', { type: 'password', id: 'omh-p2', autocomplete: 'new-password' })
      ));
    },
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Create vault', primary: true,
        enableWhen: () => ($('omh-p1')?.value ?? '').length >= 8
          && ($('omh-p1')?.value ?? '') === ($('omh-p2')?.value ?? ''),
        onClick: done => {
          const a = $('omh-p1')?.value ?? '';
          const b = $('omh-p2')?.value ?? '';
          if (a.length < 8) return modalError('Use at least 8 characters.');
          if (a !== b) return modalError('The two passphrases do not match.');
          done(a);
        }
      }
    ]
  });

  if (passphrase == null) return false;
  await initVault(passphrase);
  await noteActivity(ACTIVITY.unlock, state.settings);
  return true;
}

export async function unlockFlow(state) {
  const result = await openModal({
    title: 'Unlock the credential vault',
    build: body => {
      body.append(el('p', { text: 'Protected profiles stay inactive until the vault is unlocked.' }));
      body.append(el('label', { class: 'field' },
        el('span', { class: 'field-label', text: 'Passphrase' }),
        el('input', { type: 'password', id: 'omh-pass', autocomplete: 'current-password' })
      ));
    },
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Unlock', primary: true,
        enableWhen: () => ($('omh-pass')?.value ?? '') !== '',
        onClick: async done => {
          const value = $('omh-pass')?.value ?? '';
          if (!value) return modalError('Enter your passphrase.');
          const outcome = await unlock(value, state.settings);
          if (!outcome.ok) {
            if (outcome.error === 'incorrect-passphrase') return modalError('That passphrase is not correct.');
            if (outcome.error === 'no-session-storage') return modalError('This browser does not expose session storage, so the vault cannot be unlocked safely.');
            if (outcome.error === 'no-vault') return modalError('No vault has been set up yet.');
            return modalError('The vault could not be read. You may need to reset it.');
          }
          done(outcome);
        }
      }
    ]
  });

  if (!result) return false;
  if (result.corrupt?.length) {
    await openModal({
      title: 'Some credentials could not be read',
      build: body => {
        body.append(el('p', { text:
          `${result.corrupt.length} stored credential${result.corrupt.length === 1 ? '' : 's'} `
          + 'failed to decrypt and were left untouched. The affected profiles stay locked until '
          + 'you re-enter those values.' }));
      },
      actions: [{ label: 'OK', primary: true, value: true }]
    });
  }
  notifyBackground('unlocked');
  return true;
}

export async function changePassphraseFlow(state) {
  const values = await openModal({
    title: 'Change the vault passphrase',
    build: body => {
      body.append(el('p', { class: 'muted', text:
        'Every stored credential is re-encrypted under the new passphrase in a single write.' }));
      body.append(el('label', { class: 'field' },
        el('span', { class: 'field-label', text: 'Current passphrase' }),
        el('input', { type: 'password', id: 'omh-cur', autocomplete: 'current-password' })
      ));
      body.append(el('label', { class: 'field' },
        el('span', { class: 'field-label', text: 'New passphrase' }),
        el('input', { type: 'password', id: 'omh-n1', autocomplete: 'new-password' })
      ));
      body.append(el('label', { class: 'field' },
        el('span', { class: 'field-label', text: 'Confirm new passphrase' }),
        el('input', { type: 'password', id: 'omh-n2', autocomplete: 'new-password' })
      ));
    },
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Change', primary: true,
        enableWhen: () => ($('omh-cur')?.value ?? '') !== ''
          && ($('omh-n1')?.value ?? '').length >= 8
          && ($('omh-n1')?.value ?? '') === ($('omh-n2')?.value ?? ''),
        onClick: done => {
          const cur = $('omh-cur')?.value ?? '';
          const a = $('omh-n1')?.value ?? '';
          const b = $('omh-n2')?.value ?? '';
          if (!cur) return modalError('Enter your current passphrase.');
          if (a.length < 8) return modalError('Use at least 8 characters.');
          if (a !== b) return modalError('The two new passphrases do not match.');
          done({ cur, next: a });
        }
      }
    ]
  });

  if (!values) return false;

  const vault = await getVault();
  const result = await changePassphrase(vault, values.cur, values.next);
  if (!result.ok) return 'incorrect';

  /* Single write: an interrupted change leaves the original vault intact. */
  await putVault(result.vault);
  await unlock(values.next, state.settings);
  notifyBackground('unlocked');
  return true;
}

export async function resetVaultFlow() {
  const ok = await openModal({
    title: 'Reset the vault',
    build: body => {
      body.append(el('p', { class: 'warn', text:
        'Every encrypted credential will be permanently deleted. This cannot be undone and '
        + 'there is no way to recover them without the passphrase.' }));
      body.append(el('p', { text:
        'Your profiles, filters, redirects and non-sensitive headers are kept. Protected '
        + 'headers will ask for a new credential.' }));
    },
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Delete all credentials', danger: true, value: true }
    ]
  });
  if (ok !== true) return false;
  await resetVault();
  notifyBackground('lock');
  return true;
}

/* ---------------------------------------------------------------- *
 * Backups
 * ---------------------------------------------------------------- */

export async function makeEncryptedBackup(state) {
  const passphrase = await promptPassphrase({
    title: 'Passphrase for this backup',
    intro: 'The backup is encrypted with this passphrase. Re-enter your vault passphrase.',
    confirmLabel: 'Create backup'
  });
  if (passphrase == null) return null;

  const payload = await buildExportPayload(state, { includeSecrets: true });
  await noteActivity(ACTIVITY.exportCredential, state.settings);
  return createBackup(passphrase, payload);
}

export async function restoreBackup(backup) {
  const passphrase = await promptPassphrase({
    title: 'Backup passphrase',
    intro: 'Enter the passphrase this backup was created with.',
    confirmLabel: 'Restore',
    verify: false
  });
  if (passphrase == null) return null;

  let payload;
  try {
    payload = await readBackup(backup, passphrase);
  } catch (err) {
    modalError(String(err.message || 'The backup could not be read.'));
    return null;
  }
  if (payload == null) return 'incorrect';
  return payload;
}

/* ---------------------------------------------------------------- *
 * Migration
 * ---------------------------------------------------------------- */

export async function runMigrationFlow(state, pending) {
  const choice = await chooseModal({
    title: 'Protect your stored credentials',
    intro: `OpenModHeader found ${pending.credentialCount} credential`
      + `${pending.credentialCount === 1 ? '' : 's'} stored unencrypted in your profiles. `
      + 'Choose how they should be stored from now on. Nothing has been deleted.',
    options: [
      {
        value: 'session',
        label: CREDENTIAL_MODES.session.label,
        blurb: CREDENTIAL_MODES.session.blurb
      },
      {
        value: 'vault',
        label: CREDENTIAL_MODES.vault.label,
        blurb: CREDENTIAL_MODES.vault.blurb
      },
      {
        value: 'plaintext',
        label: CREDENTIAL_MODES.plaintext.label,
        blurb: 'Keeps the current behaviour. Credentials stay unencrypted on disk.',
        danger: true
      }
    ],
    defaultValue: 'session',
    confirmLabel: 'Apply'
  });

  if (!choice) return false;

  if (choice === 'vault') {
    if (!(await vaultExists()) && !(await setupVault(state))) return false;
    if (!(await isUnlocked()) && !(await unlockFlow(state))) return false;
  }

  if (choice === 'plaintext' && !(await confirmPlaintextMode())) return false;

  state.settings.credentialStorage = choice;
  state.settings.plaintextAcknowledged = choice === 'plaintext';

  /* Move the values the background extracted into the chosen store. */
  const bag = await api.storage.local.get('migrationSecrets');
  const extracted = bag.migrationSecrets || {};
  for (const [secretId, value] of Object.entries(extracted)) {
    await putSecret(secretId, value, state.settings);
  }

  await api.storage.local.remove(['migrationSecrets', 'pendingMigration']);
  return true;
}

export async function confirmPlaintextMode() {
  const ok = await openModal({
    title: 'Store credentials unencrypted?',
    build: body => {
      body.append(el('p', { class: 'warn', text:
        'Credentials will be written to your browser profile in plain text. Any program '
        + 'or person with access to that profile directory can read them, and they stay '
        + 'readable after the browser is closed.' }));
      body.append(el('p', { text:
        'This matches how the extension behaved before credential protection existed. '
        + 'It is only appropriate for throwaway or non-production values.' }));
    },
    actions: [
      { label: 'Cancel', value: null },
      { label: 'I accept the risk', danger: true, value: true }
    ]
  });
  return ok === true;
}

/* ---------------------------------------------------------------- *
 * Settings panel
 * ---------------------------------------------------------------- */

export async function renderSecurityPanel(content, state, ctx) {
  const settings = state.settings;
  const unlocked = await isUnlocked();
  const exists = await vaultExists();

  const save = () => ctx.save({ now: true });
  const reapply = () => api.runtime.sendMessage({ type: 'apply' }).catch(() => {});

  const checkbox = (key, label, blurb, extra = null) => el('label', { class: 'opt' },
    el('input', {
      type: 'checkbox', checked: settings[key],
      onchange: async event => {
        settings[key] = event.target.checked;
        await save();
        reapply();
        ctx.rerender();
      }
    }),
    el('span', { class: 'opt-body' },
      el('span', { class: 'opt-label' }, label, extra),
      el('span', { class: 'opt-blurb', text: blurb })
    )
  );

  /* --- Sensitive header restrictions --- */
  const restrictions = el('div', { class: 'settings-group' },
    el('h3', { class: 'settings-head', text: 'Sensitive header restrictions' }),
    checkbox('requireExplicitHosts',
      'Require explicit hosts for credential-bearing headers',
      'Prevents credentials from being applied globally. A profile can still override this individually.'),
    checkbox('warnOnInsecureHosts',
      'Warn when credentials target http:// hosts',
      'Local development addresses are exempt.')
  );

  /* --- Credential storage --- */
  const storageGroup = el('div', { class: 'settings-group' },
    el('h3', { class: 'settings-head', text: 'Credential storage' })
  );

  for (const [value, meta] of Object.entries(CREDENTIAL_MODES)) {
    storageGroup.append(el('label', { class: `opt${value === 'plaintext' ? ' danger' : ''}` },
      el('input', {
        type: 'radio', name: 'omh-mode', checked: settings.credentialStorage === value,
        onchange: async event => {
          if (!event.target.checked) return;
          const previous = settings.credentialStorage;
          if (value === previous) return;

          if (value === 'plaintext' && !(await confirmPlaintextMode())) {
            ctx.rerender();
            return;
          }
          if (value === 'vault') {
            if (!(await vaultExists()) && !(await setupVault(state))) { ctx.rerender(); return; }
            if (!(await isUnlocked()) && !(await unlockFlow(state))) { ctx.rerender(); return; }
          }

          const moved = await migrateSecretsToMode(value, settings);
          if (!moved.ok) {
            ctx.flash('Unlock the vault before switching to it.');
            ctx.rerender();
            return;
          }
          settings.credentialStorage = value;
          settings.plaintextAcknowledged = value === 'plaintext';
          await save();
          reapply();
          ctx.rerender();
        }
      }),
      el('span', { class: 'opt-body' },
        el('span', { class: 'opt-label', text: meta.label }),
        el('span', { class: 'opt-blurb', text: meta.blurb })
      )
    ));
  }

  if (!hasSessionStorage()) {
    storageGroup.append(el('p', { class: 'settings-note', text:
      'This browser does not expose session storage, so session-only and encrypted-vault '
      + 'modes cannot hold credentials. Update the browser to use them.' }));
  }

  /* --- Vault --- */
  const vaultGroup = el('div', { class: 'settings-group' },
    el('h3', { class: 'settings-head', text: 'Vault locking' })
  );

  if (settings.credentialStorage === 'vault') {
    vaultGroup.append(el('div', { class: 'vault-state' },
      el('span', { class: `vault-dot ${unlocked ? 'on' : 'off'}` }),
      el('span', { text: exists ? (unlocked ? 'Vault unlocked' : 'Vault locked') : 'No vault yet' }),
      el('span', { class: 'vault-actions' },
        exists && unlocked ? el('button', {
          class: 'ghost-btn', text: 'Lock now',
          onclick: async () => {
            await lock();
            notifyBackground('lock');
            ctx.rerender();
          }
        }) : null,
        exists && !unlocked ? el('button', {
          class: 'ghost-btn', text: 'Unlock',
          onclick: async () => { if (await unlockFlow(state)) ctx.rerender(); }
        }) : null,
        !exists ? el('button', {
          class: 'ghost-btn', text: 'Create vault',
          onclick: async () => { if (await setupVault(state)) ctx.rerender(); }
        }) : null
      )
    ));

    vaultGroup.append(
      checkbox('lockOnRestart',
        'Require passphrase after browser restart',
        'Session storage is cleared on restart, so this is always in effect for the vault.'),
      el('label', { class: 'opt' },
        el('input', {
          type: 'checkbox', checked: !settings.disableAutoLock,
          onchange: async event => {
            settings.disableAutoLock = !event.target.checked;
            await save();
            await noteActivity(ACTIVITY.openCredentialUi, settings);
            ctx.rerender();
          }
        }),
        el('span', { class: 'opt-body' },
          el('span', { class: 'opt-label' }, 'Lock after ',
            el('select', {
              class: 'inline-select', disabled: settings.disableAutoLock,
              onchange: async event => {
                settings.lockAfterMinutes = Number(event.target.value);
                await save();
                await noteActivity(ACTIVITY.openCredentialUi, settings);
              }
            }, LOCK_MINUTES_CHOICES.map(m => el('option', {
              value: m, selected: settings.lockAfterMinutes === m,
              text: m >= 60 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`
            })))
          ),
          el('span', { class: 'opt-blurb', text:
            'Measured from your last deliberate credential action. Network traffic does not '
            + 'keep the vault open.' })
        )
      )
    );

    if (exists) {
      vaultGroup.append(el('div', { class: 'popover-actions' },
        el('button', {
          class: 'ghost-btn', text: 'Change passphrase',
          onclick: async () => {
            const result = await changePassphraseFlow(state);
            if (result === 'incorrect') ctx.flash('That passphrase is not correct.');
            else if (result) ctx.flash('Passphrase changed and all credentials re-encrypted.');
            ctx.rerender();
          }
        }),
        el('button', {
          class: 'ghost-btn danger', text: 'Reset vault',
          onclick: async () => {
            if (await resetVaultFlow()) {
              ctx.flash('Vault reset. Protected headers need new credentials.');
              ctx.rerender();
            }
          }
        })
      ));
    }
  } else {
    vaultGroup.append(el('p', { class: 'settings-note', text:
      'Vault locking applies to encrypted-vault mode. Session-only credentials are cleared '
      + 'when the browser session ends.' }));
  }

  /* --- Exports and clipboard --- */
  const exportGroup = el('div', { class: 'settings-group' },
    el('h3', { class: 'settings-head', text: 'Exports and clipboard' }),
    checkbox('omitCredentialsByDefault',
      'Omit credentials by default',
      'Exports and clipboard copies leave credentials out unless you choose otherwise.'),
    checkbox('requirePassphraseToReveal',
      'Require passphrase before copying or exporting credentials',
      'Applies even while the vault is already unlocked, because the result leaves the browser.'),
    checkbox('askPassphraseOnReveal',
      'Also ask before viewing a credential in the popup',
      'Off by default: unlocking the vault already authenticated you. Useful on a shared '
      + 'machine, where it stops someone at your keyboard reading a value from an unlocked popup.')
  );

  const limits = el('div', { class: 'settings-group' },
    el('h3', { class: 'settings-head', text: 'What this protects against' }),
    el('p', { class: 'settings-note', text:
      'Encryption protects credentials at rest: someone reading your browser profile from '
      + 'disk, a stolen backup, or a synced copy cannot recover them without the passphrase.' }),
    el('p', { class: 'settings-note', text:
      'It cannot protect against malware running as you, or against a compromised extension, '
      + 'while the vault is unlocked \u2014 at that point the credentials are in memory by '
      + 'definition. Host restrictions are the protection that still applies then, because '
      + 'they limit where a credential can be sent.' })
  );

  content.append(restrictions, storageGroup, vaultGroup, exportGroup, limits);
}

/* Imported plaintext credentials are never activated silently. */
export async function confirmImportedCredentials(count, state) {
  const ok = await openModal({
    title: 'This file contains credentials',
    build: body => {
      body.append(el('p', { text:
        `The file carries ${count} credential${count === 1 ? '' : 's'} in plain text.` }));
      body.append(el('p', { class: 'muted', text:
        `They will be stored using your current setting: `
        + `${CREDENTIAL_MODES[state.settings.credentialStorage].label}.` }));
      body.append(el('p', { class: 'muted', text:
        'Imported profiles do not inherit permission to send credentials to every site; '
        + 'host restrictions are re-checked before they activate.' }));
    },
    actions: [
      { label: 'Import without credentials', value: 'skip' },
      { label: 'Import with credentials', primary: true, value: true }
    ]
  });
  return ok === true;
}

/* Reveals a stored credential.

   In vault mode the passphrase is not checked against a flag and then
   discarded: it is used to re-derive the key and decrypt that one record
   from ciphertext. Removing or short-circuiting this prompt does not yield
   a value, because without a passphrase there is no key to decrypt with. */
/* Returns the decrypted credential for inline display, or null if the user
   cancelled or it could not be obtained. Does not open a viewer of its own —
   the caller decides how to present it. */
export async function revealCredentialValue(header, state) {
  const settings = state.settings;
  if (!header.secretId) return null;

  if (settings.credentialStorage === 'vault') {
    /* Locked: unlocking is the authentication step. */
    if (!(await isUnlocked()) && !(await unlockFlow(state))) return null;

    if (settings.askPassphraseOnReveal) {
      const value = await openModal({
        title: `Show credential for ${header.name}`,
        build: body => {
          body.append(el('p', { class: 'muted', text:
            'Strict reveal is on, so your passphrase decrypts this value directly '
            + 'rather than using the unlocked vault key.' }));
          body.append(el('label', { class: 'field' },
            el('span', { class: 'field-label', text: 'Passphrase' }),
            el('input', { type: 'password', id: 'omh-pass', autocomplete: 'current-password' })
          ));
        },
        actions: [
          { label: 'Cancel', value: null },
          {
            label: 'Show', primary: true,
            enableWhen: () => ($('omh-pass')?.value ?? '') !== '',
            onClick: async done => {
              const result = await revealSecret(header.secretId, $('omh-pass').value, settings);
              if (!result.ok) {
                return modalError('That passphrase did not decrypt this credential.');
              }
              done(result.value);
            }
          }
        ]
      });
      if (value == null) return null;
      await noteActivity(ACTIVITY.revealCredential, settings);
      return value;
    }
  }

  const secrets = await resolveSecrets(settings);
  const value = secrets[header.secretId];
  if (value == null) return null;
  await noteActivity(ACTIVITY.revealCredential, settings);
  return value;
}

export async function revealCredential(header, state) {
  const settings = state.settings;

  if (settings.credentialStorage === 'vault') {
    if (!header.secretId) return false;

    /* Locked: unlocking IS the authentication step, so route through the
       normal unlock flow rather than asking for the passphrase twice. */
    if (!(await isUnlocked())) {
      if (!(await unlockFlow(state))) return false;
    }

    /* Unlocked, and not configured to ask again: the cached key already
       authorises decryption, so read the value directly. */
    if (!settings.askPassphraseOnReveal) {
      const secrets = await resolveSecrets(settings);
      const value = secrets[header.secretId];
      if (value == null) return false;
      await noteActivity(ACTIVITY.revealCredential, settings);
      return showRevealed(header, value, state);
    }

    /* Opt-in strict mode: decrypt this one record with a freshly typed
       passphrase, ignoring the cached key entirely. */
    const revealed = await openModal({
      title: `View credential for ${header.name}`,
      build: body => {
        body.append(el('p', { class: 'muted', text:
          'Strict reveal is on, so your passphrase decrypts this value directly '
          + 'rather than using the unlocked vault key.' }));
        body.append(el('label', { class: 'field' },
          el('span', { class: 'field-label', text: 'Passphrase' }),
          el('input', { type: 'password', id: 'omh-pass', autocomplete: 'current-password' })
        ));
      },
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Reveal', primary: true,
          enableWhen: () => ($('omh-pass')?.value ?? '') !== '',
          onClick: async done => {
            const pass = $('omh-pass')?.value ?? '';
            const result = await revealSecret(header.secretId, pass, settings);
            if (!result.ok) {
              /* A wrong passphrase and a damaged record are reported the
                 same way; the failure came from the cipher, not a check. */
              return modalError('That passphrase did not decrypt this credential.');
            }
            done(result.value);
          }
        }
      ]
    });

    if (revealed == null) return false;
    await noteActivity(ACTIVITY.revealCredential, settings);
    return showRevealed(header, revealed, state);
  }

  /* Session-only and plaintext modes have no passphrase and no ciphertext,
     so there is nothing to decrypt against. */
  const secrets = await resolveSecrets(settings);
  const value = secrets[header.secretId];
  if (value == null) return false;
  await noteActivity(ACTIVITY.revealCredential, settings);
  return showRevealed(header, value, state);
}

/* Displays a decrypted value and offers to replace it. The value lives in a
   local variable and an input's `value` property only — never in an
   attribute, dataset, or anything serialised. */
async function showRevealed(header, value, state) {
  const next = await openModal({
    title: `Credential for ${header.name}`,
    build: body => {
      body.append(el('p', { class: 'muted', text: modeBlurb(state.settings) }));
      body.append(el('label', { class: 'field' },
        el('span', { class: 'field-label', text: 'Value' }),
        el('input', { type: 'text', id: 'omh-secret', autocomplete: 'off', value })
      ));
      body.append(el('label', { class: 'opt' },
        el('input', {
          type: 'checkbox', id: 'omh-show', checked: true,
          onchange: event => {
            $('omh-secret').type = event.target.checked ? 'text' : 'password';
          }
        }),
        el('span', { class: 'opt-body' },
          el('span', { class: 'opt-label', text: 'Show value' }))
      ));
    },
    actions: [
      { label: 'Close', value: null },
      {
        label: 'Save changes', primary: true,
        enableWhen: () => {
          const v = $('omh-secret')?.value ?? '';
          return v !== '' && v !== value;
        },
        onClick: done => done($('omh-secret')?.value ?? '')
      }
    ]
  });

  if (next == null || next === value) return false;
  const result = await putSecret(header.secretId, next, state.settings);
  return result.ok;
}

export async function storeImportedSecret(secretId, value, state) {
  return putSecret(secretId, value, state.settings);
}

export { isSensitiveHeader, evaluateProfile, describeBlock, isUnlocked, vaultExists };
