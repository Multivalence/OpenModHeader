/* OpenModHeader — shared state model and rule compiler.
   Byte-identical in the chrome/ and firefox/ builds. */

import { api } from './common-api.js';
import { isSensitiveHeader, normalizeSettings, DEFAULT_SETTINGS } from './security.js';

export { api };

export const SCHEMA_VERSION = 3;

export const RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media',
  'websocket', 'other'
];

/* Gecko recognises everything above plus these. Chrome rejects an entire
   rule if it sees a type it does not know, so they stay separate and only
   the Firefox engine accepts them. */
export const GECKO_RESOURCE_TYPES = [
  'beacon', 'imageset', 'object_subrequest', 'speculative',
  'web_manifest', 'xml_dtd', 'xslt'
];

export const PROFILE_COLORS = [
  '#B4470E', '#0D6E6B', '#3F3FBF', '#A81E1E',
  '#0B6E3F', '#6D28D9', '#0369A1', '#8A6212'
];

export const OPERATIONS = ['set', 'append', 'remove'];

export const SECTIONS = [
  'requestHeaders', 'responseHeaders', 'cookies', 'csp', 'redirects', 'filters'
];

/* Chrome only allows `append` on this set of request headers. */
export const APPENDABLE_REQUEST_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'access-control-request-headers',
  'cache-control', 'connection', 'content-language', 'cookie', 'forwarded',
  'if-match', 'if-none-match', 'keep-alive', 'range', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'user-agent', 'via', 'want-digest',
  'x-forwarded-for'
]);

export const FILTER_TYPES = {
  urlContains: { label: 'URL contains', placeholder: 'api.example.com/v2' },
  urlRegex: { label: 'URL matches regex', placeholder: '^https://[a-z]+\\.example\\.com/' },
  excludeUrlContains: { label: 'Exclude URL containing', placeholder: '/healthz' },
  excludeUrlRegex: { label: 'Exclude URL regex', placeholder: '\\.(png|jpe?g|gif)$' },
  excludeDomain: { label: 'Exclude domains', placeholder: 'ads.com, tracker.io' },
  resourceType: { label: 'Resource types', placeholder: 'xmlhttprequest, main_frame' },
  tabId: { label: 'Tab', placeholder: 'tab id', capture: 'tab' },
  windowId: { label: 'Window', placeholder: 'window id', capture: 'window' }
};

export const CSP_MODES = {
  off: 'Leave CSP alone',
  remove: 'Remove CSP entirely',
  replace: 'Replace CSP with the policy below'
};

export const CSP_DIRECTIVES = [
  'default-src', 'script-src', 'script-src-elem', 'style-src', 'style-src-elem',
  'img-src', 'connect-src', 'font-src', 'media-src', 'object-src',
  'frame-src', 'child-src', 'worker-src', 'manifest-src',
  'frame-ancestors', 'base-uri', 'form-action', 'sandbox',
  'report-uri', 'report-to', 'upgrade-insecure-requests'
];

export const SAME_SITE_VALUES = ['', 'Strict', 'Lax', 'None'];

export const REDIRECT_TYPES = {
  contains: { label: 'URL contains', placeholder: 'https://cdn.example.com/app.js' },
  regex: { label: 'URL matches regex', placeholder: '^https://cdn\\.example\\.com/(.*)$' }
};

/* Offered as autocomplete in the header name fields. */
export const COMMON_REQUEST_HEADERS = [
  'Accept', 'Accept-Encoding', 'Accept-Language', 'Authorization', 'Cache-Control',
  'Content-Type', 'Cookie', 'DNT', 'If-Match', 'If-None-Match', 'Origin',
  'Pragma', 'Referer', 'User-Agent', 'X-Api-Key', 'X-Correlation-Id',
  'X-CSRF-Token', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto',
  'X-Requested-With'
];

export const COMMON_RESPONSE_HEADERS = [
  'Access-Control-Allow-Credentials', 'Access-Control-Allow-Headers',
  'Access-Control-Allow-Methods', 'Access-Control-Allow-Origin',
  'Access-Control-Expose-Headers', 'Cache-Control', 'Content-Disposition',
  'Content-Security-Policy', 'Content-Type', 'Cross-Origin-Embedder-Policy',
  'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy', 'ETag',
  'Location', 'Permissions-Policy', 'Referrer-Policy', 'Set-Cookie',
  'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options'
];

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function blankHeader(name = '', value = '') {
  return {
    id: uid(), enabled: true, operation: 'set', name, value, comment: '',
    /* Set when the header is credential-bearing. The value then lives in the
       secret store under secretId and never inside the profile object. */
    sensitive: false, secretId: null, requiresCredential: false
  };
}

export function blankSecretId() {
  return `secret-${uid()}`;
}

export function blankCookie() {
  return {
    id: uid(), enabled: true, target: 'request', name: '', value: '',
    path: '', domain: '', maxAge: '', secure: false, httpOnly: false,
    sameSite: '', comment: ''
  };
}

export function blankCspDirective(name = '', value = '') {
  return { id: uid(), enabled: true, name, value };
}

export function blankRedirect() {
  return { id: uid(), enabled: true, type: 'contains', from: '', to: '', comment: '' };
}

export function blankFilter(type = 'urlContains') {
  return { id: uid(), enabled: true, type, value: '' };
}

export function blankCsp() {
  return { mode: 'off', reportOnly: false, directives: [] };
}

export function blankProfile(index = 1, colorIndex = 0) {
  return {
    id: uid(),
    name: `Profile ${index}`,
    color: PROFILE_COLORS[colorIndex % PROFILE_COLORS.length],
    enabled: true,
    /* Per-profile escape hatch for the global-host requirement. Deliberately
       per profile so accepting the risk once does not disable the protection
       everywhere. */
    allowGlobalSensitiveHeaders: false,
    requestHeaders: [blankHeader()],
    responseHeaders: [],
    cookies: [],
    cookieMode: 'merge',
    csp: blankCsp(),
    redirects: [],
    filters: []
  };
}

export function defaultState() {
  const profile = blankProfile(1, 0);
  return {
    version: SCHEMA_VERSION,
    paused: false,
    activeProfileId: profile.id,
    settings: { ...DEFAULT_SETTINGS },
    profiles: [profile],
    /* Non-secret metadata only: labels and reference counts, never values. */
    secretsMeta: {}
  };
}

/* ---------------------------------------------------------------- *
 * Normalisation — accepts anything and returns a valid state
 * ---------------------------------------------------------------- */

export function normalize(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;

  const profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
  const clean = profiles.map((p, i) => normalizeProfile(p, i)).filter(Boolean);
  if (!clean.length) return base;

  const activeProfileId = clean.some(p => p.id === raw.activeProfileId)
    ? raw.activeProfileId
    : clean[0].id;

  return {
    version: SCHEMA_VERSION,
    paused: !!raw.paused,
    activeProfileId,
    settings: normalizeSettings(raw.settings),
    profiles: clean,
    secretsMeta: normalizeSecretsMeta(raw.secretsMeta, clean)
  };
}

function normalizeSecretsMeta(raw, profiles) {
  const referenced = new Set(collectSecretIds({ profiles }));
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [id, meta] of Object.entries(raw)) {
      if (!referenced.has(id)) continue;   // drop orphaned metadata
      out[id] = {
        label: str(meta?.label).slice(0, 80),
        createdAt: Number(meta?.createdAt) || Date.now()
      };
    }
  }
  for (const id of referenced) {
    if (!out[id]) out[id] = { label: '', createdAt: Date.now() };
  }
  return out;
}

/* Every secret id referenced by any profile. Used for orphan pruning and to
   decide whether deleting a profile may delete a shared secret. */
export function collectSecretIds(state) {
  const ids = [];
  for (const profile of state.profiles || []) {
    for (const list of [profile.requestHeaders, profile.responseHeaders]) {
      for (const header of list || []) {
        if (header.secretId) ids.push(header.secretId);
      }
    }
  }
  return [...new Set(ids)];
}

export function secretRefCount(state, secretId) {
  let count = 0;
  for (const profile of state.profiles || []) {
    for (const list of [profile.requestHeaders, profile.responseHeaders]) {
      for (const header of list || []) {
        if (header.secretId === secretId) count++;
      }
    }
  }
  return count;
}

function str(value) {
  return String(value ?? '');
}

function normalizeProfile(p, i) {
  if (!p || typeof p !== 'object') return null;
  return {
    id: typeof p.id === 'string' && p.id ? p.id : uid(),
    name: typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 60) : `Profile ${i + 1}`,
    color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : PROFILE_COLORS[i % PROFILE_COLORS.length],
    enabled: p.enabled !== false,
    allowGlobalSensitiveHeaders: p.allowGlobalSensitiveHeaders === true,
    requestHeaders: normalizeHeaders(p.requestHeaders ?? p.headers),
    responseHeaders: normalizeHeaders(p.responseHeaders ?? p.respHeaders),
    cookies: normalizeCookies(p.cookies),
    cookieMode: p.cookieMode === 'replace' ? 'replace' : 'merge',
    csp: normalizeCsp(p.csp),
    redirects: normalizeRedirects(p.redirects),
    filters: normalizeFilters(p.filters)
  };
}

function normalizeHeaders(list) {
  if (!Array.isArray(list)) return [];
  return list.map(h => {
    if (!h || typeof h !== 'object') return null;
    return {
      id: typeof h.id === 'string' && h.id ? h.id : uid(),
      enabled: h.enabled !== false,
      operation: OPERATIONS.includes(h.operation) ? h.operation : 'set',
      name: str(h.name).trim(),
      /* A sensitive header keeps no inline value: it is either resolved from
         the secret store at rule-build time, or the profile stays locked. */
      value: h.secretId ? '' : str(h.value),
      comment: str(h.comment),
      sensitive: h.sensitive === true || isSensitiveHeader({ name: str(h.name) }),
      secretId: typeof h.secretId === 'string' && h.secretId ? h.secretId : null,
      requiresCredential: h.requiresCredential === true
    };
  }).filter(Boolean);
}

function normalizeCookies(list) {
  if (!Array.isArray(list)) return [];
  return list.map(c => {
    if (!c || typeof c !== 'object') return null;
    return {
      id: typeof c.id === 'string' && c.id ? c.id : uid(),
      enabled: c.enabled !== false,
      target: c.target === 'response' ? 'response' : 'request',
      name: str(c.name).trim(),
      value: str(c.value),
      path: str(c.path).trim(),
      domain: str(c.domain).trim(),
      maxAge: str(c.maxAge).trim(),
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: SAME_SITE_VALUES.includes(c.sameSite) ? c.sameSite : '',
      comment: str(c.comment)
    };
  }).filter(Boolean);
}

function normalizeCsp(csp) {
  if (!csp || typeof csp !== 'object') return blankCsp();
  const directives = Array.isArray(csp.directives) ? csp.directives : [];
  return {
    mode: Object.hasOwn(CSP_MODES, csp.mode) ? csp.mode : 'off',
    reportOnly: !!csp.reportOnly,
    directives: directives.map(d => {
      if (!d || typeof d !== 'object') return null;
      return {
        id: typeof d.id === 'string' && d.id ? d.id : uid(),
        enabled: d.enabled !== false,
        name: str(d.name).trim(),
        value: str(d.value).trim()
      };
    }).filter(Boolean)
  };
}

function normalizeRedirects(list) {
  if (!Array.isArray(list)) return [];
  return list.map(r => {
    if (!r || typeof r !== 'object') return null;
    return {
      id: typeof r.id === 'string' && r.id ? r.id : uid(),
      enabled: r.enabled !== false,
      type: Object.hasOwn(REDIRECT_TYPES, r.type) ? r.type : 'contains',
      from: str(r.from).trim(),
      to: str(r.to).trim(),
      comment: str(r.comment)
    };
  }).filter(Boolean);
}

function normalizeFilters(list) {
  if (!Array.isArray(list)) return [];
  return list.map(f => {
    if (!f || typeof f !== 'object') return null;
    return {
      id: typeof f.id === 'string' && f.id ? f.id : uid(),
      enabled: f.enabled !== false,
      type: Object.hasOwn(FILTER_TYPES, f.type) ? f.type : 'urlContains',
      value: str(f.value)
    };
  }).filter(Boolean);
}

export async function loadState() {
  const stored = await api.storage.local.get('state');
  return normalize(stored.state);
}

/* ---------------------------------------------------------------- *
 * Schema migration
 * ---------------------------------------------------------------- */

/* Detects v2-and-earlier profiles that hold credentials inline. Returns the
   headers that need migrating without ever copying their values. */
export function findLegacySensitiveHeaders(raw) {
  const found = [];
  for (const profile of raw?.profiles || []) {
    for (const key of ['requestHeaders', 'responseHeaders']) {
      for (const header of profile[key] || []) {
        if (header.secretId) continue;
        if (!isSensitiveHeader(header)) continue;
        if (!String(header.value ?? '')) continue;
        found.push({ profileId: profile.id, profileName: profile.name, section: key, headerId: header.id, name: header.name });
      }
    }
  }
  return found;
}

export function needsMigration(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if ((Number(raw.version) || 0) < SCHEMA_VERSION) return true;
  return findLegacySensitiveHeaders(raw).length > 0;
}

/* Moves inline credentials out of the profile and into the secret store.
   Idempotent: a header that already has a secretId is left alone, so an
   interrupted migration can simply be run again.

   Returns the rewritten state plus the extracted values; the caller decides
   which store they go into, so this function never picks a storage mode. */
export function migrateToV3(raw) {
  const extracted = {};
  const state = normalize(raw);

  for (const profile of state.profiles) {
    for (const key of ['requestHeaders', 'responseHeaders']) {
      for (const header of profile[key]) {
        if (!isSensitiveHeader(header)) continue;
        if (header.secretId) continue;              // already migrated

        const value = String(header.value ?? '');
        header.sensitive = true;
        if (header.operation === 'remove') continue; // no credential involved

        const secretId = blankSecretId();
        header.secretId = secretId;
        header.value = '';
        header.requiresCredential = value === '';
        if (value) extracted[secretId] = value;

        state.secretsMeta[secretId] = {
          label: `${profile.name} \u00B7 ${header.name}`,
          createdAt: Date.now()
        };
      }
    }
  }

  state.version = SCHEMA_VERSION;
  return { state, extracted, migrated: Object.keys(extracted).length };
}

export async function saveState(state) {
  await api.storage.local.set({ state });
}

/* ---------------------------------------------------------------- *
 * Planning — profile to a browser-agnostic set of operations
 * ---------------------------------------------------------------- */

function isLive(item) {
  return item.enabled && item.name.trim().length > 0;
}

export function serializeCookie(cookie) {
  const parts = [`${cookie.name.trim()}=${cookie.value}`];
  if (cookie.path) parts.push(`Path=${cookie.path}`);
  if (cookie.domain) parts.push(`Domain=${cookie.domain}`);
  if (cookie.maxAge) parts.push(`Max-Age=${cookie.maxAge}`);
  if (cookie.sameSite) parts.push(`SameSite=${cookie.sameSite}`);
  if (cookie.secure) parts.push('Secure');
  if (cookie.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

export function buildCspPolicy(csp) {
  return csp.directives
    .filter(d => d.enabled && d.name.trim())
    .map(d => `${d.name.trim()} ${d.value}`.trim())
    .join('; ');
}

function toOp(header) {
  return {
    name: header.name.trim(),
    value: header.value,
    operation: header.operation || 'set'
  };
}

/* Turns one profile into the header operations it implies, folding in the
   cookie editor and the CSP editor. Request cookies come back separately
   because Firefox can merge them properly against the real header while
   Chrome can only append. */
/* `resolve(secretId)` returns the credential string or null/undefined.
   A sensitive header whose credential cannot be resolved is dropped
   entirely rather than sent empty — the fail-closed rule. Dropped ops are
   reported so callers can mark the profile as needing a credential. */
export function planProfile(profile, resolve = null) {
  const missing = [];

  const withSecret = header => {
    if (header.operation === 'remove') return toOp(header);

    /* A credential-bearing header with no secretId is unmanaged: its inline
       value is dropped rather than sent, so hand-edited or partially
       migrated data cannot leak a credential. */
    if (!header.secretId) {
      if (isSensitiveHeader(header)) {
        missing.push(`unmanaged:${header.name.trim().toLowerCase()}`);
        return null;
      }
      return toOp(header);
    }

    const value = resolve ? resolve(header.secretId) : undefined;
    if (value == null || value === '') {
      missing.push(header.secretId);
      return null;
    }
    return { name: header.name.trim(), value, operation: header.operation || 'set' };
  };

  const requestOps = profile.requestHeaders.filter(isLive).map(withSecret).filter(Boolean);
  const responseOps = profile.responseHeaders.filter(isLive).map(withSecret).filter(Boolean);

  const cookies = profile.cookies || [];
  const requestCookies = cookies
    .filter(c => c.enabled && c.target === 'request' && c.name.trim())
    .map(c => ({ name: c.name.trim(), value: c.value }));

  for (const cookie of cookies.filter(c => c.enabled && c.target === 'response' && c.name.trim())) {
    responseOps.push({ name: 'Set-Cookie', value: serializeCookie(cookie), operation: 'append' });
  }

  const csp = profile.csp || blankCsp();
  if (csp.mode === 'remove') {
    responseOps.push({ name: 'Content-Security-Policy', value: '', operation: 'remove' });
    responseOps.push({ name: 'Content-Security-Policy-Report-Only', value: '', operation: 'remove' });
  } else if (csp.mode === 'replace') {
    const policy = buildCspPolicy(csp);
    if (policy) {
      responseOps.push({
        name: csp.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy',
        value: policy,
        operation: 'set'
      });
    }
  }

  const redirects = (profile.redirects || [])
    .filter(r => r.enabled && r.from.trim() && r.to.trim());

  return {
    requestOps,
    responseOps,
    requestCookies,
    cookieMode: profile.cookieMode === 'replace' ? 'replace' : 'merge',
    redirects,
    missingSecretIds: [...new Set(missing)]
  };
}

export function profileIsActive(profile, resolve = null) {
  const plan = planProfile(profile, resolve);
  return plan.requestOps.length > 0
    || plan.responseOps.length > 0
    || plan.requestCookies.length > 0
    || plan.redirects.length > 0;
}

export function countActiveHeaders(state, resolve = null) {
  if (state.paused) return 0;
  return state.profiles.reduce((total, profile) => {
    if (!profile.enabled) return total;
    const plan = planProfile(profile, resolve);
    return total
      + plan.requestOps.length
      + plan.responseOps.length
      + (plan.requestCookies.length ? 1 : 0)
      + plan.redirects.length;
  }, 0);
}

/* ---------------------------------------------------------------- *
 * Filters
 * ---------------------------------------------------------------- */

function splitList(value) {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function parseFilters(profile, knownTypes) {
  const live = (profile.filters || []).filter(f => f.enabled && f.value.trim());
  const pick = type => live.filter(f => f.type === type).map(f => f.value.trim());
  const ints = type => live.filter(f => f.type === type)
    .flatMap(f => splitList(f.value))
    .map(Number)
    .filter(Number.isInteger);

  const types = live.filter(f => f.type === 'resourceType')
    .flatMap(f => splitList(f.value).map(t => t.toLowerCase()))
    .filter(t => (knownTypes || RESOURCE_TYPES).includes(t));

  return {
    contains: pick('urlContains'),
    regexes: pick('urlRegex'),
    excludeContains: pick('excludeUrlContains'),
    excludeRegexes: pick('excludeUrlRegex'),
    excludeDomains: live.filter(f => f.type === 'excludeDomain')
      .flatMap(f => splitList(f.value).map(d => d.toLowerCase())),
    types: [...new Set(types)],
    tabIds: [...new Set(ints('tabId'))],
    windowIds: [...new Set(ints('windowId'))]
  };
}

export function hasTabScope(profile) {
  const parsed = parseFilters(profile);
  return parsed.tabIds.length > 0 || parsed.windowIds.length > 0;
}
