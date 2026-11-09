# google-workspace-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server that connects Cursor, Claude, or Google Antigravity to one Google account. It exposes two tools:

- `send_email` sends one plain-text Gmail message.
- `append_to_google_doc` appends plain text to the end of an existing Google Doc.

```text
        MCP (stdio)
              |
              v
   Local TypeScript MCP server
              |
              +--> send_email ----------> Gmail API ------> Email sent
              +--> append_to_google_doc -> Google Docs API -> Text appended
              +--> Google OAuth token/credential store (local only)
```

The local server speaks stdio. Logs go to stderr so they do not mix with the MCP protocol on stdout. An optional HTTP entrypoint for hosting is described under "Hosted mode". The same process is registered in each client. Business logic does not change per client.

## What you need

- Node.js 20 or newer
- A Google account
- A Google Cloud project where you can enable APIs and create an OAuth client

## Install

```bash
npm install
npm run build
```

Copy the path template and leave the secrets out of git:

```bash
copy .env.example .env
```

On macOS or Linux, use `cp .env.example .env`.

## Google Cloud setup

The OAuth client is an installed Desktop app. Do not use a Google account password, a hard-coded API key, or a service account. If your Google Workspace organization blocks OAuth or third-party agent access, stop and report that restriction. Do not try to work around it.

1. Create or choose a Google Cloud project.
2. Enable the Gmail API and the Google Docs API.
3. Configure Google Auth Platform branding, audience, and the two scopes below. If the app is External and in testing mode, add yourself as a test user.
4. Create an OAuth 2.0 client of type **Desktop app**. Where Google offers it, mark the app as an AI-powered agent.
5. Download the client JSON and store it outside version control, for example `%USERPROFILE%\.google-workspace-mcp\secrets\credentials.json` (macOS and Linux: `~/.google-workspace-mcp/secrets/credentials.json`).
6. Install dependencies with `npm install`.
7. Run `npm run auth` in an interactive terminal. Sign in and grant Gmail send and Docs edit access.
8. Build and start the server with `npm run build`, then `node dist/index.js` using the absolute path below.
9. Register that absolute path with an MCP host, refresh or restart the host, and confirm both tools are listed.

Scopes used by this version:

- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/documents`

`documents` can edit any Doc the signed-in user can edit. A later version can look at the narrower `drive.file` scope and an explicit document picker. This version does not.

Optional path overrides in `.env` use placeholder absolute paths only:

```text
GOOGLE_OAUTH_CREDENTIALS_PATH=/ABSOLUTE/PATH/TO/credentials.json
GOOGLE_OAUTH_TOKEN_PATH=/ABSOLUTE/USER-PRIVATE/PATH/google-workspace-mcp-token.json
```

Leave them unset to use the home-directory defaults. Do not commit `.env`, the client JSON, or the token.

## Sign in once

```bash
npm run auth
```

A browser opens on a localhost redirect. Sign in with the test user and approve both scopes. The command writes `token.json` next to that secrets folder, mode `0600`, and does not print the token. Later calls refresh the access token from the refresh token. Cursor, Antigravity, Claude Code, and Claude Desktop all use this same login. Credentials are configured in the server, not in each client.

If Google does not return a refresh token, remove the app at [Google Account permissions](https://myaccount.google.com/permissions) and run `npm run auth` again. If consent is denied or a scope is missing, the tool returns an error asking you to run `npm run auth` again.

## Register the server

Build first: `npm run build`.

Replace `/ABSOLUTE/PATH/google-workspace-mcp` with the directory that contains this `package.json`. Every host starts the same file:

```text
node /ABSOLUTE/PATH/google-workspace-mcp/dist/index.js
```

On this machine that path is `d:/nextleap/MCP-SERVER-6/dist/index.js`. The login files stay in the home directory, so the client config does not need `cwd` or secrets.

The host discovers tools with `tools/list`. It should see only `send_email` and `append_to_google_doc`. A natural-language request becomes a tool call only after the host shows the arguments and you approve them. The server sends or appends exactly those arguments. It does not invent a recipient or a document, and it does not act on instructions found inside an email or a Doc.

### Cursor

Configure `.cursor/mcp.json` in the project or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/google-workspace-mcp/dist/index.js"]
    }
  }
}
```

### Google Antigravity

Configure `.agents/mcp_config.json` in the workspace or `~/.gemini/config/mcp_config.json` globally:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/google-workspace-mcp/dist/index.js"]
    }
  }
}
```

In the Antigravity IDE, open MCP Servers, then Manage MCP Servers, then View raw config, and refresh the MCP servers. In the Antigravity CLI, check `/mcp`. Use `command` for this local stdio server. Do not set `serverUrl`.

### Claude Code

```bash
claude mcp add google-workspace -- node /ABSOLUTE/PATH/google-workspace-mcp/dist/index.js
```

Run `/mcp` in Claude Code to inspect the connection.

### Claude Desktop

Add the same entry under `mcpServers` in `claude_desktop_config.json` (`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/google-workspace-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop after saving. Claude Code and Claude Desktop use different configuration files. Both run this same local server.

## Try it

You can also list the tools without a chat client:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

After the client lists the tools, confirm the details in the approval prompt, then approve.

Send mail:

> Use send_email to email alex@example.com with subject 'Project update' and body 'The first milestone is complete'.

```json
{
  "to": "alex@example.com",
  "subject": "Project update",
  "body": "Hi Alex, the first milestone is complete."
}
```

Success looks like:

```json
{
  "success": true,
  "message": "Email sent successfully",
  "messageId": "GMAIL_MESSAGE_ID",
  "threadId": "GMAIL_THREAD_ID"
}
```

Append a note. `###` is stored as plain text. It is not turned into a heading.

> Use append_to_google_doc to append '### Weekly update\nCompleted the first milestone.' to this Google Doc: https://docs.google.com/document/d/DOCUMENT_ID/edit

```json
{
  "documentId": "https://docs.google.com/document/d/DOCUMENT_ID/edit",
  "content": "### Weekly update\nCompleted the first milestone."
}
```

Success looks like:

```json
{
  "success": true,
  "message": "Content appended successfully",
  "documentId": "DOCUMENT_ID",
  "documentUrl": "https://docs.google.com/document/d/DOCUMENT_ID/edit"
}
```

Calling the Docs tool again appends a second copy. It does not edit the previous note.

For a Doc with more than one tab, the text goes on the first tab and the response includes a `note` saying so. Choosing another tab is left for a later version.

A failure is JSON with `"success": false`. Codes include `INVALID_RECIPIENT`, `AUTH_MISSING`, `AUTH_EXPIRED`, `AUTH_SCOPES_MISSING`, `GMAIL_PERMISSION_DENIED`, `DOCUMENT_NOT_FOUND`, `DOCS_PERMISSION_DENIED`, `RATE_LIMITED`, and `GOOGLE_SERVER_ERROR`. A 429 or a 5xx is not retried, because the first attempt may already have sent the email or appended the text.

Manual checks, after `npm run auth`:

1. In MCP Inspector, confirm both tools are listed.
2. Send one test email to an address you own and confirm it arrives once.
3. In a Doc that already says `Original content`, append a new line and confirm the original text is still there.
4. Append the same text again and confirm a second copy appears.
5. Try a Doc you cannot edit and confirm a permission error.
6. Connect Cursor, Antigravity, or Claude and invoke both tools only after you approve the arguments.

## Hosted mode (Railway, Streamable HTTP)

Besides the local stdio server, the same tools can run as an HTTP service. See [`docs/deployment-plan.md`](docs/deployment-plan.md) for the full Railway walkthrough.

- `npm run start:http` (or `npm run dev:http`) runs `dist/http.js`: `POST /mcp` for MCP and `GET /health`.
- `MCP_AUTH_TOKEN` (32+ random characters) is required. The server refuses to start without it, and every `/mcp` request needs `Authorization: Bearer <token>`. There is also a per-client rate limit.
- The Google login comes from `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` (all three), or from `GOOGLE_OAUTH_CREDENTIALS_JSON` and `GOOGLE_OAUTH_TOKEN_JSON` (the two login files, base64 encoded; see `.env.example` for the encode commands). Set none to use the local files. Run `npm run auth` on your own machine once, then copy the values into Railway's Variables tab. Never commit them.
- `Dockerfile` and `railway.json` are included for Railway, and `render.yaml` for Render (free plan, health check `/health`). Both platforms supply `PORT`.

Local test:

```powershell
$env:MCP_AUTH_TOKEN = "<random-32+-characters>"
$env:GOOGLE_CLIENT_ID = "..."; $env:GOOGLE_CLIENT_SECRET = "..."; $env:GOOGLE_REFRESH_TOKEN = "..."
npm run build
npm run start:http
```

Client entry for a remote server (Cursor): `{ "mcpServers": { "google-workspace": { "url": "https://<name>.up.railway.app/mcp", "headers": { "Authorization": "Bearer <token>" } } } }`.

## Tests

```bash
npm test
```

Automated tests mock the Gmail and Docs clients. They check one encoded send, one end-of-document insert, rejected addresses and headers, empty fields, URL extraction, missing login, permission and rate-limit failures, and that ordinary logs stay off stdout. They do not send mail or edit a Doc.

## Layout

```text
src/server.ts       MCP server and tool registration (shared)
src/index.ts        stdio entrypoint (local hosts)
src/http.ts         Streamable HTTP entrypoint (Railway): bearer auth, /health, rate limit
src/auth.ts         OAuth login, token load/save and refresh
src/gmail.ts        send_email implementation
src/docs.ts         append_to_google_doc implementation
src/validation.ts   Input validation and document ID extraction
scripts/authorize.ts
tests/gmail.test.ts
tests/docs.test.ts
```

The implementation uses MCP SDK v2: `McpServer`, `registerTool`, and `serveStdio` from `@modelcontextprotocol/server`.

## Security

- The OAuth client JSON and `token.json` live under `~/.google-workspace-mcp/`, outside the repo. The token file is written with mode `0600`. `secrets/` and `token.json` are also gitignored if they are ever created inside the project.
- Gmail `messages.send` and Docs `batchUpdate` are not retried. A lost response is reported as a failure instead of sending or appending a second time.
- Tool responses never include an access token or client secret.
- Email bodies and token values are not written to the log. stdout carries MCP JSON-RPC only.
- `send_email` always calls `gmail.users.messages.send` with `userId: "me"`.
- Approval of the recipient, subject, body, document, and appended text is the MCP client's job, before it calls the tool. The server then checks those arguments with Zod.
