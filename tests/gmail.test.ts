import assert from "node:assert/strict";
import test from "node:test";
import { mapGoogleError } from "../src/auth.js";
import { buildRawMime, sendPlainTextEmail, type GmailSendClient } from "../src/gmail.js";
import { ToolFailure, toFailurePayload } from "../src/validation.js";

const previousOauthCredentials = process.env.GOOGLE_OAUTH_CREDENTIALS_PATH;
const previousOauthToken = process.env.GOOGLE_OAUTH_TOKEN_PATH;
const previousCredentials = process.env.GOOGLE_CREDENTIALS_PATH;
const previousToken = process.env.GOOGLE_TOKEN_PATH;

test.afterEach(() => {
  restore("GOOGLE_OAUTH_CREDENTIALS_PATH", previousOauthCredentials);
  restore("GOOGLE_OAUTH_TOKEN_PATH", previousOauthToken);
  restore("GOOGLE_CREDENTIALS_PATH", previousCredentials);
  restore("GOOGLE_TOKEN_PATH", previousToken);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function pointAtMissingLogin(): void {
  process.env.GOOGLE_OAUTH_CREDENTIALS_PATH = "credentials/missing-client.json";
  process.env.GOOGLE_OAUTH_TOKEN_PATH = "credentials/missing-token.json";
  process.env.GOOGLE_CREDENTIALS_PATH = "credentials/missing-client.json";
  process.env.GOOGLE_TOKEN_PATH = "credentials/missing-token.json";
}

test("rejects an address that is not one plain email", async () => {
  const samples = ["not-an-email", "alex@example.com, sam@example.com", "Alex <alex@example.com>", "alex@example.com\nBcc: evil@example.com"];
  for (const to of samples) {
    await assert.rejects(
      () => buildRawMime({ to, subject: "Project update", body: "Hello" }),
      (err: unknown) => err instanceof ToolFailure && err.code === "INVALID_RECIPIENT",
    );
  }
});

test("rejects a subject with a line break and an empty body", async () => {
  await assert.rejects(
    () => buildRawMime({ to: "alex@example.com", subject: "Hello\nBcc: evil@example.com", body: "Hello" }),
    (err: unknown) => err instanceof ToolFailure && err.code === "INVALID_SUBJECT",
  );
  await assert.rejects(
    () => buildRawMime({ to: "alex@example.com", subject: "Project update", body: "  \n  " }),
    (err: unknown) => err instanceof ToolFailure && err.code === "INVALID_BODY",
  );
});

test("builds a UTF-8 MIME message for the authenticated user, not a chosen sender", async () => {
  const raw = await buildRawMime({
    to: "alex@example.com",
    subject: "Project update",
    body: "### Weekly update\nThe first milestone is complete.",
  });
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const headerEnd = decoded.search(/\r?\n\r?\n/);
  assert.ok(headerEnd > 0);
  const headers = decoded.slice(0, headerEnd);
  const body = decoded.slice(headerEnd);

  assert.match(headers, /To:\s*alex@example\.com/i);
  assert.match(headers, /Subject:\s*Project update/i);
  assert.match(headers, /charset=utf-8/i);
  assert.doesNotMatch(headers, /^From:/im);
  assert.doesNotMatch(headers, /^Bcc:/im);
  assert.match(body, /### Weekly update/);
  assert.match(body, /The first milestone is complete\./);
});

test("keeps a body line that looks like a header out of the header block", async () => {
  const raw = await buildRawMime({
    to: "alex@example.com",
    subject: "Project update",
    body: "Bcc: injected@example.com\nHello",
  });
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const headerEnd = decoded.search(/\r?\n\r?\n/);
  const headers = decoded.slice(0, headerEnd);
  assert.doesNotMatch(headers, /^Bcc:/im);
  assert.match(decoded.slice(headerEnd), /Bcc: injected@example\.com/);
});

test("missing authorization is an error and not a success", async () => {
  pointAtMissingLogin();

  await assert.rejects(
    () =>
      sendPlainTextEmail({
        to: "alex@example.com",
        subject: "Project update",
        body: "The first milestone is complete.",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ToolFailure);
      assert.equal(err.code, "AUTH_MISSING");
      const payload = toFailurePayload(err);
      assert.equal(payload.success, false);
      assert.match(payload.message, /npm run auth/);
      return true;
    },
  );
});

test("maps Gmail permission and expired login errors", () => {
  const denied = mapGoogleError(
    { code: 403, response: { status: 403, data: { error: { status: "PERMISSION_DENIED", message: "insufficient" } } } },
    "gmail",
  );
  assert.equal(denied.code, "GMAIL_PERMISSION_DENIED");
  assert.match(denied.message, /not allowed to send this message/);

  const expired = mapGoogleError({ code: 400, message: "invalid_grant" }, "auth");
  assert.equal(expired.code, "AUTH_EXPIRED");
  assert.match(expired.message, /npm run auth/);

  const payload = toFailurePayload(denied);
  assert.equal(payload.success, false);
  assert.equal(payload.error, "GMAIL_PERMISSION_DENIED");

  const limited = mapGoogleError({ code: 429, message: "rate limit" }, "gmail");
  assert.equal(limited.code, "RATE_LIMITED");
  assert.equal(toFailurePayload(limited).success, false);
  assert.match(limited.message, /not retried/);

  const serverError = mapGoogleError({ code: 503, message: "unavailable" }, "gmail");
  assert.equal(serverError.code, "GOOGLE_SERVER_ERROR");
  assert.match(serverError.message, /not confirmed/);
});

function fakeGmail(send: GmailSendClient["users"]["messages"]["send"]): {
  client: GmailSendClient;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      users: {
        messages: {
          send: async (args, options) => {
            calls += 1;
            return send(args, options);
          },
        },
      },
    },
  };
}

test("a valid send calls Gmail once with a base64url raw message and does not retry", async () => {
  const sent: Array<{ userId: string; raw: string; retry?: boolean }> = [];
  const fake = fakeGmail(async (args, options) => {
    sent.push({ userId: args.userId, raw: args.requestBody.raw, retry: options?.retry });
    return { data: { id: "MSG123", threadId: "THR123" } };
  });

  const result = await sendPlainTextEmail(
    {
      to: "alex@example.com",
      subject: "Project update",
      body: "Hi Alex, the first milestone is complete.",
    },
    { gmail: fake.client },
  );

  assert.equal(fake.calls(), 1);
  assert.equal(sent[0]?.userId, "me");
  assert.equal(sent[0]?.retry, false);
  const decoded = Buffer.from(sent[0]?.raw ?? "", "base64url").toString("utf8");
  assert.match(decoded, /To:\s*alex@example\.com/i);
  assert.match(decoded, /Subject:\s*Project update/i);
  assert.match(decoded, /Hi Alex, the first milestone is complete\./);
  assert.equal(result.success, true);
  assert.equal(result.messageId, "MSG123");
  assert.equal(result.threadId, "THR123");
});

test("invalid email and empty fields never call Gmail", async () => {
  const fake = fakeGmail(async () => {
    throw new Error("Gmail should not be called");
  });
  await assert.rejects(
    () => sendPlainTextEmail({ to: "not-an-email", subject: "Hi", body: "Hello" }, { gmail: fake.client }),
    (err: unknown) => err instanceof ToolFailure && err.code === "INVALID_RECIPIENT",
  );
  await assert.rejects(
    () => sendPlainTextEmail({ to: "alex@example.com", subject: "", body: "Hello" }, { gmail: fake.client }),
    (err: unknown) => err instanceof ToolFailure && err.code === "INVALID_SUBJECT",
  );
  await assert.rejects(
    () => sendPlainTextEmail({ to: "alex@example.com", subject: "Hi", body: " " }, { gmail: fake.client }),
    (err: unknown) => err instanceof ToolFailure && err.code === "INVALID_BODY",
  );
  assert.equal(fake.calls(), 0);
});

test("a Gmail permission or rate-limit failure is one call and not a success", async () => {
  const denied = fakeGmail(async () => {
    throw { code: 403, response: { status: 403, data: { error: { status: "PERMISSION_DENIED", message: "no" } } } };
  });
  await assert.rejects(
    () =>
      sendPlainTextEmail(
        { to: "alex@example.com", subject: "Project update", body: "Hello" },
        { gmail: denied.client },
      ),
    (err: unknown) => {
      assert.ok(err instanceof ToolFailure);
      assert.equal(err.code, "GMAIL_PERMISSION_DENIED");
      assert.equal(toFailurePayload(err).success, false);
      return true;
    },
  );
  assert.equal(denied.calls(), 1);

  const limited = fakeGmail(async () => {
    throw { code: 429, response: { status: 429, data: { error: { status: "RESOURCE_EXHAUSTED", message: "slow down" } } } };
  });
  await assert.rejects(
    () =>
      sendPlainTextEmail(
        { to: "alex@example.com", subject: "Project update", body: "Hello" },
        { gmail: limited.client },
      ),
    (err: unknown) => err instanceof ToolFailure && err.code === "RATE_LIMITED" && toFailurePayload(err).success === false,
  );
  assert.equal(limited.calls(), 1);
});
