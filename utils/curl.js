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
