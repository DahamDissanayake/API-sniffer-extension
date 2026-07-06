function shouldSkipWebRequestFallback(recentHookCaptures, method, url, now, windowMs = 1000) {
  const key = `${method.toUpperCase()} ${url}`;
  const seenAt = recentHookCaptures.get(key);
  if (seenAt === undefined) return false;
  return now - seenAt <= windowMs;
}

const api = { shouldSkipWebRequestFallback };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.dedup = api;
