import assert from "node:assert/strict";
import test from "node:test";
import { envLogin, mapGoogleError } from "../src/auth.js";
import { ToolFailure } from "../src/validation.js";

const NAMES = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] as const;
const previous = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

function clearEnv(): void {
  for (const name of NAMES) delete process.env[name];
}

test.beforeEach(clearEnv);
test.afterEach(() => {
  for (const name of NAMES) {
    const value = previous[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("no Google environment variables means use the local login files", () => {
  assert.equal(envLogin(), undefined);
});

test("all three variables are returned as the hosted login", () => {
  process.env.GOOGLE_CLIENT_ID = "id-value";
  process.env.GOOGLE_CLIENT_SECRET = "secret-value";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh-value";
  assert.deepEqual(envLogin(), {
    clientId: "id-value",
    clientSecret: "secret-value",
    refreshToken: "refresh-value",
  });
});

test("a partial setup names the missing variables and never prints a value", () => {
  process.env.GOOGLE_CLIENT_ID = "id-value-should-not-leak";
  process.env.GOOGLE_CLIENT_SECRET = "secret-value-should-not-leak";
  assert.throws(
    () => envLogin(),
    (err: unknown) => {
      assert.ok(err instanceof ToolFailure);
      assert.equal(err.code, "AUTH_MISSING");
      assert.match(err.message, /GOOGLE_REFRESH_TOKEN/);
      assert.doesNotMatch(err.message, /should-not-leak/);
      return true;
    },
  );
});

test("blank values count as unset", () => {
  process.env.GOOGLE_CLIENT_ID = "   ";
  process.env.GOOGLE_CLIENT_SECRET = "";
  process.env.GOOGLE_REFRESH_TOKEN = "";
  assert.equal(envLogin(), undefined);
});

test("expired-login errors tell a hosted server owner to update GOOGLE_REFRESH_TOKEN", () => {
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh";
  const expired = mapGoogleError({ code: 400, message: "invalid_grant" }, "auth");
  assert.equal(expired.code, "AUTH_EXPIRED");
  assert.match(expired.message, /GOOGLE_REFRESH_TOKEN/);
  assert.doesNotMatch(expired.message, /refresh\b.*secret/);
});
