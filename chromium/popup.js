/* OpenModHeader — popup controller. */

import {
  api, loadState, saveState, normalize, defaultState, blankSecretId, secretRefCount,
  blankHeader, blankCookie, blankCspDirective, blankRedirect, blankFilter, blankProfile,
  PROFILE_COLORS, FILTER_TYPES, OPERATIONS, CSP_MODES, CSP_DIRECTIVES,
  REDIRECT_TYPES, SAME_SITE_VALUES, COMMON_REQUEST_HEADERS, COMMON_RESPONSE_HEADERS,
  APPENDABLE_REQUEST_HEADERS, buildCspPolicy, countActiveHeaders, planProfile
} from './common.js';
import {
  isSensitiveHeader, isSensitiveHeaderName, isSensitiveCookie, isSensitiveCookieName,
  evaluateProfile, describeBlock
} from './security.js';
import {
  resolveSecrets, isUnlocked, lock, noteActivity, ACTIVITY, deleteSecret
} from './secretstore.js';
import * as sec from './popup-security.js';
import { icon, hydrateIcons } from './icons.js';

const $ = id => document.getElementById(id);

let state = defaultState();
let section = 'requestHeaders';
let ruleErrors = [];
let saveTimer = null;
let confirmTimer = null;
let searchTerm = '';
let expandedRows = new Set();
let secretIds = new Set();      // which credentials are currently resolvable
/* Header ids whose credential is currently shown in the clear, and the values
   backing them. Kept in module memory only — never written to storage, never
   placed in a DOM attribute — and dropped whenever the vault locks. */
let revealedHeaders = new Set();
let revealedValues = new Map();
let unlocked = true;
let blockedProfiles = [];

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

/* Element.append() stringifies non-Node arguments, so a conditional child of
   `null` renders the literal text "null". Every conditional append goes
   through here instead. */
function appendKids(node, ...kids) {
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid);
  }
  return node;
}

function textInput(props) {
  return el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', ...props });
}

/* ---------------------------------------------------------------- *
 * State plumbing
 * ---------------------------------------------------------------- */

/* A profile is locked out when the vault is locked and it holds credentials.
   Credential-free profiles keep working normally, and their configuration is
   still saved — only the credential-bearing ones freeze. */
function profileIsLocked(profile) {
  if (state.settings.credentialStorage !== 'vault') return false;
  if (unlocked) return false;
  return profileUsesCredentials(profile);
}

function profileUsesCredentials(profile) {
  const headers = [...(profile.requestHeaders || []), ...(profile.responseHeaders || [])];
  if (headers.some(h => isSensitiveHeader(h) && h.operation !== 'remove')) return true;
  return (profile.cookies || []).some(c => c.enabled && c.name.trim() && isSensitiveCookie(c));
}

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
  /* Security is app-level configuration, not per-profile content, so it takes
     over the whole panel instead of competing for room in the tab strip. */
  const inSettings = section === 'security';

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
    filters: 'Add filter',
    security: ''
  }[section];
  const locked = profileIsLocked(activeProfile());
  $('btn-add').hidden = inSettings || locked;
  $('btn-undo').disabled = undoStack.length === 0 || locked;
  $('settings-bar').hidden = !inSettings;
  document.querySelector('.sections').hidden = inSettings;
  $('profiles').hidden = inSettings;
  $('btn-security').classList.toggle('active', inSettings);
  $('profile-search').hidden = inSettings || state.profiles.length < 6;
  renderProfiles();
  renderRows();
  renderTallies();
  renderStatus();
  renderBanners();
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
      profileIsLocked(profile) ? el('span', { class: 'chip-lock' }, icon('lock', { size: 10 })) : null,
      el('span', { class: 'chip-name', text: profile.name }),
      isActive ? el('span', { class: 'chip-caret' }, icon('caret', { size: 10 })) : null
    );
    nav.append(chip);
  }

  nav.append(el('button', {
    class: 'chip-add', title: 'Add a profile', onclick: addProfile
  }, icon('plus', { size: 13 })));
}

function sectionCount(profile, key) {
  if (key === 'security') return blockedProfiles.length;
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
  const attention = blockedProfiles.length;
  $('settings-tally').textContent = attention
    ? `${attention} need${attention === 1 ? 's' : ''} attention`
    : '';
  $('btn-security').classList.toggle('flagged', attention > 0);
}

function renderRows() {
  const content = $('content');
  content.textContent = '';
  const profile = activeProfile();

  if (section === 'security') {
    return sec.renderSecurityPanel(content, state, {
      save, rerender: refreshAndRender, flash
    });
  }

  /* Everything below edits credential-bearing content, so a locked profile
     gets the unlock panel instead. The Security tab stays reachable. */
  if (profileIsLocked(profile)) return content.append(lockedPanel(profile));
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

function lockedPanel(profile) {
  return el('div', { class: 'locked-panel' },
    el('div', { class: 'locked-icon' }, icon('lock', { size: 26, stroke: 1.6 })),
    el('h3', { class: 'locked-title', text: `"${profile.name}" is locked` }),
    el('p', { class: 'locked-body', text:
      'This profile uses stored credentials, so it cannot be viewed or edited until the '
      + 'vault is unlocked. Its rules are not being applied.' }),
    el('p', { class: 'locked-body muted', text:
      'Profiles without credentials are unaffected and can still be edited.' }),
    el('button', {
      class: 'primary-btn',
      text: 'Unlock the vault',
      onclick: async () => {
        if (await sec.unlockFlow(state)) {
          await refreshAndRender();
          flash('Vault unlocked. Protected profiles are active again.');
        }
      }
    })
  );
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
      line: 'cdn.example.com to localhost:3000',
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
    class: 'del-btn', title: 'Remove this row',
    onclick: () => {
      profile[key] = profile[key].filter(x => x.id !== item.id);
      restructure();
    }
  }, icon('close', { size: 12 }));
}

/* A comment lives on its own line under the row, hidden until asked for. */
function commentToggle(item, wrapper) {
  return el('button', {
    class: `note-btn${item.comment ? ' has-note' : ''}`,
    title: 'Add a comment',
    onclick: () => {
      const open = expandedRows.has(item.id);
      open ? expandedRows.delete(item.id) : expandedRows.add(item.id);
      renderCommentLine(item, wrapper);
    }
  }, icon('pencil', { size: 12 }));
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
  const wrapper = el('div', { class: 'row-group', dataset: { id: item.id } }, row);
  renderCommentLine(item, wrapper);
  return wrapper;
}

/* ---------------------------------------------------------------- *
 * Headers
 * ---------------------------------------------------------------- */

function headerRow(profile, header) {
  const row = el('div', { class: `row${header.enabled ? '' : ' disabled'}` });
  const wrapper = wrapRow(row, header);

  const sensitive = isSensitiveHeader(header);

  /* A credential is never bound into the DOM: the field is a placeholder and
     the real value lives in the secret store. */
  const shown = revealedHeaders.has(header.id) && revealedValues.has(header.id);
  const valueInput = sensitive && header.operation !== 'remove'
    ? textInput({
        class: `h-value${shown ? ' revealed' : ''}`,
        placeholder: header.secretId && secretIds.has(header.secretId)
          ? '\u2022'.repeat(12) + '  (stored)'
          : 'credential required',
        value: shown ? revealedValues.get(header.id) : '',
        /* Read-only rather than disabled once revealed, so the value can be
           selected and copied. Editing still goes through the credential
           dialog so it is written to the secret store. */
        readonly: shown ? true : null,
        disabled: shown ? null : true
      })
    : textInput({
        class: 'h-value',
        placeholder: header.operation === 'remove' ? 'removed from the request' : 'value',
        value: header.value,
        disabled: header.operation === 'remove',
        oninput: event => { header.value = event.target.value; touch(); }
      });

  const nameInput = textInput({
    class: 'h-name', placeholder: 'Header-Name', value: header.name,
    list: section === 'requestHeaders' ? 'request-header-names' : 'response-header-names',
    oninput: event => {
      const wasSensitive = isSensitiveHeader(header);
      header.name = event.target.value;
      flagRow(row, header);

      /* Typing a credential-bearing name mid-edit must swap the row over to
         the secret-store field immediately, or the user would be typing a
         credential straight into the profile object. */
      if (isSensitiveHeader(header) !== wasSensitive) {
        const caret = event.target.selectionStart;
        header.value = '';
        restructure();
        const again = $('content').querySelector(`.row-group[data-id="${header.id}"] .h-name`);
        if (again) {
          again.focus();
          try { again.setSelectionRange(caret, caret); } catch { /* ignore */ }
        }
        return;
      }
      touch();
    }
  });

  appendKids(row,
    checkbox(header, row),
    el('select', {
      class: 'op-select', title: 'What to do with this header',
      onchange: event => {
        header.operation = event.target.value;
        valueInput.disabled = header.operation === 'remove';
        valueInput.placeholder = header.operation === 'remove' ? 'removed from the request' : 'value';
        flagRow(row, header);
        restructure();
      }
    }, OPERATIONS.map(op => el('option', { value: op, selected: header.operation === op, text: op }))),
    el('div', { class: 'wire' },
      nameInput, el('span', { class: 'colon', text: ':' }), valueInput
    ),
    sensitive && header.operation !== 'remove' ? credentialChip(profile, header) : null,
    credentialToggle(header),
    commentToggle(header, wrapper),
    deleteButton(profile, section, header)
  );

  if (sensitive) row.classList.add('locked');
  flagRow(row, header);
  return wrapper;
}

/* FEATURE: let the user mark any header as credential-bearing, since the
   built-in list cannot know every vendor's header name. Auto-detected names
   cannot be un-marked. */
function credentialToggle(header) {
  const auto = isSensitiveHeaderName(header.name);
  const on = isSensitiveHeader(header);

  return el('button', {
    class: `mark-btn${on ? ' on' : ''}${auto ? ' locked-on' : ''}`,
    title: auto
      ? `${header.name} is always treated as a credential`
      : (on ? 'Marked as a credential \u2014 click to unmark'
            : 'Mark this header as a credential'),
    onclick: () => {
      if (auto) return flash(`${header.name} is always treated as a credential.`);
      header.sensitive = !header.sensitive;
      /* Moving into credential handling must not leave the typed value behind
         in the profile object. */
      if (header.sensitive) header.value = '';
      restructure();
    }
  }, icon('key', { size: 13 }));
}

/* The only entry point for editing a credential from a header row. Stored
   credentials get a separate reveal action so viewing and replacing are
   distinct, deliberate choices. */
function credentialChip(profile, header, listKey = null) {
  const stored = header.secretId && secretIds.has(header.secretId);
  const shared = header.secretId && secretRefCount(state, header.secretId) > 1;

  const commit = async changed => {
    if (!changed) return;
    await save({ now: true });
    await refreshAndRender();
    sec.notifyBackground('apply');
  };

  const setBtn = el('button', {
    class: `secret-chip${stored ? (shared ? ' shared' : '') : ' needs'}`,
    text: !stored ? 'Set credential' : (shared ? 'Shared' : 'Change'),
    title: shared
      ? 'Shared with another profile. Changing it affects both.'
      : 'Enter or replace the stored credential',
    onclick: async () => {
      if (!await sec.confirmSensitiveHost(profile, state)) return;
      await sec.warnInsecureHosts(profile, state);
      await commit(await sec.promptCredential(header, state));
    }
  });

  if (!stored) return setBtn;

  const shown = revealedHeaders.has(header.id);

  return el('span', { class: 'chip-pair' },
    el('button', {
      class: `secret-chip reveal${shown ? ' on' : ''}`,
      title: shown ? 'Hide the credential' : 'Show the credential',
      onclick: async () => {
        if (shown) {
          revealedHeaders.delete(header.id);
          revealedValues.delete(header.id);
          return restructure();
        }
        const value = await sec.revealCredentialValue(header, state);
        if (value == null) return;
        revealedHeaders.add(header.id);
        revealedValues.set(header.id, value);
        await refreshAndRender();
      }
    }, icon(shown ? 'eyeOff' : 'eye', { size: 13 })),
    setBtn
  );
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
  const wrapper = el('div', { class: 'row-group', dataset: { id: cookie.id } }, row);

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

  const sensitive = isSensitiveCookie(cookie);
  const shown = revealedHeaders.has(cookie.id) && revealedValues.has(cookie.id);

  /* A credential cookie behaves exactly like a credential header: the value
     lives in the secret store, and the field here is a placeholder. */
  const valueInput = sensitive
    ? textInput({
        class: `h-value${shown ? ' revealed' : ''}`,
        placeholder: cookie.secretId && secretIds.has(cookie.secretId)
          ? '\u2022'.repeat(10) + '  (stored)'
          : 'credential required',
        value: shown ? revealedValues.get(cookie.id) : '',
        readonly: shown ? true : null,
        disabled: shown ? null : true
      })
    : textInput({
        class: 'h-value', placeholder: 'value', value: cookie.value,
        oninput: event => { cookie.value = event.target.value; touch(); }
      });

  appendKids(row,
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
        oninput: event => {
          const was = isSensitiveCookie(cookie);
          cookie.name = event.target.value;
          /* Typing a credential cookie name mid-edit swaps the row over, so a
             secret is never typed into the profile object. */
          if (isSensitiveCookie(cookie) !== was) {
            const caret = event.target.selectionStart;
            cookie.value = '';
            restructure();
            const again = $('content').querySelector(`.row-group[data-id="${cookie.id}"] .h-name`);
            if (again) {
              again.focus();
              try { again.setSelectionRange(caret, caret); } catch { /* ignore */ }
            }
            return;
          }
          touch();
        }
      }),
      el('span', { class: 'colon', text: '=' }),
      valueInput
    ),
    sensitive ? credentialChip(profile, cookie, 'cookies') : null,
    cookieCredentialToggle(cookie),
    el('button', {
      class: 'note-btn', title: 'Cookie attributes',
      onclick: () => {
        expandedRows.has(attrsId) ? expandedRows.delete(attrsId) : expandedRows.add(attrsId);
        renderAttrs();
      }
    }, icon('gear', { size: 12 })),
    deleteButton(profile, 'cookies', cookie)
  );

  if (sensitive) row.classList.add('locked');
  renderAttrs();
  return wrapper;
}

/* Marks a cookie the built-in list does not recognise as credential-bearing. */
function cookieCredentialToggle(cookie) {
  const auto = isSensitiveCookieName(cookie.name);
  const on = isSensitiveCookie(cookie);

  return el('button', {
    class: `mark-btn${on ? ' on' : ''}${auto ? ' locked-on' : ''}`,
    title: auto
      ? `${cookie.name} is always treated as a credential`
      : (on ? 'Marked as a credential \u2014 click to unmark'
            : 'Mark this cookie as a credential'),
    onclick: () => {
      if (auto) return flash(`${cookie.name} is always treated as a credential.`);
      cookie.sensitive = !cookie.sensitive;
      if (cookie.sensitive) cookie.value = '';
      restructure();
    }
  }, icon('key', { size: 13 }));
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
      el('p', { class: 'empty-line', text: 'Content-Security-Policy: removed' }),
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
      class: 'del-btn', title: 'Remove this directive',
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
    el('span', { class: 'redirect-arrow' }, icon('redirect', { size: 13 })),
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

  if (state.settings.credentialStorage === 'vault' && !unlocked) {
    node.textContent = 'Vault locked. Protected profiles are inactive.';
    return;
  }

  if (blockedProfiles.length) {
    const first = blockedProfiles[0];
    node.classList.add('error');
    node.textContent = `${first.profileName}: ${describeBlock(first.reasons)}`;
    return;
  }

  const total = countActiveHeaders(state, id => (secretIds.has(id) ? '\u2022' : undefined));
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
  if (profileIsLocked(profile)) {
    flash('Unlock the vault to change this profile.');
    return;
  }
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

  $('btn-duplicate').onclick = async () => {
    const mode = await sec.chooseDuplicationMode(profile);
    if (!mode) return;

    const copy = structuredClone(profile);
    copy.id = crypto.randomUUID();
    copy.name = `${profile.name} copy`;
    for (const key of ['requestHeaders', 'responseHeaders', 'cookies', 'redirects', 'filters']) {
      copy[key].forEach(item => { item.id = crypto.randomUUID(); });
    }
    copy.csp.directives.forEach(d => { d.id = crypto.randomUUID(); });

    const needNewSecrets = sec.applyDuplicationMode(copy, mode);
    state.profiles.push(copy);
    state.activeProfileId = copy.id;
    closePopovers();

    for (const header of needNewSecrets) {
      await sec.promptCredential(header, state, {
        title: `New credential for ${header.name}`
      });
    }

    await save({ now: true });
    await refreshSecrets();
    renderAll();
    if (mode === 'share') flash('The copy shares the original credential. Changing it affects both.');
  };

  armConfirm($('btn-delete-profile'), 'Delete', 'Click again to delete', async () => {
    state.profiles = state.profiles.filter(p => p.id !== profile.id);
    if (!state.profiles.length) state.profiles.push(blankProfile(1, 0));
    state.activeProfileId = state.profiles[0].id;
    await save({ now: true });
    /* Only secrets no surviving profile references are removed, so a shared
       credential outlives the deletion of one of its users. */
    const removed = await sec.cleanupSecretsAfterDelete(state);
    await save({ now: true });
    await refreshSecrets();
    closePopovers();
    renderAll();
    if (removed.length) flash(`Profile deleted. ${removed.length} unused credential(s) removed.`);
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

function download(text, filename) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportFile() {
  closePopovers();
  const stamp = new Date().toISOString().slice(0, 10);
  const mode = await sec.chooseExportMode(state);
  if (!mode) return;

  if (mode === 'config') {
    const payload = await sec.buildExportPayload(state, { includeSecrets: false });
    download(JSON.stringify(payload, null, 2), `openmodheader-${stamp}.json`);
    return flash('Exported without credentials.');
  }

  if (mode === 'backup') {
    const backup = await sec.makeEncryptedBackup(state);
    if (!backup) return;
    download(JSON.stringify(backup, null, 2), `openmodheader-backup-${stamp}.json`);
    return flash('Encrypted backup created.');
  }

  if (!await sec.reauthenticate(state, 'export credentials in plain text')) return;
  const payload = await sec.buildExportPayload(state, { includeSecrets: true });
  download(JSON.stringify(payload, null, 2), `openmodheader-PLAINTEXT-${stamp}.json`);
  flash('Exported with credentials in plain text. Handle the file carefully.');
}

async function copyJson() {
  closePopovers();
  const mode = await sec.chooseCopyMode();
  if (!mode) return;

  if (mode === 'secrets'
      && !await sec.reauthenticate(state, 'copy credentials to the clipboard')) {
    return;
  }

  const payload = await sec.buildExportPayload(state, { includeSecrets: mode === 'secrets' });
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    flash(mode === 'secrets'
      ? 'Copied with credentials. Clipboard history tools may retain them.'
      : 'Copied without credentials.');
  } catch {
    flash('Could not reach the clipboard. Use the file export instead.');
  }
}

async function importFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return flash('That file is not valid OpenModHeader JSON.');
  }

  /* An encrypted backup needs its own passphrase before anything is read. */
  if (parsed?.kind === 'openmodheader-encrypted-backup') {
    const restored = await sec.restoreBackup(parsed);
    if (restored == null) return;
    if (restored === 'incorrect') return flash('That backup passphrase is not correct.');
    parsed = restored;
  }

  const carriesSecrets = collectImportedSecrets(parsed);
  if (carriesSecrets.count > 0
      && !await sec.confirmImportedCredentials(carriesSecrets.count, state)) {
    return;
  }

  let incoming;
  try {
    incoming = normalize(Array.isArray(parsed) ? { profiles: parsed } : parsed);
  } catch {
    return flash('That file is not valid OpenModHeader JSON.');
  }
  if (!incoming.profiles.length) return flash('That file contains no profiles.');

  /* Imported credentials are stored under the mode in force now, never the
     mode the file was written with. */
  const values = carriesSecrets.values;
  for (const profile of incoming.profiles) {
    for (const key of ['requestHeaders', 'responseHeaders']) {
      for (const header of profile[key]) {
        if (!isSensitiveHeader(header)) continue;
        header.sensitive = true;
        if (header.operation === 'remove') continue;

        const imported = values.get(`${profile.name}\u0000${header.name}`);
        if (imported != null && imported !== '') {
          header.secretId = header.secretId || blankSecretId();
          await sec.storeImportedSecret(header.secretId, imported, state);
          header.requiresCredential = false;
        } else {
          header.requiresCredential = true;
          if (!header.secretId) header.secretId = null;
        }
        header.value = '';
      }
    }
    /* An imported profile never inherits a global-sensitive override; it must
       be re-granted deliberately after review. */
    profile.allowGlobalSensitiveHeaders = false;
  }

  state.profiles = state.profiles.concat(incoming.profiles);
  state.activeProfileId = incoming.profiles[0].id;
  Object.assign(state.secretsMeta, incoming.secretsMeta);
  await save({ now: true });
  await refreshSecrets();
  renderAll();

  const locked = incoming.profiles.filter(p =>
    evaluateProfile(p, state.settings, { unlocked, resolvedIds: secretIds }).blocked).length;
  flash(locked
    ? `Imported ${incoming.profiles.length} profile(s). ${locked} need review before they activate.`
    : `Imported ${incoming.profiles.length} profile${incoming.profiles.length === 1 ? '' : 's'}.`);
}

/* Pulls plaintext credential values out of an imported payload, keyed by
   profile+header so they can be re-homed into the active store. */
function collectImportedSecrets(parsed) {
  const values = new Map();
  let count = 0;
  const profiles = Array.isArray(parsed) ? parsed : (parsed?.profiles || []);
  for (const profile of profiles) {
    for (const key of ['requestHeaders', 'responseHeaders']) {
      for (const header of profile?.[key] || []) {
        if (!isSensitiveHeader(header)) continue;
        const value = header.value;
        if (typeof value === 'string' && value !== '') {
          values.set(`${profile.name}\u0000${header.name}`, value);
          count++;
        }
      }
    }
  }
  return { values, count };
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

/* Re-reads which credentials are currently resolvable. Only ids are held in
   the popup; values stay in the store. */
async function refreshSecrets() {
  const wasUnlocked = unlocked;
  unlocked = state.settings.credentialStorage === 'vault' ? await isUnlocked() : true;
  if (wasUnlocked && !unlocked) hideAllCredentials();
  const secrets = await resolveSecrets(state.settings);
  secretIds = new Set(Object.keys(secrets).filter(id => secrets[id] !== ''));

  blockedProfiles = state.profiles
    .filter(p => p.enabled)
    .map(p => ({ p, v: evaluateProfile(p, state.settings, { unlocked, resolvedIds: secretIds }) }))
    .filter(x => x.v.hasSensitive && x.v.blocked)
    .map(x => ({ profileId: x.p.id, profileName: x.p.name, reasons: x.v.reasons }));
}

/* The one place that re-reads vault state and repaints. Every lock/unlock
   path goes through it, so the UI can never show stale lock status. */
async function refreshAndRender() {
  await refreshSecrets();
  renderAll();
}

/* Locking must take revealed values off the screen and out of memory. */
function hideAllCredentials() {
  revealedHeaders.clear();
  revealedValues.clear();
}

function renderBanners() {
  const vaultMode = state.settings.credentialStorage === 'vault';
  const lockBanner = $('lock-banner');
  const showLock = vaultMode && !unlocked;
  lockBanner.hidden = !showLock;
  if (showLock) {
    const n = state.profiles.filter(profileUsesCredentials).length;
    $('lock-text').textContent = n
      ? `Vault locked \u2014 ${n} profile${n === 1 ? '' : 's'} with credentials cannot be used or edited.`
      : 'The credential vault is locked.';
  }
  $('btn-lock').hidden = !(vaultMode && unlocked);

  /* Profiles blocked for a reason other than the lock get a quieter hint in
     the status bar rather than a second banner. */
  if (!showLock && blockedProfiles.length) {
    const first = blockedProfiles[0];
    $('status').title = `${first.profileName}: ${describeBlock(first.reasons)}`;
  }
}

async function checkMigrationBanner() {
  const bag = await api.storage.local.get('pendingMigration');
  const pending = bag.pendingMigration;
  const banner = $('migrate-banner');
  banner.hidden = !pending;
  if (!pending) return;
  $('migrate-text').textContent =
    `${pending.credentialCount} stored credential${pending.credentialCount === 1 ? '' : 's'} `
    + 'need a storage choice.';
}

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
  hydrateIcons();
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

  $('btn-security').addEventListener('click', () => {
    section = section === 'security' ? 'requestHeaders' : 'security';
    renderAll();
  });

  $('btn-back').addEventListener('click', () => {
    section = 'requestHeaders';
    renderAll();
  });

  $('btn-grant').addEventListener('click', requestAccess);

  $('btn-lock').addEventListener('click', async () => {
    await lock();
    sec.notifyBackground('lock');
    await refreshAndRender();
    const n = state.profiles.filter(profileUsesCredentials).length;
    flash(`Vault locked. ${n} profile${n === 1 ? '' : 's'} with credentials ${n === 1 ? 'is' : 'are'} now inactive.`);
  });

  $('btn-unlock').addEventListener('click', async () => {
    if (await sec.unlockFlow(state)) {
      await refreshAndRender();
      flash('Vault unlocked. Protected profiles are active again.');
    }
  });

  $('btn-migrate').addEventListener('click', async () => {
    const bag = await api.storage.local.get('pendingMigration');
    if (!bag.pendingMigration) return;
    if (await sec.runMigrationFlow(state, bag.pendingMigration)) {
      await save({ now: true });
      await refreshSecrets();
      await checkMigrationBanner();
      renderAll();
      sec.notifyBackground('apply');
      flash('Credential storage updated.');
    }
  });
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
    /* The background flips this when the auto-lock alarm fires, so the popup
       reflects a lock that happened while it was open. */
    if (changes.vaultUnlocked && changes.vaultUnlocked.newValue !== unlocked) {
      refreshAndRender();
    }
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
  await refreshSecrets();
  bind();
  renderAll();
  checkAccess();
  checkMigrationBanner();
  /* Opening the credential UI counts as deliberate activity. */
  noteActivity(ACTIVITY.openCredentialUi, state.settings);
}

init();
