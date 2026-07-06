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
