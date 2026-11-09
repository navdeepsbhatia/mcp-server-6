/**
 * MCP server definition shared by every entrypoint:
 *   src/index.ts  stdio, started by a local MCP host
 *   src/http.ts   Streamable HTTP, deployed on Railway
 *
 *   MCP client
 *       |
 *       v
 *   TypeScript MCP server
 *       |
 *       +--> send_email ----------> Gmail API
 *       +--> append_to_google_doc -> Google Docs API
 *       +--> Google OAuth login (local files, or environment variables when hosted)
 */
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { logSafeError } from "./auth.js";
import { appendToGoogleDoc } from "./docs.js";
import { sendPlainTextEmail } from "./gmail.js";
import { appendDocSchema, sendEmailSchema, toFailurePayload } from "./validation.js";

const sendEmailResult = z.object({
  success: z.boolean(),
  message: z.string(),
  error: z.string().optional(),
  messageId: z.string().optional(),
  threadId: z.string().optional(),
});

const appendResult = z.object({
  success: z.boolean(),
  message: z.string(),
  error: z.string().optional(),
  documentId: z.string().optional(),
  documentUrl: z.string().optional(),
  note: z.string().optional(),
});

function toolResult(payload: object, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true as const } : {}),
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "google-workspace-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "send_email",
    {
      description:
        "Send one plain-text email from the authorized Google account. This sends a real email. Call it only after the user has explicitly confirmed the recipient, subject, and body. Do not invent a recipient or send any address the user did not provide. CC, BCC, HTML, and attachments are not supported.",
      inputSchema: sendEmailSchema,
      outputSchema: sendEmailResult,
    },
    async ({ to, subject, body }) => {
      try {
        const result = await sendPlainTextEmail({ to, subject, body });
        return toolResult(result);
      } catch (err) {
        logSafeError(err);
        return toolResult(toFailurePayload(err), true);
      }
    },
  );

  server.registerTool(
    "append_to_google_doc",
    {
      description:
        "Append plain text to the end of an existing Google Doc. Existing content is not replaced or reformatted. Call it only after the user has confirmed the document and the exact text. A repeat call appends again; it does not update or skip a duplicate. Documents with multiple tabs are updated on the first tab only. Pass documentId as a document ID or a URL like https://docs.google.com/document/d/DOCUMENT_ID/edit.",
      inputSchema: appendDocSchema,
      outputSchema: appendResult,
    },
    async ({ documentId, content }) => {
      try {
        const result = await appendToGoogleDoc({ documentId, content });
        return toolResult(result);
      } catch (err) {
        logSafeError(err);
        return toolResult(toFailurePayload(err), true);
      }
    },
  );

  return server;
}
