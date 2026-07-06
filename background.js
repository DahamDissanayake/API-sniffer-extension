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
  ["requestHeaders"]
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
  ["responseHeaders"]
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
