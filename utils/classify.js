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
