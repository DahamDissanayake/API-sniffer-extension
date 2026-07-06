# API Sniffer

A Manifest V3 Chrome extension that passively captures every fetch/XHR request a site makes,
filters out static assets, stores real API calls locally per origin, and lets you inspect and
replay any of them from a side panel — with the page's real session cookies attached where
possible. Strictly local-only: no external servers, no analytics, nothing leaves the browser.

## Loading the unpacked extension

1. Open `chrome://extensions`.
2. Enable "Developer mode" (top-right toggle).
3. Click "Load unpacked" and select this project's root directory.
4. Click the API Sniffer toolbar icon on any site to open the side panel.

Requires **Chrome 114+** (the `chrome.sidePanel` API's minimum version). The MAIN-world
content script hook requires **Chrome 111+**.

## How it works

- `content-script-hook.js` runs in the page's own JS world (`"world": "MAIN"`, injected at
  `document_start`, before the page's own scripts run) and overrides `window.fetch` and
  `XMLHttpRequest.prototype.open/send` to capture every request's method, URL, headers, and
  request/response bodies.
- `content-script-bridge.js` runs in the extension's isolated world on the same page and
  relays what the hook captures into the extension via `chrome.runtime.sendMessage` (the MAIN
  world cannot call `chrome.*` APIs directly — this two-script split is required by Chrome).
- `background.js` (the service worker) also runs `chrome.webRequest` listeners as a
  fallback/cross-check for requests the hook might miss (e.g. from a worker). It normalizes
  URLs (collapsing `/tickets/123` and `/tickets/456` into `/tickets/{id}`), classifies content
  type, flags likely time-sensitive auth headers, and writes everything to
  `chrome.storage.local`, one key per origin.
- The side panel (`sidepanel.html/js/css`) reads that storage for the active tab's origin,
  lets you browse/search captured endpoints, and replay them.

## Replaying with cookies

Extensions cannot cleanly attach a page's session cookies to a `fetch` call made from their
own background/side-panel context. API Sniffer works around this by injecting the replay
`fetch` call directly into the target tab via `chrome.scripting.executeScript({ world: "MAIN"
})` — since that runs as same-origin JS inside the actual page, the browser attaches cookies
exactly as it would for any request the page itself makes. This requires the site's tab to
still be open. If it isn't, the side panel offers a "replay anyway" fallback that runs the
`fetch` from the extension's own context instead — cookie-less, and clearly labeled as such in
the response panel.

## Permissions

- `host_permissions: ["<all_urls>"]` is required so capture works on every site you browse to,
  not just ones you've pre-approved. To restrict this extension to specific sites, replace
  `<all_urls>` in `manifest.json`'s `host_permissions` **and** the `content_scripts.matches`
  arrays **and** the `urls` filters in `background.js`'s four `chrome.webRequest.*` listeners
  (`onBeforeRequest`, `onSendHeaders`, `onErrorOccurred`, `onCompleted`) with explicit origins,
  e.g. `"https://your-app.example.com/*"`. Note that `<all_urls>`
  triggers a broad permissions warning if you ever package and publish this extension — fine
  for personal unpacked use, worth narrowing before sharing.
- `unlimitedStorage` avoids `chrome.storage.local`'s default ~10MB cap, since captured bodies
  can add up across many sites.
- `webRequest`, `scripting`, `tabs`, `activeTab`, `sidePanel`, `alarms`, `storage` back the
  capture fallback, replay injection, tab lookup, side panel UI, and daily pruning described
  above, respectively.

## Chrome API limitations encountered

- **`chrome.webRequest` cannot read response bodies at all** — this is a hard platform
  limitation (not a missing permission). The webRequest listeners in `background.js` are
  therefore metadata-only (method/URL/headers/status) and exist purely as a fallback for
  requests the MAIN-world hook doesn't see; full request/response body capture only comes
  through the fetch/XHR hook.
- **MAIN-world content scripts can't call `chrome.*` APIs directly** — hence the
  hook/bridge split (`content-script-hook.js` / `content-script-bridge.js`) via
  `window.postMessage`.
- **`"world": "MAIN"` as a static `content_scripts` manifest key requires Chrome 111+**, and
  **`chrome.sidePanel` requires Chrome 114+**. Older Chrome versions are not supported.
- **Cookies can't be forwarded to an extension-context `fetch` call directly** — see
  "Replaying with cookies" above for the same-origin injection workaround this extension uses.
- **The MAIN-world hook cannot cryptographically distinguish its own captures from a
  spoofed message** — since `content-script-hook.js` runs in the page's own JS realm
  (not a privileged context), any other script on the page could post a same-shaped
  `window.postMessage` and have it relayed into storage indistinguishably from a real
  capture. Accepted as a reasonable tradeoff for a personal, local-only tool rather than
  adding a shared-secret handshake.

## Known limitations (by design, not bugs)

- **Signed/rotating auth tokens** (HMAC signatures, nonces, ticketing/banking-style APIs) are
  captured and displayed with an "auth-warning" badge, but replay will often fail once the
  signature or nonce has expired — this is expected, since the whole point of those schemes is
  that they can't be replayed later.
- **Large response bodies** are truncated to 50KB in storage; the side panel shows a
  "[response was truncated]" notice when displaying a truncated sample.
- **High-frequency polling endpoints** only get a fresh full sample stored once per throttle
  window (default 30s, adjustable in Settings) to keep `chrome.storage.local` writes bounded;
  every hit in between still bumps the hit count and last-seen time.
