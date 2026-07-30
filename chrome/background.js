/* OpenModHeader — Chrome background service worker.
   Watches stored state, compiles it into declarativeNetRequest dynamic rules,
   and reports any rule the engine rejects back to the popup. */

import { api, loadState, saveState, buildRules, stripMeta, countActiveHeaders } from './common.js';

let running = false;
let queued = false;

async function applyRules() {
  if (running) { queued = true; return; }
  running = true;
  try {
    const state = await loadState();
    const rules = buildRules(state);
    const existing = await api.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map(r => r.id);
    const errors = [];

    try {
      await api.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules: rules.map(stripMeta)
      });
    } catch {
      /* One bad rule fails the whole batch, so fall back to adding them
         one at a time and name the ones the engine turns down. */
      await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
      for (const rule of rules) {
        try {
          await api.declarativeNetRequest.updateDynamicRules({ addRules: [stripMeta(rule)] });
        } catch (err) {
          errors.push(describe(rule, err));
        }
      }
    }

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
  const reason = String(err?.message || err).replace(/^Error:\s*/, '');
  return `${rule.__profile}: ${names.join(', ')} — ${reason}`;
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
        ? `OpenModHeader — ${count} header${count === 1 ? '' : 's'} active`
        : 'OpenModHeader — no headers active'
    });
  }

  try {
    await api.action.setBadgeTextColor({ color: '#FFFFFF' });
  } catch {
    /* setBadgeTextColor needs Chrome 110; the badge still works without it. */
  }
}

api.storage.onChanged.addListener((changes, area) => {
  // Only react to the state key — writing ruleErrors must not loop back here.
  if (area === 'local' && changes.state) applyRules();
});

api.runtime.onInstalled.addListener(applyRules);
api.runtime.onStartup.addListener(applyRules);

api.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-pause') return;
  const state = await loadState();
  state.paused = !state.paused;
  await saveState(state); // storage.onChanged triggers applyRules
});

// Cover the case where the worker is spun up for some other reason.
applyRules();
