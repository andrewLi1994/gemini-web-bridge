import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { withFileLock } from "./operation-lock.mjs";

const ROOT = process.env.GEMINI_WEB_BRIDGE_HOME ?? join(
  homedir(),
  "Library",
  "Application Support",
  "Codex UI Extensions",
  "Gemini Web Bridge",
);
const CONVERSATION_SCHEMA_VERSION = 2;
const GEMINI_CONVERSATION_PATTERN = /^https:\/\/gemini\.google\.com\/app\/[^/?#]+(?:[?#].*)?$/i;

export const paths = {
  browserLock: join(ROOT, "locks", "browser"),
  conversations: join(ROOT, "conversations.json"),
  legacySessions: join(ROOT, "sessions.json"),
  profile: join(ROOT, "Chrome Profile"),
  root: ROOT,
  settings: join(ROOT, "settings.json"),
  stateLock: join(ROOT, "locks", "state"),
};

async function ensureRoot() {
  await mkdir(ROOT, { recursive: true, mode: 0o700 });
  await mkdir(paths.profile, { recursive: true, mode: 0o700 });
  await chmod(ROOT, 0o700).catch(() => {});
}

async function readJson(path, fallback) {
  await ensureRoot();
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(source);
  } catch {
    const backup = `${path}.corrupt-${Date.now()}`;
    await rename(path, backup).catch(() => {});
    await chmod(backup, 0o600).catch(() => {});
    return fallback;
  }
}

async function writeJson(path, value) {
  await ensureRoot();
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => {});
}

function emptyConversationState() {
  return { conversations: {}, schemaVersion: CONVERSATION_SCHEMA_VERSION };
}

function validConversationUrl(value) {
  return typeof value === "string" && GEMINI_CONVERSATION_PATTERN.test(value);
}

function normalizeConversation(value) {
  if (value == null || !validConversationUrl(value.conversationUrl)) return null;
  return {
    conversationUrl: value.conversationUrl,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : new Date().toISOString(),
    legacyVideoId: typeof value.legacyVideoId === "string" ? value.legacyVideoId : null,
    ownerThreadId: typeof value.ownerThreadId === "string" ? value.ownerThreadId : null,
  };
}

async function readConversationStateUnlocked() {
  const stored = await readJson(paths.conversations, null);
  const state = emptyConversationState();
  if (stored?.schemaVersion === CONVERSATION_SCHEMA_VERSION && stored.conversations != null) {
    for (const [id, value] of Object.entries(stored.conversations)) {
      const normalized = normalizeConversation(value);
      if (normalized != null) state.conversations[id] = normalized;
    }
    if (stored.migration != null) state.migration = stored.migration;
  }
  return state;
}

async function ensureConversationStateUnlocked() {
  const state = await readConversationStateUnlocked();
  if (state.migration?.legacySessionsImportedAt != null) return state;

  const legacy = await readJson(paths.legacySessions, {});
  let imported = 0;
  for (const [videoId, value] of Object.entries(legacy ?? {})) {
    if (!validConversationUrl(value?.conversationUrl)) continue;
    const id = `conv_${crypto.randomUUID()}`;
    const timestamp = typeof value.lastUsedAt === "string" ? value.lastUsedAt : new Date().toISOString();
    state.conversations[id] = {
      conversationUrl: value.conversationUrl,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      legacyVideoId: videoId,
      ownerThreadId: null,
    };
    imported += 1;
  }
  state.migration = {
    importedLegacySessions: imported,
    legacySessionsImportedAt: new Date().toISOString(),
  };
  await writeJson(paths.conversations, state);
  return state;
}

async function mutateConversations(mutator, signal) {
  return withFileLock(
    paths.stateLock,
    { label: "Gemini Web Bridge state", signal, staleAfterMs: 60_000, timeoutMs: 30_000 },
    async () => {
      const state = await ensureConversationStateUnlocked();
      const result = await mutator(state);
      await writeJson(paths.conversations, state);
      return result;
    },
  );
}

export async function authorizationStatus() {
  const settings = await readJson(paths.settings, {});
  return {
    authorized: settings.authorized === true,
    authorizedAt: typeof settings.authorizedAt === "string" ? settings.authorizedAt : null,
  };
}

export async function authorize(signal) {
  return withFileLock(
    paths.stateLock,
    { label: "Gemini Web Bridge state", signal, staleAfterMs: 60_000, timeoutMs: 30_000 },
    async () => {
      const settings = await readJson(paths.settings, {});
      const value = { ...settings, authorized: true, authorizedAt: new Date().toISOString() };
      await writeJson(paths.settings, value);
      return { authorized: true, authorizedAt: value.authorizedAt };
    },
  );
}

export async function getConversation(conversationId) {
  const state = await withFileLock(
    paths.stateLock,
    { label: "Gemini Web Bridge state", staleAfterMs: 60_000, timeoutMs: 30_000 },
    ensureConversationStateUnlocked,
  );
  return normalizeConversation(state.conversations[conversationId]);
}

export async function listConversations({ ownerThreadId = null, scope = "current" } = {}) {
  const state = await withFileLock(
    paths.stateLock,
    { label: "Gemini Web Bridge state", staleAfterMs: 60_000, timeoutMs: 30_000 },
    ensureConversationStateUnlocked,
  );
  return Object.entries(state.conversations)
    .filter(([, value]) => scope === "all" || value.ownerThreadId === ownerThreadId)
    .map(([conversationId, value]) => ({
      conversationId,
      createdAt: value.createdAt,
      lastUsedAt: value.lastUsedAt,
      legacy: value.legacyVideoId != null,
      ownerThreadId: value.ownerThreadId,
    }))
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
}

export async function saveConversation(
  { conversationId = null, conversationUrl, legacyVideoId = null, ownerThreadId = null },
  signal,
) {
  if (!validConversationUrl(conversationUrl)) throw new Error("Invalid Gemini conversation URL.");
  return mutateConversations((state) => {
    const now = new Date().toISOString();
    const id = conversationId ?? `conv_${crypto.randomUUID()}`;
    const existing = normalizeConversation(state.conversations[id]);
    state.conversations[id] = {
      conversationUrl,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      legacyVideoId: legacyVideoId ?? existing?.legacyVideoId ?? null,
      ownerThreadId: ownerThreadId ?? existing?.ownerThreadId ?? null,
    };
    return id;
  }, signal);
}

export async function findLegacyConversation(videoId) {
  const state = await withFileLock(
    paths.stateLock,
    { label: "Gemini Web Bridge state", staleAfterMs: 60_000, timeoutMs: 30_000 },
    ensureConversationStateUnlocked,
  );
  const matched = Object.entries(state.conversations)
    .filter(([, value]) => value.legacyVideoId === videoId)
    .sort(([, left], [, right]) => right.lastUsedAt.localeCompare(left.lastUsedAt))[0];
  return matched == null ? null : { conversationId: matched[0], ...normalizeConversation(matched[1]) };
}

export { CONVERSATION_SCHEMA_VERSION };
