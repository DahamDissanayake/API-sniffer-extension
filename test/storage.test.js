const test = require("node:test");
const assert = require("node:assert/strict");
const { truncateBody, stripCookies, mergeCapture, pruneOldEndpoints } = require("../utils/storage.js");

test("truncateBody leaves short bodies untouched", () => {
  assert.deepEqual(truncateBody("short"), { body: "short", truncated: false });
});

test("truncateBody cuts bodies over 50000 chars", () => {
  const long = "x".repeat(50010);
  const result = truncateBody(long);
  assert.equal(result.body.length, 50000);
  assert.equal(result.truncated, true);
});

test("truncateBody passes through non-string bodies", () => {
  assert.deepEqual(truncateBody(undefined), { body: undefined, truncated: false });
});

test("stripCookies removes cookie and set-cookie case-insensitively", () => {
  const result = stripCookies({ Cookie: "a=1", "Set-Cookie": "b=2", Accept: "json" });
  assert.deepEqual(result, { Accept: "json" });
});

test("mergeCapture creates a new endpoint entry on first sight", () => {
  const capture = {
    method: "GET",
    origin: "https://api.example.com",
    normalizedPath: "/api/tickets/{id}",
    tag: "json",
    authWarning: false,
    url: "/api/tickets/123",
    requestHeaders: { Accept: "json" },
    requestBody: undefined,
    responseHeaders: { "content-type": "application/json" },
    responseBody: '{"id":123}',
    status: 200,
    timestamp: 1000,
  };
  const result = mergeCapture({}, capture);
  const entry = result["GET /api/tickets/{id}"];
  assert.equal(entry.hitCount, 1);
  assert.equal(entry.firstSeen, 1000);
  assert.equal(entry.lastSeen, 1000);
  assert.deepEqual(entry.statusCodes, [200]);
  assert.equal(entry.samples.length, 1);
  assert.equal(entry.samples[0].url, "/api/tickets/123");
});

test("mergeCapture increments hitCount without a new full sample inside the throttle window", () => {
  const first = mergeCapture(
    {},
    {
      method: "GET",
      origin: "https://api.example.com",
      normalizedPath: "/api/tickets/{id}",
      tag: "json",
      authWarning: false,
      url: "/api/tickets/123",
      requestHeaders: {},
      responseHeaders: {},
      responseBody: "{}",
      status: 200,
      timestamp: 1000,
    },
    { throttleWindowMs: 30000 }
  );
  const second = mergeCapture(
    first,
    {
      method: "GET",
      origin: "https://api.example.com",
      normalizedPath: "/api/tickets/{id}",
      tag: "json",
      authWarning: false,
      url: "/api/tickets/456",
      requestHeaders: {},
      responseHeaders: {},
      responseBody: "{}",
      status: 200,
      timestamp: 5000,
    },
    { throttleWindowMs: 30000 }
  );
  const entry = second["GET /api/tickets/{id}"];
  assert.equal(entry.hitCount, 2);
  assert.equal(entry.samples.length, 1);
  assert.equal(entry.samples[0].url, "/api/tickets/123");
});

test("mergeCapture adds a new full sample once the throttle window elapses", () => {
  const first = mergeCapture(
    {},
    {
      method: "GET",
      origin: "https://api.example.com",
      normalizedPath: "/api/tickets/{id}",
      tag: "json",
      authWarning: false,
      url: "/api/tickets/123",
      requestHeaders: {},
      responseHeaders: {},
      responseBody: "{}",
      status: 200,
      timestamp: 1000,
    },
    { throttleWindowMs: 30000 }
  );
  const second = mergeCapture(
    first,
    {
      method: "GET",
      origin: "https://api.example.com",
      normalizedPath: "/api/tickets/{id}",
      tag: "json",
      authWarning: false,
      url: "/api/tickets/456",
      requestHeaders: {},
      responseHeaders: {},
      responseBody: "{}",
      status: 200,
      timestamp: 40000,
    },
    { throttleWindowMs: 30000 }
  );
  const entry = second["GET /api/tickets/{id}"];
  assert.equal(entry.hitCount, 2);
  assert.equal(entry.samples.length, 2);
  assert.equal(entry.samples[0].url, "/api/tickets/456");
});

test("mergeCapture caps stored samples at 5", () => {
  let data = {};
  for (let i = 0; i < 7; i++) {
    data = mergeCapture(
      data,
      {
        method: "GET",
        origin: "https://api.example.com",
        normalizedPath: "/api/tickets/{id}",
        tag: "json",
        authWarning: false,
        url: `/api/tickets/${i}`,
        requestHeaders: {},
        responseHeaders: {},
        responseBody: "{}",
        status: 200,
        timestamp: i * 40000,
      },
      { throttleWindowMs: 30000 }
    );
  }
  assert.equal(data["GET /api/tickets/{id}"].samples.length, 5);
});

test("mergeCapture truncates oversized response bodies", () => {
  const result = mergeCapture(
    {},
    {
      method: "GET",
      origin: "https://api.example.com",
      normalizedPath: "/api/x",
      tag: "json",
      authWarning: false,
      url: "/api/x",
      requestHeaders: {},
      responseHeaders: {},
      responseBody: "y".repeat(60000),
      status: 200,
      timestamp: 1000,
    }
  );
  const sample = result["GET /api/x"].samples[0];
  assert.equal(sample.responseTruncated, true);
  assert.equal(sample.responseBody.length, 50000);
});

test("pruneOldEndpoints drops entries older than retentionDays", () => {
  const now = 1000 * 60 * 60 * 24 * 40; // day 40
  const data = {
    "GET /old": { lastSeen: 0 },
    "GET /recent": { lastSeen: now - 1000 },
  };
  const result = pruneOldEndpoints(data, 30, now);
  assert.deepEqual(Object.keys(result), ["GET /recent"]);
});
