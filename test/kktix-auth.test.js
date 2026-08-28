import assert from "node:assert/strict";
import test from "node:test";
import { parseCookieHeader } from "../src/kktix-auth.js";

test("parseCookieHeader parses a copied Cookie request header", () => {
  const cookies = parseCookieHeader("Cookie: _kktix_session=abc%3D%3D; locale=zh-TW; flag=a=b");
  assert.deepEqual(
    cookies.map(({ name, value }) => ({ name, value })),
    [
      { name: "_kktix_session", value: "abc%3D%3D" },
      { name: "locale", value: "zh-TW" },
      { name: "flag", value: "a=b" },
    ],
  );
  assert.equal(cookies[0].domain, ".kktix.com");
});

test("parseCookieHeader keeps the final value for duplicate cookies", () => {
  const cookies = parseCookieHeader("locale=en; locale=zh-TW");
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].value, "zh-TW");
});

test("parseCookieHeader rejects empty input", () => {
  assert.throws(() => parseCookieHeader("  "), /Cookie 是空的/);
});

test("parseCookieHeader uses a host URL for __Host cookies", () => {
  const [cookie] = parseCookieHeader("__Host-session=secret");
  assert.equal(cookie.url, "https://kktix.com");
  assert.equal(cookie.domain, undefined);
});
