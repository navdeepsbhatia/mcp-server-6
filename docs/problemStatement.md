# Problem Statement: Build a Minimal Google Workspace MCP Server

| | |
| --- | --- |
| **Project name** | `google-workspace-mcp` |
| **Target clients** | Cursor, Google Antigravity (IDE/CLI), and Claude (Code/Desktop) |
| **Project type** | Beginner-friendly, local MCP server |
| **Status** | Implementation brief / requirements, not a completed implementation |

## 1. Problem

AI coding assistants can generate the content of an email or a document update, but cannot reliably take those actions in a user's Google account without an authorized integration. Copying text into Gmail or Google Docs manually interrupts the workflow.

Build a small, reusable Model Context Protocol (MCP) server that connects a local AI assistant to a user's Google account and exposes exactly two tools:

1. `send_email` — send a plain-text email through Gmail.
2. `append_to_google_doc` — append plain text to an existing Google Doc without overwriting its current content.

The same server should work in Cursor, Antigravity, and Claude through a standard local stdio MCP connection. It should be straightforward to build, test, understand, and extend.

## 2. Goal and Expected Outcome

A user should be able to type natural-language requests such as:

> Use `send_email` to email alex@example.com with subject 'Project update' and body 'The first milestone is complete'.

> Use `append_to_google_doc` to append '### Weekly update\nCompleted the first milestone.' to this Google Doc: https://docs.google.com/document/d/DOCUMENT_ID/edit

After an explicit user approval for the action, the MCP server should perform the requested operation using the authenticated user's Google account, then return a concise success or failure response.

**Definition of success:** Both tools can be discovered and invoked from at least one MCP client, and the documented setup allows the same server to be registered in Cursor, Antigravity, and Claude without changing the server's business logic.

## 3. Scope

### In scope (MVP)

- Node.js + TypeScript MCP server with stdio transport.
- Exactly two public MCP tools: `send_email` and `append_to_google_doc`.
- Google OAuth 2.0 login for a single local user.
- Gmail API integration to send plain-text emails.
- Google Docs API integration to append plain text to an existing editable document.
- Input validation, readable error messages, and safe local credential handling.
- Clear setup instructions, example MCP client configurations, and basic tests.
- Return Google-generated identifiers / links when successful.

### Out of scope (for the first version)

- Reading or searching Gmail, listing files, or searching Google Drive.
- Creating new Google Docs.
- Attachments, HTML email, CC/BCC, scheduling, mass emailing, or bulk operations.
- Rich-text formatting, inserting tables/images, or editing arbitrary document positions.
- Multi-user accounts, cloud hosting, HTTP transport, database storage, or a web dashboard.
- A third-party MCP service or an unofficial browser-automation approach.

## 4. Users and Use Cases

**Primary user:** A developer using Cursor, Antigravity, or Claude on a personal development machine.

| Use case | User input | Expected outcome |
| --- | --- | --- |
| Send a message | Recipient email, subject, body | One email is sent from the connected Gmail account. |
| Add a meeting note | Existing Google Doc URL/ID, text | New text appears at the end of the specified document while existing content remains intact. |
| Handle an error | Bad email, missing document permissions, expired authorization | No false success message; actionable error returned. |

## 5. Functional Requirements

### FR-1: Gmail sending tool

**MCP tool name:** `send_email`

**Description:** Send one plain-text email from the Google account that the user has explicitly authorized.

**Input schema:**

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `to` | string | Yes | One valid email address; no newlines or header injection. |
| `subject` | string | Yes | Nonempty, reasonable length; no CR/LF header injection. |
| `body` | string | Yes | Nonempty plain text; preserve user-entered line breaks. |

**Behavior:**

1. Validate input.
2. Use the authenticated account, not an arbitrary sender account supplied by the model.
3. Construct a standards-compliant UTF-8 MIME email (prefer a vetted MIME builder rather than manually concatenating untrusted headers).
4. Base64url-encode the MIME message into the Gmail API `raw` field.
5. Call `gmail.users.messages.send({ userId: "me", requestBody: { raw } })`.
6. Return a structured, user-readable outcome.

**Example success response:**

```json
{
  "success": true,
  "message": "Email sent successfully",
  "messageId": "GMAIL_MESSAGE_ID",
  "threadId": "GMAIL_THREAD_ID"
}
```

**Example failure response:**

```json
{
  "success": false,
  "error": "GMAIL_PERMISSION_DENIED",
  "message": "The authenticated Google account is not allowed to send this message. Reconnect or check account permissions."
}
```

**Important:** The operation sends a real email. The client/agent should show the intended recipient, subject, and body and ask the user for explicit confirmation before calling the tool. The MCP server itself must not silently invent recipients or send messages outside a direct user-authorized request.

### FR-2: Google Docs append tool

**MCP tool name:** `append_to_google_doc`

**Description:** Append plain text at the end of an existing editable Google Doc without changing the content already there.

**Input schema:**

- `document` (required): an existing Google Doc ID, or a Docs URL such as `https://docs.google.com/document/d/DOCUMENT_ID/edit`
- `content` (required): plain text to append. Newlines are preserved. The text is not converted into headings, lists, tables, or images.

**Behavior:**

4. For documents with multiple tabs, the MVP targets the first tab. State this in the response/README; optionally add a `tabId` parameter in a later version.
5. Append rather than replace. Keep existing content unchanged.
6. Return the document ID, URL, and success status.

**Illustrative Google Docs request:**

```json
{
  "requests": [
    {
      "insertText": {
        "endOfSegmentLocation": {},
        "text": "\nWeekly update\nCompleted the first milestone."
      }
    }
  ]
}
```

This request is illustrative; handle leading/trailing newline logic and Google Docs tab semantics in the implementation. The Google Docs API `endOfSegmentLocation` inserts immediately before the segment's final newline, so test empty and nonempty documents.

**Example success response:**

```json
{
  "success": true,
  "message": "Content appended successfully",
  "documentId": "DOCUMENT_ID",
  "documentUrl": "https://docs.google.com/document/d/DOCUMENT_ID/edit"
}
```

**Important:** The client/agent should show the target document and exact text to be added, then request user confirmation before modifying the document. A repeat call is another append, not an update or deduplicated write.

### FR-3: Authentication and authorization

- Use Google OAuth 2.0 with an installed/desktop application client, not a Google account password or hard-coded API key.
- Support an explicit one-time local browser login through a separate command such as `npm run auth` before starting the MCP server.
- Request the minimal functional scopes for this MVP:
  - `https://www.googleapis.com/auth/gmail.send`
  - `https://www.googleapis.com/auth/documents`
- The Docs scope is relatively broad. For a more constrained future version, investigate per-file access with `drive.file`.

Store client credentials outside source code, persist the session in a local token file, and never hardcode secrets or access tokens. This version supports a single local user. Do not assume credentials already exist.

## 6. Project Structure

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

**Suggested project structure:**

```text
google-workspace-mcp/
├── src/
│   ├── index.ts          # MCP stdio server and tool registration
│   ├── auth.ts           # OAuth login, token load/save and refresh
│   ├── gmail.ts          # send_email implementation
│   ├── docs.ts           # append_to_google_doc implementation
│   └── validation.ts     # Input validation and document ID extraction
├── scripts/
│   └── authorize.ts      # One-time interactive OAuth setup
├── tests/
│   ├── gmail.test.ts
│   └── docs.test.ts
├── .env.example          # Non-secret path/config placeholders only
├── .gitignore            # Exclude .env, credentials and token files
├── package.json
├── tsconfig.json
├── README.md
└── problemStatement.md
```

The implementation must follow the installed MCP SDK v2 APIs rather than copying old v1 `@modelcontextprotocol/sdk` imports. In v2, use `McpServer`, tool registration, and `serveStdio` from the documented packages.

## 7. Google Cloud Setup Requirements

The README produced by the coding assistant must explain these steps:

1. Create or choose a Google Cloud project.
2. Enable Gmail API and Google Docs API.
3. Configure the OAuth consent screen using an External app in testing mode, and add the developer as a test user.

## 8. MCP Server Requirements

- Implement the server in Node.js and TypeScript with the installed MCP SDK v2 APIs (`McpServer`, tool registration, and `serveStdio`).
- Expose exactly two public tools over the MCP protocol.
- Use stdio transport so a client can start the server as a local process. Do not add HTTP transport.
- Log in a way that does not write logs to stdout (stdout is the MCP transport).
- Validate every input before calling Google.
- Handle authentication failures and API errors with a readable, actionable error. Never return a success message for a failed call.

## 9. MCP Client Configuration

Document how to register this server, without changing its business logic, in:

- Cursor
- Claude Desktop and Claude Code
- Google Antigravity (IDE and CLI), where MCP configuration is supported

Explain how the client discovers the two tools and how a natural-language request becomes a tool call after the user approves it.

## 10. Testing Requirements

**Gmail**

- Send one plain-text email to a valid recipient from the connected account.
- Reject an invalid email address with an actionable error and no false success.
- Report expired or missing authorization clearly.

**Google Docs**

- Append text to the end of an existing document.
- Append multiple lines, including a string such as `### Weekly update`, as plain text.
- Confirm existing document content remains intact.
- Test both an empty document and a nonempty document, because `endOfSegmentLocation` inserts immediately before the segment's final newline.
- For a document with multiple tabs, append to the first tab and say so in the response.
- Accept both a raw document ID and a Docs edit URL.
- Report invalid document IDs and missing permissions clearly, with no false success.

## 11. Deliverables

- Working Node.js + TypeScript source that calls the real Gmail and Google Docs APIs.
- `package.json`
- `.env.example`
- `.gitignore` that excludes credentials and tokens
- README with install, Google Cloud OAuth setup, and run instructions
- MCP configuration examples for Cursor, Claude, and Antigravity
- Sample invocations for both tools
- Basic test cases for the scenarios above

## 12. Implementation Guidelines

- Keep the code simple, modular, and beginner-friendly.
- Avoid extra frameworks and unnecessary abstraction.
- Comment the important functions.
- Do not mock Gmail or Google Docs.
- Do not assume credentials already exist.

## 13. Security Requirements

- Never return OAuth tokens or client secrets to the MCP client.
- Do not log email bodies or OAuth credentials.
- Validate recipient addresses and document IDs or URLs before calling Google.
- Perform a send or an append only when the corresponding tool is invoked. The client is responsible for explicit user approval before that invocation.

## 14. Definition of Done

The brief is met when:

- The server starts locally over stdio.
- At least one MCP client discovers and invokes both tools.
- `send_email` sends a real plain-text Gmail message from the authenticated account.
- `append_to_google_doc` appends real text to an existing Google Doc and does not overwrite what was already there.
- The same server can be registered in Cursor, Antigravity, and Claude from the documented configuration, with no change to business logic.
- OAuth works, failures come back as concise errors, and setup is documented clearly.
