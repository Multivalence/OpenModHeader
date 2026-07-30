# OpenModHeader

A Chrome/Firefox extension for adding, rewriting, and removing HTTP request and response headers.

## Install on Chrome

1. Unzip somewhere permanent. Chrome reads the folder from disk at every startup, so don't leave it in Downloads.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `chrome` folder.
3. Pin it from the puzzle-piece menu.

Site access is granted at install and stays granted.

## Install on Firefox

**For a session, no signing needed:**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and pick any file inside the `firefox` folder, such as `manifest.json`.

Temporary add-ons are removed when Firefox restarts. That is fine for trying it out, less fine for daily use.

**To keep it permanently,** release and Beta Firefox require a signed add-on, so pick one of:

- **Sign it yourself.** Zip the *contents* of the `firefox` folder (the manifest must sit at the archive root, not inside a subfolder), then submit it to [addons.mozilla.org](https://addons.mozilla.org/developers/) as an **unlisted** add-on. Mozilla signs it and hands back an `.xpi` that installs permanently and stays private. This is the intended route for personal extensions and usually takes a few minutes.
- **Turn signing off.** Only Developer Edition, Nightly, and ESR allow this: set `xpinstall.signatures.required` to `false` in `about:config`, then install the zip renamed to `.xpi`. Release and Beta ignore this setting.

The `web-ext` CLI (`npx web-ext run` and `npx web-ext sign`) automates both paths if you'd rather not click through.

### Site access on Firefox

Firefox treats host access as something you can revoke at any moment, from the extensions button in the toolbar. If access is missing, the popup shows a red bar with a **Grant access** button. If you'd rather do it manually, use the extensions button in the toolbar and choose to always allow OpenModHeader on all sites.

Firefox also never re-prompts when an update asks for new host permissions, which is why the popup re-checks every time you open it.

## Using it

**Request / Response tabs** hold the headers themselves. Each row is one header:

| Control | What it does |
|---|---|
| Checkbox | Turns that single header on or off without deleting it |
| `set` | Adds the header, replacing any existing value |
| `append` | Adds another copy alongside the existing value |
| `remove` | Strips the header from the request or response |
| Name : Value | The header itself, in wire order |

**Filters tab** scopes the open profile. With no filters, the profile applies to every URL.

| Filter | Example | Notes |
|---|---|---|
| URL contains | `api.example.com/v2` | Plain substring match |
| URL matches regex | `^https://[a-z]+\.example\.com/` | RE2 syntax |
| Exclude domains | `ads.com, tracker.io` | Comma-separated; matches subdomains too |
| Resource types | `xmlhttprequest, main_frame` | Comma-separated, from the list below |

Valid resource types: `main_frame`, `sub_frame`, `stylesheet`, `script`, `image`, `font`, `object`, `xmlhttprequest`, `ping`, `csp_report`, `media`, `websocket`, `other`.

Multiple filters of the same kind are combined with OR — a header applies if any one of them matches.

**Profiles** are independent header sets. Click a profile tab to open it; click the open one again for its name, colour, duplicate, and delete controls. Every enabled profile is live at once, so you can layer an "auth token" profile over a "feature flags" profile.

**The toggle in the title bar** turns everything off without losing your setup. `Alt+Shift+H` does the same from anywhere. The toolbar badge shows how many headers are currently live, or `off`.

**The ⋯ menu** exports and imports profiles as JSON, so you can share a setup with a teammate or check one into a repo. Import adds to what you have rather than replacing it.

## Things Chrome imposes

- **Header names are lowercased.** This matches HTTP/2 and HTTP/3, and servers treat header names case-insensitively.
- **`append` only works on some request headers.** Chrome's allowlist is `accept`, `accept-encoding`, `accept-language`, `access-control-request-headers`, `cache-control`, `connection`, `content-language`, `cookie`, `forwarded`, `if-match`, `if-none-match`, `keep-alive`, `range`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `user-agent`, `via`, `want-digest`, and `x-forwarded-for`. Rows that break this rule get a red outline; use `set` instead. Response headers can be appended freely.
- **A few headers can't be touched at all.** Chrome reserves some for its own use. If the rule engine turns a rule down, the reason appears in the status bar at the bottom of the popup.
- **Already-loaded resources keep their old headers.** New requests pick up changes straight away; reload the page for the rest.
- **Limits:** 5000 rules total and 1000 regex rules. Each profile compiles to one rule per URL filter, so you would need a very large setup to reach either.
- **Profiles live in local storage**, not synced storage, so they stay on this machine. Use export/import to move them.

## Files

| File | Role |
|---|---|
| `manifest.json` | Permissions, service worker, popup, keyboard shortcut |
| `common.js` | State model, JSON normalisation, and the rule compiler |
| `background.js` | Watches state, updates dynamic rules, drives the badge |
| `popup.html` / `popup.css` / `popup.js` | The interface |
| `icons/` | Toolbar and store icons |

`common.js` is shared by the service worker and the popup, so the rules the popup describes and the rules Chrome enforces are compiled by the same code.

## Debugging

To see which rules actually matched a request, add `"declarativeNetRequestFeedback"` to the `permissions` array in `manifest.json` and reload the extension. You can then call `chrome.declarativeNetRequest.getMatchedRules()` from the service worker console, reachable via the **service worker** link on the extension's card in `chrome://extensions`.

To inspect the compiled rules at any time, open that same console and run:

```js
chrome.declarativeNetRequest.getDynamicRules().then(console.log)
```
