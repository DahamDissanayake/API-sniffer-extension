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

const urlNormalizerApi = { normalizePath, buildEndpointKey };
if (typeof module !== "undefined" && module.exports) module.exports = urlNormalizerApi;
if (typeof globalThis !== "undefined") globalThis.urlNormalizer = urlNormalizerApi;
