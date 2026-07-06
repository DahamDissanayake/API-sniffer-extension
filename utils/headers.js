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

const headersApi = { parseRawHeaderString };
if (typeof module !== "undefined" && module.exports) module.exports = headersApi;
if (typeof globalThis !== "undefined") globalThis.headerUtils = headersApi;
