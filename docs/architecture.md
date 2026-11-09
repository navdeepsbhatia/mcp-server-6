# Architecture: google-workspace-mcp

## 1. Goals

- One local Node.js/TypeScript process that any MCP host (Cursor, Antigravity, Claude Code, Claude Desktop) can launch with `node /ABSOLUTE/PATH/google-workspace-mcp/dist/index.js`.
- Exactly two tools, each a thin, well-validated wrapper around one Google API write call.
- OAuth 2.0 (Desktop client) for a single OS user, with credentials stored once on the machine and shared by all local hosts.
- Predictable behavior: no false success, no silent retries of writes, no secrets in logs, nothing but MCP JSON-RPC on stdout.

## Non-Goals (MVP)

- Reading Gmail, searching Drive, creating Docs, HTML/attachments/CC/BCC, rich formatting.
- HTTP transport, multi-user, hosting, databases, or UI.
- Service accounts / domain-wide delegation.

## 2. System Context

```text
Developer
    |
    v
MCP Host (Cursor / Antigravity / Claude)
    AI Agent
    Tool-call approval UI
    |
    | MCP JSON-RPC over stdin/stdout
    v
google-workspace-mcp  (Node.js process, stdio)
    |
    +--> secrets/credentials.json     OAuth client
    +--> token.json                   refresh token, mode 0600
    |
    |  npm run auth is one-time and interactive
    |
    +--> browser consent + loopback / token refresh --> Google OAuth 2.0
    +--> gmail.users.messages.send                 --> Gmail API
    +--> documents.get / batchUpdate               --> Google Docs API
```

The OAuth client and token stay on the local machine, outside the git repo, under `~/.google-workspace-mcp/` (`secrets/credentials.json` and `token.json`). Every host starts the same server and reads that same login.

## Trust boundaries

| Boundary | Trusted side | Untrusted side | Control |
| --- | --- | --- | --- |
| Host → Server | Server code | Tool arguments (produced by an LLM, possibly influenced by prompt injection) | Host-side approval + server-side Zod validation |
| Server → Google | Server | Network | TLS via googleapis, minimal scopes |
| Server ↔ Disk | Server | Other users/processes on machine | Files outside repo, 0600 token file, .gitignore |
