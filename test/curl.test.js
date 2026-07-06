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
