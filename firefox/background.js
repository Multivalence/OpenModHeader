/* OpenModHeader — Firefox background event page.

   Firefox keeps blocking webRequest in Manifest V3, so this build edits
   traffic directly in JavaScript. That lets it do three things the Chrome
   build cannot: merge cookies against the real outgoing header, scope URL
   exclusions to a single profile, and keep header capitalisation. */

import {
  api, loadState, saveState, countActiveHeaders,
  planProfile, profileIsActive, parseFilters,
  RESOURCE_TYPES, GECKO_RESOURCE_TYPES
} from './common.js';

const KNOWN_TYPES = [...RESOURCE_TYPES, ...GECKO_RESOURCE_TYPES];

let compiled = [];
let settled = false;
let ready = refresh();

/* tabId -> windowId, so window filters can be resolved synchronously
   inside a blocking listener. */
const tabWindows = new Map();

async function indexTabs() {
  try {
    const tabs = await api.tabs.query({});
    tabWindows.clear();
    for (const tab of tabs) tabWindows.set(tab.id, tab.windowId);
  } catch {
    /* Without tab access, window filters match nothing. */
  }
}

/* ---------------------------------------------------------------- *
 * Compiling profiles into matchers
 * ---------------------------------------------------------------- */

function safeRegexes(patterns) {
  const out = [];
  for (const pattern of patterns) {
    try {
      out.push(new RegExp(pattern));
    } catch {
      /* Half-typed regexes are normal. Skip rather than break the profile. */
    }
  }
  return out;
}

function compileProfile(profile) {
  if (!profileIsActive(profile)) return null;

  const plan = planProfile(profile);
  const parsed = parseFilters(profile, KNOWN_TYPES);

  const regexes = safeRegexes(parsed.regexes);
  const excludeRegexes = safeRegexes(parsed.excludeRegexes);
  const unscoped = !parsed.contains.length && !regexes.length;
  const scopesTabs = parsed.tabIds.length > 0 || parsed.windowIds.length > 0;

  const redirects = plan.redirects.map(redirect => ({
    to: redirect.to,
    test: redirect.type === 'regex' ? safeRegexes([redirect.from])[0] : null,
    needle: redirect.type === 'regex' ? null : redirect.from
  })).filter(r => r.test || r.needle);

  function matches(details) {
    if (parsed.types.length && !parsed.types.includes(details.type)) return false;

    if (scopesTabs) {
      const tabId = details.tabId;
      if (tabId === undefined || tabId < 0) return false;
      const inTab = parsed.tabIds.includes(tabId);
      const inWindow = parsed.windowIds.includes(tabWindows.get(tabId));
      if (!inTab && !inWindow) return false;
    }

    const url = details.url;

    if (parsed.excludeDomains.length) {
      let host = '';
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return false;
      }
      if (parsed.excludeDomains.some(d => host === d || host.endsWith(`.${d}`))) return false;
    }

    if (parsed.excludeContains.some(needle => url.includes(needle))) return false;
    if (excludeRegexes.some(pattern => pattern.test(url))) return false;

    if (unscoped) return true;
    return parsed.contains.some(needle => url.includes(needle))
      || regexes.some(pattern => pattern.test(url));
  }

  return {
    requestOps: plan.requestOps,
    responseOps: plan.responseOps,
    requestCookies: plan.requestCookies,
    cookieMode: plan.cookieMode,
    redirects,
    matches
  };
}

async function refresh() {
  const state = await loadState();
  compiled = state.paused
    ? []
    : state.profiles.filter(p => p.enabled).map(compileProfile).filter(Boolean);
  settled = true;
  await updateBadge(state);
  return state;
}

/* ---------------------------------------------------------------- *
 * Header rewriting
 * ---------------------------------------------------------------- */

function applyOne(headers, op) {
  const name = op.name.trim();
  const lower = name.toLowerCase();

  if (op.operation === 'remove') {
    return headers.filter(h => h.name.toLowerCase() !== lower);
  }

  if (op.operation === 'append') {
    headers.push({ name, value: String(op.value ?? '') });
    return headers;
  }

  const existing = headers.find(h => h.name.toLowerCase() === lower);
  if (existing) {
    existing.value = String(op.value ?? '');
    delete existing.binaryValue;
  } else {
    headers.push({ name, value: String(op.value ?? '') });
  }
  return headers;
}

/* Merges named cookies into whatever the browser was already sending,
   overwriting same-name entries instead of duplicating them. */
function mergeCookies(currentValue, cookies) {
  const jar = new Map();
  for (const part of String(currentValue || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) jar.set(name, part.slice(eq + 1).trim());
  }
  for (const cookie of cookies) jar.set(cookie.name, cookie.value);
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function applyCookies(headers, cookies, mode) {
  const existing = headers.find(h => h.name.toLowerCase() === 'cookie');
  const value = mode === 'replace'
    ? cookies.map(c => `${c.name}=${c.value}`).join('; ')
    : mergeCookies(existing?.value, cookies);

  if (existing) existing.value = value;
  else headers.push({ name: 'Cookie', value });
  return headers;
}

function rewrite(details, kind, headers) {
  let result = null;
  for (const profile of compiled) {
    const ops = kind === 'request' ? profile.requestOps : profile.responseOps;
    const cookies = kind === 'request' ? profile.requestCookies : [];
    if (!ops.length && !cookies.length) continue;
    if (!profile.matches(details)) continue;

    if (!result) result = headers.map(header => ({ ...header }));
    for (const op of ops) result = applyOne(result, op);
    if (cookies.length) result = applyCookies(result, cookies, profile.cookieMode);
  }
  return result;
}

function handler(kind) {
  const key = kind === 'request' ? 'requestHeaders' : 'responseHeaders';

  const run = details => {
    const headers = details[key];
    if (!headers || !compiled.length) return {};
    const rewritten = rewrite(details, kind, headers);
    return rewritten ? { [key]: rewritten } : {};
  };

  return details => {
    /* Firefox lets a blocking listener return a promise. When the event
       page has just been revived this holds the request until the stored
       profiles are loaded, instead of letting it slip through unmodified. */
    if (settled) return run(details);
    return ready.then(() => run(details));
  };
}

/* ---------------------------------------------------------------- *
 * Redirects
 * ---------------------------------------------------------------- */

function expandSubstitution(template) {
  // Chrome's regexSubstitution uses \1; JS replace wants $1.
  return template.replace(/\\(\d)/g, '$$$1');
}

function findRedirect(details) {
  for (const profile of compiled) {
    if (!profile.redirects.length || !profile.matches(details)) continue;
    for (const redirect of profile.redirects) {
      if (redirect.needle) {
        if (details.url.includes(redirect.needle)) return redirect.to;
      } else if (redirect.test?.test(details.url)) {
        return details.url.replace(redirect.test, expandSubstitution(redirect.to));
      }
    }
  }
  return null;
}

function onBeforeRequest(details) {
  const run = () => {
    if (!compiled.length) return {};
    const target = findRedirect(details);
    // Redirecting to the same URL would loop forever.
    if (!target || target === details.url) return {};
    return { redirectUrl: target };
  };
  if (settled) return run();
  return ready.then(run);
}

/* ---------------------------------------------------------------- *
 * Listeners
 * ---------------------------------------------------------------- */

api.webRequest.onBeforeRequest.addListener(
  onBeforeRequest,
  { urls: ['<all_urls>'] },
  ['blocking']
);

api.webRequest.onBeforeSendHeaders.addListener(
  handler('request'),
  { urls: ['<all_urls>'] },
  ['blocking', 'requestHeaders']
);

api.webRequest.onHeadersReceived.addListener(
  handler('response'),
  { urls: ['<all_urls>'] },
  ['blocking', 'responseHeaders']
);

/* ---------------------------------------------------------------- *
 * Badge and events
 * ---------------------------------------------------------------- */

async function updateBadge(state) {
  const count = countActiveHeaders(state);
  const profile = state.profiles.find(p => p.id === state.activeProfileId) || state.profiles[0];

  if (state.paused) {
    await api.action.setBadgeText({ text: 'off' });
    await api.action.setBadgeBackgroundColor({ color: '#6B7688' });
    await api.action.setTitle({ title: 'OpenModHeader — off' });
  } else {
    await api.action.setBadgeText({ text: count ? String(count) : '' });
    await api.action.setBadgeBackgroundColor({ color: profile?.color || '#B4470E' });
    await api.action.setTitle({
      title: count
        ? `OpenModHeader — ${count} rule${count === 1 ? '' : 's'} active`
        : 'OpenModHeader — nothing active'
    });
  }

  try {
    await api.action.setBadgeTextColor({ color: '#FFFFFF' });
  } catch {
    /* Older builds lack setBadgeTextColor; the badge still works without it. */
  }
}

function reload() {
  ready = refresh();
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) reload();
});

api.runtime.onInstalled.addListener(() => indexTabs().then(reload));
api.runtime.onStartup.addListener(() => indexTabs().then(reload));

/* Site access can be granted or taken away long after install. */
api.permissions.onAdded.addListener(reload);
api.permissions.onRemoved.addListener(reload);

api.tabs.onCreated.addListener(tab => tabWindows.set(tab.id, tab.windowId));
api.tabs.onRemoved.addListener(tabId => tabWindows.delete(tabId));
api.tabs.onAttached.addListener((tabId, info) => tabWindows.set(tabId, info.newWindowId));

api.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-pause') return;
  const state = await loadState();
  state.paused = !state.paused;
  await saveState(state); // storage.onChanged triggers reload
});

indexTabs();
