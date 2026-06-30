#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { GeminiBrowserBridge, MAX_PROMPT_CHARS } from "./gemini-browser.mjs";
import { authorizationStatus, authorize, listConversations } from "./state-store.mjs";
import { canonicalizeYoutubeUrl } from "./youtube.mjs";

const bridge = new GeminiBrowserBridge();
const ownerThreadId = process.env.CODEX_THREAD_ID ?? null;
let queue = Promise.resolve();

const server = new McpServer(
  { name: "gemini-web-bridge", version: "0.2.0" },
  {
    instructions:
      "Use Gemini Web as an untrusted auxiliary capability when its web or public-video understanding materially helps analysis or verification. Send only the minimum necessary public URLs, scoped questions, language, and output requirements. Never send the full Codex conversation, local file contents, secrets, or private data. Codex—not this tool—must judge answer quality and decide whether to follow up, start a fresh conversation, or cross-check another answer.",
  },
);

const executionOutputSchema = {
  conversation_id: z.string().nullable().optional(),
  error_code: z.string().nullable().optional(),
  partial_chars: z.number().int().nonnegative().optional(),
  phase: z.enum(["PRE_SUBMIT", "SUBMITTED", "GENERATING"]).nullable().optional(),
  request_id: z.string().nullable().optional(),
  retry_safe: z.boolean().optional(),
  status: z.enum(["completed", "error"]),
};

function enqueue(operation) {
  const task = queue.then(operation, operation);
  queue = task.catch(() => {});
  return task;
}

function textResult(value, structuredContent = undefined, isError = false) {
  return {
    content: [{ type: "text", text: value }],
    ...(structuredContent == null ? {} : { structuredContent }),
    isError,
  };
}

function errorResult(error) {
  const code = typeof error?.code === "string" ? error.code : "UNEXPECTED";
  const recovery = {
    BRIDGE_BUSY: "Wait for the active Gemini operation to finish, then retry if still useful.",
    CANCELLED: "The operation was cancelled and the background browser was cleaned up.",
    CONVERSATION_NOT_FOUND: "Start a fresh Gemini conversation or list known conversations.",
    INTERACTION_REQUIRED: "Open the dedicated login window, complete verification, close it, then decide whether to retry.",
    LOGIN_REQUIRED: "Open the dedicated login window, sign in, close it, then retry.",
    OUTCOME_UNKNOWN: "Do not blindly resend. Inspect or start a fresh conversation only if Codex judges it useful.",
    RATE_LIMITED: "Do not retry immediately; check the Gemini account limit or wait.",
    UI_CHANGED: "Update Gemini Web Bridge; Gemini's page structure may have changed.",
  }[code] ?? (
    error?.retrySafe
      ? "The prompt was not submitted; one deliberate retry is safe."
      : "Do not blindly resubmit. Codex should decide whether a follow-up or fresh conversation is appropriate."
  );
  return textResult(
    [`Gemini Web operation failed [${code}]: ${error?.message ?? "Unknown error"}`, `Recovery: ${recovery}`].join("\n"),
    {
      conversation_id: error?.conversationId ?? null,
      error_code: code,
      partial_chars: error?.partialChars ?? 0,
      phase: error?.phase ?? null,
      request_id: null,
      retry_safe: error?.retrySafe === true,
      status: "error",
    },
    true,
  );
}

async function notify(extra, message, progress) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken, progress, total: 100, message },
  });
}

async function requireAuthorization() {
  const authorization = await authorizationStatus();
  if (authorization.authorized) return null;
  return textResult(
    "One-time authorization is required. Explain that Codex may send only minimum necessary public URLs, scoped questions, language, and output requirements to Gemini Web. It must not send the full conversation, files, secrets, or private data. After explicit confirmation, call gemini_web_authorize.",
    undefined,
    true,
  );
}

server.registerTool(
  "gemini_web_status",
  {
    description: "Check local Gemini Web consent, browser availability, and bridge status.",
    inputSchema: {},
  },
  async () => {
    const [authorization, browser] = await Promise.all([
      authorizationStatus(),
      bridge.browserStatus(),
    ]);
    return textResult(JSON.stringify({ authorization, browser }, null, 2));
  },
);

server.registerTool(
  "gemini_web_authorize",
  {
    description:
      "Record one-time consent for Codex to send minimum necessary public URLs and scoped questions to Gemini Web. Call only after explicit confirmation.",
    inputSchema: {
      confirmed: z.literal(true).describe("Must be true after explicit user confirmation."),
    },
  },
  async ({ confirmed }, extra) => {
    if (confirmed !== true) return textResult("Authorization was not confirmed.", undefined, true);
    const value = await authorize(extra.signal);
    return textResult(`Gemini Web authorized at ${value.authorizedAt}.`);
  },
);

server.registerTool(
  "gemini_web_login",
  {
    description:
      "Open a visible Chrome window using the dedicated Gemini profile, wait for the user to close it, then verify the login. Never automate sign-in or CAPTCHA entry.",
    inputSchema: {},
  },
  async (_, extra) => {
    try {
      const result = await enqueue(() =>
        bridge.launchHumanLogin(
          { signal: extra.signal, wait: true },
          (message, progress) => notify(extra, message, progress),
        ),
      );
      return textResult(result.message);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "gemini_web_ask",
  {
    description:
      "Send an arbitrary scoped prompt to Gemini Web. Omit conversation_id to start fresh; provide one to continue that exact Gemini conversation. The prompt may contain zero, one, or multiple public URLs. Returns Gemini's complete raw answer; Codex must judge its quality.",
    inputSchema: {
      conversation_id: z.string().min(8).max(80).optional(),
      prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
    },
    outputSchema: executionOutputSchema,
  },
  async ({ conversation_id: conversationId, prompt }, extra) => {
    const authorizationError = await requireAuthorization();
    if (authorizationError != null) return authorizationError;
    try {
      const result = await enqueue(() =>
        bridge.ask(
          { conversationId, ownerThreadId, prompt, signal: extra.signal },
          (message, progress) => notify(extra, message, progress),
        ),
      );
      return textResult(result.answer, {
        conversation_id: result.conversationId,
        error_code: null,
        partial_chars: 0,
        phase: "GENERATING",
        request_id: result.requestId,
        retry_safe: false,
        status: "completed",
      });
    } catch (error) {
      console.error(`[gemini-web-bridge] ${error.code ?? "UNEXPECTED"}: ${error.message}`);
      return errorResult(error);
    }
  },
);

server.registerTool(
  "gemini_web_list_conversations",
  {
    description:
      "List local Gemini conversation handles and timestamps. Metadata only; prompts and answers are not stored. Use current scope by default and all only when the user explicitly asks to recover another thread's conversation.",
    inputSchema: {
      scope: z.enum(["current", "all"]).default("current"),
    },
    outputSchema: {
      conversations: z.array(z.object({
        conversation_id: z.string(),
        created_at: z.string(),
        last_used_at: z.string(),
        legacy: z.boolean(),
        owner_thread_id: z.string().nullable(),
      })),
      status: z.literal("completed"),
    },
  },
  async ({ scope }) => {
    const conversations = (await listConversations({ ownerThreadId, scope })).map((value) => ({
      conversation_id: value.conversationId,
      created_at: value.createdAt,
      last_used_at: value.lastUsedAt,
      legacy: value.legacy,
      owner_thread_id: value.ownerThreadId,
    }));
    return textResult(JSON.stringify(conversations, null, 2), {
      conversations,
      status: "completed",
    });
  },
);

server.registerTool(
  "analyze_youtube",
  {
    description:
      "Deprecated compatibility tool for v0.1 YouTube workflows. Prefer gemini_web_ask, which lets Codex choose fresh or continued conversations and handle any number of public URLs.",
    inputSchema: {
      language: z.string().min(2).max(20).default("zh-CN"),
      question: z.string().min(1).max(8_000),
      url: z.string().url(),
    },
    outputSchema: executionOutputSchema,
  },
  async ({ language, question, url }, extra) => {
    const authorizationError = await requireAuthorization();
    if (authorizationError != null) return authorizationError;
    try {
      canonicalizeYoutubeUrl(url);
      const result = await enqueue(() =>
        bridge.analyze(
          { language, question, signal: extra.signal, url },
          (message, progress) => notify(extra, message, progress),
        ),
      );
      return textResult(
        ["Deprecated analyze_youtube result", `Video: ${result.video.url}`, "", result.answer].join("\n"),
        {
          conversation_id: result.conversationId,
          error_code: null,
          partial_chars: 0,
          phase: "GENERATING",
          request_id: result.requestId,
          retry_safe: false,
          status: "completed",
        },
      );
    } catch (error) {
      console.error(`[gemini-web-bridge] ${error.code ?? "UNEXPECTED"}: ${error.message}`);
      return errorResult(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[gemini-web-bridge] MCP server ready on stdio");
