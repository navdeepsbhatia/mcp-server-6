/**
 * One-time browser login for the Desktop OAuth client.
 * Run this before starting the MCP server: npm run auth
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import dotenv from "dotenv";
import { google } from "googleapis";
import { SCOPES, googlePaths, readInstalledClient, saveGoogleToken } from "../src/auth.js";
import { ToolFailure } from "../src/validation.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });

const LOGIN_TIMEOUT_MS = 180_000;

function openBrowser(url: string): void {
  if (process.platform === "win32") {
    // Passing the OAuth URL on the command line drops everything after "&", including response_type.
    const page = path.join(os.tmpdir(), "google-workspace-mcp-auth.html");
    const href = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}">`);
    spawn("explorer.exe", [page], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
}

/**
 * Listen on 127.0.0.1 with a free port, then accept the single OAuth redirect.
 * Desktop clients allow this loopback redirect without registering each port.
 */
function startLoopback(): Promise<{
  redirectUri: string;
  code: Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let settleCode: (code: string) => void = () => undefined;
    let failCode: (err: Error) => void = () => undefined;
    const code = new Promise<string>((resolveCode, rejectCode) => {
      settleCode = resolveCode;
      failCode = rejectCode;
    });

    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const oauthError = requestUrl.searchParams.get("error");
      const oauthCode = requestUrl.searchParams.get("code");

      if (oauthError) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Google sign-in was cancelled. You can close this window.");
        failCode(new ToolFailure("AUTH_MISSING", `Google sign-in was not completed (${oauthError}).`));
        return;
      }

      if (!oauthCode) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Missing authorization code.");
        return;
      }

      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Authorization complete. You can close this window and return to the terminal.");
      settleCode(oauthCode);
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new ToolFailure("AUTH_MISSING", "Could not open a local address for Google sign-in."));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}`,
        code,
        close: () => server.close(),
      });
    });
  });
}

async function authorize(): Promise<void> {
  const { credentialsPath, tokenPath } = googlePaths();
  const installed = readInstalledClient(credentialsPath);
  const loopback = await startLoopback();

  try {
    const client = new google.auth.OAuth2(installed.clientId, installed.clientSecret, loopback.redirectUri);
    const authUrl = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [...SCOPES],
    });

    console.log("Opening a browser so you can sign in with the Google account this server should use.");
    console.log("If the browser does not open, visit this URL:");
    console.log(authUrl);
    openBrowser(authUrl);

    const code = await Promise.race([
      loopback.code,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new ToolFailure("AUTH_MISSING", "Timed out waiting for Google sign-in.")),
          LOGIN_TIMEOUT_MS,
        );
      }),
    ]);

    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new ToolFailure(
        "AUTH_MISSING",
        "Google did not return a refresh token. Remove this app at https://myaccount.google.com/permissions and run npm run auth again.",
      );
    }

    saveGoogleToken(tokenPath, {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expiry_date: tokens.expiry_date,
      token_type: tokens.token_type,
      scope: tokens.scope ?? undefined,
      id_token: tokens.id_token,
    });
    console.log(`Saved the Google login to ${tokenPath}.`);
    console.log("The token stays on this machine. You can register the MCP server now.");
  } finally {
    loopback.close();
  }
}

authorize().catch((err: unknown) => {
  const message = err instanceof ToolFailure ? err.message : "Google sign-in failed.";
  console.error(message);
  process.exitCode = 1;
});
