import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

interface JsonRpc {
  id?: number;
  result?: { tools?: Array<{ name: string }> };
  error?: { message?: string };
}

test("stdio server lists exactly send_email and append_to_google_doc", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const messages: JsonRpc[] = [];
  let stdout = "";
  let plainStdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line.startsWith("{")) messages.push(JSON.parse(line) as JsonRpc);
      else if (line.length > 0) plainStdout += `${line}\n`;
      newline = stdout.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const send = (message: unknown) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const waitFor = async (id: number) => {
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const found = messages.find((message) => message.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for response ${id}. stderr: ${stderr}`);
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "google-workspace-mcp-test", version: "1.0.0" },
      },
    });
    const initialized = await waitFor(1);
    assert.equal(initialized.error, undefined);
    assert.match(stderr, /running on stdio/);

    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await waitFor(2);
    const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
    assert.deepEqual(names, ["append_to_google_doc", "send_email"]);
    assert.match(stderr, /running on stdio/);
    assert.equal(plainStdout, "");
  } finally {
    child.kill();
  }
});
