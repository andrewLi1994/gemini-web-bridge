import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);

test("committed bundle exposes the v0.2 MCP contract", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "gemini-bridge-bundle-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, "..", "dist", "mcp-server.mjs")],
    env: { ...process.env, CODEX_THREAD_ID: "bundle-thread", GEMINI_WEB_BRIDGE_HOME: stateRoot },
    stderr: "pipe",
  });
  const client = new Client({ name: "bundle-smoke-test", version: "0.2.0" });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.deepEqual(
      result.tools.map(({ name }) => name).sort(),
      [
        "analyze_youtube",
        "gemini_web_ask",
        "gemini_web_authorize",
        "gemini_web_list_conversations",
        "gemini_web_login",
        "gemini_web_status",
      ],
    );
    const listed = await client.callTool({
      name: "gemini_web_list_conversations",
      arguments: { scope: "current" },
    });
    assert.equal(listed.isError, false);
    assert.deepEqual(listed.structuredContent, { conversations: [], status: "completed" });
    const unauthorized = await client.callTool({
      name: "gemini_web_ask",
      arguments: { prompt: "A minimal verification question" },
    });
    assert.equal(unauthorized.isError, true);
  } finally {
    await client.close();
  }
});

test("diagnostic CLI emits JSON for status, authorization, and conversation listing", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "gemini-bridge-cli-"));
  const cli = join(import.meta.dirname, "..", "dist", "gemini-web-cli.mjs");
  const env = { ...process.env, CODEX_THREAD_ID: "cli-thread", GEMINI_WEB_BRIDGE_HOME: stateRoot };
  const status = JSON.parse((await execFileAsync(process.execPath, [cli, "status"], { env })).stdout);
  assert.equal(status.status, "completed");
  assert.equal(status.authorization.authorized, false);
  const authorized = JSON.parse(
    (await execFileAsync(process.execPath, [cli, "authorize", "--confirmed"], { env })).stdout,
  );
  assert.equal(authorized.authorized, true);
  const conversations = JSON.parse(
    (await execFileAsync(process.execPath, [cli, "conversations"], { env })).stdout,
  );
  assert.deepEqual(conversations, { conversations: [], status: "completed" });
});

test("diagnostic CLI uses a stable JSON error and exit code for invalid input", async () => {
  const cli = join(import.meta.dirname, "..", "dist", "gemini-web-cli.mjs");
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "unknown-command"]),
    (error) => {
      assert.equal(error.code, 5);
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, "error");
      assert.equal(result.error.code, "INVALID_INPUT");
      return true;
    },
  );
});
