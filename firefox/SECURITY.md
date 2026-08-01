# Credential security in OpenModHeader

OpenModHeader edits HTTP headers, and some headers carry credentials. This
document explains what the extension does to keep those credentials from
leaking, and — just as importantly — what it cannot do.

---

## Which headers are treated as sensitive

These names are recognised case-insensitively:

`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`,
`API-Key`, `Api-Key`, `ApiKey`, `X-Auth-Token`, `X-Access-Token`

Vendor-specific variants are matched by pattern, so `X-Acme-Api-Key`,
`X-Session-Token`, `X-Refresh-Token` and similar names are also protected.

### Cookies

Cookies get exactly the same treatment as headers, because a session cookie is
as much a credential as a bearer token.

These cookie names are recognised case-insensitively: `session`, `sessionid`,
`sid`, `sess`, `auth`, `token`, `access_token`, `refresh_token`, `jwt`,
`bearer`, `csrf`, `xsrf`, `remember_token`, `connect.sid`, `jsessionid`,
`phpsessid`, `laravel_session`, and similar. Patterns also catch names ending
in `_token`, `_auth`, `_secret`, `_key`, or containing a session id.

A recognised cookie's value moves into the secret store: it is encrypted in
vault mode, cleared on lock, revealed with the eye button, and omitted from
exports by default — all identically to a credential header.

Ordinary cookies such as `locale` or `theme` keep their value inline and are
not gated, because forcing a passphrase on a language preference would be
noise. Any cookie can be marked as a credential with the shield button on its
row when the built-in list does not recognise it.

**You can mark any header as a credential yourself.** Every header row has a
shield button; clicking it moves that header under credential handling even if
its name is not recognised. This matters because no built-in list can cover
every vendor's naming. Marking a header clears any value already typed into it,
so the value moves into the secret store rather than staying in the profile.

The flag only ever *adds* protection. Headers on the recognised list are always
treated as credentials and their shield cannot be switched off.

To recognise another header name, add one lowercase entry to
`SENSITIVE_HEADER_NAMES` in `security.js`. Nothing else hardcodes a name.

---

## Why host restrictions matter

A header rule with no URL filter applies to **every request your browser
makes**. For `X-Debug: 1` that is harmless. For `Authorization: Bearer …` it
means your token is sent to every site you visit, including sites with no
relationship to the service that issued it. Any of them can log it and replay
it.

So by default, a credential-bearing header will not activate until the profile
has at least one meaningful URL or host filter. A bare `*`, `<all_urls>` or
`^.*$` does not count — those restrict nothing.

If you genuinely need a credential everywhere, you can override the rule for a
single profile. The override is stored on that profile
(`allowGlobalSensitiveHeaders`), so accepting the risk once never weakens
protection for your other profiles.

Host restrictions are the protection that keeps working even when everything
else has failed, because they limit *where* a credential can go.

### HTTPS

You are warned when a credential profile targets a plain `http://` host,
because the credential travels unencrypted and anyone on the network path can
read it. Local development addresses (`localhost`, `127.0.0.1`, `[::1]`,
`*.local`) are exempt — you are not prevented from doing local HTTP work.

---

## The three storage modes

### Session only (default)

Credentials live in `storage.session`, which is memory-only and never written
to disk.

- They survive closing the popup, switching tabs, and the browser suspending
  the extension's background worker.
- They are gone when the browser session ends, the extension reloads, or the
  browser clears extension session storage.
- After they are cleared, your profiles, filters and header names are all still
  there — the profile is simply marked as needing a credential, and its
  protected rules stay inactive until you re-enter one.

### Encrypted vault

Credentials are encrypted with a key derived from your passphrase and stored as
ciphertext in `storage.local`.

- The decrypted values and the derived key live only in `storage.session`.
- After a browser or extension restart, the vault is locked and you must enter
  the passphrase again.
- While unlocked, protected rules are installed as session rules.
- When locked, all sensitive session rules are removed and every decrypted
  value and key is cleared. The ciphertext and your non-sensitive
  configuration are untouched.

### What locking actually does

Locking the vault freezes **any profile that contains credentials**:

- Its rules stop being applied.
- It cannot be viewed or edited in the popup — the profile shows an unlock
  panel instead of its rows, and its settings menu is unavailable.
- Its configuration is fully preserved. Nothing is deleted.

**Profiles with no credentials are completely unaffected.** You can open, edit,
add to and delete them normally while the vault is locked, and those changes
are saved as usual. Locking is about credentials, not about disabling the
extension.

Profile tabs holding credentials show a padlock, and the status bar states how
many profiles are affected whenever the lock state changes.

### Viewing a stored credential

A header with a stored credential has two controls: an eye button that reveals
the current value, and a button that replaces it.

**Unlocking the vault is the authentication step.** While it is unlocked, the
eye button shows the value immediately — no second passphrase prompt. That is
not a shortcut: the derived key is already cached in session storage, so
asking again would be a dialog box, not a cryptographic control. Anything able
to bypass the prompt could read the key just as easily.

When the vault is **locked**, clicking the eye routes through the normal unlock
flow. One prompt, not two.

There is an optional setting, *Also ask before viewing a credential in the
popup*, off by default. It is worth turning on for a shared machine, where the
threat is someone sitting at your keyboard in front of an already-unlocked
popup. In that mode the passphrase does real work: it re-derives the key from
the vault salt and decrypts that single record from ciphertext, ignoring the
cached key entirely.

Exporting and clipboard copies are different, and still re-authenticate by
default: their output leaves the browser, so the extra confirmation is worth
the friction.

### What is actually held in memory while unlocked

Unlocking caches **only the derived key**, in `storage.session`. Credentials
are decrypted from ciphertext on demand when rules are built. Earlier designs
wrote every decrypted credential into session storage on unlock; that is no
longer done, so an unlocked vault does not leave a readable list of all your
credentials sitting in a storage area.

Be clear about what this does and does not buy. Anything that can execute code
in the extension's context while the vault is unlocked can use the cached key
to decrypt everything. Not caching plaintext raises the effort and shrinks the
resting footprint; it does not change the fundamental position. Whenever rules
are applied automatically without you typing anything, the extension must be
able to reach the plaintext, and so can anything with equivalent access. **Lock
the vault, or let auto-lock do it, when you are away from the machine.**

Credentials are encrypted and written the moment you finish editing them —
not deferred until the popup closes or the browser exits.

### Persistent plaintext — not recommended

This is the extension's original behaviour, kept for people who need it.

- Credentials are stored **unencrypted** in your browser profile directory.
- Anything that can read that directory can read your credentials, and they
  remain readable after the browser closes.
- On Chromium they continue to use dynamic rules, as before.
- Switching to this mode requires an explicit confirmation.

Reasonable for throwaway or non-production values. Not appropriate for
anything that matters.

---

## After a browser restart

| Mode | What happens |
|---|---|
| Session only | Credentials are gone. Profiles are preserved and marked as needing credentials. |
| Encrypted vault | Vault is locked. Enter your passphrase to reactivate protected profiles. |
| Persistent plaintext | Credentials are still active. |

In every mode, profile names, filters, exclusions, ordering, enabled state,
redirects, CSP settings and non-sensitive headers survive a restart.

---

## What the 15-minute timeout measures

The auto-lock timer measures time since your last **deliberate credential
action**:

- unlocking the vault
- creating or editing a credential
- enabling a protected profile
- revealing a credential
- copying or exporting credentials
- opening the credential-management interface

It deliberately does **not** count network requests. Browsing a site that uses
one of your profiles will not hold the vault open — otherwise a background tab
polling an API would keep it unlocked forever.

The duration is configurable, and automatic locking can be switched off
entirely (the vault still locks on restart). There is a **Lock now** action in
the title bar and in the Security panel.

Locking is scheduled with the browser alarms API rather than a timer, because
Manifest V3 can suspend the background worker at any moment. The intended lock
time is stored in session storage, and because alarms can fire late, the
deadline is re-checked when the alarm arrives.

---

## Exports and the clipboard

**Exports** offer three choices, defaulting to the safest:

1. **Configuration only** *(default)* — profiles, filters, redirects and
   non-sensitive values. Credentials become `"value": null,
   "requiresCredential": true`. The import works fine and stays locked until
   you supply the values.
2. **Encrypted backup with credentials** — available in vault mode. Requires
   your passphrase again even if the vault is already unlocked, and produces an
   encrypted file carrying its own salt and KDF parameters so it can be
   restored elsewhere.
3. **Plaintext export with credentials** — warned about explicitly, never the
   default. Anyone who opens the file can read every credential in it.

**Clipboard copies** default to omitting credentials. Copying *with*
credentials requires re-authentication, and warns that clipboard-history tools
may retain the value. The extension does not claim it can clear your clipboard
afterwards, because it cannot.

**Imports** detect whether a file carries omitted credentials, plaintext
credentials, or an encrypted backup. Plaintext credentials are never activated
silently: you are told they are present and asked first. Imported credentials
are stored under *your current* mode, not the mode the file was written with.
An imported profile never inherits permission to send credentials globally —
host restrictions are re-checked before it activates.

---

## Duplicating and deleting profiles

Duplicating a profile that uses credentials offers three options, defaulting to
the safest:

- **Configuration only** *(default)* — the copy has no credentials and stays
  locked.
- **Reuse the existing credential** — both profiles reference the same stored
  secret. No second copy of the ciphertext is created. Changing the credential
  affects every profile using it, and the UI marks the header as shared.
- **New independent credential** — a new secret is created and you are prompted
  for its value.

Deleting a profile never deletes a credential another profile still
references. Secrets that no profile references any more are cleaned up.

---

## The limits of client-side encryption

Please read this part.

The encrypted vault protects credentials **at rest**. If someone copies your
browser profile off disk, recovers it from a backup, or reads a synced copy,
they cannot recover your credentials without the passphrase.

It does **not** protect against:

- **Malware running as your user account.** While the vault is unlocked, the
  decrypted credentials are in browser memory by definition. Anything with that
  level of access can read them.
- **A compromised or malicious extension**, including a hostile update of this
  one. Extension storage is not a security boundary against extension code.
- **You sending the credential somewhere you did not intend.** That is what
  host restrictions are for, and they keep working in cases where encryption
  does not.
- **A hostile server you have legitimately configured.** If a profile is
  scoped to a host, the credential goes to that host.

A passphrase you can remember is also, generally, a passphrase that can be
guessed given the ciphertext. PBKDF2 with 600,000 SHA-256 iterations makes that
expensive rather than impossible. Use a long passphrase.

---

## Resetting a forgotten passphrase

There is no recovery mechanism, by design — a backdoor would defeat the
encryption.

**Security → Reset vault** permanently deletes every encrypted credential. It
warns you first. Your profiles, filters, redirects and non-sensitive headers
are kept; protected headers simply ask for a new credential.

---

## Cross-browser differences

| | Chromium | Firefox |
|---|---|---|
| Engine | `declarativeNetRequest` | blocking `webRequest` |
| Sensitive rules, session/vault mode | Session rules (`updateSessionRules`) | Resolved per request from session storage |
| Sensitive rules, plaintext mode | Dynamic rules, as before | Same code path as other modes |
| When a credential is missing | The whole sensitive rule is withheld | Only the protected operation is skipped |

The Firefox behaviour is more precise: because `webRequest` inspects each
request in JavaScript, a locked credential skips just that one header operation
while the rest of the profile keeps working. On Chromium the sensitive rule is
a separate rule object, so the whole rule is withheld — non-sensitive rules in
the same profile are unaffected either way.

On Chromium, sensitive session rules occupy a reserved rule-id band
(≥ 100000). Locking removes only that band, so tab-scoped and non-sensitive
rules are never disturbed.

Both builds share `security.js`, `vault.js`, `secretstore.js` and `common.js`
byte-for-byte, so the two browsers cannot disagree about whether a profile is
allowed to activate.

`storage.session` is required for session-only and encrypted-vault modes. It is
available in Chrome 102+ and Firefox 115+, which both builds already require.
If it is somehow unavailable, the extension fails closed — it will not quietly
fall back to storing a credential persistently.

---

## Migration for existing users

If you have profiles from before this feature, the extension detects
credentials stored inline and shows a banner. Nothing is deleted and nothing is
changed until you choose.

You pick one of the three storage modes, including staying on persistent
plaintext. Your credentials are then moved into that store.

Old Chromium dynamic rules containing credentials are removed as part of the
migration, so a stale plaintext rule can never be active alongside a new
session rule.

The migration is idempotent: a header that has already been migrated is left
alone, so an interrupted migration simply resumes. All profile names, filters,
exclusions, ordering, enabled state, redirects and non-sensitive headers are
preserved exactly.

---

## Reporting a problem

If you find a way to make the extension send a credential somewhere it should
not, or to recover one from disk without the passphrase, that is a security bug
and worth reporting rather than filing as a feature request.
