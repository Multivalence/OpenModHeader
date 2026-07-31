/* OpenModHeader — Chrome background service worker.

   Compiles stored profiles into declarativeNetRequest rules. Profiles that
   filter by tab or window go into session rules, because `tabIds` is only
   supported there; everything else goes into dynamic rules, which survive
   a browser restart. */

import {
  api, loadState, saveState, countActiveHeaders,
  planProfile, profileIsActive, parseFilters, hasTabScope, RESOURCE_TYPES
} from './common.js';

/* Priority bands. An `allow` rule suppresses lower-priority rules, so
   exclusions must outrank the modifications they cancel. */
const PRIORITY_MODIFY = 1;
const PRIORITY_REDIRECT = 2;
const PRIORITY_ALLOW = 3;

let running = false;
let queued = false;

/* tabId -> windowId, kept current so window filters can be expanded into
   the tab ids that declarativeNetRequest actually understands. */
const tabWindows = new Map();

async function indexTabs() {
  try {
    const tabs = await api.tabs.query({});
    tabWindows.clear();
    for (const tab of tabs) tabWindows.set(tab.id, tab.windowId);
  } catch {
    /* Without tab access, window filters simply match nothing. */
  }
}

function tabsInWindows(windowIds) {
  const out = [];
  for (const [tabId, windowId] of tabWindows) {
    if (windowIds.includes(windowId)) out.push(tabId);
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * Rule compilation
 * ---------------------------------------------------------------- */

function toHeaderInfo(op) {
  const info = { header: op.name.trim().toLowerCase(), operation: op.operation || 'set' };
  if (info.operation !== 'remove') info.value = String(op.value ?? '');
  return info;
}

function conditionsFor(parsed, tabIds) {
  const base = { resourceTypes: parsed.types.length ? parsed.types : RESOURCE_TYPES };
  if (parsed.excludeDomains.length) base.excludedRequestDomains = parsed.excludeDomains;
  if (tabIds.length) base.tabIds = tabIds;

  const conditions = [];
  for (const value of parsed.contains) conditions.push({ ...base, urlFilter: value });
  for (const value of parsed.regexes) conditions.push({ ...base, regexFilter: value });
  if (!conditions.length) conditions.push({ ...base });
  return conditions;
}

export function buildRules(state) {
  const dynamic = [];
  const session = [];
  let dynamicId = 1;
  let sessionId = 1;

  if (state.paused) return { dynamic, session };

  for (const profile of state.profiles) {
    if (!profile.enabled || !profileIsActive(profile)) continue;

    const parsed = parseFilters(profile);
    const tabIds = [...new Set([...parsed.tabIds, ...tabsInWindows(parsed.windowIds)])];

    /* A profile scoped to a window with no open tabs must match nothing,
       rather than falling through and matching everything. */
    if (hasTabScope(profile) && !tabIds.length) continue;

    const scoped = tabIds.length > 0;
    const bucket = scoped ? session : dynamic;
    const nextId = () => (scoped ? sessionId++ : dynamicId++);

    const plan = planProfile(profile);
    const conditions = conditionsFor(parsed, tabIds);

    const requestHeaders = plan.requestOps.map(toHeaderInfo);
    if (plan.requestCookies.length) {
      requestHeaders.push({
        header: 'cookie',
        /* Chrome cannot read the outgoing header, so a merge is an append.
           Duplicate names end up sent twice; replace avoids that. */
        operation: plan.cookieMode === 'replace' ? 'set' : 'append',
        value: plan.requestCookies.map(c => `${c.name}=${c.value}`).join('; ')
      });
    }
    const responseHeaders = plan.responseOps.map(toHeaderInfo);

    if (requestHeaders.length || responseHeaders.length) {
      const action = { type: 'modifyHeaders' };
      if (requestHeaders.length) action.requestHeaders = requestHeaders;
      if (responseHeaders.length) action.responseHeaders = responseHeaders;
      for (const condition of conditions) {
        bucket.push({
          id: nextId(), priority: PRIORITY_MODIFY, action, condition,
          __profile: profile.name
        });
      }
    }

    for (const redirect of plan.redirects) {
      const condition = { resourceTypes: parsed.types.length ? parsed.types : RESOURCE_TYPES };
      if (parsed.excludeDomains.length) condition.excludedRequestDomains = parsed.excludeDomains;
      if (tabIds.length) condition.tabIds = tabIds;

      if (redirect.type === 'regex') {
        condition.regexFilter = redirect.from;
        bucket.push({
          id: nextId(), priority: PRIORITY_REDIRECT,
          action: { type: 'redirect', redirect: { regexSubstitution: redirect.to } },
          condition, __profile: profile.name
        });
      } else {
        condition.urlFilter = redirect.from;
        bucket.push({
          id: nextId(), priority: PRIORITY_REDIRECT,
          action: { type: 'redirect', redirect: { url: redirect.to } },
          condition, __profile: profile.name
        });
      }
    }

    /* URL exclusions. declarativeNetRequest has no negative URL condition,
       so these become high-priority `allow` rules. Note this suppresses
       every profile's rules for a matching request, not just this one —
       the Firefox build scopes exclusions per profile correctly. */
    for (const value of parsed.excludeContains) {
      bucket.push({
        id: nextId(), priority: PRIORITY_ALLOW, action: { type: 'allow' },
        condition: { urlFilter: value, resourceTypes: RESOURCE_TYPES },
        __profile: profile.name
      });
    }
    for (const value of parsed.excludeRegexes) {
      bucket.push({
        id: nextId(), priority: PRIORITY_ALLOW, action: { type: 'allow' },
        condition: { regexFilter: value, resourceTypes: RESOURCE_TYPES },
        __profile: profile.name
      });
    }
  }

  return { dynamic, session };
}

export function stripMeta(rule) {
  const { __profile, ...clean } = rule;
  return clean;
}

/* ---------------------------------------------------------------- *
 * Applying
 * ---------------------------------------------------------------- */

async function applyBucket(rules, getExisting, update) {
  const existing = await getExisting();
  const removeRuleIds = existing.map(r => r.id);
  const errors = [];

  try {
    await update({ removeRuleIds, addRules: rules.map(stripMeta) });
  } catch {
    /* One bad rule fails the whole batch, so add them individually and
       name the ones the engine turns down. */
    await update({ removeRuleIds });
    for (const rule of rules) {
      try {
        await update({ addRules: [stripMeta(rule)] });
      } catch (err) {
        errors.push(describe(rule, err));
      }
    }
  }
  return errors;
}

async function applyRules() {
  if (running) { queued = true; return; }
  running = true;
  try {
    const state = await loadState();
    const { dynamic, session } = buildRules(state);

    const errors = [
      ...await applyBucket(
        dynamic,
        () => api.declarativeNetRequest.getDynamicRules(),
        opts => api.declarativeNetRequest.updateDynamicRules(opts)
      ),
      ...await applyBucket(
        session,
        () => api.declarativeNetRequest.getSessionRules(),
        opts => api.declarativeNetRequest.updateSessionRules(opts)
      )
    ];

    await api.storage.local.set({ ruleErrors: errors });
    await updateBadge(state);
  } finally {
    running = false;
    if (queued) { queued = false; applyRules(); }
  }
}

function describe(rule, err) {
  const names = [
    ...(rule.action.requestHeaders || []).map(h => h.header),
    ...(rule.action.responseHeaders || []).map(h => h.header)
  ];
  const what = names.length ? names.join(', ') : rule.action.type;
  const reason = String(err?.message || err).replace(/^Error:\s*/, '');
  return `${rule.__profile}: ${what} — ${reason}`;
}

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
    /* setBadgeTextColor needs Chrome 110; the badge still works without it. */
  }
}

async function reindexAndApply() {
  await indexTabs();
  await applyRules();
}

/* ---------------------------------------------------------------- *
 * Events
 * ---------------------------------------------------------------- */

api.storage.onChanged.addListener((changes, area) => {
  // Only react to the state key — writing ruleErrors must not loop back.
  if (area === 'local' && changes.state) applyRules();
});

api.runtime.onInstalled.addListener(reindexAndApply);
api.runtime.onStartup.addListener(reindexAndApply);

/* Window filters depend on which tabs live where, so track membership. */
api.tabs.onCreated.addListener(tab => {
  tabWindows.set(tab.id, tab.windowId);
  applyRules();
});

api.tabs.onRemoved.addListener(tabId => {
  tabWindows.delete(tabId);
  applyRules();
});

api.tabs.onAttached.addListener((tabId, info) => {
  tabWindows.set(tabId, info.newWindowId);
  applyRules();
});

api.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-pause') return;
  const state = await loadState();
  state.paused = !state.paused;
  await saveState(state); // storage.onChanged triggers applyRules
});

reindexAndApply();
