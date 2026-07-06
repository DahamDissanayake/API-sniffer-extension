const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRawHeaderString } = require("../utils/headers.js");

test("parses a multi-line raw header string", () => {
  const raw = "Content-Type: application/json\r\nX-Request-Id: abc123\r\n";
  assert.deepEqual(parseRawHeaderString(raw), {
    "Content-Type": "application/json",
    "X-Request-Id": "abc123",
  });
});

test("returns empty object for empty input", () => {
  assert.deepEqual(parseRawHeaderString(""), {});
  assert.deepEqual(parseRawHeaderString(null), {});
});

test("handles values containing colons", () => {
  const raw = "Date: Mon, 06 Jul 2026 10:00:00 GMT";
  assert.deepEqual(parseRawHeaderString(raw), { Date: "Mon, 06 Jul 2026 10:00:00 GMT" });
});
