/* OpenModHeader — shared state model and rule compiler.
   Imported by the background script and the popup on every browser.
   This file is byte-identical in the chrome/ and firefox/ builds. */

/* Firefox exposes promise-based `browser.*`; Chrome exposes `chrome.*`,
   which also returns promises for every API this extension touches. */
export const api = globalThis.browser ?? globalThis.chrome;

export const RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media',
  'websocket', 'other'
];

/* Gecko recognises everything above plus these. Chrome rejects an entire
   rule if it sees a type it does not know, so they stay in a separate list
   and only the Firefox engine accepts them. */
export const GECKO_RESOURCE_TYPES = [
  'beacon', 'imageset', 'object_subrequest', 'speculative',
  'web_manifest', 'xml_dtd', 'xslt'
];

export const PROFILE_COLORS = [
  '#B4470E', '#0D6E6B', '#3F3FBF', '#A81E1E',
  '#0B6E3F', '#6D28D9', '#0369A1', '#8A6212'
];

export const FILTER_TYPES = {
  urlContains: {
    label: 'URL contains',
    placeholder: 'api.example.com/v2'
  },
  urlRegex: {
    label: 'URL matches regex',
    placeholder: '^https://[a-z]+\\.example\\.com/.*'
  },
  excludeDomain: {
    label: 'Exclude domains',
    placeholder: 'analytics.com, ads.example.com'
  },
  resourceType: {
    label: 'Resource types',
    placeholder: 'xmlhttprequest, main_frame'
  }
};

export const OPERATIONS = ['set', 'append', 'remove'];

/* Chrome only allows `append` on this set of request headers. Anything else
   is rejected by the rule engine, so the popup warns before you save. */
export const APPENDABLE_REQUEST_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'access-control-request-headers',
  'cache-control', 'connection', 'content-language', 'cookie', 'forwarded',
  'if-match', 'if-none-match', 'keep-alive', 'range', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'user-agent', 'via', 'want-digest',
  'x-forwarded-for'
]);

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function blankHeader(name = '', value = '') {
  return { id: uid(), enabled: true, operation: 'set', name, value };
}

export function blankFilter(type = 'urlContains') {
  return { id: uid(), enabled: true, type, value: '' };
}

export function blankProfile(index = 1, colorIndex = 0) {
  return {
    id: uid(),
    name: `Profile ${index}`,
    color: PROFILE_COLORS[colorIndex % PROFILE_COLORS.length],
    enabled: true,
    requestHeaders: [blankHeader()],
    responseHeaders: [],
    filters: []
  };
}

export function defaultState() {
  const profile = blankProfile(1, 0);
  return {
    version: 1,
    paused: false,
    activeProfileId: profile.id,
    profiles: [profile]
  };
}

/* Accepts anything (old versions, hand-edited JSON, partial imports) and
   returns a fully-formed state object. Never throws. */
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
    version: 1,
    paused: !!raw.paused,
    activeProfileId,
    profiles: clean
  };
}

function normalizeProfile(p, i) {
  if (!p || typeof p !== 'object') return null;
  return {
    id: typeof p.id === 'string' && p.id ? p.id : uid(),
    name: typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 60) : `Profile ${i + 1}`,
    color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : PROFILE_COLORS[i % PROFILE_COLORS.length],
    enabled: p.enabled !== false,
    requestHeaders: normalizeHeaders(p.requestHeaders ?? p.headers),
    responseHeaders: normalizeHeaders(p.responseHeaders ?? p.respHeaders),
    filters: normalizeFilters(p.filters)
  };
}

function normalizeHeaders(list) {
  if (!Array.isArray(list)) return [];
  return list.map(h => {
    if (!h || typeof h !== 'object') return null;
    const operation = OPERATIONS.includes(h.operation) ? h.operation : 'set';
    return {
      id: typeof h.id === 'string' && h.id ? h.id : uid(),
      enabled: h.enabled !== false,
      operation,
      name: String(h.name ?? '').trim(),
      value: String(h.value ?? '')
    };
  }).filter(Boolean);
}

function normalizeFilters(list) {
  if (!Array.isArray(list)) return [];
  return list.map(f => {
    if (!f || typeof f !== 'object') return null;
    const type = Object.hasOwn(FILTER_TYPES, f.type) ? f.type : 'urlContains';
    return {
      id: typeof f.id === 'string' && f.id ? f.id : uid(),
      enabled: f.enabled !== false,
      type,
      value: String(f.value ?? '')
    };
  }).filter(Boolean);
}

export async function loadState() {
  const stored = await api.storage.local.get('state');
  return normalize(stored.state);
}

export async function saveState(state) {
  await api.storage.local.set({ state });
}

/* ---------------------------------------------------------------- *
 * Rule compiler: state -> declarativeNetRequest dynamic rules
 * ---------------------------------------------------------------- */

export function activeHeaders(profile) {
  const req = (profile.requestHeaders || []).filter(isLive);
  const res = (profile.responseHeaders || []).filter(isLive);
  return { req, res };
}

function isLive(h) {
  return h.enabled && h.name.trim().length > 0;
}

export function countActiveHeaders(state) {
  if (state.paused) return 0;
  return state.profiles.reduce((total, p) => {
    if (!p.enabled) return total;
    const { req, res } = activeHeaders(p);
    return total + req.length + res.length;
  }, 0);
}

function toHeaderInfo(h) {
  const info = {
    header: h.name.trim().toLowerCase(),
    operation: h.operation || 'set'
  };
  if (info.operation !== 'remove') info.value = String(h.value ?? '');
  return info;
}

function buildConditions(profile) {
  const live = (profile.filters || []).filter(f => f.enabled && f.value.trim());
  const split = v => v.split(',').map(s => s.trim()).filter(Boolean);

  const contains = live.filter(f => f.type === 'urlContains').map(f => f.value.trim());
  const regexes = live.filter(f => f.type === 'urlRegex').map(f => f.value.trim());
  const excluded = live.filter(f => f.type === 'excludeDomain').flatMap(f => split(f.value));
  const types = live.filter(f => f.type === 'resourceType')
    .flatMap(f => split(f.value).map(t => t.toLowerCase()))
    .filter(t => RESOURCE_TYPES.includes(t));

  const base = { resourceTypes: types.length ? [...new Set(types)] : RESOURCE_TYPES };
  if (excluded.length) base.excludedRequestDomains = [...new Set(excluded)];

  const conditions = [];
  for (const value of contains) conditions.push({ ...base, urlFilter: value });
  for (const value of regexes) conditions.push({ ...base, regexFilter: value });
  if (!conditions.length) conditions.push({ ...base });
  return conditions;
}

export function buildRules(state) {
  const rules = [];
  if (state.paused) return rules;

  let id = 1;
  for (const profile of state.profiles) {
    if (!profile.enabled) continue;
    const { req, res } = activeHeaders(profile);
    if (!req.length && !res.length) continue;

    const action = { type: 'modifyHeaders' };
    if (req.length) action.requestHeaders = req.map(toHeaderInfo);
    if (res.length) action.responseHeaders = res.map(toHeaderInfo);

    for (const condition of buildConditions(profile)) {
      rules.push({
        id: id++,
        priority: 1,
        action,
        condition,
        __profile: profile.name
      });
    }
  }
  return rules;
}

/* Strips the bookkeeping field before handing a rule to Chrome. */
export function stripMeta(rule) {
  const { __profile, ...clean } = rule;
  return clean;
}
