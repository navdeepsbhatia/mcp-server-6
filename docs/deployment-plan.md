# Deployment Plan: google-workspace-mcp on Railway

> **Implementation status:** the code changes in section 3 are done and tested: `src/server.ts`, `src/http.ts`, env-variable auth in `src/auth.ts`, `Dockerfile`, `.dockerignore`, `railway.json`, `.env.example`, and tests (`npm test`, 29 passing). Still manual: Google OAuth decisions (section 4), `git init` and push, the Railway dashboard steps (section 6.3 onward), and client configuration (section 7). The Docker image has not been built locally because Docker is not installed on this machine.

## 1. Summary

Deploy the `google-workspace-mcp` server (tools: `send_email`, `append_to_google_doc`) to [Railway](https://railway.com) so it is reachable at a public HTTPS URL, such as `https://google-workspace-mcp-production.up.railway.app/mcp`. MCP clients (Cursor, Claude, Antigravity) then connect over HTTP instead of spawning a local process.

**The project cannot be deployed to Railway as it is.** Two assumptions in the current code break on a hosted service:

| # | Current behavior | Why it fails on Railway | Fix (section) |
| --- | --- | --- | --- |
| 1 | `src/index.ts` uses `serveStdio` only. A client must spawn `node dist/index.js` and talk over stdin/stdout. | Railway runs a long-lived web service. Nothing can attach to its stdio, and it must listen on `$PORT`. | Add a Streamable HTTP entrypoint (section 3.1) |
| 2 | `src/auth.ts` reads `credentials.json` and `token.json` from `~/.google-workspace-mcp/`, created by the interactive `npm run auth`. | A Railway container has no browser and no persistent home directory, and its filesystem is wiped on every deploy. | Read OAuth values from environment variables (section 3.2) |

There is also a **security gap** that does not exist locally: the endpoint will be on the public internet and can send email from your Gmail account. It **must** require a secret bearer token (section 3.3). Do not deploy without it.

**Changes required, in order of importance:**

1. **Protect the endpoint.** A public URL that can send email and edit Docs must reject every request without a valid secret (3.3).
2. **Add an HTTP entry point** (MCP Streamable HTTP) next to the existing stdio one (3.1).
3. **Load secrets from environment variables** instead of local files (3.2). The refresh token can optionally be persisted on a Railway volume (6.4).
4. **Containerize** with a pinned Node 20 image and a Railway config file (6.2).

The tool logic (`gmail.ts`, `docs.ts`, `validation.ts`) does not change. The stdio entrypoint stays for local use. The server stays **single-user**: one Google account, one deployment.

### Local today vs on Railway

| Concern | Local today | On Railway |
| --- | --- | --- |
| Transport | stdio | Streamable HTTP at `POST /mcp` |
| Entry point | `dist/index.js` | `dist/http.js` (new) |
| Who can call it | Only processes your OS user starts | Anyone with the URL, so a bearer token is required |
| OAuth client | `~/.google-workspace-mcp/secrets/credentials.json` | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` variables |
| Refresh token | `~/.google-workspace-mcp/token.json` | `GOOGLE_REFRESH_TOKEN` variable (or a file on a volume) |
| First login | `npm run auth` on this machine | Run `npm run auth` locally once, then copy the token into Railway |
| Port | none | `$PORT`, injected by Railway, bound on `0.0.0.0` |
| Logs | stderr only | stdout/stderr to the Railway log viewer |
| Process lifetime | started and stopped by the client | long-lived service with a healthcheck and restarts |

`docs/problemStatement.md` and `README.md` list "HTTP transport / cloud hosting" as out of scope for the MVP. This plan is a deliberate extension of that scope. Keep the stdio entrypoint working so local use is unchanged.

---

## 2. Target architecture

```text
MCP client (Cursor / Claude / Antigravity)
        |
        |  HTTPS  POST /mcp   Authorization: Bearer <MCP_AUTH_TOKEN>
        v
Railway edge (TLS termination, public domain)
        |
        v
Railway service: Node 20+ (node dist/http.js, listens on 0.0.0.0:$PORT)
   |  GET /health            -> 200 (no auth, used by Railway healthcheck)
   |  POST /mcp              -> bearer check -> createMcpHandler(createServer)
   |
   +--> send_email ----------------> Gmail API
   +--> append_to_google_doc ------> Google Docs API
   +--> Google OAuth client id/secret + refresh token (Railway env vars)
```

Design choices:

- **Stateless HTTP.** `createMcpHandler` (from `@modelcontextprotocol/server`, v2.4.0 is installed) builds a fresh `McpServer` per request. There are no sessions, no database, and **no Railway volume is needed**. One replica is enough.
- **No filesystem state.** Google refresh tokens do not rotate on use, so refreshed access tokens can live in memory.
- **Single user.** The deployed server acts as the one Google account that generated the refresh token, the same model as today.

---

## 3. Code changes required

Do these on a branch and verify locally (section 5) before touching Railway.

### 3.1 Add an HTTP entrypoint

1. Move `createServer()` and the tool definitions out of `src/index.ts` into a new `src/server.ts` that exports `createServer`. Keep **`src/index.ts` as the stdio entrypoint** that imports it. `tests/server.test.ts` spawns `src/index.ts`, so the stdio behavior and its test stay valid.
2. Add the Node adapter package. It lives outside `@modelcontextprotocol/server`:

   ```bash
   npm install @modelcontextprotocol/node
   ```

   Latest is 2.1.2, and it has a peer dependency on `@modelcontextprotocol/server@^2.4.0`, which matches what is installed.
3. Create `src/http.ts`. Sketch (check the exact `toNodeHandler` signature against the installed `@modelcontextprotocol/node` types):

   ```ts
   import http from "node:http";
   import { timingSafeEqual } from "node:crypto";
   import { createMcpHandler } from "@modelcontextprotocol/server";
   import { toNodeHandler } from "@modelcontextprotocol/node";
   import { createServer } from "./server.js";

   const PORT = Number(process.env.PORT ?? 3000);
   const TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
   if (TOKEN.length < 32) {
     console.error("MCP_AUTH_TOKEN must be set to a random string of at least 32 characters.");
     process.exit(1); // refuse to start an open endpoint
   }

   const mcp = toNodeHandler(createMcpHandler(createServer));

   function authorized(header: string | undefined): boolean {
     const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
     const expected = Buffer.from(TOKEN);
     return given.length === expected.length && timingSafeEqual(given, expected);
   }

   const server = http.createServer((req, res) => {
     if (req.url === "/health") {
       res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
       return;
     }
     if (req.url?.split("?")[0] !== "/mcp") {
       res.writeHead(404).end();
       return;
     }
     if (!authorized(req.headers.authorization)) {
       res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
       return;
     }
     void mcp(req, res);
   });

   server.listen(PORT, "0.0.0.0", () => console.log(`google-workspace-mcp listening on :${PORT}`));

   // Railway sends SIGTERM on redeploy: stop accepting connections and exit.
   process.on("SIGTERM", () => server.close(() => process.exit(0)));
   ```

   Notes:
   - Bind to `0.0.0.0`, not `127.0.0.1`, or Railway cannot reach the process.
   - The token check uses a constant-time comparison and runs **before** any MCP handling.
   - Do not log request bodies or the `Authorization` header (the existing "no email bodies in logs" rule still applies).
4. Update `package.json` scripts:

   ```json
   "start": "node dist/index.js",
   "start:http": "node dist/http.js"
   ```

   `tsconfig.json` already compiles everything under `src/`, so `dist/http.js` is produced by `npm run build`.

### 3.2 Environment-variable credentials (`src/auth.ts`)

Change `getAuthClient()` so it prefers environment variables and falls back to the existing file-based flow (local use keeps working):

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | `client_id` from the Desktop OAuth client |
| `GOOGLE_CLIENT_SECRET` | `client_secret` from the same client |
| `GOOGLE_REFRESH_TOKEN` | `refresh_token` produced by `npm run auth` on your machine |

Behavior:

- If all three are set, build `new google.auth.OAuth2(id, secret)`, call `setCredentials({ refresh_token })`, and skip `readInstalledClient` and `readToken`. Do **not** register the `tokens` listener that writes `token.json`.
- If none are set, use the current file-based path unchanged.
- If only some are set, throw `AUTH_MISSING` with a message naming the missing variables (never include their values).
- Update the `AUTH_*` error text so it does not tell a remote caller to "run `npm run auth`" when running in env mode. For example: "Regenerate the refresh token locally and update `GOOGLE_REFRESH_TOKEN` in Railway."
- Add a test in `tests/` for the env path, using the same mocking style as the existing tests.

### 3.3 Protect the endpoint

- **`MCP_AUTH_TOKEN`**: a random secret of at least 32 characters. Generate it with:

  ```powershell
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

- The server refuses to start without it (see 3.1). Without this check, anyone who finds the URL could send email as you.
- Optional hardening:
  - Rate-limit `/mcp` (for example 30 requests a minute) so a leaked token has limited blast radius.
  - Check the `Origin` header if browser-based clients are ever used.
- Keep the existing server-side Zod validation. The host-side approval prompt still applies.

### 3.4 Repository hygiene

The workspace is **not a git repo yet**, and the folder contains `credentials.json` and `.env` with real secrets.

- `.gitignore` already excludes `.env`, `credentials.json`, `token.json`, `secrets/`, `client_secret*.json`, `node_modules/` and `dist/`. Run `git init`, then **`git status` and `git add -n .`** to confirm none of those files are staged before the first commit.
- Never put the secret values in `railway.json`, a `Dockerfile`, or the README. They go only in Railway's Variables tab.
- If a secret is ever committed or pasted somewhere public, rotate it. Create a new OAuth client secret in Google Cloud Console, revoke the app at <https://myaccount.google.com/permissions>, and generate a new token.

---

## 4. Google Cloud and OAuth preparation

1. **Refresh tokens in "Testing" mode expire after 7 days.** The README setup uses an External app in testing mode, and both scopes (`gmail.send`, `documents`) are sensitive. A hosted server would silently start returning `AUTH_EXPIRED` every week. Choose one:
   - **Recommended for a personal deployment:** in Google Auth Platform → Audience, click **Publish app** (In production). You do not need to complete verification for personal use. Google shows an "unverified app" warning on the consent screen, which you click through for your own account. Refresh tokens then stay valid until you revoke them. The unverified app is limited to 100 users, which is fine here.
   - **Alternative:** keep Testing mode and re-run `npm run auth` and update `GOOGLE_REFRESH_TOKEN` in Railway every 7 days.
2. Keep the **Desktop app** OAuth client. The token is created locally with `npm run auth`, so no redirect URI for the Railway domain is needed.
3. Generate the token locally:
   1. Make sure `credentials.json` is in place (see `.env.example`).
   2. Run `npm run auth` and approve both scopes. If no refresh token is returned, revoke the app at the Google permissions page and run it again.
   3. Open `~/.google-workspace-mcp/token.json` and copy `refresh_token`. Open the credentials JSON and copy `installed.client_id` and `installed.client_secret`. Paste them straight into Railway's Variables UI. Do not paste them into chat, tickets, or commits.

---

## 5. Local verification before deploying

1. `npm install`
2. `npm run build`
3. `npm test` (stdio tests must still pass).
4. Run in HTTP mode with environment variables (PowerShell):

   ```powershell
   $env:MCP_AUTH_TOKEN = "<random-32+-chars>"
   $env:PORT = "3000"
   $env:GOOGLE_CLIENT_ID = "..."; $env:GOOGLE_CLIENT_SECRET = "..."; $env:GOOGLE_REFRESH_TOKEN = "..."
   npm run start:http
   ```

5. Check the endpoint:
   - `curl http://localhost:3000/health` returns `ok`.
   - `POST /mcp` with no token returns **401**, and with a wrong token returns **401**.
   - Inspector: `npx @modelcontextprotocol/inspector` → Streamable HTTP → `http://localhost:3000/mcp` with header `Authorization: Bearer <token>`. Confirm exactly two tools are listed.
6. Run the manual checks from the README (one test email to yourself, an append to a scratch Doc) against the HTTP server before moving on.

---

## 6. Railway setup

### 6.1 Prerequisites

- A Railway account with a payment method or credits. The Hobby plan is plenty. Expect a few dollars a month at most, since the service is idle most of the time.
- The project pushed to a GitHub repository (private recommended). Alternatively use the Railway CLI (`npm i -g @railway/cli`, `railway login`, `railway init`, `railway up`).

### 6.2 Add a config file

**Implemented:** the repo contains a `Dockerfile` (pinned `node:20-alpine`, multi-stage), a `.dockerignore`, and this `railway.json`, which tells Railway to build from the Dockerfile:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "healthcheckPath": "/health",
    "healthcheckTimeout": 60,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5,
    "numReplicas": 1
  }
}
```

The Dockerfile in the repo (the start command comes from its `CMD`):

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/http.js"]
```

The `.dockerignore` keeps `.env`, `credentials.json`, `token.json`, `secrets`, `docs`, `tests`, `scripts` and `.git` out of the image, so secrets never enter it. `npm run auth` runs locally only.

**Alternative (Railpack, no Dockerfile):** delete the `Dockerfile`, set `build.builder` to `RAILPACK` with `buildCommand` `npm ci && npm run build`, and add `deploy.startCommand` `node dist/http.js`. Railway's builder (Railpack) detects Node from `package.json` (`engines.node >= 20`). `typescript` and `tsx` are devDependencies, and they are available during the build step, which is when `tsc` runs. If you ever see "tsc: not found", move `typescript` and `@types/*` to `dependencies` or set `NPM_CONFIG_PRODUCTION=false` for the build.

### 6.3 Create the service

1. Railway dashboard → **New Project** → **Deploy from GitHub repo** → select the repo (or `railway init` + `railway up` from the CLI).
2. Open the service → **Variables** and add:

   | Variable | Value |
   | --- | --- |
   | `MCP_AUTH_TOKEN` | the random 64-hex-character string |
   | `GOOGLE_CLIENT_ID` | from `credentials.json` |
   | `GOOGLE_CLIENT_SECRET` | from `credentials.json` |
   | `GOOGLE_REFRESH_TOKEN` | from `token.json` |
   | `NODE_ENV` | `production` |

   Do **not** set `PORT`. Railway injects it. Use the **sealed** option for the secret values where available, so they can't be viewed again in the UI.
3. Service → **Settings** → **Networking** → **Generate Domain**. This gives `https://<name>.up.railway.app`. (Optional: add a custom domain.)
4. Confirm the **Deploy** logs show `google-workspace-mcp listening on :<port>` and the healthcheck passes.

### 6.4 Optional: persist the token on a Railway volume

The default plan needs no volume, because Google refresh tokens do not rotate. Use a volume only if you prefer file-based tokens, or want refreshed tokens saved across deploys:

1. Service → **Settings** → **Volumes** → add a volume mounted at `/data`.
2. Set `GOOGLE_OAUTH_TOKEN_PATH=/data/token.json` and `GOOGLE_OAUTH_CREDENTIALS_PATH=/data/credentials.json` (the existing path overrides in `auth.ts`).
3. Seed the files once, for example with `railway ssh` or a one-time startup step that writes them from variables if they are missing. The container user needs write access to `/data`.
4. A volume pins the service to one replica and causes a short downtime on each redeploy, so only add it if you need it.

### 6.5 Smoke test the live service

```bash
curl https://<name>.up.railway.app/health                       # 200 ok
curl -i -X POST https://<name>.up.railway.app/mcp               # 401, no token
```

Then run the Inspector against `https://<name>.up.railway.app/mcp` with the bearer header and call `tools/list`. Finish with one real `send_email` to yourself and one `append_to_google_doc` on a scratch Doc.

---

## 7. Connect the MCP clients to the hosted server

Replace `<name>` and `<MCP_AUTH_TOKEN>`. Do not commit files that contain the real token. Prefer your user-level config, or an environment-variable reference where the client supports one.

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "google-workspace": {
      "url": "https://<name>.up.railway.app/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add --transport http google-workspace https://<name>.up.railway.app/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**Claude Desktop:** custom connectors in the app expect OAuth, not a static bearer header. The reliable route is the `mcp-remote` bridge in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<name>.up.railway.app/mcp",
        "--header", "Authorization:${MCP_AUTH_HEADER}"
      ],
      "env": { "MCP_AUTH_HEADER": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

**Google Antigravity** (`~/.gemini/config/mcp_config.json`): use `serverUrl` for a remote server, and the README's `command` form no longer applies:

```json
{
  "mcpServers": {
    "google-workspace": {
      "serverUrl": "https://<name>.up.railway.app/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

Client config formats change often, so check each product's current MCP docs if one of these is rejected. After saving, refresh or restart the client and confirm that only `send_email` and `append_to_google_doc` are listed.

---

## 8. Operations

| Topic | Plan |
| --- | --- |
| **Logs** | Railway → service → Logs. Confirm no email bodies, tokens, or `Authorization` headers appear. |
| **Deploys** | Pushing to the connected branch redeploys. Enable "Wait for CI" if you add GitHub Actions running `npm test`. |
| **Rollback** | Service → Deployments → pick a previous successful deployment → Redeploy. |
| **Rotate `MCP_AUTH_TOKEN`** | Change it in Railway (triggers a redeploy), then update every client config. Do this immediately if it leaks. |
| **Rotate Google access** | Revoke at <https://myaccount.google.com/permissions>, re-run `npm run auth` locally, update `GOOGLE_REFRESH_TOKEN`. |
| **`AUTH_EXPIRED` errors** | Refresh token revoked or expired (7-day Testing-mode limit). Regenerate and update the variable. |
| **Cost** | Idle Node service is cheap. Set a usage limit in Railway → Settings → Usage. |
| **Write retries** | Keep the "never retry a send or append" behavior. Clients retrying after a timeout can still duplicate a write, so keep host-side approval on. |
| **Scaling** | Leave `numReplicas` at 1. Stateless mode would allow more, but there is no need for a single-user server. |

---

## 9. Risks and open decisions

1. **Public endpoint that can email as you.** The bearer token is the only barrier, so treat it like a password: long, random, rotated on suspicion, never committed. Consider adding rate limiting (3.3).
2. **Prompt injection.** A hosted server is still driven by LLM-produced arguments. Keep the host's approval prompt for each tool call enabled, and do not auto-approve these tools.
3. **Scope breadth.** The `documents` scope can edit every Doc the account can edit. Consider a dedicated Google account for the deployment, or moving to `drive.file` later.
4. **Google consent mode** (section 4): decide between publishing the app and weekly re-auth.
5. **Scope change from the original brief.** HTTP transport and hosting were explicitly out of scope. Update `README.md` and `docs/architecture.md` after this lands so they describe both stdio (local) and HTTP (Railway) modes.
6. **SDK surface.** The `createMcpHandler` / `@modelcontextprotocol/node` APIs are v2 and new. Pin versions and read the installed `.d.mts` types while implementing.

---

## 10. Checklist

**Code**
- [ ] `src/server.ts` extracted, and `src/index.ts` still runs stdio
- [ ] `@modelcontextprotocol/node` installed, and `src/http.ts` added with `/health` and a bearer-protected `/mcp`
- [ ] Server exits at startup if `MCP_AUTH_TOKEN` is missing or short
- [ ] `auth.ts` supports `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN`, with the file fallback kept
- [ ] `start:http` script and `railway.json` added
- [ ] `npm test` passes, with a new env-auth test

**Google**
- [ ] Decision made on publishing the OAuth app vs weekly re-auth
- [ ] Refresh token generated locally with `npm run auth`

**Repo**
- [ ] `git init`, with `git status` confirming no `.env`, `credentials.json`, or `token.json`
- [ ] Pushed to a private GitHub repo

**Railway**
- [ ] Project created from the repo, with 5 variables set (secrets sealed)
- [ ] Public domain generated, healthcheck green
- [ ] `/mcp` returns 401 without the token
- [ ] Inspector lists exactly two tools
- [ ] Real test email and Doc append succeed

**Clients**
- [ ] Cursor / Claude / Antigravity configured with the URL and bearer header
- [ ] README and architecture docs updated for the HTTP mode
