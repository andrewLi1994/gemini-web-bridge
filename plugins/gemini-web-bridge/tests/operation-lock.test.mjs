import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireFileLock } from "../scripts/operation-lock.mjs";

test("a second process-level operation waits for the active lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "gemini-bridge-lock-"));
  const lockPath = join(root, "browser");
  const releaseFirst = await acquireFileLock(lockPath, { timeoutMs: 1_000 });
  let secondAcquired = false;
  const second = acquireFileLock(lockPath, { pollMs: 10, timeoutMs: 1_000 }).then((release) => {
    secondAcquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(secondAcquired, false);
  await releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondAcquired, true);
  await releaseSecond();
});

test("a stale lock owned by a dead process is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gemini-bridge-stale-lock-"));
  const lockPath = join(root, "browser");
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({
      createdAt: "2000-01-01T00:00:00.000Z",
      pid: 999_999_999,
      token: "stale",
    }),
  );
  const release = await acquireFileLock(lockPath, { pollMs: 10, staleAfterMs: 1, timeoutMs: 1_000 });
  await release();
});

test("waiting for a lock can be cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "gemini-bridge-cancel-lock-"));
  const lockPath = join(root, "browser");
  const release = await acquireFileLock(lockPath, { timeoutMs: 1_000 });
  const controller = new AbortController();
  const waiting = acquireFileLock(lockPath, {
    pollMs: 10,
    signal: controller.signal,
    timeoutMs: 1_000,
  });
  controller.abort();
  await assert.rejects(waiting, (error) => error.code === "CANCELLED");
  await release();
});
