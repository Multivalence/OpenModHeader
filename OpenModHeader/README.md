# OpenModHeader

A Chrome extension for adding, rewriting, and removing HTTP request and response headers. Built on Manifest V3 and `declarativeNetRequest`.

## Install

1. Unzip this folder somewhere permanent — Chrome loads it from disk every time it starts, so don't leave it in Downloads.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `OpenModHeader` folder.
5. Pin it from the puzzle-piece menu in the toolbar.

Chrome will ask for "Read and change all your data on all websites". Rewriting headers on arbitrary URLs is exactly what that permission covers.

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
