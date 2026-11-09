/**
 * Streamable HTTP MCP entrypoint for the hosted (Railway) deployment.
 *
 *   GET  /health   200 "ok", no auth, used by the Railway healthcheck
 *   POST /mcp      requires  Authorization: Bearer <MCP_AUTH_TOKEN>
 *
 * The endpoint can send email and edit Docs as the configured Google account,
 * so it refuses to start unless MCP_AUTH_TOKEN is set to a long random secret.
 * Stateless: every request gets a fresh McpServer, so no session store is needed.
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createServer } from "./server.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });

export const MIN_TOKEN_LENGTH = 32;
const RATE_LIMIT_PER_MINUTE = 60;
const MAX_BODY_BYTES = 1_000_000;

/** Constant-time check of an `Authorization: Bearer ...` header against the secret. */
export function isAuthorized(header: string | undefined, secret: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match || !match[1]) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Simple fixed-window limiter per client address. Limits the damage from a leaked token. */
export function createRateLimiter(limit: number, windowMs = 60_000, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const time = now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= time) {
      hits.set(key, { count: 1, resetAt: time + windowMs });
      if (hits.size > 1000) {
        for (const [k, v] of hits) if (v.resetAt <= time) hits.delete(k);
      }
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

/** Railway sits behind a proxy: use the first X-Forwarded-For address when present. */
function clientKey(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

export function createHttpServer(secret: string): http.Server {
  const mcp = toNodeHandler(createMcpHandler(createServer, { maxRequestBodySize: MAX_BODY_BYTES }));
  const allow = createRateLimiter(RATE_LIMIT_PER_MINUTE);

  return http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];

    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }

    if (pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }

    // Authenticate before any MCP handling. Never log headers or bodies.
    if (!isAuthorized(req.headers.authorization, secret)) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer", "Content-Type": "text/plain" }).end("Unauthorized");
      return;
    }

    if (!allow(clientKey(req))) {
      res.writeHead(429, { "Retry-After": "60", "Content-Type": "text/plain" }).end("Too many requests");
      return;
    }

    mcp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end();
    });
  });
}

function main(): void {
  const secret = process.env.MCP_AUTH_TOKEN?.trim() ?? "";
  if (secret.length < MIN_TOKEN_LENGTH) {
    console.error(
      `MCP_AUTH_TOKEN must be set to a random secret of at least ${MIN_TOKEN_LENGTH} characters. Refusing to start an open endpoint.`,
    );
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? 3000);
  const server = createHttpServer(secret);
  server.listen(port, "0.0.0.0", () => {
    console.log(`google-workspace-mcp listening on :${port} (POST /mcp, GET /health)`);
  });

  // Railway sends SIGTERM on redeploy: stop accepting connections, then exit.
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only start when run directly, so tests can import the helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
