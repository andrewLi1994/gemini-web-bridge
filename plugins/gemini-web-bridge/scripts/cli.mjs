#!/usr/bin/env node

import { GeminiBrowserBridge, normalizeBridgeError } from "./gemini-browser.mjs";
import { authorizationStatus, authorize, listConversations } from "./state-store.mjs";

const bridge = new GeminiBrowserBridge();
const ownerThreadId = process.env.CODEX_THREAD_ID ?? null;
const abortController = new AbortController();
let interruptCount = 0;

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    interruptCount += 1;
    if (interruptCount === 1) abortController.abort();
    else process.exit(130);
  });
}

function writeJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function readStdinJson() {
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  if (source.trim().length === 0) throw Object.assign(new Error("Expected JSON input on stdin."), { code: "INVALID_INPUT" });
  try {
    return JSON.parse(source);
  } catch {
    throw Object.assign(new Error("Stdin did not contain valid JSON."), { code: "INVALID_INPUT" });
  }
}

function progress(message, value) {
  writeJson({ event: "progress", message, progress: value }, process.stderr);
}

function exitCodeFor(error) {
  if (["AUTHORIZATION_REQUIRED", "LOGIN_REQUIRED", "INTERACTION_REQUIRED", "LOGIN_TIMEOUT"].includes(error.code)) return 2;
  if (error.code === "RATE_LIMITED") return 3;
  if (["INVALID_INPUT", "CONVERSATION_NOT_FOUND"].includes(error.code)) return 5;
  return 4;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "status") {
    const [authorization, browser] = await Promise.all([authorizationStatus(), bridge.browserStatus()]);
    writeJson({ authorization, browser, status: "completed" });
    return;
  }
  if (command === "authorize") {
    if (!args.includes("--confirmed")) {
      throw Object.assign(new Error("authorize requires --confirmed after explicit user consent."), { code: "INVALID_INPUT" });
    }
    writeJson({ ...(await authorize(abortController.signal)), status: "completed" });
    return;
  }
  if (command === "login") {
    const result = await bridge.launchHumanLogin({ signal: abortController.signal, wait: true }, progress);
    writeJson({ ...result, status: "completed" });
    return;
  }
  if (command === "ask") {
    const authorization = await authorizationStatus();
    if (!authorization.authorized) {
      throw Object.assign(new Error("One-time Gemini Web authorization is required."), { code: "AUTHORIZATION_REQUIRED" });
    }
    const input = await readStdinJson();
    const result = await bridge.ask(
      {
        conversationId: input.conversation_id ?? null,
        ownerThreadId,
        prompt: input.prompt,
        signal: abortController.signal,
      },
      progress,
    );
    writeJson({
      answer: result.answer,
      conversation_id: result.conversationId,
      request_id: result.requestId,
      status: "completed",
    });
    return;
  }
  if (command === "conversations") {
    const scope = args.includes("--all") ? "all" : "current";
    const conversations = await listConversations({ ownerThreadId, scope });
    writeJson({ conversations, status: "completed" });
    return;
  }
  throw Object.assign(
    new Error("Usage: gemini-web-cli <status|authorize --confirmed|login --wait|ask|conversations [--all]>"),
    { code: "INVALID_INPUT" },
  );
}

try {
  await main();
} catch (error) {
  const normalized = normalizeBridgeError(error);
  writeJson({
    conversation_id: normalized.conversationId ?? null,
    error: {
      code: normalized.code,
      message: normalized.message,
      partial_chars: normalized.partialChars ?? 0,
      phase: normalized.phase,
      retry_safe: normalized.retrySafe === true,
    },
    status: "error",
  });
  process.exitCode = exitCodeFor(normalized);
}
