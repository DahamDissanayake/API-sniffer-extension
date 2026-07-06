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
