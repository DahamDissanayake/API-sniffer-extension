# API Sniffer — Chrome Extension (Manifest V3) Design

## Purpose

A Chrome extension that passively captures every fetch/XHR request a website makes, filters
out static assets to isolate real API calls, stores them locally per origin, and provides a
side panel UI to browse, inspect, and manually replay any captured request with its original
headers and body. A personal, always-on, per-site Postman that builds itself as you browse.

Strictly local-only: no external servers, no analytics, no data leaving the browser.

## Architecture & data flow

```
Page (MAIN world)
  └─ content-script-hook.js (world: MAIN, document_start)
       hooks window.fetch + XHR.prototype.open/send
       └─ postMessage → content-script-bridge.js (ISOLATED world)
            └─ chrome.runtime.sendMessage → background.js (service worker)
                                                   │
                                    ┌──────────────┼───────────────────┐
                                    ▼                                  ▼
                          chrome.webRequest listeners          utils/storage.js
                          (onBeforeRequest/onSendHeaders/       (chrome.storage.local,
                           onCompleted) — cross-check only)      keyed by origin)
                                                                       │
                                                                       ▼
                                                              sidepanel.js/html/css
                                                          (reads storage, renders list,
                                                           handles replay + settings)
```

Two capture paths feed the same background pipeline: the MAIN-world hook (primary, has full
request/response body access) and `webRequest` (fallback/cross-check — catches requests the
hook might miss, e.g. from workers, but cannot see response bodies, only metadata/headers).
`background.js` is the single place that normalizes, dedupes, throttles, and writes to
storage, so both paths converge before anything is persisted.

**Why two content-script files:** Manifest V3 requires `"world": "MAIN"` scripts to be
isolated from extension APIs (`chrome.runtime` is not available in MAIN world). The hook
script runs in MAIN world and does `window.postMessage`; a small ISOLATED-world bridge script
listens for that postMessage and relays via `chrome.runtime.sendMessage`. This is the only
supported way to get MAIN-world captured data into the extension's storage.

## Storage schema & normalization

Storage backend: `chrome.storage.local` with the `unlimitedStorage` permission (avoids the
default ~10MB cap). One top-level key per origin to keep reads/writes scoped:

```js
"endpoints::https://api.example.com": {
  "GET /api/tickets/{id}": {
    method: "GET",
    pattern: "/api/tickets/{id}",
    origin: "https://api.example.com",
    tag: "json",              // "json" | "form" | "other"
    firstSeen: 169..., lastSeen: 169...,
    hitCount: 42,
    statusCodes: [200, 404],
    authWarning: false,       // true if headers look signed/time-sensitive
    lastFullSampleAt: 169...,
    samples: [                // ring buffer, max 5 most recent full samples
      {
        url: "/api/tickets/123?expand=notes",
        requestHeaders: {...},   // cookies stripped, never persisted
        requestBody: "...",
        responseBody: "...",     // truncated at 50KB, truncated:true flag if cut
        responseHeaders: {...},
        status: 200,
        timestamp: 169...
      }
    ]
  }
}
```

**Normalization** (`utils/urlNormalizer.js`): split the path into segments; replace a segment
with `{id}` if it matches:
- numeric: `^\d+$`
- UUID (v1–v5 pattern)
- long hex/hash: `^[0-9a-f]{16,}$` (case-insensitive)

Query strings are stripped from the pattern key but the concrete URL (with query) is kept on
each sample. Dedup key = `METHOD + normalized path`, scoped within an origin.

**Poll throttle**: each endpoint entry tracks `lastFullSampleAt`. A new hit only pushes a new
full sample if `now - lastFullSampleAt >= throttleWindowMs` (default 30000ms, user-adjustable
in Settings); otherwise the hit only bumps `hitCount`, `lastSeen`, and `statusCodes`.

**Auth warning heuristic**: a request/response header name matching
`/auth|signature|token|hmac|nonce/i` whose value looks opaque (base64/hex-like, length > 20)
sets `authWarning: true` on the endpoint, surfaced as a UI badge: "may contain time-sensitive
auth, replay may fail".

**Pruning**: a settings-configurable `retentionDays` (default 30). `background.js` runs a
cleanup pass on extension startup and once per day via `chrome.alarms`, dropping endpoint
entries whose `lastSeen` is older than the cutoff. Manual "Clear this domain" / "Clear all
data" buttons are also available in Settings.

## Filtering & classification

Applied in the bridge/background layer, not the hook — the hook captures everything so
nothing is lost before classification:

- Drop by resource type: image/font/css/script/media/favicon, checked via `Content-Type`
  response header where available, and URL file-extension heuristics for cases where headers
  aren't yet accessible (e.g. XHR at `open()` time).
- Keep only requests captured as `fetch`/`XHR` (automatic for the hook path, since it only
  ever sees these two APIs). For the `webRequest` fallback, filter to `type: "xmlhttprequest"`.
- Tag `application/json` / `application/x-www-form-urlencoded` (request or response) as
  `tag: "json"`/`"form"` (prioritized in UI ordering/emphasis); everything else is still
  captured and tagged `"other"`, shown lower/dimmer — nothing is silently hidden.

Cookies are stripped from stored request headers entirely; they are never persisted to
`chrome.storage.local`, only used live at replay time via page-context injection.

## Replay flow

1. Side panel sends `{action: "replay", endpointKey, editedRequest}` to `background.js`.
2. Background finds a tab matching the endpoint's origin via `chrome.tabs.query`. If found, it
   calls `chrome.scripting.executeScript` with `world: "MAIN"` on that tab, passing the edited
   method/URL/headers/body as function arguments. The injected function runs `fetch(...)` from
   inside the page's own context — cookies attach natively since it's a same-origin request,
   no `cookies` permission needed.
3. If no matching tab is open, the side panel shows: "No open tab for this origin — open the
   site in a tab to replay with its session, or the request will run cookie-less from the
   extension context," with a "replay anyway" fallback that runs the fetch directly from
   `background.js` (no cookies attached, clearly labeled as such in the response panel).
4. The injected function's result (status, headers, body) is returned through
   `executeScript`'s return value to background, then to the side panel, and rendered inline
   under the Replay form (status, headers, pretty-printed/raw-toggle JSON body).

**Copy as curl**: pure client-side string-building (`utils/curl.js`) from the endpoint's last
sample (method, URL, headers, body). Cookies are never included in curl output; a one-line
comment in the generated command notes this.

## UI

Side panel (`chrome.sidePanel`, requires Chrome 114+) with two views via a top-tab toggle:
**Endpoints** (default) and **Settings**.

- **Endpoints view**: search/filter bar (path substring match) at top; list of collapsed cards
  — `METHOD` badge, path pattern, hit count, last-seen relative time, tag (json/form/other),
  auth-warning badge if flagged — sorted by `lastSeen` descending, scoped to the active tab's
  origin (re-queries on `chrome.tabs.onActivated`/`onUpdated`).
- **Expanded card**: sub-tabs for Headers / Request Body / Response Body / Sample history, all
  in monospace; "Replay" and "Copy as curl" buttons.
- **Replay form**: inline editable method, URL (with param editor), headers (key/value list),
  and body (textarea), pre-filled from the endpoint's last sample. "Send" triggers the replay
  flow above; response renders below the form.
- **Settings view**: retention days (number input), poll-throttle window in ms (number
  input), "Clear this domain" / "Clear all data" (with confirm step).
- **Style**: white background, light-gray (`#e5e5e5`-ish) borders/dividers, no bright accent
  colors — status text limited to muted green/red for 2xx vs 4xx/5xx. Monospace
  (`ui-monospace, "SF Mono", Consolas, monospace`) for URLs/headers/JSON/bodies; system
  sans-serif for labels, nav, and buttons.

## Manifest & permissions

```json
{
  "manifest_version": 3,
  "permissions": ["storage", "webRequest", "activeTab", "scripting", "sidePanel", "tabs", "alarms", "unlimitedStorage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["content-script-hook.js"], "world": "MAIN", "run_at": "document_start" },
    { "matches": ["<all_urls>"], "js": ["content-script-bridge.js"], "run_at": "document_start" }
  ],
  "side_panel": { "default_path": "sidepanel.html" }
}
```

- `side_panel` requires Chrome 114+.
- `"world": "MAIN"` as a content_scripts manifest key requires Chrome 111+ (older approach
  needed manual `<script>` tag injection — not used here since the target is a recent Chrome).
- `<all_urls>` is required because capture must work on any site browsed to. README documents
  scoping `matches` down to specific site patterns for personal hardening (this will trigger a
  broad permissions warning if ever published — acceptable for personal unpacked use).

## File structure

```
manifest.json
background.js                 (webRequest listeners, storage writes, replay handling)
content-script-hook.js         (MAIN world: fetch/XHR hooking)
content-script-bridge.js       (ISOLATED world: relays hook messages to background)
sidepanel.html / sidepanel.js / sidepanel.css
utils/urlNormalizer.js         (path pattern normalization)
utils/storage.js               (read/write wrapper over chrome.storage.local)
utils/curl.js                  (copy-as-curl string builder)
icons/ (16/48/128 placeholder icons)
README.md
```

## Edge cases

- **Signed/rotating auth tokens** (HMAC signatures, ticketing/banking-style APIs): still
  captured and displayed, tagged with the `authWarning` badge described above. Replay may
  fail because the signature/nonce has expired — expected behavior, not a bug, and called out
  in the README.
- **Large response bodies**: truncated to 50KB in storage with a `truncated: true` flag;
  side panel shows a "response was truncated" notice when rendering such a sample.
- **High-frequency polling endpoints**: throttled per the poll-throttle window above so
  storage writes stay bounded regardless of polling rate.

## Out of scope / non-goals

- No external network calls of any kind (no analytics, no remote sync).
- No IndexedDB — `chrome.storage.local` with `unlimitedStorage` is sufficient given
  truncation + pruning.
- No cross-device sync; data is local to the one Chrome profile/machine.
