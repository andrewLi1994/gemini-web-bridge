import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { CdpClient } from "./cdp-client.mjs";
import {
  cancelGeminiGeneration,
  inspectGeminiPage,
  readGeminiGenerationState,
  submitGeminiPrompt,
} from "./gemini-page.mjs";
import { withFileLock } from "./operation-lock.mjs";
import {
  findLegacyConversation,
  getConversation,
  paths,
  saveConversation,
} from "./state-store.mjs";
import { buildGeminiPrompt, canonicalizeYoutubeUrl } from "./youtube.mjs";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const GEMINI_HOME = "https://gemini.google.com/app";
const ANSWER_TIMEOUT_MS = 3 * 60_000;
const NO_RESPONSE_TIMEOUT_MS = 90_000;
const STALLED_RESPONSE_TIMEOUT_MS = 45_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_PROMPT_CHARS = 16_000;

export const BRIDGE_PHASES = {
  GENERATING: "GENERATING",
  PRE_SUBMIT: "PRE_SUBMIT",
  SUBMITTED: "SUBMITTED",
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GeminiBridgeError extends Error {
  constructor(
    code,
    message,
    {
      conversationId = null,
      conversationUrl = null,
      partialChars = 0,
      phase = BRIDGE_PHASES.PRE_SUBMIT,
      retrySafe = false,
    } = {},
  ) {
    super(message);
    this.name = "GeminiBridgeError";
    this.code = code;
    this.conversationId = conversationId;
    this.conversationUrl = conversationUrl;
    this.partialChars = partialChars;
    this.phase = phase;
    this.retrySafe = retrySafe;
    this.retryable = retrySafe;
  }
}

function errorOptions(context, overrides = {}) {
  return {
    conversationId: context.conversationId ?? null,
    conversationUrl: context.conversationUrl ?? null,
    phase: context.phase ?? BRIDGE_PHASES.PRE_SUBMIT,
    ...overrides,
  };
}

function normalizeBridgeError(error, context = {}) {
  if (error instanceof GeminiBridgeError) {
    if (error.conversationId == null) error.conversationId = context.conversationId ?? null;
    if (error.conversationUrl == null) error.conversationUrl = context.conversationUrl ?? null;
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const phase = context.phase ?? BRIDGE_PHASES.PRE_SUBMIT;
  if (/取消|cancelled|aborted/i.test(message) || error?.code === "CANCELLED") {
    return new GeminiBridgeError("CANCELLED", "Gemini analysis was cancelled.", errorOptions(context));
  }
  if (error?.code === "LOCK_TIMEOUT") {
    return new GeminiBridgeError(
      "BRIDGE_BUSY",
      "Timed out waiting for another Gemini Web Bridge operation to finish.",
      errorOptions(context),
    );
  }
  if (["AUTHORIZATION_REQUIRED", "CONVERSATION_NOT_FOUND", "INVALID_INPUT"].includes(error?.code)) {
    return new GeminiBridgeError(error.code, message, errorOptions(context));
  }
  if (/连接已关闭|fetch failed|ECONN|WebSocket|socket/i.test(message)) {
    const submitted = phase !== BRIDGE_PHASES.PRE_SUBMIT;
    return new GeminiBridgeError(
      submitted ? "OUTCOME_UNKNOWN" : "BROWSER_DISCONNECTED",
      submitted
        ? "The browser connection closed after submission may have started; the outcome is unknown."
        : "The browser connection closed before submission.",
      errorOptions(context, { retrySafe: !submitted }),
    );
  }
  if (/超时|timed out/i.test(message)) {
    const submitted = phase !== BRIDGE_PHASES.PRE_SUBMIT;
    return new GeminiBridgeError(
      submitted ? "OUTCOME_UNKNOWN" : "BROWSER_TIMEOUT",
      submitted ? "A browser call timed out after submission may have started; the outcome is unknown." : message,
      errorOptions(context, { retrySafe: !submitted }),
    );
  }
  if (/没有开始生成|did not start generating/i.test(message) && phase !== BRIDGE_PHASES.PRE_SUBMIT) {
    return new GeminiBridgeError(
      "OUTCOME_UNKNOWN",
      "Gemini accepted the page interaction but generation did not become observable; the outcome is unknown.",
      errorOptions(context),
    );
  }
  if (/找不到 Gemini 输入框|找不到可用的 Gemini 发送按钮/i.test(message)) {
    return new GeminiBridgeError(
      "UI_CHANGED",
      "Gemini Web may have changed its page structure; the input or send control was not found.",
      errorOptions(context),
    );
  }
  return new GeminiBridgeError("UNEXPECTED", message, errorOptions(context));
}

export function shouldRetryBridgeError(error, attempt, aborted = false) {
  return attempt === 0 && error?.retrySafe === true && !aborted;
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) throw new Error(`Chrome debugging endpoint returned ${response.status}.`);
  return response.json();
}

async function fetchBrowserWebSocket(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) throw new Error(`Chrome browser endpoint returned ${response.status}.`);
  const version = await response.json();
  if (typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error("Chrome browser endpoint did not provide a WebSocket URL.");
  }
  return version.webSocketDebuggerUrl;
}

async function readActivePort() {
  try {
    const [line] = (await readFile(`${paths.profile}/DevToolsActivePort`, "utf8")).split("\n");
    const port = Number(line);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function isSpecificConversationUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.origin === "https://gemini.google.com" && /^\/app\/[^/]+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function cleanPrompt(value) {
  const prompt = String(value).trim();
  if (prompt.length === 0) throw new GeminiBridgeError("INVALID_INPUT", "Prompt cannot be empty.");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new GeminiBridgeError(
      "INVALID_INPUT",
      `Prompt is too long; keep it within ${MAX_PROMPT_CHARS} characters.`,
    );
  }
  return prompt;
}

export class GeminiBrowserBridge {
  async browserStatus() {
    const executable = await this.findBrowser();
    const port = await readActivePort();
    let connected = false;
    if (port != null) {
      try {
        await fetchTargets(port);
        connected = true;
      } catch {}
    }
    return {
      browserInstalled: executable != null,
      connected,
      executable,
      runtimeMode: "headless-per-task",
    };
  }

  async findBrowser() {
    for (const candidate of CHROME_CANDIDATES) {
      if (await fileExists(candidate)) return candidate;
    }
    return null;
  }

  async shutdownBrowser(port) {
    if (port == null) return;
    try {
      const client = new CdpClient(await fetchBrowserWebSocket(port));
      await client.connect();
      try {
        await client.send("Browser.close", {}, 5_000);
      } finally {
        client.close();
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          await fetchTargets(port);
          await delay(200);
        } catch {
          break;
        }
      }
    } catch {}
  }

  async waitForBrowserPort(signal, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new GeminiBridgeError("CANCELLED", "Operation cancelled.");
      const port = await readActivePort();
      if (port != null) {
        try {
          await fetchTargets(port);
          return port;
        } catch {}
      }
      await delay(250);
    }
    throw new GeminiBridgeError(
      "BROWSER_TIMEOUT",
      "Chrome started, but its local debugging endpoint did not become ready.",
      { retrySafe: true },
    );
  }

  async spawnBrowser({ headless, signal }) {
    await this.shutdownBrowser(await readActivePort());
    const executable = await this.findBrowser();
    if (executable == null) {
      throw new GeminiBridgeError(
        "BROWSER_NOT_FOUND",
        "No compatible browser was found. Install Google Chrome before using Gemini Web Bridge.",
      );
    }
    const args = [
      `--user-data-dir=${paths.profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,1000",
    ];
    if (headless) args.push("--headless=new", "about:blank");
    else args.push("--new-window", GEMINI_HOME);
    spawn(executable, args, { detached: true, stdio: "ignore" }).unref();
    return this.waitForBrowserPort(signal);
  }

  async startBrowser(signal) {
    return this.spawnBrowser({ headless: true, signal });
  }

  async openTarget(port) {
    const response = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`,
      { method: "PUT", signal: AbortSignal.timeout(2_000) },
    );
    if (!response.ok) throw new Error("Unable to create a Gemini browser tab.");
    const target = await response.json();
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    return { client, target };
  }

  async waitForComposer(client, onProgress, signal, expectedUrl) {
    const deadline = Date.now() + 60_000;
    const expectedPath =
      expectedUrl === GEMINI_HOME ? null : new URL(expectedUrl).pathname.replace(/\/$/, "");
    let readyChecks = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new GeminiBridgeError("CANCELLED", "Operation cancelled.");
      const page = await client.call(inspectGeminiPage.toString());
      if (page?.signedOut === true || /accounts\.google\.com/i.test(page?.url ?? "")) {
        throw new GeminiBridgeError(
          "LOGIN_REQUIRED",
          "Sign in to Gemini in the dedicated browser window, close it, and retry.",
        );
      }
      if (
        page?.composerReady &&
        page.signedOut !== true &&
        /gemini\.google\.com/i.test(page.url) &&
        (expectedPath == null || new URL(page.url).pathname.replace(/\/$/, "") === expectedPath)
      ) {
        readyChecks += 1;
        if (readyChecks >= 4) return page;
      } else {
        readyChecks = 0;
      }
      await delay(750);
    }
    throw new GeminiBridgeError(
      "COMPOSER_TIMEOUT",
      "Timed out waiting for the Gemini input box.",
      { retrySafe: true },
    );
  }

  async verifyLogin(onProgress, signal) {
    let client = null;
    let port = null;
    try {
      port = await this.startBrowser(signal);
      ({ client } = await this.openTarget(port));
      await client.send("Page.navigate", { url: GEMINI_HOME });
      await onProgress?.("Verifying the Gemini login.", 90);
      await this.waitForComposer(client, onProgress, signal, GEMINI_HOME);
      return true;
    } finally {
      client?.close();
      await this.shutdownBrowser(port);
    }
  }

  async launchHumanLogin({ signal, wait = true } = {}, onProgress) {
    return withFileLock(
      paths.browserLock,
      { label: "Gemini Web browser", signal },
      async () => {
        const port = await this.spawnBrowser({ headless: false, signal });
        await onProgress?.(
          "Sign in to Gemini in the visible browser, then close the entire dedicated window.",
          10,
        );
        if (!wait) {
          return { loginVerified: false, message: "Gemini login window opened.", profile: paths.profile };
        }

        const deadline = Date.now() + LOGIN_TIMEOUT_MS;
        let interactivePageObserved = false;
        while (Date.now() < deadline) {
          if (signal?.aborted) {
            await this.shutdownBrowser(port);
            throw new GeminiBridgeError("CANCELLED", "Login was cancelled.");
          }
          try {
            const targets = await fetchTargets(port);
            const pages = targets.filter(({ type }) => type === "page");
            if (pages.some(({ url }) => /gemini\.google\.com|accounts\.google\.com/i.test(url ?? ""))) {
              interactivePageObserved = true;
            }
            if (interactivePageObserved && pages.length === 0) {
              await this.shutdownBrowser(port);
              await delay(500);
              const loginVerified = await this.verifyLogin(onProgress, signal);
              return {
                loginVerified,
                message: "Gemini login verified.",
                profile: paths.profile,
              };
            }
          } catch {
            await delay(500);
            const loginVerified = await this.verifyLogin(onProgress, signal);
            return {
              loginVerified,
              message: "Gemini login verified.",
              profile: paths.profile,
            };
          }
          await delay(750);
        }
        await this.shutdownBrowser(port);
        throw new GeminiBridgeError(
          "LOGIN_TIMEOUT",
          "The Gemini login window remained open for more than 10 minutes.",
        );
      },
    );
  }

  async waitForAnswer(client, before, onProgress, signal, context) {
    const startedAt = Date.now();
    const deadline = startedAt + ANSWER_TIMEOUT_MS;
    let lastChangedAt = startedAt;
    let lastText = "";
    let lastUrl = context.conversationUrl;
    let stableChecks = 0;
    let ticks = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new GeminiBridgeError("CANCELLED", "Generation was cancelled.", {
          ...context,
          conversationUrl: lastUrl,
          partialChars: lastText.length,
          phase: lastText.length > 0 ? BRIDGE_PHASES.GENERATING : BRIDGE_PHASES.SUBMITTED,
        });
      }
      const state = await client.call(readGeminiGenerationState.toString(), [before]);
      lastUrl = state.url ?? lastUrl;
      const phase = lastText.length > 0 ? BRIDGE_PHASES.GENERATING : BRIDGE_PHASES.SUBMITTED;
      if (state.failure?.kind === "RATE_LIMITED") {
        throw new GeminiBridgeError("RATE_LIMITED", "Gemini Web reached the account usage limit.", {
          ...context,
          conversationUrl: lastUrl,
          partialChars: lastText.length,
          phase,
        });
      }
      if (state.failure?.kind === "INTERACTION_REQUIRED") {
        throw new GeminiBridgeError(
          "INTERACTION_REQUIRED",
          "Gemini requires manual verification in the dedicated browser.",
          { ...context, conversationUrl: lastUrl, partialChars: lastText.length, phase },
        );
      }
      if (state.failure?.kind === "TRANSIENT") {
        throw new GeminiBridgeError("GEMINI_TRANSIENT", "Gemini Web displayed a generation error.", {
          ...context,
          conversationUrl: lastUrl,
          partialChars: lastText.length,
          phase,
        });
      }
      if (state.isNew && state.snapshot.text === lastText) {
        stableChecks += 1;
      } else if (state.isNew) {
        stableChecks = 0;
        lastText = state.snapshot.text;
        lastChangedAt = Date.now();
      } else {
        stableChecks = 0;
      }
      ticks += 1;
      if (ticks % 8 === 0) {
        await onProgress?.(`Gemini is generating; received ${lastText.length} characters.`, 50);
      }
      const completeByControls =
        state.isNew &&
        !state.stopVisible &&
        state.snapshot.completedCount > (before?.completedCount ?? 0);
      if (lastText.length > 0 && stableChecks >= 4 && completeByControls) {
        return { answer: lastText, conversationUrl: lastUrl };
      }
      if (!state.isNew && Date.now() - startedAt >= NO_RESPONSE_TIMEOUT_MS) {
        throw new GeminiBridgeError("NO_RESPONSE", "Gemini did not return an answer within 90 seconds.", {
          ...context,
          conversationUrl: lastUrl,
          phase: BRIDGE_PHASES.SUBMITTED,
        });
      }
      if (lastText.length > 0 && Date.now() - lastChangedAt >= STALLED_RESPONSE_TIMEOUT_MS) {
        throw new GeminiBridgeError(
          "RESPONSE_STALLED",
          `Gemini stopped generating after ${lastText.length} characters without completing.`,
          {
            ...context,
            conversationUrl: lastUrl,
            partialChars: lastText.length,
            phase: BRIDGE_PHASES.GENERATING,
          },
        );
      }
      await delay(750);
    }
    throw new GeminiBridgeError(
      "GENERATION_TIMEOUT",
      `Gemini did not complete within three minutes${lastText.length > 0 ? `; received ${lastText.length} characters` : ""}.`,
      {
        ...context,
        conversationUrl: lastUrl,
        partialChars: lastText.length,
        phase: lastText.length > 0 ? BRIDGE_PHASES.GENERATING : BRIDGE_PHASES.SUBMITTED,
      },
    );
  }

  async runAttempt({ conversationId, destination, prompt, requestId, signal }, onProgress) {
    let client = null;
    let completed = false;
    let conversationUrl = destination;
    let phase = BRIDGE_PHASES.PRE_SUBMIT;
    let port = null;
    try {
      port = await this.startBrowser(signal);
      ({ client } = await this.openTarget(port));
      await client.send("Page.navigate", { url: destination });
      await this.waitForComposer(client, onProgress, signal, destination);
      if (conversationId != null) await delay(4_000);
      const requestMarker = `GW-${requestId}`;
      const markedPrompt = `${prompt}\n\nLocal request marker: ${requestMarker} (do not repeat this marker in the answer)`;
      await onProgress?.("Submitting a prompt to Gemini Web.", 25);
      // Runtime.callFunctionOn may disconnect after the page has clicked Send.
      // From this point onward, treat the outcome as submitted rather than risk a duplicate.
      phase = BRIDGE_PHASES.SUBMITTED;
      const submission = await client.call(
        submitGeminiPrompt.toString(),
        [markedPrompt, requestMarker],
        30_000,
      );
      conversationUrl = submission.url ?? conversationUrl;
      const result = await this.waitForAnswer(client, submission.before, onProgress, signal, {
        conversationId,
        conversationUrl,
      });
      completed = true;
      return result;
    } catch (error) {
      throw normalizeBridgeError(error, { conversationId, conversationUrl, phase });
    } finally {
      if (client != null && !completed) {
        await client.call(cancelGeminiGeneration.toString(), [], 5_000).catch(() => {});
      }
      client?.close();
      await this.shutdownBrowser(port);
    }
  }

  async ask({ conversationId = null, ownerThreadId = null, prompt, signal }, onProgress) {
    const clean = cleanPrompt(prompt);
    const requestId = crypto.randomUUID();
    let conversation = null;
    if (conversationId != null) {
      conversation = await getConversation(conversationId);
      if (conversation == null) {
        throw new GeminiBridgeError(
          "CONVERSATION_NOT_FOUND",
          `No local Gemini conversation was found for ${conversationId}.`,
          { conversationId },
        );
      }
    }

    return withFileLock(
      paths.browserLock,
      { label: "Gemini Web browser", signal },
      async () => {
        let lastError = null;
        const destination = conversation?.conversationUrl ?? GEMINI_HOME;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const result = await this.runAttempt(
              { conversationId, destination, prompt: clean, requestId, signal },
              onProgress,
            );
            const savedId = await saveConversation(
              {
                conversationId,
                conversationUrl: result.conversationUrl,
                ownerThreadId,
              },
              signal,
            );
            await onProgress?.("Gemini Web returned a complete answer.", 100);
            return { ...result, conversationId: savedId, requestId };
          } catch (error) {
            lastError = normalizeBridgeError(error, { conversationId });
            if (lastError.conversationId == null && isSpecificConversationUrl(lastError.conversationUrl)) {
              lastError.conversationId = await saveConversation(
                { conversationUrl: lastError.conversationUrl, ownerThreadId },
                signal,
              );
            }
            if (shouldRetryBridgeError(lastError, attempt, signal?.aborted)) {
              await onProgress?.("A pre-submit browser failure occurred; retrying once safely.", 15);
              await delay(1_000);
              continue;
            }
            throw lastError;
          }
        }
        throw lastError;
      },
    );
  }

  async analyze({ language, question, signal, url }, onProgress) {
    const video = canonicalizeYoutubeUrl(url);
    const legacy = await findLegacyConversation(video.videoId);
    const result = await this.ask(
      {
        conversationId: legacy?.conversationId ?? null,
        ownerThreadId: process.env.CODEX_THREAD_ID ?? null,
        prompt: buildGeminiPrompt({ language, question, url: video.url }),
        signal,
      },
      onProgress,
    );
    await saveConversation(
      {
        conversationId: result.conversationId,
        conversationUrl: result.conversationUrl,
        legacyVideoId: video.videoId,
        ownerThreadId: process.env.CODEX_THREAD_ID ?? null,
      },
      signal,
    );
    return { ...result, video };
  }
}

export { GEMINI_HOME, MAX_PROMPT_CHARS, normalizeBridgeError };
