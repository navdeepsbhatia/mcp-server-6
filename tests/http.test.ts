import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createHttpServer, createRateLimiter, isAuthorized } from "../src/http.js";

const SECRET = "test-secret-".padEnd(40, "x");

test("isAuthorized accepts only the exact bearer token", () => {
  assert.equal(isAuthorized(`Bearer ${SECRET}`, SECRET), true);
  assert.equal(isAuthorized(`bearer ${SECRET}`, SECRET), true);
  assert.equal(isAuthorized(undefined, SECRET), false);
  assert.equal(isAuthorized("", SECRET), false);
  assert.equal(isAuthorized(SECRET, SECRET), false);
  assert.equal(isAuthorized("Bearer wrong", SECRET), false);
  assert.equal(isAuthorized(`Bearer ${SECRET}extra`, SECRET), false);
  assert.equal(isAuthorized(`Basic ${SECRET}`, SECRET), false);
});

test("rate limiter allows the limit, blocks the next call, and resets after the window", () => {
  let time = 0;
  const allow = createRateLimiter(2, 1000, () => time);
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), false);
  assert.equal(allow("b"), true);
  time = 1001;
  assert.equal(allow("a"), true);
});

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createHttpServer(SECRET);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const jsonHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

test("health is open, other paths are 404, and /mcp rejects a missing or wrong token", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");

    assert.equal((await fetch(`${base}/nope`)).status, 404);

    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const none = await fetch(`${base}/mcp`, { method: "POST", headers: jsonHeaders, body });
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("www-authenticate"), "Bearer");

    const wrong = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...jsonHeaders, Authorization: "Bearer wrong" },
      body,
    });
    assert.equal(wrong.status, 401);
  });
});

test("an authorized client lists exactly send_email and append_to_google_doc over HTTP", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...jsonHeaders, Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(response.status, 200);

    const text = await response.text();
    // The response is either plain JSON or one SSE "data:" event.
    const payload = text.trimStart().startsWith("{")
      ? text
      : (text.split("\n").find((line) => line.startsWith("data:")) ?? "").slice(5);
    const parsed = JSON.parse(payload) as { result?: { tools?: Array<{ name: string }> } };
    const names = (parsed.result?.tools ?? []).map((tool) => tool.name).sort();
    assert.deepEqual(names, ["append_to_google_doc", "send_email"]);
  });
});
