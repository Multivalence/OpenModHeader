/* OpenModHeader — Firefox background event page.

   Firefox keeps the blocking webRequest API in Manifest V3, so this build
   edits headers directly in JavaScript instead of compiling declarative
   rules. That buys three things the Chrome build cannot have: header names
   keep the capitalisation you type, `append` works on any header, and there
   is no cap on how many rules you can define. */

import {
  api, loadState, saveState, countActiveHeaders,
  RESOURCE_TYPES, GECKO_RESOURCE_TYPES
} from './common.js';

const KNOWN_TYPES = new Set([...RESOURCE_TYPES, ...GECKO_RESOURCE_TYPES]);

let compiled = [];
let settled = false;
let ready = refresh();

/* ---------------------------------------------------------------- *
 * Compiling profiles into matchers
 * ---------------------------------------------------------------- */

function isLive(header) {
  return header.enabled && header.name.trim().length > 0;
}

function compileProfile(profile) {
  const requestOps = (profile.requestHeaders || []).filter(isLive);
  const responseOps = (profile.responseHeaders || []).filter(isLive);
  if (!requestOps.length && !responseOps.length) return null;

  const live = (profile.filters || []).filter(f => f.enabled && f.value.trim());
  const split = value => value.split(',').map(s => s.trim()).filter(Boolean);

  const contains = live.filter(f => f.type === 'urlContains').map(f => f.value.trim());
  const excluded = live.filter(f => f.type === 'excludeDomain')
    .flatMap(f => split(f.value).map(d => d.toLowerCase()));
  const types = live.filter(f => f.type === 'resourceType')
    .flatMap(f => split(f.value).map(t => t.toLowerCase()))
    .filter(t => KNOWN_TYPES.has(t));

  const regexes = [];
  for (const filter of live.filter(f => f.type === 'urlRegex')) {
    try {
      regexes.push(new RegExp(filter.value.trim()));
    } catch {
      /* An unfinished regex is normal while someone is still typing it.
         Skip it rather than taking the whole profile down. */
    }
  }

  const unscoped = !contains.length && !regexes.length;

  function matches(details) {
    if (types.length && !types.includes(details.type)) return false;

    if (excluded.length) {
      let host = '';
      try {
        host = new URL(details.url).hostname.toLowerCase();
      } catch {
        return false;
      }
      if (excluded.some(domain => host === domain || host.endsWith(`.${domain}`))) return false;
    }

    if (unscoped) return true;
    return contains.some(needle => details.url.includes(needle))
      || regexes.some(pattern => pattern.test(details.url));
  }

  return { requestOps, responseOps, matches };
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

/* Returns a new header array, or null when no profile matched — returning
   null lets the request through untouched instead of rewriting it needlessly. */
function rewrite(details, kind, headers) {
  let result = null;
  for (const profile of compiled) {
    const ops = kind === 'request' ? profile.requestOps : profile.responseOps;
    if (!ops.length || !profile.matches(details)) continue;
    if (!result) result = headers.map(header => ({ ...header }));
    for (const op of ops) result = applyOne(result, op);
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
    /* Firefox lets a blocking listener return a promise. That matters here:
       when the event page has just been revived it holds the request until
       stored profiles are loaded, rather than letting it slip through. */
    if (settled) return run(details);
    return ready.then(() => run(details));
  };
}

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
        ? `OpenModHeader — ${count} header${count === 1 ? '' : 's'} active`
        : 'OpenModHeader — no headers active'
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
  // Only react to the state key — the popup writes other keys too.
  if (area === 'local' && changes.state) reload();
});

api.runtime.onInstalled.addListener(reload);
api.runtime.onStartup.addListener(reload);

/* Site access can be granted or taken away long after install. */
api.permissions.onAdded.addListener(reload);
api.permissions.onRemoved.addListener(reload);

api.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-pause') return;
  const state = await loadState();
  state.paused = !state.paused;
  await saveState(state); // storage.onChanged triggers reload
});
