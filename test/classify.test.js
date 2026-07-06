const test = require("node:test");
const assert = require("node:assert/strict");
const { isStaticAsset, classifyContentType, hasAuthWarning } = require("../utils/classify.js");

test("flags image content-type as static", () => {
  assert.equal(isStaticAsset("https://x.com/thing", "image/png"), true);
});

test("flags font/css/js extensions as static", () => {
  assert.equal(isStaticAsset("https://x.com/app.css", undefined), true);
  assert.equal(isStaticAsset("https://x.com/font.woff2", undefined), true);
  assert.equal(isStaticAsset("https://x.com/bundle.js", undefined), true);
});

test("does not flag a JSON API path as static", () => {
  assert.equal(isStaticAsset("https://x.com/api/tickets/123", "application/json"), false);
});

test("classifies application/json header as json", () => {
  assert.equal(classifyContentType({ "content-type": "application/json; charset=utf-8" }), "json");
});

test("classifies form-urlencoded header as form", () => {
  assert.equal(
    classifyContentType({ "content-type": "application/x-www-form-urlencoded" }),
    "form"
  );
});

test("classifies parseable JSON body with no content-type as json", () => {
  assert.equal(classifyContentType({}, '{"ok":true}'), "json");
});

test("classifies unrecognized content as other", () => {
  assert.equal(classifyContentType({ "content-type": "text/plain" }, "hello"), "other");
});

test("flags long opaque authorization header value", () => {
  assert.equal(
    hasAuthWarning({ Authorization: "Bearer abcdef0123456789abcdef0123456789" }),
    true
  );
});

test("does not flag short header values", () => {
  assert.equal(hasAuthWarning({ "X-Token": "abc" }), false);
});

test("does not flag unrelated headers", () => {
  assert.equal(hasAuthWarning({ Accept: "application/json; charset=utf-8-and-then-some" }), false);
});
