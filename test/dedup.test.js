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
