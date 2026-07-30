/* OpenModHeader — popup controller. */

import {
  api, loadState, saveState, normalize, defaultState,
  blankHeader, blankFilter, blankProfile,
  PROFILE_COLORS, FILTER_TYPES, OPERATIONS,
  APPENDABLE_REQUEST_HEADERS, countActiveHeaders
} from './common.js';

const $ = id => document.getElementById(id);

let state = defaultState();
let section = 'requestHeaders';
let ruleErrors = [];
let saveTimer = null;
let confirmTimer = null;

/* ---------------------------------------------------------------- *
 * Tiny DOM helper
 * ---------------------------------------------------------------- */

function el(tag, props = {}, ...kids) {
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
 * State plumbing
 * ---------------------------------------------------------------- */

function activeProfile() {
  return state.profiles.find(p => p.id === state.activeProfileId) || state.profiles[0];
}

function save({ now = false } = {}) {
  clearTimeout(saveTimer);
  if (now) return saveState(state);
  saveTimer = setTimeout(() => saveState(state), 200);
}

/* Structural changes rebuild the rows; typing does not, so focus survives. */
function touch() {
  save();
  renderProfiles();
  renderTallies();
  renderStatus();
}

/* ---------------------------------------------------------------- *
 * Rendering
 * ---------------------------------------------------------------- */

function renderAll() {
  document.body.dataset.section = section;
  document.body.classList.toggle('off', state.paused);
  $('power').checked = !state.paused;
  $('power-label').textContent = state.paused ? 'Off' : 'On';
  for (const tab of document.querySelectorAll('.section-tab')) {
    tab.classList.toggle('active', tab.dataset.section === section);
    tab.setAttribute('aria-selected', String(tab.dataset.section === section));
  }
  $('btn-add').textContent = section === 'filters' ? 'Add filter' : 'Add header';
  renderProfiles();
  renderRows();
  renderTallies();
  renderStatus();
}

function renderProfiles() {
  const nav = $('profiles');
  nav.textContent = '';

  for (const profile of state.profiles) {
    const isActive = profile.id === state.activeProfileId;
    const chip = el('button', {
      class: `chip${isActive ? ' active' : ''}${profile.enabled ? '' : ' muted'}`,
      style: `--chip-color:${profile.color}`,
      title: profile.enabled ? 'Click to open, click again for settings' : 'This profile is off',
      dataset: { id: profile.id },
      onclick: event => {
        if (isActive) openProfileMenu(chip, profile);
        else { state.activeProfileId = profile.id; save(); renderAll(); }
        event.stopPropagation();
      }
    },
      el('span', { class: 'chip-dot' }),
      el('span', { class: 'chip-name', text: profile.name }),
      isActive ? el('span', { class: 'chip-caret', text: '\u25BC' }) : null
    );
    nav.append(chip);
  }

  nav.append(el('button', {
    class: 'chip-add',
    title: 'Add a profile',
    text: '+',
    onclick: addProfile
  }));
}

function renderTallies() {
  const profile = activeProfile();
  for (const node of document.querySelectorAll('[data-tally]')) {
    const list = profile[node.dataset.tally] || [];
    const live = list.filter(item =>
      item.enabled && (node.dataset.tally === 'filters' ? item.value.trim() : item.name.trim())
    ).length;
    node.textContent = live ? String(live) : '';
  }
}

function renderRows() {
  const content = $('content');
  content.textContent = '';
  const profile = activeProfile();
  const list = profile[section] || [];

  if (!list.length) {
    content.append(emptyState());
    return;
  }

  for (const item of list) {
    content.append(section === 'filters' ? filterRow(profile, item) : headerRow(profile, item));
  }
}

function emptyState() {
  const copy = {
    requestHeaders: {
      line: 'X-Header: value',
      text: 'Request headers are added to traffic leaving the browser. Add one to get started.'
    },
    responseHeaders: {
      line: 'Cache-Control: no-store',
      text: 'Response headers are rewritten as traffic arrives. Add one to get started.'
    },
    filters: {
      line: '# applies everywhere',
      text: 'This profile currently applies to every URL. Add a filter to narrow it down.'
    }
  }[section];

  return el('div', { class: 'empty' },
    el('p', { class: 'empty-line', text: copy.line }),
    el('p', { text: copy.text })
  );
}

function headerRow(profile, header) {
  const row = el('div', {
    class: `row${header.enabled ? '' : ' disabled'}`,
    dataset: { id: header.id }
  });

  const nameInput = el('input', {
    class: 'h-name',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'Header-Name',
    value: header.name,
    oninput: event => { header.name = event.target.value; flagRow(row, profile, header); touch(); }
  });

  const valueInput = el('input', {
    class: 'h-value',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: header.operation === 'remove' ? 'removed from the request' : 'value',
    value: header.value,
    disabled: header.operation === 'remove',
    oninput: event => { header.value = event.target.value; touch(); }
  });

  row.append(
    el('label', { class: 'row-check' },
      el('input', {
        type: 'checkbox',
        checked: header.enabled,
        title: 'Use this header',
        onchange: event => {
          header.enabled = event.target.checked;
          row.classList.toggle('disabled', !header.enabled);
          touch();
        }
      })
    ),
    el('select', {
      class: 'op-select',
      title: 'What to do with this header',
      onchange: event => {
        header.operation = event.target.value;
        valueInput.disabled = header.operation === 'remove';
        valueInput.placeholder = header.operation === 'remove' ? 'removed from the request' : 'value';
        flagRow(row, profile, header);
        touch();
      }
    }, OPERATIONS.map(op =>
      el('option', { value: op, selected: header.operation === op, text: op })
    )),
    el('div', { class: 'wire' },
      nameInput,
      el('span', { class: 'colon', text: ':' }),
      valueInput
    ),
    el('button', {
      class: 'del-btn',
      title: 'Remove this row',
      text: '\u2715',
      onclick: () => {
        profile[section] = profile[section].filter(h => h.id !== header.id);
        save();
        renderRows();
        renderTallies();
        renderStatus();
      }
    })
  );

  flagRow(row, profile, header);
  return row;
}

/* Chrome rejects `append` on request headers outside a fixed allowlist —
   say so here rather than letting the rule silently fail. */
function flagRow(row, profile, header) {
  const bad = section === 'requestHeaders'
    && header.operation === 'append'
    && header.name.trim()
    && !APPENDABLE_REQUEST_HEADERS.has(header.name.trim().toLowerCase());
  row.classList.toggle('warn', bad);
  row.title = bad ? 'Chrome only allows append on a fixed set of request headers. Use set instead.' : '';
}

function filterRow(profile, filter) {
  const row = el('div', {
    class: `row${filter.enabled ? '' : ' disabled'}`,
    dataset: { id: filter.id }
  });

  const valueInput = el('input', {
    class: 'f-value',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: FILTER_TYPES[filter.type].placeholder,
    value: filter.value,
    oninput: event => { filter.value = event.target.value; touch(); }
  });

  row.append(
    el('label', { class: 'row-check' },
      el('input', {
        type: 'checkbox',
        checked: filter.enabled,
        title: 'Use this filter',
        onchange: event => {
          filter.enabled = event.target.checked;
          row.classList.toggle('disabled', !filter.enabled);
          touch();
        }
      })
    ),
    el('select', {
      class: 'filter-select',
      onchange: event => {
        filter.type = event.target.value;
        valueInput.placeholder = FILTER_TYPES[filter.type].placeholder;
        touch();
      }
    }, Object.entries(FILTER_TYPES).map(([key, meta]) =>
      el('option', { value: key, selected: filter.type === key, text: meta.label })
    )),
    el('div', { class: 'wire' }, valueInput),
    el('button', {
      class: 'del-btn',
      title: 'Remove this filter',
      text: '\u2715',
      onclick: () => {
        profile.filters = profile.filters.filter(f => f.id !== filter.id);
        save();
        renderRows();
        renderTallies();
        renderStatus();
      }
    })
  );

  return row;
}

function renderStatus() {
  const node = $('status');
  node.classList.toggle('error', ruleErrors.length > 0);

  if (ruleErrors.length) {
    node.textContent = `Chrome turned down ${ruleErrors.length} rule${ruleErrors.length === 1 ? '' : 's'}. ${ruleErrors[0]}`;
    node.title = ruleErrors.join('\n');
    return;
  }

  node.title = '';
  if (state.paused) {
    node.textContent = 'Off. Nothing is being changed.';
    return;
  }

  const total = countActiveHeaders(state);
  if (!total) {
    node.textContent = 'Nothing active. Tick a header to start.';
    return;
  }

  const profile = activeProfile();
  const scopes = (profile.filters || []).filter(f => f.enabled && f.value.trim()).length;
  const scope = scopes
    ? `${scopes} filter${scopes === 1 ? '' : 's'} narrow${scopes === 1 ? 's' : ''} this profile`
    : 'this profile applies to every URL';
  node.textContent = `${total} header${total === 1 ? '' : 's'} active \u00B7 ${scope}`;
}

/* ---------------------------------------------------------------- *
 * Profiles
 * ---------------------------------------------------------------- */

function addProfile() {
  const profile = blankProfile(state.profiles.length + 1, state.profiles.length);
  state.profiles.push(profile);
  state.activeProfileId = profile.id;
  section = 'requestHeaders';
  save();
  renderAll();
}

function openProfileMenu(anchor, profile) {
  const menu = $('profile-menu');
  const nameField = $('profile-name');
  nameField.value = profile.name;
  nameField.oninput = () => {
    profile.name = nameField.value;
    save();
    const chipName = document.querySelector(`.chip[data-id="${profile.id}"] .chip-name`);
    if (chipName) chipName.textContent = profile.name;
  };

  const colors = $('profile-colors');
  colors.textContent = '';
  for (const color of PROFILE_COLORS) {
    colors.append(el('button', {
      class: `swatch${profile.color === color ? ' selected' : ''}`,
      style: `background:${color}`,
      title: color,
      onclick: () => { profile.color = color; save(); renderProfiles(); closePopovers(); }
    }));
  }

  const dupe = $('btn-duplicate');
  dupe.onclick = () => {
    const copy = structuredClone(profile);
    copy.id = crypto.randomUUID();
    copy.name = `${profile.name} copy`;
    copy.requestHeaders.forEach(h => { h.id = crypto.randomUUID(); });
    copy.responseHeaders.forEach(h => { h.id = crypto.randomUUID(); });
    copy.filters.forEach(f => { f.id = crypto.randomUUID(); });
    state.profiles.push(copy);
    state.activeProfileId = copy.id;
    save();
    closePopovers();
    renderAll();
  };

  armConfirm($('btn-delete-profile'), 'Delete', 'Click again to delete', () => {
    state.profiles = state.profiles.filter(p => p.id !== profile.id);
    if (!state.profiles.length) state.profiles.push(blankProfile(1, 0));
    state.activeProfileId = state.profiles[0].id;
    save();
    closePopovers();
    renderAll();
  });

  placePopover(menu, anchor);
}

/* Destructive buttons ask twice instead of using a blocking dialog,
   which a popup window cannot show reliably. */
function armConfirm(button, idleLabel, confirmLabel, action) {
  button.textContent = idleLabel;
  button.dataset.armed = '';
  button.onclick = () => {
    if (button.dataset.armed === 'yes') {
      clearTimeout(confirmTimer);
      button.dataset.armed = '';
      action();
      return;
    }
    button.dataset.armed = 'yes';
    button.textContent = confirmLabel;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      button.dataset.armed = '';
      button.textContent = idleLabel;
    }, 4000);
  };
}

/* ---------------------------------------------------------------- *
 * Popovers
 * ---------------------------------------------------------------- */

function placePopover(menu, anchor) {
  closePopovers(menu);
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - width - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
}

function closePopovers(except) {
  for (const menu of document.querySelectorAll('.popover')) {
    if (menu !== except) menu.hidden = true;
  }
}

document.addEventListener('click', event => {
  if (!event.target.closest('.popover')) closePopovers();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closePopovers();
});

/* ---------------------------------------------------------------- *
 * Import / export
 * ---------------------------------------------------------------- */

function exportPayload() {
  return JSON.stringify({
    app: 'OpenModHeader',
    version: 1,
    profiles: state.profiles
  }, null, 2);
}

function exportFile() {
  const blob = new Blob([exportPayload()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const link = el('a', { href: url, download: `openmodheader-${stamp}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  closePopovers();
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText(exportPayload());
    flash('Copied to the clipboard.');
  } catch {
    flash('Could not reach the clipboard. Use the file export instead.');
  }
  closePopovers();
}

async function importFile(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = normalize(
      Array.isArray(parsed) ? { profiles: parsed } : parsed
    );
    state.profiles = state.profiles.concat(incoming.profiles);
    state.activeProfileId = incoming.profiles[0].id;
    await save({ now: true });
    renderAll();
    flash(`Imported ${incoming.profiles.length} profile${incoming.profiles.length === 1 ? '' : 's'}.`);
  } catch {
    flash('That file is not valid OpenModHeader JSON.');
  }
}

function flash(message) {
  const node = $('status');
  node.textContent = message;
  node.classList.remove('error');
  setTimeout(renderStatus, 3000);
}

/* ---------------------------------------------------------------- *
 * Wiring
 * ---------------------------------------------------------------- */

function bind() {
  $('power').addEventListener('change', event => {
    state.paused = !event.target.checked;
    save();
    renderAll();
  });

  $('btn-expand').addEventListener('click', () => {
    api.tabs.create({ url: api.runtime.getURL('popup.html?view=tab') });
    window.close();
  });

  $('btn-menu').addEventListener('click', event => {
    const menu = $('main-menu');
    if (!menu.hidden) return closePopovers();
    placePopover(menu, event.currentTarget);
    event.stopPropagation();
  });

  for (const tab of document.querySelectorAll('.section-tab')) {
    tab.addEventListener('click', () => {
      section = tab.dataset.section;
      renderAll();
    });
  }

  $('btn-add').addEventListener('click', () => {
    const profile = activeProfile();
    profile[section].push(section === 'filters' ? blankFilter() : blankHeader());
    save();
    renderRows();
    renderTallies();
    renderStatus();
    const inputs = $('content').querySelectorAll('.wire input:not([disabled])');
    inputs[inputs.length - (section === 'filters' ? 1 : 2)]?.focus();
  });

  $('btn-grant').addEventListener('click', requestAccess);
  $('btn-export').addEventListener('click', exportFile);
  $('btn-copy').addEventListener('click', copyJson);
  $('btn-import').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', event => {
    const file = event.target.files[0];
    if (file) importFile(file);
    event.target.value = '';
    closePopovers();
  });

  armConfirm($('btn-reset'), 'Delete everything and start over', 'Click again to delete everything', async () => {
    state = defaultState();
    section = 'requestHeaders';
    await save({ now: true });
    closePopovers();
    renderAll();
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ruleErrors) {
      ruleErrors = changes.ruleErrors.newValue || [];
      renderStatus();
    }
    if (changes.state && changes.state.newValue?.paused !== state.paused) {
      state.paused = !!changes.state.newValue.paused;
      renderAll();
    }
  });
}

/* Firefox treats host access as revocable at any moment, and an extension
   update never re-prompts. Check on every open and offer to ask again. */
async function checkAccess() {
  const banner = $('access');
  if (!api.permissions?.contains) return;
  try {
    banner.hidden = await api.permissions.contains({ origins: ['<all_urls>'] });
  } catch {
    banner.hidden = true;
  }
}

async function requestAccess() {
  try {
    if (await api.permissions.request({ origins: ['<all_urls>'] })) {
      $('access').hidden = true;
      flash('Site access granted. Reload any open tabs to pick up your headers.');
    }
  } catch {
    flash('Firefox would not open the access prompt. Grant it from the extensions button in the toolbar.');
  }
}

async function init() {
  if (new URLSearchParams(location.search).get('view') === 'tab') {
    document.body.classList.add('expanded');
  }
  state = await loadState();
  const stored = await api.storage.local.get('ruleErrors');
  ruleErrors = stored.ruleErrors || [];
  bind();
  renderAll();
  checkAccess();
}

init();
