# API Sniffer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 Chrome extension ("API Sniffer") that passively captures fetch/XHR API calls per site, stores them locally (deduped/normalized by path pattern), and lets the user browse, inspect, and replay them from a side panel — with replayed requests carrying the page's real session cookies via same-origin injection.

**Architecture:** A MAIN-world content script hooks `window.fetch`/`XMLHttpRequest`, relays captures through an ISOLATED-world bridge to a background service worker via `chrome.runtime.sendMessage`. `webRequest` listeners in the service worker act as a metadata-only fallback/cross-check. The service worker owns all `chrome.storage.local` reads/writes (one key per origin) and handles replay by injecting a `fetch` call into the target tab's MAIN world via `chrome.scripting.executeScript`. A side panel UI (two views: Endpoints, Settings) talks to the service worker exclusively via `chrome.runtime.sendMessage`.

**Tech Stack:** Vanilla JS, Manifest V3 (no bundler, no framework). Node.js built-in test runner (`node --test`) for pure-logic unit tests; no external npm dependencies.

## Global Constraints

- Chrome version floor: 111+ (required for `"world": "MAIN"` in `content_scripts`), 114+ (required for `chrome.sidePanel`). Call this out in README.
- No external network calls anywhere in the extension — no analytics, no remote sync, no CDN-loaded scripts.
- No build step. All files are plain `<script>`-loadable JS; ES module syntax (`import`/`export`) is not used anywhere.
- Shared logic modules under `utils/` use a **dual-export pattern** so the same file works as a CommonJS module (for Node tests), a classic-service-worker `importScripts` target, and a browser `<script>` tag:
  ```js
  const api = { /* ... */ };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof globalThis !== "undefined") globalThis.<namespace> = api;
  ```
  Namespaces used: `urlNormalizer`, `classify`, `curlBuilder`, `dedup`, `headerUtils`, `storage`.
- Storage keys: per-origin endpoint data at `endpoints::<origin>`; global settings at `settings` (`{ retentionDays, throttleWindowMs }`, defaults `{ retentionDays: 30, throttleWindowMs: 30000 }`).
- Message types passed to `chrome.runtime.sendMessage` (all handled in `background.js`): `capture`, `getEndpoints`, `getSettings`, `setSettings`, `clearDomain`, `clearAll`, `replay`, `replayCookieless`.
- Testing approach: pure logic (`utils/*.js` minus the `chrome.storage.local` IO wrappers) gets `node --test` unit tests with zero mocking. Code that only functions inside a real Chrome extension context (content scripts, `background.js` glue, `sidepanel.js` DOM/message code) is verified manually by loading the unpacked extension — there is no bundler/headless-browser harness in this project, so each such task's steps spell out exact manual verification clicks/console commands instead of an automated test command.
- JSON does not support comments, so the `host_permissions: ["<all_urls>"]` rationale (and how to scope it down) lives in `README.md`, not inline in `manifest.json`.

---

### Task 1: Project scaffolding

**Files:**
- Create: `manifest.json`
- Create: `package.json`
- Create: `README.md` (stub, finalized in Task 13)
- Create: `sidepanel.css` (stub, filled in Task 11)

**Interfaces:**
- Produces: the manifest wiring every other task's files into (`background.js`, `content-script-hook.js`, `content-script-bridge.js`, `sidepanel.html`, `utils/headers.js`). Later tasks create these referenced files.

- [ ] **Step 1: Create `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "API Sniffer",
  "version": "0.1.0",
  "description": "Passively captures fetch/XHR API calls per site and lets you inspect and replay them.",
  "permissions": ["storage", "webRequest", "activeTab", "scripting", "sidePanel", "tabs", "alarms", "unlimitedStorage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "action": {},
  "side_panel": { "default_path": "sidepanel.html" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["utils/headers.js", "content-script-hook.js"],
      "world": "MAIN",
      "run_at": "document_start"
    },
    {
      "matches": ["<all_urls>"],
      "js": ["content-script-bridge.js"],
      "run_at": "document_start"
    }
  ]
}
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "api-sniffer",
  "version": "0.1.0",
  "private": true,
  "description": "Chrome extension that captures and replays API calls per site.",
  "scripts": {
    "test": "node --test test/"
  }
}
```

- [ ] **Step 3: Create stub `README.md`**

```markdown
# API Sniffer

A Manifest V3 Chrome extension that passively captures API calls per site and lets you
inspect and replay them. See the full documentation in this file once the build is complete
(Task 13 of the implementation plan finalizes this section).
```

- [ ] **Step 4: Create stub `sidepanel.css`**

```css
/* Filled in by Task 11 */
```

- [ ] **Step 5: Verify Node test runner works with an empty test directory**

Run: `mkdir test && node --test test/`
Expected: Node reports `0 tests ... pass 0 fail 0` (no error), confirming Node 18+'s built-in test runner is available before later tasks add real tests.

- [ ] **Step 6: Commit**

```bash
git add manifest.json package.json README.md sidepanel.css
git commit -m "Scaffold API Sniffer extension project"
```

---

### Task 2: URL path normalization (`utils/urlNormalizer.js`)

**Files:**
- Create: `utils/urlNormalizer.js`
- Test: `test/urlNormalizer.test.js`

**Interfaces:**
- Produces: `normalizePath(pathname: string) -> string`, `buildEndpointKey(method: string, normalizedPath: string) -> string`. Consumed by `utils/storage.js` (Task 7) and `background.js` (Task 9).

- [ ] **Step 1: Write the failing tests**

Create `test/urlNormalizer.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePath, buildEndpointKey } = require("../utils/urlNormalizer.js");

test("collapses numeric id segments", () => {
  assert.equal(normalizePath("/api/tickets/123"), "/api/tickets/{id}");
});

test("collapses uuid segments", () => {
  assert.equal(
    normalizePath("/api/users/550e8400-e29b-41d4-a716-446655440000"),
    "/api/users/{id}"
  );
});

test("collapses long hex hash segments", () => {
  assert.equal(normalizePath("/api/objects/5f2d3c1a9b8e7d6c"), "/api/objects/{id}");
});

test("leaves non-id segments untouched", () => {
  assert.equal(normalizePath("/api/tickets/open"), "/api/tickets/open");
});

test("handles root path", () => {
  assert.equal(normalizePath("/"), "/");
});

test("buildEndpointKey combines method and pattern", () => {
  assert.equal(buildEndpointKey("get", "/api/tickets/{id}"), "GET /api/tickets/{id}");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/urlNormalizer.test.js`
Expected: FAIL — `Cannot find module '../utils/urlNormalizer.js'`

- [ ] **Step 3: Implement `utils/urlNormalizer.js`**

```js
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const NUMERIC_RE = /^\d+$/;

function normalizePath(pathname) {
  if (!pathname) return "/";
  const segments = pathname.split("/");
  const normalized = segments.map((segment) => {
    if (segment.length === 0) return segment;
    if (NUMERIC_RE.test(segment) || UUID_RE.test(segment) || HEX_RE.test(segment)) {
      return "{id}";
    }
    return segment;
  });
  return normalized.join("/");
}

function buildEndpointKey(method, normalizedPath) {
  return `${method.toUpperCase()} ${normalizedPath}`;
}

const api = { normalizePath, buildEndpointKey };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.urlNormalizer = api;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/urlNormalizer.test.js`
Expected: PASS — 6 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add utils/urlNormalizer.js test/urlNormalizer.test.js
git commit -m "Add URL path normalization for endpoint deduplication"
```

---

### Task 3: Request/response classification (`utils/classify.js`)

**Files:**
- Create: `utils/classify.js`
- Test: `test/classify.test.js`

**Interfaces:**
- Produces: `isStaticAsset(url: string, contentType?: string) -> boolean`, `classifyContentType(headers: object, body?: string) -> "json"|"form"|"other"`, `hasAuthWarning(headers: object) -> boolean`. Consumed by `background.js` (Task 9).

- [ ] **Step 1: Write the failing tests**

Create `test/classify.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { isStaticAsset, classifyContentType, hasAuthWarning } = require("../utils/classify.js");

test("flags image content-type as static", () => {
  assert.equal(isStaticAsset("https://x.com/thing", "image/png"), true);
});

test("flags font/css/js extensions as static", () => {
  assert.equal(isStaticAsset("https://x.com/app.css", undefined), true);
  assert.equal(isStaticAsset("https://x.com/font.woff2", undefined), true);
  assert.equal(isStaticAsset("https://x.com/bundle.js", undefined), true);
});

test("does not flag a JSON API path as static", () => {
  assert.equal(isStaticAsset("https://x.com/api/tickets/123", "application/json"), false);
});

test("classifies application/json header as json", () => {
  assert.equal(classifyContentType({ "content-type": "application/json; charset=utf-8" }), "json");
});

test("classifies form-urlencoded header as form", () => {
  assert.equal(
    classifyContentType({ "content-type": "application/x-www-form-urlencoded" }),
    "form"
  );
});

test("classifies parseable JSON body with no content-type as json", () => {
  assert.equal(classifyContentType({}, '{"ok":true}'), "json");
});

test("classifies unrecognized content as other", () => {
  assert.equal(classifyContentType({ "content-type": "text/plain" }, "hello"), "other");
});

test("flags long opaque authorization header value", () => {
  assert.equal(
    hasAuthWarning({ Authorization: "Bearer abcdef0123456789abcdef0123456789" }),
    true
  );
});

test("does not flag short header values", () => {
  assert.equal(hasAuthWarning({ "X-Token": "abc" }), false);
});

test("does not flag unrelated headers", () => {
  assert.equal(hasAuthWarning({ Accept: "application/json; charset=utf-8-and-then-some" }), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/classify.test.js`
Expected: FAIL — `Cannot find module '../utils/classify.js'`

- [ ] **Step 3: Implement `utils/classify.js`**

```js
const STATIC_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|css|js|mp4|webm|mp3|wav|avif)(\?|$)/i;
const STATIC_CONTENT_TYPES = /^(image|font|text\/css|video|audio)\//i;
const AUTH_HEADER_NAME_RE = /auth|signature|token|hmac|nonce/i;

function isStaticAsset(url, contentType) {
  if (contentType && STATIC_CONTENT_TYPES.test(contentType)) return true;
  if (STATIC_EXTENSIONS.test(url)) return true;
  return false;
}

function classifyContentType(headers, body) {
  const contentType = (headers && (headers["content-type"] || headers["Content-Type"])) || "";
  if (/application\/json/i.test(contentType)) return "json";
  if (/application\/x-www-form-urlencoded/i.test(contentType)) return "form";
  if (typeof body === "string") {
    const trimmed = body.trim();
    const looksLikeJson =
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"));
    if (looksLikeJson) {
      try {
        JSON.parse(trimmed);
        return "json";
      } catch (e) {
        // not actually valid JSON, fall through to "other"
      }
    }
  }
  return "other";
}

function hasAuthWarning(headers) {
  if (!headers) return false;
  return Object.entries(headers).some(([name, value]) => {
    if (!AUTH_HEADER_NAME_RE.test(name)) return false;
    return typeof value === "string" && value.length > 20;
  });
}

const api = { isStaticAsset, classifyContentType, hasAuthWarning };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.classify = api;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/classify.test.js`
Expected: PASS — 10 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add utils/classify.js test/classify.test.js
git commit -m "Add static-asset filtering and content classification"
```

---

### Task 4: curl command builder (`utils/curl.js`)

**Files:**
- Create: `utils/curl.js`
- Test: `test/curl.test.js`

**Interfaces:**
- Produces: `buildCurlCommand(request: { method, url, headers?, body? }) -> string`. Consumed by `sidepanel.js` (Task 12).

- [ ] **Step 1: Write the failing tests**

Create `test/curl.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCurlCommand } = require("../utils/curl.js");

test("builds a basic GET command", () => {
  const cmd = buildCurlCommand({ method: "GET", url: "https://api.example.com/tickets" });
  assert.match(cmd, /curl -X GET 'https:\/\/api\.example\.com\/tickets'/);
});

test("includes headers except cookie", () => {
  const cmd = buildCurlCommand({
    method: "GET",
    url: "https://api.example.com/tickets",
    headers: { Accept: "application/json", Cookie: "session=abc", cookie: "session=abc" },
  });
  assert.match(cmd, /-H 'Accept: application\/json'/);
  // Not asserting the whole output lacks the word "cookie" — the builder's own
  // disclaimer comment legitimately contains it. This checks specifically that
  // no -H flag carries a Cookie header.
  assert.doesNotMatch(cmd, /-H '[Cc]ookie:/);
});

test("includes body with -d for non-GET requests", () => {
  const cmd = buildCurlCommand({
    method: "POST",
    url: "https://api.example.com/tickets",
    body: '{"title":"hi"}',
  });
  assert.match(cmd, /-d '\{"title":"hi"\}'/);
});

test("escapes single quotes in values", () => {
  const cmd = buildCurlCommand({ method: "GET", url: "https://api.example.com/it's-fine" });
  assert.match(cmd, /it'\\''s-fine/);
});

test("includes a comment noting cookies are excluded", () => {
  const cmd = buildCurlCommand({ method: "GET", url: "https://api.example.com/x" });
  assert.match(cmd, /^# cookies are not included/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/curl.test.js`
Expected: FAIL — `Cannot find module '../utils/curl.js'`

- [ ] **Step 3: Implement `utils/curl.js`**

```js
function shellEscape(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildCurlCommand(request) {
  const { method, url, headers = {}, body } = request;
  const parts = [`curl -X ${method.toUpperCase()}`, shellEscape(url)];

  for (const [name, value] of Object.entries(headers)) {
    if (/^cookie$/i.test(name)) continue;
    parts.push(`-H ${shellEscape(`${name}: ${value}`)}`);
  }

  if (body) {
    parts.push(`-d ${shellEscape(body)}`);
  }

  return `# cookies are not included; add -b '<cookie>' manually if needed\n${parts.join(" ")}`;
}

const api = { buildCurlCommand };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.curlBuilder = api;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/curl.test.js`
Expected: PASS — 5 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add utils/curl.js test/curl.test.js
git commit -m "Add copy-as-curl command builder"
```

---

### Task 5: webRequest/hook dedup (`utils/dedup.js`)

**Files:**
- Create: `utils/dedup.js`
- Test: `test/dedup.test.js`

**Interfaces:**
- Produces: `shouldSkipWebRequestFallback(recentHookCaptures: Map<string, number>, method: string, url: string, now: number, windowMs?: number) -> boolean`. Consumed by `background.js` (Task 9).

- [ ] **Step 1: Write the failing tests**

Create `test/dedup.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldSkipWebRequestFallback } = require("../utils/dedup.js");

test("skips when hook captured the same method+url recently", () => {
  const recent = new Map([["GET https://x.com/api/a", 1000]]);
  assert.equal(shouldSkipWebRequestFallback(recent, "GET", "https://x.com/api/a", 1500), true);
});

test("does not skip when nothing recent matches", () => {
  const recent = new Map();
  assert.equal(shouldSkipWebRequestFallback(recent, "GET", "https://x.com/api/a", 1500), false);
});

test("does not skip once outside the dedup window", () => {
  const recent = new Map([["GET https://x.com/api/a", 1000]]);
  assert.equal(
    shouldSkipWebRequestFallback(recent, "GET", "https://x.com/api/a", 5000, 1000),
    false
  );
});

test("method is case-insensitive when matching", () => {
  const recent = new Map([["GET https://x.com/api/a", 1000]]);
  assert.equal(shouldSkipWebRequestFallback(recent, "get", "https://x.com/api/a", 1200), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/dedup.test.js`
Expected: FAIL — `Cannot find module '../utils/dedup.js'`

- [ ] **Step 3: Implement `utils/dedup.js`**

```js
function shouldSkipWebRequestFallback(recentHookCaptures, method, url, now, windowMs = 1000) {
  const key = `${method.toUpperCase()} ${url}`;
  const seenAt = recentHookCaptures.get(key);
  if (seenAt === undefined) return false;
  return now - seenAt <= windowMs;
}

const api = { shouldSkipWebRequestFallback };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.dedup = api;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/dedup.test.js`
Expected: PASS — 4 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add utils/dedup.js test/dedup.test.js
git commit -m "Add hook/webRequest capture deduplication"
```

---

### Task 6: Raw header parsing (`utils/headers.js`)

**Files:**
- Create: `utils/headers.js`
- Test: `test/headers.test.js`

**Interfaces:**
- Produces: `parseRawHeaderString(raw: string) -> object`. Consumed by `content-script-hook.js` (Task 8), loaded there via the manifest's MAIN-world `content_scripts` array (see Task 1) so `globalThis.headerUtils` is available before that script runs.

- [ ] **Step 1: Write the failing tests**

Create `test/headers.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRawHeaderString } = require("../utils/headers.js");

test("parses a multi-line raw header string", () => {
  const raw = "Content-Type: application/json\r\nX-Request-Id: abc123\r\n";
  assert.deepEqual(parseRawHeaderString(raw), {
    "Content-Type": "application/json",
    "X-Request-Id": "abc123",
  });
});

test("returns empty object for empty input", () => {
  assert.deepEqual(parseRawHeaderString(""), {});
  assert.deepEqual(parseRawHeaderString(null), {});
});

test("handles values containing colons", () => {
  const raw = "Date: Mon, 06 Jul 2026 10:00:00 GMT";
  assert.deepEqual(parseRawHeaderString(raw), { Date: "Mon, 06 Jul 2026 10:00:00 GMT" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/headers.test.js`
Expected: FAIL — `Cannot find module '../utils/headers.js'`

- [ ] **Step 3: Implement `utils/headers.js`**

```js
function parseRawHeaderString(raw) {
  const result = {};
  if (!raw) return result;
  raw
    .trim()
    .split(/[\r\n]+/)
    .forEach((line) => {
      const idx = line.indexOf(":");
      if (idx > -1) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        result[key] = value;
      }
    });
  return result;
}

const api = { parseRawHeaderString };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.headerUtils = api;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/headers.test.js`
Expected: PASS — 3 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add utils/headers.js test/headers.test.js
git commit -m "Add raw HTTP header string parsing"
```

---

### Task 7: Storage schema, merge, truncation, and pruning (`utils/storage.js`)

**Files:**
- Create: `utils/storage.js`
- Test: `test/storage.test.js`

**Interfaces:**
- Consumes: `urlNormalizer.buildEndpointKey` (Task 2).
- Produces (pure, unit-tested): `truncateBody(body?: string) -> {body, truncated}`, `stripCookies(headers?: object) -> object`, `mergeCapture(originData: object, capture: object, opts?: {throttleWindowMs}) -> object`, `pruneOldEndpoints(originData: object, retentionDays: number, now: number) -> object`.
- Produces (chrome IO wrappers, not unit-tested — require a real `chrome` runtime; verified manually in Task 9): `getOriginData(origin)`, `setOriginData(origin, data)`, `getSettings()`, `setSettings(settings)`, `clearDomain(origin)`, `clearAllData()`, `pruneAllOrigins()`.
- The `capture` object passed into `mergeCapture` has shape: `{ method, origin, normalizedPath, tag, authWarning, url, requestHeaders, requestBody, responseHeaders, responseBody, status, timestamp }`. This exact shape is produced by `background.js`'s `ingestCapture` in Task 9.

- [ ] **Step 1: Write the failing tests**

Create `test/storage.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { truncateBody, stripCookies, mergeCapture, pruneOldEndpoints } = require("../utils/storage.js");

test("truncateBody leaves short bodies untouched", () => {
  assert.deepEqual(truncateBody("short"), { body: "short", truncated: false });
});

test("truncateBody cuts bodies over 50000 chars", () => {
  const long = "x".repeat(50010);
  const result = truncateBody(long);
  assert.equal(result.body.length, 50000);
  assert.equal(result.truncated, true);
});

test("truncateBody passes through non-string bodies", () => {
  assert.deepEqual(truncateBody(undefined), { body: undefined, truncated: false });
});

test("stripCookies removes cookie and set-cookie case-insensitively", () => {
  const result = stripCookies({ Cookie: "a=1", "Set-Cookie": "b=2", Accept: "json" });
  assert.deepEqual(result, { Accept: "json" });
});

test("mergeCapture creates a new endpoint entry on first sight", () => {
  const capture = {
    method: "GET",
    origin: "https://api.example.com",
    normalizedPath: "/api/tickets/{id}",
    tag: "json",
    authWarning: false,
    url: "/api/tickets/123",
    requestHeaders: { Accept: "json" },
    requestBody: undefined,
    responseHeaders: { "content-type": "application/json" },
    responseBody: '{"id":123}',
    status: 200,
    timestamp: 1000,
  };
  const result = mergeCapture({}, capture);
  const entry = result["GET /api/tickets/{id}"];
  assert.equal(entry.hitCount, 1);
  assert.equal(entry.firstSeen, 1000);
  assert.equal(entry.lastSeen, 1000);
  assert.deepEqual(entry.statusCodes, [200]);
  assert.equal(entry.samples.length, 1);
  assert.equal(entry.samples[0].url, "/api/tickets/123");
});

test("mergeCapture increments hitCount without a new full sample inside the throttle window", () => {
  const first = mergeCapture(
    {},
    {
      method: "GET",
      origin: "https://api.example.com",
      normalizedPath: "/api/tickets/{id}",
      tag: "json",
      authWarning: false,
      url: "/api/tickets/123",
      requestHeaders: {},
      responseHeaders: {},
      responseBody: "{}",
      status: 200,
      timestamp: 1000,
    },
    { throttleWindowMs: 30000 }
  );
  const second = mergeCapture(
    first,
    {
      method: "GET",
      origin: "https://api.example.com",
      normalizedPath: "/api/tickets/{id}",
      tag: "json",
      authWarning: false,
      url: "/api/tickets/456",
      requestHeaders: {},
      responseHeaders: {},
      responseBody: "{}",
      status: 200,
      timestamp: 5000,
    },
    { throttleWindowMs: 30000 }
  );
  const entry = second["GET /api/tickets/{id}"];
  assert.equal(entry.hitCount, 2);
  assert.equal(entry.samples.length, 1);
  assert.equal(entry.samples[0].url, "/api/tickets/123");
});

test("mergeCapture adds a new full sample once the throttle window elapses", () => {
  const first = mergeCapture(
    {},
    {
      method: "GET",
      origin: "https://api.example.com",
      normalizedPath: "/api/tickets/{id}",
      tag: "json",
      authWarning: false,
      url: "/api/tickets/123",
      requestHeaders: {},
      responseHeaders: {},
      responseBody: "{}",
      status: 200,
      timestamp: 1000,
    },
    { throttleWindowMs: 30000 }
  );
  const second = mergeCapture(
    first,
    {
      method: "GET",
      origin: "https://api.example.com",
      normalizedPath: "/api/tickets/{id}",
      tag: "json",
      authWarning: false,
      url: "/api/tickets/456",
      requestHeaders: {},
      responseHeaders: {},
      responseBody: "{}",
      status: 200,
      timestamp: 40000,
    },
    { throttleWindowMs: 30000 }
  );
  const entry = second["GET /api/tickets/{id}"];
  assert.equal(entry.hitCount, 2);
  assert.equal(entry.samples.length, 2);
  assert.equal(entry.samples[0].url, "/api/tickets/456");
});

test("mergeCapture caps stored samples at 5", () => {
  let data = {};
  for (let i = 0; i < 7; i++) {
    data = mergeCapture(
      data,
      {
        method: "GET",
        origin: "https://api.example.com",
        normalizedPath: "/api/tickets/{id}",
        tag: "json",
        authWarning: false,
        url: `/api/tickets/${i}`,
        requestHeaders: {},
        responseHeaders: {},
        responseBody: "{}",
        status: 200,
        timestamp: i * 40000,
      },
      { throttleWindowMs: 30000 }
    );
  }
  assert.equal(data["GET /api/tickets/{id}"].samples.length, 5);
});

test("mergeCapture truncates oversized response bodies", () => {
  const result = mergeCapture(
    {},
    {
      method: "GET",
      origin: "https://api.example.com",
      normalizedPath: "/api/x",
      tag: "json",
      authWarning: false,
      url: "/api/x",
      requestHeaders: {},
      responseHeaders: {},
      responseBody: "y".repeat(60000),
      status: 200,
      timestamp: 1000,
    }
  );
  const sample = result["GET /api/x"].samples[0];
  assert.equal(sample.responseTruncated, true);
  assert.equal(sample.responseBody.length, 50000);
});

test("pruneOldEndpoints drops entries older than retentionDays", () => {
  const now = 1000 * 60 * 60 * 24 * 40; // day 40
  const data = {
    "GET /old": { lastSeen: 0 },
    "GET /recent": { lastSeen: now - 1000 },
  };
  const result = pruneOldEndpoints(data, 30, now);
  assert.deepEqual(Object.keys(result), ["GET /recent"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/storage.test.js`
Expected: FAIL — `Cannot find module '../utils/storage.js'`

- [ ] **Step 3: Implement `utils/storage.js`**

```js
const urlNormalizerRef =
  typeof require !== "undefined" && typeof module !== "undefined"
    ? require("./urlNormalizer.js")
    : globalThis.urlNormalizer;

const MAX_SAMPLES = 5;
const MAX_BODY_BYTES = 50000;
const DEFAULT_SETTINGS = { retentionDays: 30, throttleWindowMs: 30000 };

function truncateBody(body) {
  if (typeof body !== "string") return { body, truncated: false };
  if (body.length <= MAX_BODY_BYTES) return { body, truncated: false };
  return { body: body.slice(0, MAX_BODY_BYTES), truncated: true };
}

function stripCookies(headers) {
  if (!headers) return {};
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^(cookie|set-cookie)$/i.test(name)) continue;
    result[name] = value;
  }
  return result;
}

function mergeCapture(originData, capture, opts = {}) {
  const throttleWindowMs = opts.throttleWindowMs ?? DEFAULT_SETTINGS.throttleWindowMs;
  const now = capture.timestamp;
  const key = urlNormalizerRef.buildEndpointKey(capture.method, capture.normalizedPath);
  const data = { ...originData };
  const existing = data[key];
  const { body: truncatedResponseBody, truncated: responseTruncated } = truncateBody(
    capture.responseBody
  );

  const sampleFromCapture = () => ({
    url: capture.url,
    requestHeaders: capture.requestHeaders,
    requestBody: capture.requestBody,
    responseBody: truncatedResponseBody,
    responseTruncated,
    responseHeaders: capture.responseHeaders,
    status: capture.status,
    timestamp: now,
  });

  if (!existing) {
    data[key] = {
      method: capture.method,
      pattern: capture.normalizedPath,
      origin: capture.origin,
      tag: capture.tag,
      firstSeen: now,
      lastSeen: now,
      hitCount: 1,
      statusCodes: capture.status ? [capture.status] : [],
      authWarning: !!capture.authWarning,
      lastFullSampleAt: now,
      samples: [sampleFromCapture()],
    };
    return data;
  }

  const entry = { ...existing };
  entry.lastSeen = now;
  entry.hitCount = existing.hitCount + 1;
  entry.authWarning = existing.authWarning || !!capture.authWarning;
  entry.statusCodes =
    capture.status && !existing.statusCodes.includes(capture.status)
      ? [...existing.statusCodes, capture.status]
      : existing.statusCodes;

  const sinceLastFullSample = now - (existing.lastFullSampleAt ?? 0);
  if (sinceLastFullSample >= throttleWindowMs) {
    entry.lastFullSampleAt = now;
    entry.samples = [sampleFromCapture(), ...existing.samples].slice(0, MAX_SAMPLES);
  }

  data[key] = entry;
  return data;
}

function pruneOldEndpoints(originData, retentionDays, now) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const result = {};
  for (const [key, entry] of Object.entries(originData)) {
    if (entry.lastSeen >= cutoff) result[key] = entry;
  }
  return result;
}

function originStorageKey(origin) {
  return `endpoints::${origin}`;
}

async function getOriginData(origin) {
  const key = originStorageKey(origin);
  const result = await chrome.storage.local.get(key);
  return result[key] || {};
}

async function setOriginData(origin, data) {
  const key = originStorageKey(origin);
  await chrome.storage.local.set({ [key]: data });
}

async function getSettings() {
  const result = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
}

async function setSettings(settings) {
  const current = await getSettings();
  await chrome.storage.local.set({ settings: { ...current, ...settings } });
}

async function clearDomain(origin) {
  await chrome.storage.local.remove(originStorageKey(origin));
}

async function clearAllData() {
  const all = await chrome.storage.local.get(null);
  const endpointKeys = Object.keys(all).filter((k) => k.startsWith("endpoints::"));
  await chrome.storage.local.remove(endpointKeys);
}

async function pruneAllOrigins() {
  const settings = await getSettings();
  const all = await chrome.storage.local.get(null);
  const updates = {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith("endpoints::")) continue;
    updates[key] = pruneOldEndpoints(value, settings.retentionDays, Date.now());
  }
  await chrome.storage.local.set(updates);
}

const api = {
  truncateBody,
  stripCookies,
  mergeCapture,
  pruneOldEndpoints,
  getOriginData,
  setOriginData,
  getSettings,
  setSettings,
  clearDomain,
  clearAllData,
  pruneAllOrigins,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.storage = api;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/storage.test.js`
Expected: PASS — 10 tests, 0 failures

- [ ] **Step 5: Run the full test suite to confirm nothing regressed**

Run: `npm test`
Expected: All test files pass (urlNormalizer, classify, curl, dedup, headers, storage)

- [ ] **Step 6: Commit**

```bash
git add utils/storage.js test/storage.test.js
git commit -m "Add endpoint merge, truncation, and pruning logic"
```

---

### Task 8: Capture hook (content-script-hook.js + content-script-bridge.js)

**Files:**
- Create: `content-script-hook.js`
- Create: `content-script-bridge.js`

**Interfaces:**
- Consumes: `globalThis.headerUtils.parseRawHeaderString` (Task 6, loaded first in the same MAIN-world content_scripts array per `manifest.json`).
- Produces: `window.postMessage({ source: "api-sniffer-hook", payload: {...} }, "*")` from the hook, relayed by the bridge as `chrome.runtime.sendMessage({ type: "capture", payload })`. The `payload` shape — `{ method, url, requestHeaders, requestBody, responseHeaders, responseBody, status, timestamp }` — is what `background.js`'s `ingestCapture` (Task 9) consumes.
- No automated tests: this file only functions inside a live page/extension context. Verified manually in Step 3 below.

- [ ] **Step 1: Implement `content-script-hook.js`**

```js
(function hookFetch() {
  const originalFetch = window.fetch;

  window.fetch = async function patchedFetch(input, init) {
    const startTime = Date.now();
    const method = (init && init.method) || (typeof input !== "string" && input && input.method) || "GET";
    // Resolve against the page's own location: a plain string `input` is very often
    // relative (fetch('/api/foo')), and capturing it as-is would let background.js
    // resolve it against the extension's own origin instead of the page's — silently
    // misattributing the endpoint to the wrong domain. Request/URL objects already
    // carry an absolute URL, so this is a no-op for them.
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, location.href).href;

    const requestHeaders = {};
    if (init && init.headers) {
      new Headers(init.headers).forEach((value, key) => {
        requestHeaders[key] = value;
      });
    }
    const requestBody = init && typeof init.body === "string" ? init.body : undefined;

    const response = await originalFetch.call(this, input, init);

    // Read headers synchronously and the body asynchronously, without awaiting the
    // body before returning `response` to the page. Native fetch() resolves as soon
    // as headers arrive, independent of body consumption — awaiting cloned.text()
    // here would hang the page's own fetch() promise forever on a long-lived/streamed
    // response (SSE-over-fetch, chunked NDJSON, etc), which breaks "passive" capture.
    const cloned = response.clone();
    const responseHeaders = {};
    cloned.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    cloned
      .text()
      .then((responseBody) => {
        window.postMessage(
          {
            source: "api-sniffer-hook",
            payload: {
              method: method.toUpperCase(),
              url,
              requestHeaders,
              requestBody,
              responseHeaders,
              responseBody,
              status: response.status,
              timestamp: startTime,
            },
          },
          "*"
        );
      })
      .catch(() => {
        // Body unreadable or never completes (e.g. an infinite stream) — nothing to capture.
      });

    return response;
  };
})();

(function hookXHR() {
  const XHRProto = XMLHttpRequest.prototype;
  const originalOpen = XHRProto.open;
  const originalSend = XHRProto.send;
  const originalSetRequestHeader = XHRProto.setRequestHeader;

  XHRProto.open = function patchedOpen(method, url, ...rest) {
    // Same relative-URL concern as the fetch hook above: xhr.open('GET', '/api/foo')
    // is common and must resolve against the page's own location, not the extension's.
    const absoluteUrl = new URL(url, location.href).href;
    this.__apiSniffer = { method: method.toUpperCase(), url: absoluteUrl, requestHeaders: {}, startTime: Date.now() };
    return originalOpen.call(this, method, url, ...rest);
  };

  XHRProto.setRequestHeader = function patchedSetRequestHeader(name, value) {
    if (this.__apiSniffer) {
      this.__apiSniffer.requestHeaders[name] = value;
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  XHRProto.send = function patchedSend(body) {
    if (this.__apiSniffer) {
      this.__apiSniffer.requestBody = typeof body === "string" ? body : undefined;
      this.addEventListener("loadend", () => {
        const responseHeaders = headerUtils.parseRawHeaderString(this.getAllResponseHeaders());
        // Reading .responseText throws InvalidStateError when responseType is anything
        // other than "" or "text" (a common case: responseType = "json"). Branch on
        // responseType instead of relying on a typeof check after the throw already happened.
        let responseBody;
        if (this.responseType === "" || this.responseType === "text") {
          responseBody = typeof this.responseText === "string" ? this.responseText : undefined;
        } else if (this.responseType === "json") {
          responseBody = this.response !== null && this.response !== undefined ? JSON.stringify(this.response) : undefined;
        } else {
          responseBody = undefined; // arraybuffer/blob/document: not safely capturable as text
        }
        window.postMessage(
          {
            source: "api-sniffer-hook",
            payload: {
              method: this.__apiSniffer.method,
              url: this.__apiSniffer.url,
              requestHeaders: this.__apiSniffer.requestHeaders,
              requestBody: this.__apiSniffer.requestBody,
              responseHeaders,
              responseBody,
              status: this.status,
              timestamp: this.__apiSniffer.startTime,
            },
          },
          "*"
        );
      });
    }
    return originalSend.call(this, body);
  };
})();
```

- [ ] **Step 2: Implement `content-script-bridge.js`**

```js
// Trust note: this only filters on message shape (same-window + a matching `source`
// tag), not authenticity. Because content-script-hook.js runs in the page's own MAIN
// world (not a privileged context), any script on the page could post a
// same-shaped message and have it relayed indistinguishably from a genuine capture.
// Accepted for a personal, local-only tool — see README's "Chrome API limitations".
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "api-sniffer-hook") return;
  chrome.runtime.sendMessage({ type: "capture", payload: event.data.payload }).catch(() => {
    // Extension context may be invalidated (e.g. reloaded) mid-page-life; safe to ignore.
  });
});
```

- [ ] **Step 3: Manual verification**

1. Open `chrome://extensions`, enable Developer Mode, click "Load unpacked", select this project's directory.
2. Open any site that makes fetch/XHR calls (e.g. `https://httpbin.org` or any JSON-backed app).
3. Open that page's DevTools Console and run: `fetch('https://httpbin.org/get').then(r => r.json())`.
4. In the same Console, run: `window.postMessage` should not be needed — instead confirm the hook installed by checking `window.fetch.toString()` includes `patchedFetch`.
5. Open the extension's service worker console (`chrome://extensions` → API Sniffer → "service worker" link) and run `chrome.storage.local.get(null, console.log)` — expect to see nothing yet (background.js doesn't exist until Task 9), but no errors should appear in either console. This confirms the hook fires and the bridge attempts `chrome.runtime.sendMessage` without throwing.

- [ ] **Step 4: Commit**

```bash
git add content-script-hook.js content-script-bridge.js
git commit -m "Add fetch/XHR capture hook and MAIN-to-ISOLATED world bridge"
```

---

### Task 9: Background capture pipeline

**Files:**
- Create: `background.js`

**Interfaces:**
- Consumes: `urlNormalizer.normalizePath` (Task 2), `classify.isStaticAsset`/`classifyContentType`/`hasAuthWarning` (Task 3), `dedup.shouldSkipWebRequestFallback` (Task 5), `storage.getSettings`/`getOriginData`/`setOriginData`/`stripCookies` (Task 7). Loaded via `importScripts(...)` at the top of `background.js`.
- Consumes: `{ type: "capture", payload }` messages sent by `content-script-bridge.js` (Task 8).
- Produces: an internal `ingestCapture(payload)` function and `recentHookCaptures` Map, both consumed by the webRequest fallback listeners added in this same task, and (for `recentHookCaptures`) referenced again in no other task — it is fully internal to `background.js`.

- [ ] **Step 1: Implement the capture pipeline in `background.js`**

```js
importScripts(
  "utils/urlNormalizer.js",
  "utils/classify.js",
  "utils/curl.js",
  "utils/dedup.js",
  "utils/storage.js"
);

const recentHookCaptures = new Map();
const pendingRequestData = new Map(); // requestId -> { method, url, headers, body }

function cleanupRecentHookCaptures() {
  const cutoff = Date.now() - 5000;
  for (const [key, ts] of recentHookCaptures) {
    if (ts < cutoff) recentHookCaptures.delete(key);
  }
}

async function ingestCapture(payload) {
  const contentType =
    (payload.responseHeaders &&
      (payload.responseHeaders["content-type"] || payload.responseHeaders["Content-Type"])) ||
    "";
  if (classify.isStaticAsset(payload.url, contentType)) return;

  let originStr;
  let pathname;
  try {
    const parsed = new URL(payload.url, self.location.href);
    originStr = parsed.origin;
    pathname = parsed.pathname;
  } catch (e) {
    return;
  }

  const normalizedPath = urlNormalizer.normalizePath(pathname);
  const tag = classify.classifyContentType(
    payload.responseHeaders || payload.requestHeaders,
    payload.responseBody
  );
  const authWarning =
    classify.hasAuthWarning(payload.requestHeaders) || classify.hasAuthWarning(payload.responseHeaders);

  const settings = await storage.getSettings();
  const originData = await storage.getOriginData(originStr);

  const capture = {
    method: payload.method,
    origin: originStr,
    normalizedPath,
    tag,
    authWarning,
    url: payload.url,
    requestHeaders: storage.stripCookies(payload.requestHeaders),
    requestBody: payload.requestBody,
    responseHeaders: payload.responseHeaders,
    responseBody: payload.responseBody,
    status: payload.status,
    timestamp: payload.timestamp || Date.now(),
  };

  const merged = storage.mergeCapture(originData, capture, {
    throttleWindowMs: settings.throttleWindowMs,
  });
  await storage.setOriginData(originStr, merged);
}

// --- webRequest fallback/cross-check ---
// host_permissions: ["<all_urls>"] (see manifest.json) is required here so these listeners
// fire for every site you browse to, not just ones you've explicitly granted access to.
// To scope this extension down to specific sites, replace "<all_urls>" in manifest.json's
// host_permissions AND the "matches" arrays below and in content_scripts with explicit
// origins (e.g. "https://your-app.example.com/*"). See README.md for details.

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type !== "xmlhttprequest") return;
    let bodyStr;
    if (details.requestBody) {
      if (details.requestBody.formData) {
        bodyStr = new URLSearchParams(
          Object.entries(details.requestBody.formData).flatMap(([k, values]) =>
            values.map((v) => [k, v])
          )
        ).toString();
      } else if (details.requestBody.raw && details.requestBody.raw[0]) {
        try {
          bodyStr = new TextDecoder("utf-8").decode(details.requestBody.raw[0].bytes);
        } catch (e) {
          bodyStr = undefined;
        }
      }
    }
    pendingRequestData.set(details.requestId, {
      method: details.method,
      url: details.url,
      body: bodyStr,
      headers: {},
    });
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const pending = pendingRequestData.get(details.requestId);
    if (!pending) return;
    const headers = {};
    (details.requestHeaders || []).forEach((h) => {
      headers[h.name] = h.value;
    });
    pending.headers = headers;
  },
  { urls: ["<all_urls>"] },
  // "extraHeaders" is required to see security-sensitive request headers (notably
  // Authorization) in this callback at all — without it Chrome silently omits them,
  // which would under-detect authWarning for requests the hook missed and this
  // fallback path had to capture on its own.
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    // Aborted/failed requests never reach onCompleted, so without this listener
    // their pendingRequestData entry (set in onBeforeRequest) would never be
    // cleaned up and would accumulate for the life of the service worker instance.
    pendingRequestData.delete(details.requestId);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const pending = pendingRequestData.get(details.requestId);
    pendingRequestData.delete(details.requestId);
    if (!pending) return;

    const responseHeaders = {};
    (details.responseHeaders || []).forEach((h) => {
      responseHeaders[h.name] = h.value;
    });

    // webRequest.onCompleted fires as soon as the network layer finishes, which is
    // typically BEFORE the MAIN-world hook's capture message arrives here — that
    // message has to cross an extra postMessage + chrome.runtime.sendMessage hop.
    // Checking the dedup window immediately would almost always miss a hook capture
    // that's still in flight, double-counting nearly every request. Delay briefly
    // and re-check right before ingesting instead, giving the hook message time to
    // register in recentHookCaptures first.
    setTimeout(() => {
      cleanupRecentHookCaptures();
      if (dedup.shouldSkipWebRequestFallback(recentHookCaptures, pending.method, pending.url, Date.now())) {
        return;
      }

      // Note: chrome.webRequest cannot access response bodies at all (a hard Chrome
      // platform limitation, not something extra permissions unlock), so this fallback
      // path only ever fills in requests the MAIN-world hook missed entirely, with
      // responseBody left undefined. See README.md "Chrome API limitations".
      ingestCapture({
        method: pending.method,
        url: pending.url,
        requestHeaders: pending.headers,
        requestBody: pending.body,
        responseHeaders,
        responseBody: undefined,
        status: details.statusCode,
        timestamp: Date.now(),
      }).catch((e) => console.error("api-sniffer webRequest capture error", e));
    }, 500);
  },
  { urls: ["<all_urls>"] },
  // "extraHeaders" is required to see Set-Cookie and a few other security-sensitive
  // response headers in this callback — same rationale as onSendHeaders above.
  ["responseHeaders", "extraHeaders"]
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "capture") {
    const key = `${message.payload.method} ${message.payload.url}`;
    recentHookCaptures.set(key, Date.now());
    ingestCapture(message.payload).catch((e) => console.error("api-sniffer capture error", e));
    return false;
  }
  return false;
});
```

- [ ] **Step 2: Manual verification**

1. Reload the unpacked extension at `chrome://extensions` (the reload icon on the API Sniffer card).
2. Visit `https://httpbin.org` (or any site with API calls) and trigger a fetch (e.g. via its own UI, or run `fetch('https://httpbin.org/get').then(r=>r.json())` in that page's console).
3. Open the extension's service worker console and run:
   ```js
   chrome.storage.local.get(null, console.log)
   ```
4. Expected: an object with a key like `endpoints::https://httpbin.org` containing a `GET /get` entry with `hitCount: 1` and a `samples` array with the captured headers/body.
5. Trigger the same request 2 more times quickly, re-run the `chrome.storage.local.get(null, console.log)` command, and confirm `hitCount` increased but `samples.length` did not (still within the 30s throttle window) — validates the poll throttle from Task 7.

- [ ] **Step 3: Commit**

```bash
git add background.js
git commit -m "Add background service worker capture pipeline"
```

---

### Task 10: Background replay, settings, and pruning handlers

**Files:**
- Modify: `background.js` (append to the file created in Task 9)

**Interfaces:**
- Consumes: `storage.getSettings`/`setSettings`/`clearDomain`/`clearAllData`/`pruneAllOrigins` (Task 7).
- Produces: handlers for message types `getEndpoints`, `getSettings`, `setSettings`, `clearDomain`, `clearAll`, `replay`, `replayCookieless` — all consumed by `sidepanel.js` (Tasks 11-12).

- [ ] **Step 1: Add the remaining message handlers and replay logic to `background.js`**

Replace the existing `chrome.runtime.onMessage.addListener` block (added in Task 9) with:

```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "capture") {
    const key = `${message.payload.method} ${message.payload.url}`;
    recentHookCaptures.set(key, Date.now());
    ingestCapture(message.payload).catch((e) => console.error("api-sniffer capture error", e));
    return false;
  }

  if (message.type === "getEndpoints") {
    storage.getOriginData(message.origin).then((data) => sendResponse({ ok: true, data }));
    return true;
  }

  if (message.type === "getSettings") {
    storage.getSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (message.type === "setSettings") {
    storage.setSettings(message.settings).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "clearDomain") {
    storage.clearDomain(message.origin).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "clearAll") {
    storage.clearAllData().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "replay") {
    handleReplay(message.origin, message.request).then((result) => sendResponse(result));
    return true;
  }

  if (message.type === "replayCookieless") {
    replayWithoutCookies(message.request).then((result) => sendResponse(result));
    return true;
  }

  return false;
});

async function handleReplay(origin, request) {
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  if (tabs.length === 0) {
    return { ok: false, reason: "no-tab" };
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      world: "MAIN",
      func: async (req) => {
        try {
          const resp = await fetch(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          });
          const text = await resp.text();
          const headers = {};
          resp.headers.forEach((v, k) => {
            headers[k] = v;
          });
          return { ok: true, status: resp.status, headers, body: text };
        } catch (err) {
          return { ok: false, reason: "fetch-error", message: String(err) };
        }
      },
      args: [request],
    });
    return result;
  } catch (err) {
    return { ok: false, reason: "inject-error", message: String(err) };
  }
}

async function replayWithoutCookies(request) {
  try {
    const resp = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    });
    const text = await resp.text();
    const headers = {};
    resp.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { ok: true, status: resp.status, headers, body: text, cookieless: true };
  } catch (err) {
    return { ok: false, reason: "fetch-error", message: String(err) };
  }
}

chrome.alarms.create("api-sniffer-prune", { periodInMinutes: 1440 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "api-sniffer-prune") {
    storage.pruneAllOrigins().catch((e) => console.error("api-sniffer prune error", e));
  }
});
storage.pruneAllOrigins().catch((e) => console.error("api-sniffer initial prune error", e));

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
```

- [ ] **Step 2: Manual verification**

1. Reload the unpacked extension.
2. Open the extension's service worker console and run:
   ```js
   chrome.runtime.sendMessage({ type: "getSettings" }, console.log)
   ```
   Expected: logs `{ ok: true, settings: { retentionDays: 30, throttleWindowMs: 30000 } }`.
3. Run:
   ```js
   chrome.runtime.sendMessage({ type: "setSettings", settings: { retentionDays: 10 } }, console.log)
   ```
   then re-run the `getSettings` command from step 2 — expect `retentionDays: 10`, `throttleWindowMs: 30000` (merged, not overwritten).
4. Run `chrome.runtime.sendMessage({ type: "getEndpoints", origin: "https://httpbin.org" }, console.log)` (using an origin captured in Task 9) and confirm it returns the stored endpoint data.

- [ ] **Step 3: Commit**

```bash
git add background.js
git commit -m "Add replay, settings, and pruning message handlers"
```

---

### Task 11: Side panel endpoint list and search

**Files:**
- Modify: `sidepanel.css` (created as a stub in Task 1)
- Create: `sidepanel.html`
- Create: `sidepanel.js`

**Interfaces:**
- Consumes: `{ type: "getEndpoints", origin }` message (Task 10), returning `{ ok: true, data: <originData> }` where `originData` matches the shape produced by `mergeCapture` (Task 7).
- Produces: `state`, `renderEndpointList()`, `renderCard(key, entry)` functions in `sidepanel.js`, extended by Task 12.

- [ ] **Step 1: Create `sidepanel.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="sidepanel.css" />
</head>
<body>
  <header>
    <nav>
      <button id="tab-endpoints" class="tab-button active">Endpoints</button>
      <button id="tab-settings" class="tab-button">Settings</button>
    </nav>
  </header>

  <section id="view-endpoints">
    <input id="search-input" type="text" placeholder="Filter by path..." />
    <div id="endpoint-list"></div>
  </section>

  <section id="view-settings" hidden>
    <label>Retention (days): <input id="retention-days" type="number" min="1" /></label>
    <label>Poll throttle (ms): <input id="throttle-ms" type="number" min="0" /></label>
    <button id="save-settings">Save</button>
    <hr />
    <button id="clear-domain">Clear this domain</button>
    <button id="clear-all">Clear all data</button>
  </section>

  <script src="utils/curl.js"></script>
  <script src="sidepanel.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `sidepanel.js` (list + search only; replay/settings added in Task 12)**

```js
const state = {
  origin: null,
  endpoints: {},
  filter: "",
};

function qs(id) {
  return document.getElementById(id);
}

async function getActiveTabOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  try {
    return new URL(tab.url).origin;
  } catch (e) {
    return null;
  }
}

async function loadEndpoints() {
  if (!state.origin) return;
  const response = await chrome.runtime.sendMessage({ type: "getEndpoints", origin: state.origin });
  state.endpoints = (response && response.data) || {};
  renderEndpointList();
}

function renderEndpointList() {
  const container = qs("endpoint-list");
  container.innerHTML = "";
  const entries = Object.entries(state.endpoints)
    .filter(([, entry]) => entry.pattern.toLowerCase().includes(state.filter.toLowerCase()))
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen);

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No endpoints captured yet for this origin.";
    container.appendChild(empty);
    return;
  }

  for (const [key, entry] of entries) {
    container.appendChild(renderCard(key, entry));
  }
}

function renderCard(key, entry) {
  const card = document.createElement("div");
  card.className = "endpoint-card";

  const summary = document.createElement("div");
  summary.className = "endpoint-summary";

  const methodBadge = document.createElement("span");
  methodBadge.className = `method-badge method-${entry.method.toLowerCase()}`;
  methodBadge.textContent = entry.method;

  const pathLabel = document.createElement("span");
  pathLabel.className = "endpoint-path";
  pathLabel.textContent = entry.pattern;

  const meta = document.createElement("span");
  meta.className = "endpoint-meta";
  meta.textContent = `${entry.hitCount} hits · ${entry.tag}${entry.authWarning ? " · auth-warning" : ""}`;

  summary.appendChild(methodBadge);
  summary.appendChild(pathLabel);
  summary.appendChild(meta);

  const details = document.createElement("div");
  details.className = "endpoint-details";
  details.hidden = true;
  summary.addEventListener("click", () => {
    details.hidden = !details.hidden;
  });

  const latestSample = entry.samples[0];
  details.appendChild(renderSection("Headers", JSON.stringify(latestSample.requestHeaders, null, 2)));
  details.appendChild(renderSection("Request Body", latestSample.requestBody || "(empty)"));
  const responseNote = latestSample.responseTruncated ? "\n[response was truncated]" : "";
  details.appendChild(
    renderSection("Response Body", (latestSample.responseBody || "(empty)") + responseNote)
  );

  card.appendChild(summary);
  card.appendChild(details);
  return card;
}

function renderSection(label, content) {
  const section = document.createElement("div");
  section.className = "endpoint-section";
  const heading = document.createElement("h4");
  heading.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = content;
  section.appendChild(heading);
  section.appendChild(pre);
  return section;
}

function setupSearch() {
  qs("search-input").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderEndpointList();
  });
}

function setupTabs() {
  qs("tab-endpoints").addEventListener("click", () => {
    qs("tab-endpoints").classList.add("active");
    qs("tab-settings").classList.remove("active");
    qs("view-endpoints").hidden = false;
    qs("view-settings").hidden = true;
  });
  qs("tab-settings").addEventListener("click", () => {
    qs("tab-settings").classList.add("active");
    qs("tab-endpoints").classList.remove("active");
    qs("view-settings").hidden = false;
    qs("view-endpoints").hidden = true;
  });
}

async function init() {
  setupTabs();
  setupSearch();
  state.origin = await getActiveTabOrigin();
  await loadEndpoints();

  chrome.tabs.onActivated.addListener(async () => {
    state.origin = await getActiveTabOrigin();
    await loadEndpoints();
  });
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.active) {
      state.origin = await getActiveTabOrigin();
      await loadEndpoints();
    }
  });
}

init();
```

- [ ] **Step 3: Write `sidepanel.css`**

```css
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #ffffff;
  color: #1a1a1a;
  font-size: 13px;
}

header nav {
  display: flex;
  border-bottom: 1px solid #e5e5e5;
}

.tab-button {
  flex: 1;
  padding: 10px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 13px;
  color: #555;
  border-bottom: 2px solid transparent;
}

.tab-button.active {
  color: #1a1a1a;
  border-bottom-color: #1a1a1a;
}

#search-input {
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-bottom: 1px solid #e5e5e5;
  font-size: 13px;
  outline: none;
}

.empty-state {
  padding: 16px;
  color: #888;
}

.endpoint-card {
  border-bottom: 1px solid #e5e5e5;
}

.endpoint-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
}

.method-badge {
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  font-size: 11px;
  padding: 2px 6px;
  border: 1px solid #e5e5e5;
  border-radius: 3px;
  color: #444;
}

.endpoint-path {
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.endpoint-meta {
  color: #888;
  font-size: 11px;
  white-space: nowrap;
}

.endpoint-details {
  padding: 8px 10px;
  background: #fafafa;
  border-top: 1px solid #e5e5e5;
}

.endpoint-section h4 {
  margin: 8px 0 4px;
  font-size: 11px;
  text-transform: uppercase;
  color: #888;
  font-weight: normal;
}

.endpoint-section pre {
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  background: #ffffff;
  border: 1px solid #e5e5e5;
  border-radius: 3px;
  padding: 6px;
  margin: 0;
}

.endpoint-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

button {
  font-family: inherit;
  font-size: 12px;
  padding: 5px 10px;
  border: 1px solid #d0d0d0;
  background: #ffffff;
  border-radius: 3px;
  cursor: pointer;
}

button:hover {
  background: #f2f2f2;
}

#view-settings label {
  display: block;
  margin: 10px;
  font-size: 12px;
}

#view-settings input {
  margin-left: 6px;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
}
```

- [ ] **Step 4: Manual verification**

1. Reload the unpacked extension.
2. Navigate to `https://httpbin.org`, click the extension's toolbar icon to open the side panel (falls back to right-click the icon → "Open side panel" if the click behavior isn't wired yet — it is, via `setPanelBehavior` in Task 10).
3. Trigger a couple of fetches on the page as in Task 9's verification.
4. Expected: the side panel's Endpoints view shows a card for `GET /get` with hit count, tag, and a "json" label; clicking the card expands it to show Headers/Request Body/Response Body sections in monospace.
5. Type part of the path into the search box and confirm the list filters live.

- [ ] **Step 5: Commit**

```bash
git add sidepanel.html sidepanel.js sidepanel.css
git commit -m "Add side panel endpoint list, expand/collapse, and search"
```

---

### Task 12: Replay form, copy-as-curl, and Settings view

**Files:**
- Modify: `sidepanel.js`

**Interfaces:**
- Consumes: `curlBuilder.buildCurlCommand` (Task 4, loaded via `<script src="utils/curl.js">` in `sidepanel.html` from Task 11), `{ type: "replay" | "replayCookieless" | "getSettings" | "setSettings" | "clearDomain" | "clearAll" }` messages (Task 10).
- Produces: fully working end-to-end replay, curl export, and settings UI — the last piece of the extension's functional surface.

- [ ] **Step 1: Add replay, curl, and settings wiring to `sidepanel.js`**

Insert this helper before `renderCard`, and extend `renderCard`'s body as shown:

```js
function cssSafe(key) {
  return key.replace(/[^a-zA-Z0-9]/g, "_");
}
```

Replace the `renderCard` function from Task 11 with this extended version (adds the actions row and a replay container):

```js
function renderCard(key, entry) {
  const card = document.createElement("div");
  card.className = "endpoint-card";

  const summary = document.createElement("div");
  summary.className = "endpoint-summary";

  const methodBadge = document.createElement("span");
  methodBadge.className = `method-badge method-${entry.method.toLowerCase()}`;
  methodBadge.textContent = entry.method;

  const pathLabel = document.createElement("span");
  pathLabel.className = "endpoint-path";
  pathLabel.textContent = entry.pattern;

  const meta = document.createElement("span");
  meta.className = "endpoint-meta";
  meta.textContent = `${entry.hitCount} hits · ${entry.tag}${entry.authWarning ? " · auth-warning" : ""}`;

  summary.appendChild(methodBadge);
  summary.appendChild(pathLabel);
  summary.appendChild(meta);

  const details = document.createElement("div");
  details.className = "endpoint-details";
  details.hidden = true;
  summary.addEventListener("click", () => {
    details.hidden = !details.hidden;
  });

  const latestSample = entry.samples[0];
  details.appendChild(renderSection("Headers", JSON.stringify(latestSample.requestHeaders, null, 2)));
  details.appendChild(renderSection("Request Body", latestSample.requestBody || "(empty)"));
  const responseNote = latestSample.responseTruncated ? "\n[response was truncated]" : "";
  details.appendChild(
    renderSection("Response Body", (latestSample.responseBody || "(empty)") + responseNote)
  );

  const actions = document.createElement("div");
  actions.className = "endpoint-actions";

  const replayButton = document.createElement("button");
  replayButton.textContent = "Replay";
  replayButton.addEventListener("click", () => openReplayForm(key, entry));

  const curlButton = document.createElement("button");
  curlButton.textContent = "Copy as curl";
  curlButton.addEventListener("click", () => {
    const cmd = curlBuilder.buildCurlCommand({
      method: entry.method,
      url: latestSample.url.startsWith("http") ? latestSample.url : entry.origin + latestSample.url,
      headers: latestSample.requestHeaders,
      body: latestSample.requestBody,
    });
    navigator.clipboard.writeText(cmd);
  });

  actions.appendChild(replayButton);
  actions.appendChild(curlButton);
  details.appendChild(actions);

  const replayContainer = document.createElement("div");
  replayContainer.className = "replay-container";
  replayContainer.id = `replay-${cssSafe(key)}`;
  details.appendChild(replayContainer);

  card.appendChild(summary);
  card.appendChild(details);
  return card;
}
```

Add these new functions after `renderSection`:

```js
function openReplayForm(key, entry) {
  const container = qs(`replay-${cssSafe(key)}`);
  container.innerHTML = "";
  const latestSample = entry.samples[0];

  const urlInput = document.createElement("input");
  urlInput.className = "replay-url";
  urlInput.value = latestSample.url.startsWith("http") ? latestSample.url : entry.origin + latestSample.url;

  const headersInput = document.createElement("textarea");
  headersInput.className = "replay-headers";
  headersInput.value = JSON.stringify(latestSample.requestHeaders || {}, null, 2);

  const bodyInput = document.createElement("textarea");
  bodyInput.className = "replay-body";
  bodyInput.value = latestSample.requestBody || "";

  const sendButton = document.createElement("button");
  sendButton.textContent = "Send";

  const responseBox = document.createElement("pre");
  responseBox.className = "replay-response";

  sendButton.addEventListener("click", async () => {
    let headers;
    try {
      headers = JSON.parse(headersInput.value || "{}");
    } catch (e) {
      responseBox.textContent = "Invalid headers JSON";
      return;
    }
    const request = { method: entry.method, url: urlInput.value, headers, body: bodyInput.value || undefined };
    responseBox.textContent = "Sending...";

    const result = await chrome.runtime.sendMessage({ type: "replay", origin: entry.origin, request });

    if (!result.ok && result.reason === "no-tab") {
      responseBox.textContent =
        "No open tab for this origin. Open the site to replay with its session, or click Send again to replay cookie-less.";
      sendButton.dataset.forceCookieless = "true";
      return;
    }

    if (sendButton.dataset.forceCookieless === "true" && !result.ok) {
      const fallback = await chrome.runtime.sendMessage({ type: "replayCookieless", request });
      renderReplayResult(responseBox, fallback);
      return;
    }

    renderReplayResult(responseBox, result);
  });

  container.appendChild(urlInput);
  container.appendChild(headersInput);
  container.appendChild(bodyInput);
  container.appendChild(sendButton);
  container.appendChild(responseBox);
}

function renderReplayResult(responseBox, result) {
  if (!result.ok) {
    responseBox.textContent = `Error: ${result.reason}${result.message ? " - " + result.message : ""}`;
    return;
  }
  const cookieNote = result.cookieless ? "[replayed without cookies]\n" : "";
  responseBox.textContent = `${cookieNote}Status: ${result.status}\nHeaders: ${JSON.stringify(
    result.headers,
    null,
    2
  )}\n\nBody:\n${result.body}`;
}

async function loadSettings() {
  const response = await chrome.runtime.sendMessage({ type: "getSettings" });
  qs("retention-days").value = response.settings.retentionDays;
  qs("throttle-ms").value = response.settings.throttleWindowMs;
}

function setupSettingsActions() {
  qs("save-settings").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: "setSettings",
      settings: {
        retentionDays: Number(qs("retention-days").value) || 30,
        throttleWindowMs: Number(qs("throttle-ms").value) || 30000,
      },
    });
  });

  qs("clear-domain").addEventListener("click", async () => {
    if (!state.origin) return;
    if (!confirm(`Clear all captured data for ${state.origin}?`)) return;
    await chrome.runtime.sendMessage({ type: "clearDomain", origin: state.origin });
    await loadEndpoints();
  });

  qs("clear-all").addEventListener("click", async () => {
    if (!confirm("Clear ALL captured data for every domain?")) return;
    await chrome.runtime.sendMessage({ type: "clearAll" });
    await loadEndpoints();
  });
}
```

Update `setupTabs` (replace the Task 11 version) so switching to Settings loads current values, and update `init` to wire the new settings actions:

```js
function setupTabs() {
  qs("tab-endpoints").addEventListener("click", () => {
    qs("tab-endpoints").classList.add("active");
    qs("tab-settings").classList.remove("active");
    qs("view-endpoints").hidden = false;
    qs("view-settings").hidden = true;
  });
  qs("tab-settings").addEventListener("click", () => {
    qs("tab-settings").classList.add("active");
    qs("tab-endpoints").classList.remove("active");
    qs("view-settings").hidden = false;
    qs("view-endpoints").hidden = true;
    loadSettings();
  });
}

async function init() {
  setupTabs();
  setupSearch();
  setupSettingsActions();
  state.origin = await getActiveTabOrigin();
  await loadEndpoints();

  chrome.tabs.onActivated.addListener(async () => {
    state.origin = await getActiveTabOrigin();
    await loadEndpoints();
  });
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.active) {
      state.origin = await getActiveTabOrigin();
      await loadEndpoints();
    }
  });
}
```

- [ ] **Step 2: Manual verification**

1. Reload the unpacked extension and re-open the side panel on a tab with captured endpoints (e.g. `https://httpbin.org` from earlier tasks).
2. Expand a card, click "Copy as curl", paste into a text editor — confirm it's a valid `curl -X GET '...' -H '...'` line prefixed with the cookie-exclusion comment, and contains no `Cookie` header.
3. Click "Replay" — confirm the inline form appears pre-filled with the last URL/headers/body.
4. Edit a header value, click "Send" — confirm a live response (status/headers/body) renders below the form. Since the tab is open on that origin, this should use the page-context injection path (no "no-tab" warning).
5. Close the httpbin tab, click "Send" again on the same still-open replay form — confirm the "No open tab..." warning appears, and clicking "Send" a second time performs the cookie-less fallback and labels the result `[replayed without cookies]`.
6. Switch to the Settings tab, change "Retention (days)" to `7`, click Save, switch away and back to Settings — confirm the value persisted as `7`.
7. Click "Clear this domain", confirm the dialog, confirm the Endpoints list is now empty for that origin.

- [ ] **Step 3: Commit**

```bash
git add sidepanel.js
git commit -m "Add replay form, copy-as-curl, and settings view to side panel"
```

---

### Task 13: README and final end-to-end verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- None — this is documentation plus a full manual regression pass across every task's deliverable.

- [ ] **Step 1: Write the final `README.md`**

```markdown
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
  arrays **and** the `urls` filters in `background.js`'s three `chrome.webRequest.*` listeners
  with explicit origins, e.g. `"https://your-app.example.com/*"`. Note that `<all_urls>`
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
```

- [ ] **Step 2: Run the full automated test suite one final time**

Run: `npm test`
Expected: all tests across `urlNormalizer`, `classify`, `curl`, `dedup`, `headers`, and
`storage` pass with 0 failures.

- [ ] **Step 3: Full manual end-to-end regression pass**

1. Reload the unpacked extension from a clean state (Settings → "Clear all data").
2. Visit at least two different sites that make real API calls (e.g. a JSON-backed app and
   `https://httpbin.org`), triggering a handful of requests on each, including at least one
   POST/PUT with a JSON body.
3. Open the side panel on each site's tab and confirm: endpoints are scoped correctly per
   origin (switching tabs updates the list), path normalization collapsed any numeric/UUID
   path segments you triggered, and static assets (images/CSS/fonts loaded by the page) do
   *not* appear in the list.
4. Expand a card, replay it with an edited header, confirm the live response renders.
5. Copy a curl command and confirm it's valid (paste into a terminal if you want to be
   thorough, or just inspect it).
6. In Settings, adjust retention days and throttle window, save, and confirm they persist
   across a side panel reopen.
7. Confirm no requests appear in any Network tab or `chrome://net-export` log heading to any
   destination outside the sites you're actively browsing — verifying the "no data leaves the
   browser" requirement.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Finalize README with usage, permissions, and limitations"
```
