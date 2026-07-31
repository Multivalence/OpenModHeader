/* OpenModHeader — popup controller. */

import {
  api, loadState, saveState, normalize, defaultState,
  blankHeader, blankCookie, blankCspDirective, blankRedirect, blankFilter, blankProfile,
  PROFILE_COLORS, FILTER_TYPES, OPERATIONS, CSP_MODES, CSP_DIRECTIVES,
  REDIRECT_TYPES, SAME_SITE_VALUES, COMMON_REQUEST_HEADERS, COMMON_RESPONSE_HEADERS,
  APPENDABLE_REQUEST_HEADERS, buildCspPolicy, countActiveHeaders, planProfile
} from './common.js';

const $ = id => document.getElementById(id);

let state = defaultState();
let section = 'requestHeaders';
let ruleErrors = [];
let saveTimer = null;
let confirmTimer = null;
let searchTerm = '';
let expandedRows = new Set();

/* Undo history of serialised states. */
let undoStack = [];
let lastSnapshot = '';

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

function textInput(props) {
  return el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', ...props });
}

/* ---------------------------------------------------------------- *
 * State plumbing
 * ---------------------------------------------------------------- */

function activeProfile() {
  return state.profiles.find(p => p.id === state.activeProfileId) || state.profiles[0];
}

function snapshot() {
  const current = JSON.stringify(state);
  if (current === lastSnapshot) return;
  if (lastSnapshot) {
    undoStack.push(lastSnapshot);
    if (undoStack.length > 40) undoStack.shift();
  }
  lastSnapshot = current;
  $('btn-undo').disabled = undoStack.length === 0;
}

function save({ now = false } = {}) {
  clearTimeout(saveTimer);
  const commit = () => { snapshot(); return saveState(state); };
  if (now) return commit();
  saveTimer = setTimeout(commit, 200);
}

function undo() {
  if (!undoStack.length) return;
  const previous = undoStack.pop();
  state = JSON.parse(previous);
  lastSnapshot = previous;
  $('btn-undo').disabled = undoStack.length === 0;
  saveState(state);
  renderAll();
}

/* Typing changes values only; structure is untouched, so focus survives. */
function touch() {
  save();
  renderTallies();
  renderStatus();
}

function restructure() {
  save();
  renderRows();
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
  $('btn-add').textContent = {
    requestHeaders: 'Add header',
    responseHeaders: 'Add header',
    cookies: 'Add cookie',
    csp: 'Add directive',
    redirects: 'Add redirect',
    filters: 'Add filter'
  }[section];
  $('profile-search').hidden = state.profiles.length < 6;
  renderProfiles();
  renderRows();
  renderTallies();
  renderStatus();
}

function renderProfiles() {
  const nav = $('profiles');
  nav.textContent = '';
  const term = searchTerm.trim().toLowerCase();
  const visible = term
    ? state.profiles.filter(p => p.name.toLowerCase().includes(term))
    : state.profiles;

  for (const profile of visible) {
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
    class: 'chip-add', title: 'Add a profile', text: '+', onclick: addProfile
  }));
}

function sectionCount(profile, key) {
  if (key === 'csp') {
    const csp = profile.csp;
    if (csp.mode === 'remove') return 1;
    if (csp.mode === 'replace') return csp.directives.filter(d => d.enabled && d.name.trim()).length;
    return 0;
  }
  const list = profile[key] || [];
  if (key === 'filters') return list.filter(f => f.enabled && f.value.trim()).length;
  if (key === 'redirects') return list.filter(r => r.enabled && r.from.trim() && r.to.trim()).length;
  return list.filter(item => item.enabled && item.name.trim()).length;
}

function renderTallies() {
  const profile = activeProfile();
  for (const node of document.querySelectorAll('[data-tally]')) {
    const count = sectionCount(profile, node.dataset.tally);
    node.textContent = count ? String(count) : '';
  }
}

function renderRows() {
  const content = $('content');
  content.textContent = '';
  const profile = activeProfile();

  if (section === 'csp') return renderCsp(content, profile);
  if (section === 'cookies') return renderCookies(content, profile);

  const list = profile[section] || [];
  if (!list.length) return content.append(emptyState());

  const build = {
    requestHeaders: headerRow, responseHeaders: headerRow,
    redirects: redirectRow, filters: filterRow
  }[section];

  for (const item of list) content.append(build(profile, item));
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
    cookies: {
      line: 'session=abc123',
      text: 'Edit individual cookies instead of the whole header. Add one to get started.'
    },
    redirects: {
      line: 'cdn.example.com \u2192 localhost:3000',
      text: 'Send matching requests somewhere else. Add a redirect to get started.'
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

/* ---------------------------------------------------------------- *
 * Shared row pieces
 * ---------------------------------------------------------------- */

function checkbox(item, row, onchange) {
  return el('label', { class: 'row-check' },
    el('input', {
      type: 'checkbox', checked: item.enabled, title: 'Use this row',
      onchange: event => {
        item.enabled = event.target.checked;
        row.classList.toggle('disabled', !item.enabled);
        onchange ? onchange() : touch();
      }
    })
  );
}

function deleteButton(profile, key, item) {
  return el('button', {
    class: 'del-btn', title: 'Remove this row', text: '\u2715',
    onclick: () => {
      profile[key] = profile[key].filter(x => x.id !== item.id);
      restructure();
    }
  });
}

/* A comment lives on its own line under the row, hidden until asked for. */
function commentToggle(item, wrapper) {
  return el('button', {
    class: `note-btn${item.comment ? ' has-note' : ''}`,
    title: 'Add a comment', text: '\u270E',
    onclick: () => {
      const open = expandedRows.has(item.id);
      open ? expandedRows.delete(item.id) : expandedRows.add(item.id);
      renderCommentLine(item, wrapper);
    }
  });
}

function renderCommentLine(item, wrapper) {
  wrapper.querySelector('.comment-line')?.remove();
  if (!expandedRows.has(item.id) && !item.comment) return;
  if (!expandedRows.has(item.id)) return;

  wrapper.append(el('div', { class: 'comment-line' },
    textInput({
      class: 'comment-input', placeholder: 'Comment — a note for yourself',
      value: item.comment,
      oninput: event => { item.comment = event.target.value; touch(); }
    })
  ));
}

function wrapRow(row, item) {
  const wrapper = el('div', { class: 'row-group' }, row);
  renderCommentLine(item, wrapper);
  return wrapper;
}

/* ---------------------------------------------------------------- *
 * Headers
 * ---------------------------------------------------------------- */

function headerRow(profile, header) {
  const row = el('div', { class: `row${header.enabled ? '' : ' disabled'}` });
  const wrapper = wrapRow(row, header);

  const valueInput = textInput({
    class: 'h-value',
    placeholder: header.operation === 'remove' ? 'removed from the request' : 'value',
    value: header.value,
    disabled: header.operation === 'remove',
    oninput: event => { header.value = event.target.value; touch(); }
  });

  const nameInput = textInput({
    class: 'h-name', placeholder: 'Header-Name', value: header.name,
    list: section === 'requestHeaders' ? 'request-header-names' : 'response-header-names',
    oninput: event => { header.name = event.target.value; flagRow(row, header); touch(); }
  });

  row.append(
    checkbox(header, row),
    el('select', {
      class: 'op-select', title: 'What to do with this header',
      onchange: event => {
        header.operation = event.target.value;
        valueInput.disabled = header.operation === 'remove';
        valueInput.placeholder = header.operation === 'remove' ? 'removed from the request' : 'value';
        flagRow(row, header);
        touch();
      }
    }, OPERATIONS.map(op => el('option', { value: op, selected: header.operation === op, text: op }))),
    el('div', { class: 'wire' },
      nameInput, el('span', { class: 'colon', text: ':' }), valueInput
    ),
    commentToggle(header, wrapper),
    deleteButton(profile, section, header)
  );

  flagRow(row, header);
  return wrapper;
}

/* Chrome rejects `append` on request headers outside a fixed allowlist. */
function flagRow(row, header) {
  const bad = section === 'requestHeaders'
    && header.operation === 'append'
    && header.name.trim()
    && !APPENDABLE_REQUEST_HEADERS.has(header.name.trim().toLowerCase());
  row.classList.toggle('warn', bad);
  row.title = bad
    ? 'Chrome only allows append on a fixed set of request headers. Use set instead.'
    : '';
}

/* ---------------------------------------------------------------- *
 * Cookies
 * ---------------------------------------------------------------- */

function renderCookies(content, profile) {
  content.append(el('div', { class: 'section-bar' },
    el('span', { class: 'bar-label', text: 'Request cookies' }),
    el('select', {
      class: 'bar-select',
      onchange: event => { profile.cookieMode = event.target.value; touch(); }
    },
      el('option', { value: 'merge', selected: profile.cookieMode !== 'replace', text: 'Merge with existing' }),
      el('option', { value: 'replace', selected: profile.cookieMode === 'replace', text: 'Replace all cookies' })
    )
  ));

  if (!profile.cookies.length) return content.append(emptyState());
  for (const cookie of profile.cookies) content.append(cookieRow(profile, cookie));
}

function cookieRow(profile, cookie) {
  const row = el('div', { class: `row${cookie.enabled ? '' : ' disabled'}` });
  const wrapper = el('div', { class: 'row-group' }, row);

  const attrsId = `${cookie.id}-attrs`;

  const renderAttrs = () => {
    wrapper.querySelector('.cookie-attrs')?.remove();
    if (!expandedRows.has(attrsId)) return;

    const field = (label, key, placeholder) => el('label', { class: 'attr' },
      el('span', { class: 'attr-label', text: label }),
      textInput({
        placeholder, value: cookie[key],
        oninput: event => { cookie[key] = event.target.value; touch(); }
      })
    );

    const check = (label, key) => el('label', { class: 'attr-check' },
      el('input', {
        type: 'checkbox', checked: cookie[key],
        onchange: event => { cookie[key] = event.target.checked; touch(); }
      }),
      el('span', { text: label })
    );

    wrapper.append(el('div', { class: 'cookie-attrs' },
      field('Path', 'path', '/'),
      field('Domain', 'domain', '.example.com'),
      field('Max-Age', 'maxAge', '3600'),
      el('label', { class: 'attr' },
        el('span', { class: 'attr-label', text: 'SameSite' }),
        el('select', {
          onchange: event => { cookie.sameSite = event.target.value; touch(); }
        }, SAME_SITE_VALUES.map(v =>
          el('option', { value: v, selected: cookie.sameSite === v, text: v || '(unset)' })
        ))
      ),
      check('Secure', 'secure'),
      check('HttpOnly', 'httpOnly'),
      el('p', { class: 'attr-note', text: 'Attributes apply to Set-Cookie response cookies only.' })
    ));
  };

  row.append(
    checkbox(cookie, row),
    el('select', {
      class: 'op-select', title: 'Which header this cookie belongs to',
      onchange: event => { cookie.target = event.target.value; touch(); renderAttrs(); }
    },
      el('option', { value: 'request', selected: cookie.target === 'request', text: 'Cookie' }),
      el('option', { value: 'response', selected: cookie.target === 'response', text: 'Set-Cookie' })
    ),
    el('div', { class: 'wire' },
      textInput({
        class: 'h-name', placeholder: 'cookie_name', value: cookie.name,
        oninput: event => { cookie.name = event.target.value; touch(); }
      }),
      el('span', { class: 'colon', text: '=' }),
      textInput({
        class: 'h-value', placeholder: 'value', value: cookie.value,
        oninput: event => { cookie.value = event.target.value; touch(); }
      })
    ),
    el('button', {
      class: 'note-btn', title: 'Cookie attributes', text: '\u2699',
      onclick: () => {
        expandedRows.has(attrsId) ? expandedRows.delete(attrsId) : expandedRows.add(attrsId);
        renderAttrs();
      }
    }),
    deleteButton(profile, 'cookies', cookie)
  );

  renderAttrs();
  return wrapper;
}

/* ---------------------------------------------------------------- *
 * Content-Security-Policy
 * ---------------------------------------------------------------- */

function renderCsp(content, profile) {
  const csp = profile.csp;

  content.append(el('div', { class: 'section-bar' },
    el('select', {
      class: 'bar-select wide',
      onchange: event => { csp.mode = event.target.value; save(); renderRows(); renderTallies(); renderStatus(); }
    }, Object.entries(CSP_MODES).map(([value, label]) =>
      el('option', { value, selected: csp.mode === value, text: label })
    )),
    csp.mode === 'replace'
      ? el('label', { class: 'bar-check' },
          el('input', {
            type: 'checkbox', checked: csp.reportOnly,
            onchange: event => { csp.reportOnly = event.target.checked; save(); renderRows(); }
          }),
          el('span', { text: 'Report only' })
        )
      : null
  ));

  if (csp.mode === 'off') {
    return content.append(el('div', { class: 'empty' },
      el('p', { class: 'empty-line', text: '# CSP untouched' }),
      el('p', { text: 'Response Content-Security-Policy headers are passed through as the server sent them.' })
    ));
  }

  if (csp.mode === 'remove') {
    return content.append(el('div', { class: 'empty' },
      el('p', { class: 'empty-line', text: 'Content-Security-Policy: \u2717' }),
      el('p', { text: 'Both Content-Security-Policy and Content-Security-Policy-Report-Only are stripped from every matching response. Useful for testing against a page whose policy blocks your tooling.' })
    ));
  }

  if (!csp.directives.length) {
    content.append(el('div', { class: 'empty' },
      el('p', { class: 'empty-line', text: "default-src 'self'" }),
      el('p', { text: 'Build a policy one directive at a time. Add a directive to get started.' })
    ));
  } else {
    for (const directive of csp.directives) content.append(cspRow(profile, directive));
  }

  const policy = buildCspPolicy(csp);
  content.append(el('div', { class: 'preview' },
    el('span', { class: 'preview-label', text: csp.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy' }),
    el('code', { class: 'preview-body', text: policy || '(empty — nothing will be set)' })
  ));
}

function cspRow(profile, directive) {
  const row = el('div', { class: `row${directive.enabled ? '' : ' disabled'}` });

  row.append(
    el('label', { class: 'row-check' },
      el('input', {
        type: 'checkbox', checked: directive.enabled,
        onchange: event => {
          directive.enabled = event.target.checked;
          row.classList.toggle('disabled', !directive.enabled);
          save(); renderRows(); renderTallies();
        }
      })
    ),
    el('div', { class: 'wire' },
      textInput({
        class: 'h-name csp-name', placeholder: 'default-src', value: directive.name,
        list: 'csp-directive-names',
        oninput: event => { directive.name = event.target.value; save(); refreshPreview(profile); renderTallies(); }
      }),
      el('span', { class: 'colon', text: ' ' }),
      textInput({
        class: 'h-value', placeholder: "'self' https://cdn.example.com", value: directive.value,
        oninput: event => { directive.value = event.target.value; save(); refreshPreview(profile); }
      })
    ),
    el('button', {
      class: 'del-btn', title: 'Remove this directive', text: '\u2715',
      onclick: () => {
        profile.csp.directives = profile.csp.directives.filter(d => d.id !== directive.id);
        restructure();
      }
    })
  );

  return row;
}

function refreshPreview(profile) {
  const body = document.querySelector('.preview-body');
  if (!body) return;
  const policy = buildCspPolicy(profile.csp);
  body.textContent = policy || '(empty — nothing will be set)';
}

/* ---------------------------------------------------------------- *
 * Redirects
 * ---------------------------------------------------------------- */

function redirectRow(profile, redirect) {
  const row = el('div', { class: `row redirect-row${redirect.enabled ? '' : ' disabled'}` });
  const wrapper = wrapRow(row, redirect);

  const fromInput = textInput({
    class: 'h-value', placeholder: REDIRECT_TYPES[redirect.type].placeholder, value: redirect.from,
    oninput: event => { redirect.from = event.target.value; touch(); }
  });

  row.append(
    checkbox(redirect, row),
    el('select', {
      class: 'op-select',
      onchange: event => {
        redirect.type = event.target.value;
        fromInput.placeholder = REDIRECT_TYPES[redirect.type].placeholder;
        touch();
      }
    }, Object.entries(REDIRECT_TYPES).map(([value, meta]) =>
      el('option', { value, selected: redirect.type === value, text: meta.label })
    )),
    el('div', { class: 'wire' }, fromInput),
    el('span', { class: 'redirect-arrow', text: '\u2192' }),
    el('div', { class: 'wire' },
      textInput({
        class: 'h-value',
        placeholder: redirect.type === 'regex' ? 'http://localhost:3000/\\1' : 'http://localhost:3000/app.js',
        value: redirect.to,
        oninput: event => { redirect.to = event.target.value; touch(); }
      })
    ),
    commentToggle(redirect, wrapper),
    deleteButton(profile, 'redirects', redirect)
  );

  return wrapper;
}

/* ---------------------------------------------------------------- *
 * Filters
 * ---------------------------------------------------------------- */

function filterRow(profile, filter) {
  const row = el('div', { class: `row${filter.enabled ? '' : ' disabled'}` });

  const valueInput = textInput({
    class: 'f-value', placeholder: FILTER_TYPES[filter.type].placeholder, value: filter.value,
    oninput: event => { filter.value = event.target.value; touch(); }
  });

  const capture = el('button', {
    class: 'capture-btn', text: 'Use current',
    title: 'Fill in the tab or window you are looking at',
    hidden: !FILTER_TYPES[filter.type].capture,
    onclick: async () => {
      const id = await currentId(FILTER_TYPES[filter.type].capture);
      if (id == null) return flash('Could not read the current tab.');
      filter.value = String(id);
      valueInput.value = filter.value;
      touch();
    }
  });

  row.append(
    checkbox(filter, row),
    el('select', {
      class: 'filter-select',
      onchange: event => {
        filter.type = event.target.value;
        valueInput.placeholder = FILTER_TYPES[filter.type].placeholder;
        capture.hidden = !FILTER_TYPES[filter.type].capture;
        touch();
      }
    }, Object.entries(FILTER_TYPES).map(([key, meta]) =>
      el('option', { value: key, selected: filter.type === key, text: meta.label })
    )),
    el('div', { class: 'wire' }, valueInput),
    capture,
    deleteButton(profile, 'filters', filter)
  );

  return row;
}

async function currentId(kind) {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    return kind === 'window' ? tab.windowId : tab.id;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- *
 * Status
 * ---------------------------------------------------------------- */

function renderStatus() {
  const node = $('status');
  node.classList.toggle('error', ruleErrors.length > 0);

  if (ruleErrors.length) {
    node.textContent = `Rejected ${ruleErrors.length} rule${ruleErrors.length === 1 ? '' : 's'}. ${ruleErrors[0]}`;
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
    node.textContent = 'Nothing active. Tick a row to start.';
    return;
  }

  const profile = activeProfile();
  const scopes = (profile.filters || []).filter(f => f.enabled && f.value.trim()).length;
  const scope = scopes
    ? `${scopes} filter${scopes === 1 ? '' : 's'} narrow${scopes === 1 ? 's' : ''} this profile`
    : 'this profile applies to every URL';
  node.textContent = `${total} rule${total === 1 ? '' : 's'} active \u00B7 ${scope}`;
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

  const enabled = $('profile-enabled');
  enabled.checked = profile.enabled;
  enabled.onchange = () => {
    profile.enabled = enabled.checked;
    save();
    renderProfiles();
    renderStatus();
  };

  const colors = $('profile-colors');
  colors.textContent = '';
  for (const color of PROFILE_COLORS) {
    colors.append(el('button', {
      class: `swatch${profile.color === color ? ' selected' : ''}`,
      style: `background:${color}`, title: color,
      onclick: () => { profile.color = color; save(); renderProfiles(); closePopovers(); }
    }));
  }

  $('btn-duplicate').onclick = () => {
    const copy = structuredClone(profile);
    copy.id = crypto.randomUUID();
    copy.name = `${profile.name} copy`;
    for (const key of ['requestHeaders', 'responseHeaders', 'cookies', 'redirects', 'filters']) {
      copy[key].forEach(item => { item.id = crypto.randomUUID(); });
    }
    copy.csp.directives.forEach(d => { d.id = crypto.randomUUID(); });
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

/* Destructive buttons ask twice; a popup window cannot show a blocking dialog. */
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
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
  }
});

/* ---------------------------------------------------------------- *
 * Import / export
 * ---------------------------------------------------------------- */

function exportPayload() {
  return JSON.stringify({ app: 'OpenModHeader', version: 2, profiles: state.profiles }, null, 2);
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
    const incoming = normalize(Array.isArray(parsed) ? { profiles: parsed } : parsed);
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
 * Site access
 * ---------------------------------------------------------------- */

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
      flash('Site access granted. Reload any open tabs to pick up your rules.');
    }
  } catch {
    flash('Firefox would not open the access prompt. Grant it from the extensions button in the toolbar.');
  }
}

/* ---------------------------------------------------------------- *
 * Wiring
 * ---------------------------------------------------------------- */

function fillDatalist(id, values) {
  $(id).append(...values.map(value => el('option', { value })));
}

function bind() {
  fillDatalist('request-header-names', COMMON_REQUEST_HEADERS);
  fillDatalist('response-header-names', COMMON_RESPONSE_HEADERS);
  fillDatalist('csp-directive-names', CSP_DIRECTIVES);

  $('power').addEventListener('change', event => {
    state.paused = !event.target.checked;
    save();
    renderAll();
  });

  $('btn-undo').addEventListener('click', undo);

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

  $('search').addEventListener('input', event => {
    searchTerm = event.target.value;
    renderProfiles();
  });

  for (const tab of document.querySelectorAll('.section-tab')) {
    tab.addEventListener('click', () => {
      section = tab.dataset.section;
      renderAll();
    });
  }

  $('btn-add').addEventListener('click', () => {
    const profile = activeProfile();
    if (section === 'cookies') profile.cookies.push(blankCookie());
    else if (section === 'csp') {
      profile.csp.mode = 'replace';
      profile.csp.directives.push(blankCspDirective());
    } else if (section === 'redirects') profile.redirects.push(blankRedirect());
    else if (section === 'filters') profile.filters.push(blankFilter());
    else profile[section].push(blankHeader());

    restructure();
    const inputs = $('content').querySelectorAll('.wire input:not([disabled])');
    inputs[section === 'filters' ? inputs.length - 1 : inputs.length - 2]?.focus();
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

async function init() {
  if (new URLSearchParams(location.search).get('view') === 'tab') {
    document.body.classList.add('expanded');
  }
  state = await loadState();
  lastSnapshot = JSON.stringify(state);
  const stored = await api.storage.local.get('ruleErrors');
  ruleErrors = stored.ruleErrors || [];
  bind();
  renderAll();
  checkAccess();
}

init();
