import assert from "node:assert/strict";
import test from "node:test";
import { envLogin, mapGoogleError } from "../src/auth.js";
import { ToolFailure } from "../src/validation.js";

const NAMES = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "GOOGLE_OAUTH_CREDENTIALS_JSON",
  "GOOGLE_OAUTH_TOKEN_JSON",
] as const;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
const clientJson = { installed: { client_id: "json-id", client_secret: "json-secret" } };
const tokenJson = { refresh_token: "json-refresh", access_token: "old", expiry_date: 1 };
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

test("base64 credentials and token JSON become the hosted login", () => {
  process.env.GOOGLE_OAUTH_CREDENTIALS_JSON = b64(clientJson);
  process.env.GOOGLE_OAUTH_TOKEN_JSON = b64(tokenJson);
  assert.deepEqual(envLogin(), {
    clientId: "json-id",
    clientSecret: "json-secret",
    refreshToken: "json-refresh",
  });
});

test("raw (not base64) JSON in the variables also works", () => {
  process.env.GOOGLE_OAUTH_CREDENTIALS_JSON = JSON.stringify(clientJson);
  process.env.GOOGLE_OAUTH_TOKEN_JSON = JSON.stringify(tokenJson);
  assert.equal(envLogin()?.refreshToken, "json-refresh");
});

test("only one of the two JSON variables names the missing one", () => {
  process.env.GOOGLE_OAUTH_CREDENTIALS_JSON = b64(clientJson);
  assert.throws(
    () => envLogin(),
    (err: unknown) =>
      err instanceof ToolFailure && err.code === "AUTH_MISSING" && /GOOGLE_OAUTH_TOKEN_JSON/.test(err.message),
  );
});

test("garbage in a JSON variable is rejected without echoing the value", () => {
  process.env.GOOGLE_OAUTH_CREDENTIALS_JSON = "not-base64-or-json-secret-text";
  process.env.GOOGLE_OAUTH_TOKEN_JSON = b64(tokenJson);
  assert.throws(
    () => envLogin(),
    (err: unknown) => {
      assert.ok(err instanceof ToolFailure);
      assert.match(err.message, /GOOGLE_OAUTH_CREDENTIALS_JSON/);
      assert.doesNotMatch(err.message, /secret-text/);
      return true;
    },
  );
});

test("a Web client JSON and a token without refresh_token are rejected", () => {
  process.env.GOOGLE_OAUTH_CREDENTIALS_JSON = b64({ web: { client_id: "a", client_secret: "b" } });
  process.env.GOOGLE_OAUTH_TOKEN_JSON = b64(tokenJson);
  assert.throws(() => envLogin(), (err: unknown) => err instanceof ToolFailure && /Web application/.test(err.message));

  process.env.GOOGLE_OAUTH_CREDENTIALS_JSON = b64(clientJson);
  process.env.GOOGLE_OAUTH_TOKEN_JSON = b64({ access_token: "only" });
  assert.throws(() => envLogin(), (err: unknown) => err instanceof ToolFailure && err.code === "AUTH_EXPIRED");
});

test("the three plain variables win when both forms are set, and hints name the token JSON variable", () => {
  process.env.GOOGLE_CLIENT_ID = "plain-id";
  process.env.GOOGLE_CLIENT_SECRET = "plain-secret";
  process.env.GOOGLE_REFRESH_TOKEN = "plain-refresh";
  process.env.GOOGLE_OAUTH_CREDENTIALS_JSON = b64(clientJson);
  process.env.GOOGLE_OAUTH_TOKEN_JSON = b64(tokenJson);
  assert.equal(envLogin()?.clientId, "plain-id");

  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
  const expired = mapGoogleError({ code: 400, message: "invalid_grant" }, "auth");
  assert.match(expired.message, /GOOGLE_OAUTH_TOKEN_JSON/);
});
