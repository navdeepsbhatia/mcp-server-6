/**
 * stdio MCP entrypoint for local hosts (Cursor, Antigravity, Claude).
 * stdout is reserved for the protocol, so logs go to stderr.
 * For the hosted Railway deployment see src/http.ts.
 */
import path from "node:path";
import dotenv from "dotenv";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });

export { createServer };

const handle = serveStdio(createServer);
console.error("google-workspace-mcp running on stdio");

process.on("SIGINT", () => {
  void handle.close();
});
