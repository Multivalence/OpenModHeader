/* OpenModHeader — credential-security policy.

   Pure functions only: no storage, no crypto, no browser APIs. Everything
   here is decidable from a profile object plus the settings, which keeps it
   directly unit-testable and safe to import from any context. */

/* Headers whose values are credentials. Compared case-insensitively.
   To recognise another header, add one lowercase entry here — nothing else
   in the codebase hardcodes a header name. */
export const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token'
]);

/* Substring patterns catch vendor-specific variants such as
   `X-Acme-Api-Key` or `X-Session-Token` that the exact list cannot enumerate. */
export const SENSITIVE_HEADER_PATTERNS = [
  /(^|-)api[-_]?key$/i,
  /(^|-)auth(orization)?[-_]?token$/i,
  /(^|-)access[-_]?token$/i,
  /(^|-)session[-_]?token$/i,
  /(^|-)refresh[-_]?token$/i,
  /(^|-)secret$/i
];

/* Cookie names that carry session or auth state. Same extensible shape as the
   header list: add a lowercase entry and everything else follows. */
export const SENSITIVE_COOKIE_NAMES = new Set([
  'session', 'sessionid', 'session_id', 'sess', 'sid',
  'auth', 'authtoken', 'auth_token', 'token', 'access_token', 'refresh_token',
  'jwt', 'bearer', 'csrf', 'csrftoken', 'csrf_token', 'xsrf', 'xsrf-token',
  'remember_token', 'remember_me', 'connect.sid', 'jsessionid', 'phpsessid',
  'asp.net_sessionid', 'laravel_session', '_session_id'
]);

export const SENSITIVE_COOKIE_PATTERNS = [
  /sess(ion)?[-_]?id$/i,
  /(^|[-_])token$/i,
  /(^|[-_])auth$/i,
  /(^|[-_])jwt$/i,
  /(^|[-_])secret$/i,
  /(^|[-_])key$/i,
  /^_?csrf/i,
  /^_?xsrf/i
];

export const CREDENTIAL_MODES = {
  session: {
    label: 'Session only',
    blurb: 'Credentials must be entered again after restarting the browser.'
  },
  vault: {
    label: 'Encrypted vault',
    blurb: 'Credentials are stored encrypted and unlocked with a passphrase.'
  },
  plaintext: {
    label: 'Persistent plaintext \u2014 not recommended',
    blurb: 'Credentials are stored unencrypted in the browser profile.'
  }
};

export const DEFAULT_SETTINGS = {
  /* Host restrictions */
  requireExplicitHosts: true,
  warnOnInsecureHosts: true,

  /* Credential storage */
  credentialStorage: 'session',
  plaintextAcknowledged: false,

  /* Vault locking */
  lockOnRestart: true,
  lockAfterMinutes: 15,
  disableAutoLock: false,

  /* Exports and clipboard */
  omitCredentialsByDefault: true,
  requirePassphraseToReveal: true,

  /* Off by default. Unlocking the vault is the authentication step; while it
     is unlocked the key is cached, so asking again is a speed bump against
     someone at your keyboard rather than a cryptographic control. Auto-lock
     is the real answer to an unattended machine. Shared-machine users can
     still turn this on. */
  askPassphraseOnReveal: false
};

export const LOCK_MINUTES_CHOICES = [1, 5, 15, 30, 60, 240];

/* ---------------------------------------------------------------- *
 * Detection
 * ---------------------------------------------------------------- */

/* A header is sensitive if the user marked it so, or if its name matches
   the known set or patterns. The explicit flag can only add sensitivity,
   never remove it, so a user cannot accidentally downgrade Authorization. */
export function isSensitiveHeaderName(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return false;
  if (SENSITIVE_HEADER_NAMES.has(key)) return true;
  return SENSITIVE_HEADER_PATTERNS.some(pattern => pattern.test(key));
}

/* A cookie is a credential if its name matches the known set or patterns, or
   the user marked it. As with headers, the flag can only add protection. */
export function isSensitiveCookieName(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return false;
  if (SENSITIVE_COOKIE_NAMES.has(key)) return true;
  return SENSITIVE_COOKIE_PATTERNS.some(pattern => pattern.test(key));
}

export function isSensitiveCookie(cookie) {
  if (!cookie) return false;
  if (cookie.sensitive === true) return true;
  return isSensitiveCookieName(cookie.name);
}

export function sensitiveCookiesOf(profile) {
  return (profile.cookies || []).filter(isSensitiveCookie);
}

export function isSensitiveHeader(header) {
  if (!header) return false;
  if (header.sensitive === true) return true;
  return isSensitiveHeaderName(header.name);
}

/* Cookies edited through the cookie editor compose the Cookie / Set-Cookie
   headers, so they are credential-bearing by construction. */
export function profileHasSensitiveContent(profile) {
  const headers = [...(profile.requestHeaders || []), ...(profile.responseHeaders || [])];
  if (headers.some(isSensitiveHeader)) return true;
  /* Only credential-bearing cookies count. A `locale` cookie is not a secret,
     and treating every cookie as one would force host filters and vault entry
     on harmless values. Anything unrecognised can be marked by hand. */
  return (profile.cookies || []).some(c => c.enabled && c.name.trim() && isSensitiveCookie(c));
}

export function sensitiveHeadersOf(profile) {
  return [...(profile.requestHeaders || []), ...(profile.responseHeaders || [])]
    .filter(isSensitiveHeader);
}

/* ---------------------------------------------------------------- *
 * Host restrictions
 * ---------------------------------------------------------------- */

const WILDCARD_ONLY = /^(\*|\*:\/\/\*\/\*|<all_urls>|https?:\/\/\*\/?\*?|\/|\.\*|\^?\.\*\$?)$/i;

/* A filter counts as a host restriction only if it actually narrows traffic.
   `*` and `<all_urls>` match everything, so they are explicitly rejected —
   otherwise the protection would be trivially bypassable by typing a star. */
export function isMeaningfulHostFilter(filter) {
  if (!filter || !filter.enabled) return false;
  if (filter.type !== 'urlContains' && filter.type !== 'urlRegex') return false;

  const value = String(filter.value ?? '').trim();
  if (!value) return false;
  if (WILDCARD_ONLY.test(value)) return false;

  /* A regex of only wildcard/anchor metacharacters restricts nothing. */
  if (filter.type === 'urlRegex' && !/[a-z0-9]/i.test(value.replace(/\\[a-z]/gi, ''))) {
    return false;
  }
  return true;
}

export function hostFiltersOf(profile) {
  return (profile.filters || []).filter(isMeaningfulHostFilter);
}

export function hasHostRestriction(profile) {
  return hostFiltersOf(profile).length > 0;
}

/* Best-effort scheme check. A `urlContains` value of `http://dev.local`
   is plainly insecure; a bare `api.example.com` is scheme-agnostic and
   does not warrant a warning. */
export function insecureHostFilters(profile) {
  return hostFiltersOf(profile)
    .filter(f => /(^|[^s])http:\/\//i.test(f.value))
    .filter(f => !/(localhost|127\.0\.0\.1|\[::1\]|\.local\b)/i.test(f.value))
    .map(f => f.value.trim());
}

/* ---------------------------------------------------------------- *
 * Activation gate
 * ---------------------------------------------------------------- */

export const BLOCK_REASONS = {
  globalSensitive: 'globalSensitive',
  missingCredential: 'missingCredential',
  vaultLocked: 'vaultLocked'
};

/* The single decision point for whether a profile's sensitive rules may be
   applied. Both background engines call this, so Chromium and Firefox can
   never disagree about what is permitted. */
export function evaluateProfile(profile, settings, { unlocked = true, resolvedIds = null } = {}) {
  const sensitive = sensitiveHeadersOf(profile);
  const hasSensitive = sensitive.length > 0 || profileHasSensitiveContent(profile);

  const result = {
    hasSensitive,
    blocked: false,
    reasons: [],
    warnings: [],
    missingSecretIds: [],
    unmanagedHeaders: []
  };

  if (!hasSensitive) return result;

  if (settings.requireExplicitHosts
      && !profile.allowGlobalSensitiveHeaders
      && !hasHostRestriction(profile)) {
    result.blocked = true;
    result.reasons.push(BLOCK_REASONS.globalSensitive);
  }

  if (settings.warnOnInsecureHosts) {
    const insecure = insecureHostFilters(profile);
    if (insecure.length) result.warnings.push({ type: 'insecureHost', hosts: insecure });
  }

  if (settings.credentialStorage !== 'plaintext' && !unlocked) {
    result.blocked = true;
    result.reasons.push(BLOCK_REASONS.vaultLocked);
  }

  /* Fail closed. Two distinct cases both block the profile:
       - a header referencing a secret that will not resolve, and
       - a credential-bearing header with no secretId at all, which can arise
         from a hand-edited file or partially migrated data. The second case
         must never fall through to sending whatever inline value it carries. */
  if (resolvedIds) {
    const needing = [
      ...sensitive
        .filter(h => h.enabled && h.name.trim())
        .filter(h => h.operation !== 'remove'),
      ...sensitiveCookiesOf(profile).filter(c => c.enabled && c.name.trim())
    ];

    const unresolvable = needing.filter(h => h.secretId && !resolvedIds.has(h.secretId));
    const unmanaged = needing.filter(h => !h.secretId);

    if (unresolvable.length || unmanaged.length) {
      result.missingSecretIds = [...new Set(unresolvable.map(h => h.secretId))];
      result.unmanagedHeaders = unmanaged.map(h => h.name);
      result.blocked = true;
      result.reasons.push(BLOCK_REASONS.missingCredential);
    }
  }

  return result;
}

export function describeBlock(reasons) {
  if (reasons.includes(BLOCK_REASONS.globalSensitive)) {
    return 'Add a host filter before this credential can be used.';
  }
  if (reasons.includes(BLOCK_REASONS.vaultLocked)) {
    return 'Unlock the vault to use this credential.';
  }
  if (reasons.includes(BLOCK_REASONS.missingCredential)) {
    return 'Enter the credential to activate this profile.';
  }
  return '';
}

export function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!Object.hasOwn(raw, key)) continue;
    const fallback = DEFAULT_SETTINGS[key];
    const value = raw[key];
    if (typeof fallback === 'boolean') out[key] = !!value;
    else if (typeof fallback === 'number') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out[key] = Math.min(Math.max(Math.round(n), 1), 1440);
    } else if (key === 'credentialStorage') {
      if (Object.hasOwn(CREDENTIAL_MODES, value)) out[key] = value;
    }
  }

  /* Plaintext mode requires an explicit acknowledgement; without one, fall
     back to the safe default rather than honouring an imported setting. */
  if (out.credentialStorage === 'plaintext' && !out.plaintextAcknowledged) {
    out.credentialStorage = DEFAULT_SETTINGS.credentialStorage;
  }
  return out;
}
