import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readOwner(lockPath) {
  try {
    return JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8"));
  } catch {
    return null;
  }
}

async function removeIfStale(lockPath, staleAfterMs) {
  const owner = await readOwner(lockPath);
  if (owner == null) {
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs < 2_000) return false;
    } catch {
      return true;
    }
  }
  const createdAt = Date.parse(owner?.createdAt ?? "");
  const expired = Number.isFinite(createdAt) && Date.now() - createdAt > staleAfterMs;
  if (owner == null || !processExists(owner.pid) || expired) {
    await rm(lockPath, { force: true, recursive: true });
    return true;
  }
  return false;
}

export async function acquireFileLock(
  lockPath,
  {
    label = "Gemini Web Bridge operation",
    pollMs = 250,
    signal,
    staleAfterMs = 15 * 60_000,
    timeoutMs = 10 * 60_000,
  } = {},
) {
  await mkdir(dirname(lockPath), { mode: 0o700, recursive: true });
  const startedAt = Date.now();
  const token = crypto.randomUUID();

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw Object.assign(new Error(`${label} cancelled.`), { code: "CANCELLED" });
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        `${lockPath}/owner.json`,
        `${JSON.stringify({ createdAt: new Date().toISOString(), label, pid: process.pid, token })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const owner = await readOwner(lockPath);
        if (owner?.token === token) await rm(lockPath, { force: true, recursive: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await removeIfStale(lockPath, staleAfterMs)) continue;
      await delay(pollMs);
    }
  }

  throw Object.assign(new Error(`Timed out waiting for ${label}.`), { code: "LOCK_TIMEOUT" });
}

export async function withFileLock(lockPath, options, operation) {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}
