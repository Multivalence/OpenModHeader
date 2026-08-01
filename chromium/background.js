/* OpenModHeader — Chrome background service worker.

   Rule routing is the heart of the credential-security design:

     dynamic rules   non-sensitive rules, plus sensitive rules in
                     persistent-plaintext mode (legacy behaviour)
     session rules   everything tab/window-scoped, and every sensitive rule
                     in session-only or encrypted-vault mode

   Session rules carry credentials because they never touch disk. They are
   split into two id bands so locking removes the sensitive ones without
   disturbing anything else. */

import {
  api, loadState, saveState, countActiveHeaders, collectSecretIds,
  planProfile, parseFilters, hasTabScope, RESOURCE_TYPES,
  needsMigration, migrateToV3
} from './common.js';
import { evaluateProfile, sensitiveHeadersOf, profileHasSensitiveContent } from './security.js';
import {
  resolveSecrets, isUnlocked, lock, handleLockAlarm, pruneOrphans,
  LOCK_ALARM, hasSessionStorage
} from './secretstore.js';

const PRIORITY_MODIFY = 1;
const PRIORITY_REDIRECT = 2;
const PRIORITY_ALLOW = 3;

/* Reserved id bands. Session ids below SENSITIVE_BASE are ordinary
   tab-scoped rules; ids at or above it carry credentials and are the only
   ones removed on lock. Dynamic and session rules live in separate rule
   sets, so those two id spaces cannot collide with each other. */
const SESSION_PLAIN_BASE = 1;
export const SENSITIVE_BASE = 100000;

let running = false;
let queued = false;

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

/* Builds three buckets plus a report of profiles whose sensitive rules were
   withheld, so the popup can explain why. */
export function buildRules(state, { secrets = {}, unlocked = true } = {}) {
  const dynamic = [];
  const sessionPlain = [];
  const sessionSensitive = [];
  const blocked = [];

  if (state.paused) return { dynamic, sessionPlain, sessionSensitive, blocked };

  const settings = state.settings;
  const resolvedIds = new Set(Object.keys(secrets));
  const resolve = id => secrets[id];
  const plaintextMode = settings.credentialStorage === 'plaintext';

  let dynamicId = 1;
  let plainId = SESSION_PLAIN_BASE;
  let sensitiveId = SENSITIVE_BASE;

  for (const profile of state.profiles) {
    if (!profile.enabled) continue;

    const verdict = evaluateProfile(profile, settings, { unlocked, resolvedIds });
    const plan = planProfile(profile, resolve);

    if (verdict.hasSensitive && verdict.blocked) {
      blocked.push({
        profileId: profile.id,
        profileName: profile.name,
        reasons: verdict.reasons
      });
    }

    const hasAnything = plan.requestOps.length || plan.responseOps.length
      || plan.requestCookies.length || plan.redirects.length;
    if (!hasAnything) continue;

    const parsed = parseFilters(profile);
    const tabIds = [...new Set([...parsed.tabIds, ...tabsInWindows(parsed.windowIds)])];
    /* A profile scoped to a window with no open tabs matches nothing rather
       than falling through and matching everything. */
    if (hasTabScope(profile) && !tabIds.length) continue;

    const conditions = conditionsFor(parsed, tabIds);
    const sensitiveNames = new Set(
      sensitiveHeadersOf(profile).map(h => h.name.trim().toLowerCase())
    );
    /* The Cookie header is a single header, so it cannot be split across two
       rules. If any cookie in it is a credential, the whole header is routed
       to the sensitive rule set. */
    const cookiesAreSensitive = plan.requestCookies.some(c => c.sensitive);

    const splitOps = ops => {
      const plainOps = [];
      const secretOps = [];
      for (const op of ops) {
        /* `op.sensitive` is set for Set-Cookie ops built from a credential
           cookie; otherwise fall back to the header-name check. */
        const secret = op.sensitive === true
          || sensitiveNames.has(op.name.trim().toLowerCase());
        (secret ? secretOps : plainOps).push(op);
      }
      return { plainOps, secretOps };
    };

    const req = splitOps(plan.requestOps);
    const res = splitOps(plan.responseOps);

    const cookieHeader = plan.requestCookies.length ? {
      header: 'cookie',
      /* Chrome cannot read the outgoing header, so a merge is an append. */
      operation: plan.cookieMode === 'replace' ? 'set' : 'append',
      value: plan.requestCookies.map(c => `${c.name}=${c.value}`).join('; ')
    } : null;

    const scoped = tabIds.length > 0;
    const plainBucket = scoped ? sessionPlain : dynamic;
    const plainNextId = scoped ? () => plainId++ : () => dynamicId++;

    const emit = (bucket, nextId, requestHeaders, responseHeaders) => {
      if (!requestHeaders.length && !responseHeaders.length) return;
      const action = { type: 'modifyHeaders' };
      if (requestHeaders.length) action.requestHeaders = requestHeaders;
      if (responseHeaders.length) action.responseHeaders = responseHeaders;
      for (const condition of conditions) {
        bucket.push({
          id: nextId(), priority: PRIORITY_MODIFY, action, condition,
          __profile: profile.name
        });
      }
    };

    /* Non-sensitive half. */
    const plainRequest = req.plainOps.map(toHeaderInfo);
    if (cookieHeader && !cookiesAreSensitive) plainRequest.push(cookieHeader);
    emit(plainBucket, plainNextId, plainRequest, res.plainOps.map(toHeaderInfo));

    /* Sensitive half, withheld entirely when the profile is blocked. */
    if (!verdict.blocked) {
      const secretRequest = req.secretOps.map(toHeaderInfo);
      if (cookieHeader && cookiesAreSensitive) secretRequest.push(cookieHeader);
      const secretResponse = res.secretOps.map(toHeaderInfo);

      /* Plaintext mode keeps the pre-existing dynamic-rule behaviour;
         otherwise credentials only ever become session rules. */
      if (plaintextMode) {
        emit(dynamic, () => dynamicId++, secretRequest, secretResponse);
      } else {
        emit(sessionSensitive, () => sensitiveId++, secretRequest, secretResponse);
      }
    }

    for (const redirect of plan.redirects) {
      const condition = { resourceTypes: parsed.types.length ? parsed.types : RESOURCE_TYPES };
      if (parsed.excludeDomains.length) condition.excludedRequestDomains = parsed.excludeDomains;
      if (tabIds.length) condition.tabIds = tabIds;

      if (redirect.type === 'regex') {
        condition.regexFilter = redirect.from;
        plainBucket.push({
          id: plainNextId(), priority: PRIORITY_REDIRECT,
          action: { type: 'redirect', redirect: { regexSubstitution: redirect.to } },
          condition, __profile: profile.name
        });
      } else {
        condition.urlFilter = redirect.from;
        plainBucket.push({
          id: plainNextId(), priority: PRIORITY_REDIRECT,
          action: { type: 'redirect', redirect: { url: redirect.to } },
          condition, __profile: profile.name
        });
      }
    }

    for (const value of parsed.excludeContains) {
      plainBucket.push({
        id: plainNextId(), priority: PRIORITY_ALLOW, action: { type: 'allow' },
        condition: { urlFilter: value, resourceTypes: RESOURCE_TYPES },
        __profile: profile.name
      });
    }
    for (const value of parsed.excludeRegexes) {
      plainBucket.push({
        id: plainNextId(), priority: PRIORITY_ALLOW, action: { type: 'allow' },
        condition: { regexFilter: value, resourceTypes: RESOURCE_TYPES },
        __profile: profile.name
      });
    }
  }

  return { dynamic, sessionPlain, sessionSensitive, blocked };
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
    /* One bad rule fails the whole batch, so add them individually and name
       the ones the engine turns down. */
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
    const settings = state.settings;
    const unlocked = settings.credentialStorage === 'vault' ? await isUnlocked() : true;
    const secrets = await resolveSecrets(settings);

    const { dynamic, sessionPlain, sessionSensitive, blocked } =
      buildRules(state, { secrets, unlocked });

    const errors = [
      ...await applyBucket(
        dynamic,
        () => api.declarativeNetRequest.getDynamicRules(),
        opts => api.declarativeNetRequest.updateDynamicRules(opts)
      ),
      ...await applyBucket(
        [...sessionPlain, ...sessionSensitive],
        () => api.declarativeNetRequest.getSessionRules(),
        opts => api.declarativeNetRequest.updateSessionRules(opts)
      )
    ];

    await api.storage.local.set({
      ruleErrors: errors,
      blockedProfiles: blocked,
      vaultUnlocked: unlocked
    });
    await updateBadge(state, { unlocked, secrets, blocked });
  } finally {
    running = false;
    if (queued) { queued = false; applyRules(); }
  }
}

/* Removes only the sensitive band, leaving tab-scoped session rules and all
   dynamic rules untouched. */
async function removeSensitiveSessionRules() {
  const existing = await api.declarativeNetRequest.getSessionRules();
  const removeRuleIds = existing.map(r => r.id).filter(id => id >= SENSITIVE_BASE);
  if (!removeRuleIds.length) return 0;
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds });
  return removeRuleIds.length;
}

function describe(rule, err) {
  const names = [
    ...(rule.action.requestHeaders || []).map(h => h.header),
    ...(rule.action.responseHeaders || []).map(h => h.header)
  ];
  const what = names.length ? names.join(', ') : rule.action.type;
  const reason = String(err?.message || err).replace(/^Error:\s*/, '');
  /* Header names only, never a value. */
  return `${rule.__profile}: ${what} — ${reason}`;
}

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
    /* setBadgeTextColor needs Chrome 110; the badge still works without it. */
  }
}

/* ---------------------------------------------------------------- *
 * Migration
 * ---------------------------------------------------------------- */

/* Flags legacy data for the popup rather than migrating silently, because
   the user must choose a storage mode first. Old dynamic rules are dropped
   immediately so a stale plaintext rule cannot stay active alongside a new
   session rule. Idempotent: migrateToV3 skips already-migrated headers. */
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

  const existing = await api.declarativeNetRequest.getDynamicRules();
  if (existing.length) {
    await api.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map(r => r.id)
    });
  }
}

/* ---------------------------------------------------------------- *
 * Messaging and events
 * ---------------------------------------------------------------- */

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'apply':
        await applyRules();
        return sendResponse({ ok: true });
      case 'lock':
        await lock();
        await removeSensitiveSessionRules();
        await applyRules();
        return sendResponse({ ok: true });
      case 'unlocked':
        await applyRules();
        return sendResponse({ ok: true });
      case 'prune': {
        const state = await loadState();
        const removed = await pruneOrphans(collectSecretIds(state), state.settings);
        return sendResponse({ ok: true, removed });
      }
      case 'status': {
        const state = await loadState();
        return sendResponse({
          ok: true,
          unlocked: await isUnlocked(),
          sessionStorage: hasSessionStorage(),
          mode: state.settings.credentialStorage
        });
      }
      default:
        return sendResponse({ ok: false, error: 'unknown-message' });
    }
  })();
  return true; // async response
});

api.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== LOCK_ALARM) return;
  const state = await loadState();
  const result = await handleLockAlarm(state.settings);
  if (result.locked) {
    await removeSensitiveSessionRules();
    await applyRules();
  }
});

api.storage.onChanged.addListener((changes, area) => {
  // Only react to the state key — writing ruleErrors must not loop back.
  if (area === 'local' && changes.state) applyRules();
});

async function boot() {
  await indexTabs();
  await checkMigration();
  await applyRules();
}

api.runtime.onInstalled.addListener(boot);

/* A browser restart clears storage.session, so the vault is locked and the
   sensitive band is empty by construction. Clearing it explicitly guards
   against a stale rule surviving an extension reload. */
api.runtime.onStartup.addListener(async () => {
  await removeSensitiveSessionRules();
  await boot();
});

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

boot();
