/**
 * Google OAuth for one local user.
 * Client secrets and tokens stay on disk. They are never returned to the MCP client.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";
import { ToolFailure } from "./validation.js";

type AuthClient = InstanceType<typeof google.auth.OAuth2>;

interface SavedToken {
  refresh_token?: string | null;
  access_token?: string | null;
  expiry_date?: number | null;
  token_type?: string | null;
  scope?: string;
  id_token?: string | null;
}

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/documents",
] as const;

/** One login on this machine, shared by Cursor, Antigravity, and Claude. Not inside the git repo. */
function defaultConfigDir(): string {
  return path.join(os.homedir(), ".google-workspace-mcp");
}

function envPath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function googlePaths(): { credentialsPath: string; tokenPath: string } {
  const credentials =
    envPath("GOOGLE_OAUTH_CREDENTIALS_PATH") ?? envPath("GOOGLE_CREDENTIALS_PATH");
  const token = envPath("GOOGLE_OAUTH_TOKEN_PATH") ?? envPath("GOOGLE_TOKEN_PATH");
  return {
    credentialsPath: credentials
      ? path.resolve(process.cwd(), credentials)
      : path.join(defaultConfigDir(), "secrets", "credentials.json"),
    tokenPath: token ? path.resolve(process.cwd(), token) : path.join(defaultConfigDir(), "token.json"),
  };
}

/** Gmail send and Docs batchUpdate must not be retried. A retry can email or append twice. */
export const noWriteRetry = { retry: false, retryConfig: { retry: 0 } } as const;

interface InstalledClient {
  clientId: string;
  clientSecret: string;
}

/** Read a Desktop (installed) OAuth client file. Reject a Web client. */
export function readInstalledClient(credentialsPath: string): InstalledClient {
  if (!fs.existsSync(credentialsPath)) {
    throw new ToolFailure(
      "AUTH_MISSING",
      `OAuth client file not found at ${credentialsPath}. Download a Desktop app client JSON from Google Cloud Console, save it there, and run npm run auth.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as unknown;
  } catch {
    throw new ToolFailure(
      "AUTH_MISSING",
      `Could not read the OAuth client file at ${credentialsPath}. Download a Desktop app client JSON and try again.`,
    );
  }

  return installedClientFromJson(parsed);
}

/** Validate parsed Desktop (installed) OAuth client JSON. Rejects a Web client. */
function installedClientFromJson(parsed: unknown): InstalledClient {
  const root = (parsed ?? {}) as {
    installed?: { client_id?: string; client_secret?: string };
    web?: { client_id?: string; client_secret?: string };
  };

  if (root.web && !root.installed) {
    throw new ToolFailure(
      "AUTH_MISSING",
      "That file is a Web application client. Create an installed Desktop client instead.",
    );
  }

  const creds = root.installed;
  if (!creds?.client_id || !creds.client_secret) {
    throw new ToolFailure(
      "AUTH_MISSING",
      "The OAuth client file is missing client_id or client_secret. Use a Desktop application client JSON.",
    );
  }

  return { clientId: creds.client_id, clientSecret: creds.client_secret };
}

const ENV_LOGIN_VARS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] as const;
const ENV_JSON_VARS = ["GOOGLE_OAUTH_CREDENTIALS_JSON", "GOOGLE_OAUTH_TOKEN_JSON"] as const;

/**
 * Decode an environment variable that holds a JSON file, either base64 encoded or as raw JSON.
 * Errors name the variable and never contain its value.
 */
function readJsonEnv(name: string, value: string): unknown {
  const text = value.startsWith("{") ? value : Buffer.from(value, "base64").toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ToolFailure(
      "AUTH_MISSING",
      `${name} is not valid base64 or JSON. Re-encode the original JSON file and set the variable again.`,
    );
  }
}

/**
 * Login supplied through environment variables, used when the server is hosted. Two forms:
 *   1. GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN
 *   2. GOOGLE_OAUTH_CREDENTIALS_JSON + GOOGLE_OAUTH_TOKEN_JSON (the two files, base64 encoded)
 * Returns undefined when none are set (use the local files instead). Throws when a form is only
 * partly set. Error messages name the variables and never contain their values.
 */
export function envLogin(): { clientId: string; clientSecret: string; refreshToken: string } | undefined {
  const values = ENV_LOGIN_VARS.map((name) => envPath(name));
  const jsonValues = ENV_JSON_VARS.map((name) => envPath(name));
  const anySimple = values.some((value) => value !== undefined);
  const anyJson = jsonValues.some((value) => value !== undefined);
  if (!anySimple && !anyJson) return undefined;

  // The three plain variables win when both forms are present.
  if (anySimple || !anyJson) {
    const missing = ENV_LOGIN_VARS.filter((_, index) => values[index] === undefined);
    if (missing.length > 0) {
      throw new ToolFailure(
        "AUTH_MISSING",
        `Google login is only partly configured. Set the missing environment variable(s): ${missing.join(", ")}.`,
      );
    }
    const [clientId, clientSecret, refreshToken] = values as [string, string, string];
    return { clientId, clientSecret, refreshToken };
  }

  const missingJson = ENV_JSON_VARS.filter((_, index) => jsonValues[index] === undefined);
  if (missingJson.length > 0) {
    throw new ToolFailure(
      "AUTH_MISSING",
      `Google login is only partly configured. Set the missing environment variable(s): ${missingJson.join(", ")}.`,
    );
  }
  const [credentialsValue, tokenValue] = jsonValues as [string, string];
  const client = installedClientFromJson(readJsonEnv("GOOGLE_OAUTH_CREDENTIALS_JSON", credentialsValue));
  const token = readJsonEnv("GOOGLE_OAUTH_TOKEN_JSON", tokenValue) as SavedToken;
  if (!token?.refresh_token) {
    throw new ToolFailure(
      "AUTH_EXPIRED",
      "GOOGLE_OAUTH_TOKEN_JSON has no refresh_token. Run npm run auth on your own machine and encode the new token.json.",
    );
  }
  return { clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: token.refresh_token };
}

/** True when the Google login comes from environment variables (hosted) rather than local files. */
function usingEnvLogin(): boolean {
  return [...ENV_LOGIN_VARS, ...ENV_JSON_VARS].some((name) => envPath(name) !== undefined);
}

/** The remedy sentence differs: a hosted server cannot open a browser. */
function reauthHint(): string {
  if (!usingEnvLogin()) return "Run npm run auth and sign in again.";
  return envPath("GOOGLE_OAUTH_TOKEN_JSON") !== undefined && envPath("GOOGLE_REFRESH_TOKEN") === undefined
    ? "Run npm run auth on your own machine, then update GOOGLE_OAUTH_TOKEN_JSON on the server with the new token.json, base64 encoded."
    : "Run npm run auth on your own machine, then update GOOGLE_REFRESH_TOKEN on the server.";
}

function readToken(tokenPath: string): SavedToken {
  if (!fs.existsSync(tokenPath)) {
    throw new ToolFailure(
      "AUTH_MISSING",
      "No saved Google login. Run npm run auth and sign in once in the browser before using the tools.",
    );
  }
  try {
    return JSON.parse(fs.readFileSync(tokenPath, "utf8")) as SavedToken;
  } catch {
    throw new ToolFailure(
      "AUTH_EXPIRED",
      "The saved Google token could not be read. Run npm run auth and sign in again.",
    );
  }
}

/** Write the token outside the repo with mode 0600. Callers must not log the contents. */
export function saveGoogleToken(tokenPath: string, token: SavedToken): void {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // Some Windows setups reject Unix mode bits. The file is still outside the repo.
  }
}

/**
 * Load the saved login and refresh the access token when it is expired.
 * The caller always acts as this one local user. There is no sender argument.
 */
export async function getAuthClient(): Promise<AuthClient> {
  const fromEnv = envLogin();
  if (fromEnv) {
    // Hosted mode (Railway): no files. A Google refresh token does not rotate, so refreshed
    // access tokens only need to live in memory.
    const client = new google.auth.OAuth2(fromEnv.clientId, fromEnv.clientSecret);
    client.setCredentials({ refresh_token: fromEnv.refreshToken });
    try {
      await client.getAccessToken();
    } catch (err) {
      throw mapGoogleError(err, "auth");
    }
    return client;
  }

  const { credentialsPath, tokenPath } = googlePaths();
  const installed = readInstalledClient(credentialsPath);
  const saved = readToken(tokenPath);

  if (!saved.refresh_token) {
    throw new ToolFailure(
      "AUTH_EXPIRED",
      "The saved Google login has no refresh token. Run npm run auth and sign in again.",
    );
  }

  const client = new google.auth.OAuth2(installed.clientId, installed.clientSecret);
  client.setCredentials(saved);

  // Persist refreshed access tokens without dropping the refresh token.
  client.on("tokens", (tokens) => {
    const current = readToken(tokenPath);
    saveGoogleToken(tokenPath, {
      ...current,
      ...tokens,
      refresh_token: tokens.refresh_token ?? current.refresh_token,
    });
  });

  try {
    await client.getAccessToken();
  } catch (err) {
    throw mapGoogleError(err, "auth");
  }

  return client;
}

/** Turn a Google client error into a short code and a message that contains no secrets. */
export function mapGoogleError(err: unknown, service: "gmail" | "docs" | "auth"): ToolFailure {
  const status = readStatus(err);
  const apiStatus = readApiStatus(err);
  const apiMessage = sanitize(readApiMessage(err));

  if (
    status === 401 ||
    apiStatus === "UNAUTHENTICATED" ||
    /invalid_grant|invalid credentials|token has been expired or revoked|expired/i.test(apiMessage)
  ) {
    return new ToolFailure(
      "AUTH_EXPIRED",
      `Google authorization has expired or was revoked. ${reauthHint()}`,
    );
  }

  if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(`${apiStatus} ${apiMessage}`)) {
    return new ToolFailure(
      "AUTH_SCOPES_MISSING",
      `The saved Google login is missing Gmail send or Docs edit permission. ${reauthHint()} Grant both scopes.`,
    );
  }

  if (status === 429 || apiStatus === "RESOURCE_EXHAUSTED") {
    const action = service === "gmail" ? "email" : "document update";
    return new ToolFailure(
      "RATE_LIMITED",
      `Google is rate-limiting this account, so the ${action} was not completed. This call was not retried. Wait, confirm it did not already succeed, then try once more.`,
    );
  }

  if (typeof status === "number" && status >= 500) {
    return new ToolFailure(
      "GOOGLE_SERVER_ERROR",
      "Google returned a server error and success was not confirmed. This call was not retried, because a retry could create a duplicate. Check Sent mail or the document before trying again.",
    );
  }

  if (service === "gmail" && (status === 403 || apiStatus === "PERMISSION_DENIED")) {
    return new ToolFailure(
      "GMAIL_PERMISSION_DENIED",
      "The authenticated Google account is not allowed to send this message. Reconnect or check account permissions.",
    );
  }

  if (service === "docs" && (status === 404 || apiStatus === "NOT_FOUND")) {
    return new ToolFailure(
      "DOCUMENT_NOT_FOUND",
      "That Google Doc was not found. Check the document ID or URL and try again.",
    );
  }

  if (service === "docs" && (status === 403 || apiStatus === "PERMISSION_DENIED")) {
    return new ToolFailure(
      "DOCS_PERMISSION_DENIED",
      `The authenticated Google account cannot edit this document. Check sharing permissions. ${reauthHint()}`,
    );
  }

  if (service === "auth") {
    return new ToolFailure(
      "AUTH_EXPIRED",
      `Google authorization failed. ${reauthHint()}`,
    );
  }

  const code = service === "gmail" ? "GMAIL_API_ERROR" : "DOCS_API_ERROR";
  const detail = apiMessage.length > 0 ? ` ${apiMessage}` : "";
  return new ToolFailure(code, `Google request failed (${status ?? "unknown"}).${detail}`);
}

export function logSafeError(err: unknown): void {
  if (err instanceof ToolFailure) {
    console.error(`[google-workspace-mcp] ${err.code}: ${err.message}`);
    return;
  }
  const message = err instanceof Error ? err.message : "unknown error";
  console.error(`[google-workspace-mcp] ${sanitize(message)}`);
}

function readStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const record = err as { code?: unknown; response?: { status?: unknown } };
  if (typeof record.code === "number") return record.code;
  if (typeof record.response?.status === "number") return record.response.status;
  return undefined;
}

function readApiStatus(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const status = (err as { response?: { data?: { error?: { status?: unknown } } } }).response?.data?.error
    ?.status;
  return typeof status === "string" ? status : "";
}

function readApiMessage(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const apiMessage = (err as { response?: { data?: { error?: { message?: unknown } } } }).response?.data
    ?.error?.message;
  if (typeof apiMessage === "string") return apiMessage;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function sanitize(message: string): string {
  return message
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(/ya29\.[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 240);
}
