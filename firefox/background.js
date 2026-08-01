/* OpenModHeader — Firefox background event page.

   Firefox keeps blocking webRequest in Manifest V3, so this build edits
   traffic directly in JavaScript. For credential security that means the
   sensitive operations are resolved from the secret store at compile time
   and re-checked per request: when the vault is locked or a credential is
   missing, only the protected header operation is skipped. Every other
   operation in the same profile still applies. */

import {
  api, loadState, saveState, countActiveHeaders, collectSecretIds,
  planProfile, parseFilters, needsMigration, migrateToV3,
  RESOURCE_TYPES, GECKO_RESOURCE_TYPES
} from './common.js';
import { evaluateProfile, sensitiveHeadersOf, profileHasSensitiveContent } from './security.js';
import {
  resolveSecrets, isUnlocked, lock, handleLockAlarm, pruneOrphans,
  LOCK_ALARM, hasSessionStorage
} from './secretstore.js';

const KNOWN_TYPES = [...RESOURCE_TYPES, ...GECKO_RESOURCE_TYPES];

let compiled = [];
let settled = false;
let ready = refresh();

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

function compileProfile(profile, { secrets, settings, unlocked }) {
  const verdict = evaluateProfile(profile, settings, {
    unlocked,
    resolvedIds: new Set(Object.keys(secrets))
  });

  /* planProfile drops any sensitive op whose credential will not resolve, so
     a locked or missing credential can never be sent as an empty value. */
  const plan = planProfile(profile, id => (verdict.blocked ? undefined : secrets[id]));

  const sensitiveNames = new Set(
    sensitiveHeadersOf(profile).map(h => h.name.trim().toLowerCase())
  );
  const cookiesAreSensitive = plan.requestCookies.some(c => c.sensitive);

  /* When the profile is blocked, strip the credential-bearing operations but
     keep everything else — this is the "skip only the protected op" rule. */
  const keep = ops => verdict.blocked
    ? ops.filter(op => op.sensitive !== true
        && !sensitiveNames.has(op.name.trim().toLowerCase()))
    : ops;

  const requestOps = keep(plan.requestOps);
  const responseOps = keep(plan.responseOps);
  /* Firefox can be precise here: drop only the credential cookies and still
     send the ordinary ones in the same Cookie header. */
  const requestCookies = verdict.blocked
    ? plan.requestCookies.filter(c => !c.sensitive)
    : plan.requestCookies;

  if (!requestOps.length && !responseOps.length && !requestCookies.length && !plan.redirects.length) {
    return null;
  }

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
    requestOps,
    responseOps,
    requestCookies,
    cookieMode: plan.cookieMode,
    redirects,
    matches
  };
}

async function refresh() {
  const state = await loadState();
  const settings = state.settings;
  const unlocked = settings.credentialStorage === 'vault' ? await isUnlocked() : true;
  const secrets = await resolveSecrets(settings);

  compiled = state.paused
    ? []
    : state.profiles
        .filter(p => p.enabled)
        .map(p => compileProfile(p, { secrets, settings, unlocked }))
        .filter(Boolean);

  const blocked = state.paused ? [] : state.profiles
    .filter(p => p.enabled)
    .map(p => ({
      profile: p,
      verdict: evaluateProfile(p, settings, { unlocked, resolvedIds: new Set(Object.keys(secrets)) })
    }))
    .filter(x => x.verdict.hasSensitive && x.verdict.blocked)
    .map(x => ({ profileId: x.profile.id, profileName: x.profile.name, reasons: x.verdict.reasons }));

  await api.storage.local.set({ blockedProfiles: blocked, vaultUnlocked: unlocked });

  settled = true;
  await updateBadge(state, { unlocked, secrets, blocked });
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
    /* Firefox lets a blocking listener return a promise. When the event page
       has just been revived this holds the request until stored profiles and
       credentials are loaded, instead of letting it through unmodified. */
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

async function updateBadge(state, { unlocked, secrets, blocked }) {
  const count = countActiveHeaders(state, id => secrets[id]);
  const profile = state.profiles.find(p => p.id === state.activeProfileId) || state.profiles[0];
  const locked = state.settings.credentialStorage === 'vault' && !unlocked;

  if (state.paused) {
    await api.action.setBadgeText({ text: 'off' });
    await api.action.setBadgeBackgroundColor({ color: '#6B7688' });
    await api.action.setTitle({ title: 'OpenModHeader — off' });
  } else if (locked) {
    await api.action.setBadgeText({ text: 'lock' });
    await api.action.setBadgeBackgroundColor({ color: '#6D28D9' });
    await api.action.setTitle({ title: 'OpenModHeader — vault locked' });
  } else {
    await api.action.setBadgeText({ text: count ? String(count) : '' });
    await api.action.setBadgeBackgroundColor({ color: profile?.color || '#B4470E' });
    const suffix = blocked.length ? `, ${blocked.length} needing attention` : '';
    await api.action.setTitle({
      title: count
        ? `OpenModHeader — ${count} rule${count === 1 ? '' : 's'} active${suffix}`
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

async function checkMigration() {
  const stored = await api.storage.local.get(['state', 'pendingMigration']);
  const raw = stored.state;
  if (!raw || !needsMigration(raw)) return;

  const { state, extracted, migrated } = migrateToV3(raw);
  await api.storage.local.set({
    pendingMigration: {
      detectedAt: stored.pendingMigration?.detectedAt ?? Date.now(),
      credentialCount: migrated,
      secretIds: Object.keys(extracted)   // ids only, never values
    },
    migrationSecrets: extracted,
    state
  });
}

api.runtime.onMessage.addListener(async message => {
  switch (message?.type) {
    case 'apply':
      reload();
      await ready;
      return { ok: true };
    case 'lock':
      await lock();
      reload();
      await ready;
      return { ok: true };
    case 'unlocked':
      reload();
      await ready;
      return { ok: true };
    case 'prune': {
      const state = await loadState();
      const removed = await pruneOrphans(collectSecretIds(state), state.settings);
      return { ok: true, removed };
    }
    case 'status': {
      const state = await loadState();
      return {
        ok: true,
        unlocked: await isUnlocked(),
        sessionStorage: hasSessionStorage(),
        mode: state.settings.credentialStorage
      };
    }
    default:
      return { ok: false, error: 'unknown-message' };
  }
});

api.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== LOCK_ALARM) return;
  const state = await loadState();
  const result = await handleLockAlarm(state.settings);
  if (result.locked) reload();
});

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) reload();
});

async function boot() {
  await indexTabs();
  await checkMigration();
  reload();
}

api.runtime.onInstalled.addListener(boot);
api.runtime.onStartup.addListener(boot);

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

boot();
