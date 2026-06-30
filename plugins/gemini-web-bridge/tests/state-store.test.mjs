import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = await mkdtemp(join(tmpdir(), "gemini-bridge-state-"));
process.env.GEMINI_WEB_BRIDGE_HOME = root;

const {
  CONVERSATION_SCHEMA_VERSION,
  getConversation,
  listConversations,
  paths,
  saveConversation,
} = await import("../scripts/state-store.mjs");

test("legacy video mappings migrate once into random conversation handles", async () => {
  await writeFile(
    paths.legacySessions,
    JSON.stringify({
      videoA: {
        conversationUrl: "https://gemini.google.com/app/legacy-a",
        lastUsedAt: "2026-01-02T03:04:05.000Z",
      },
    }),
  );
  const first = await listConversations({ scope: "all" });
  const second = await listConversations({ scope: "all" });
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.match(first[0].conversationId, /^conv_/);
  assert.equal(first[0].legacy, true);
  const stored = JSON.parse(await readFile(paths.conversations, "utf8"));
  assert.equal(stored.schemaVersion, CONVERSATION_SCHEMA_VERSION);
  assert.equal(stored.migration.importedLegacySessions, 1);
  assert.equal((await readFile(paths.legacySessions, "utf8")).includes("legacy-a"), true);
});

test("thread IDs filter metadata but never become conversation keys", async () => {
  const firstId = await saveConversation({
    conversationUrl: "https://gemini.google.com/app/thread-a-one",
    ownerThreadId: "thread-a",
  });
  const secondId = await saveConversation({
    conversationUrl: "https://gemini.google.com/app/thread-a-two",
    ownerThreadId: "thread-a",
  });
  await saveConversation({
    conversationUrl: "https://gemini.google.com/app/thread-b",
    ownerThreadId: "thread-b",
  });
  assert.notEqual(firstId, secondId);
  assert.equal((await listConversations({ ownerThreadId: "thread-a" })).length, 2);
  assert.equal((await getConversation(firstId)).ownerThreadId, "thread-a");
  assert.equal((await readdir(root)).some((name) => name.includes(".tmp-")), false);
});

test("corrupt state is preserved as a backup and recovered", async () => {
  await writeFile(paths.conversations, "{not-json", "utf8");
  const recovered = await listConversations({ scope: "all" });
  assert.equal(recovered.length, 1);
  const files = await readdir(root);
  assert.equal(files.some((name) => name.startsWith("conversations.json.corrupt-")), true);
});
