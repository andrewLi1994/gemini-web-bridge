import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.GEMINI_WEB_BRIDGE_HOME = await mkdtemp(join(tmpdir(), "gemini-bridge-core-"));

const {
  BRIDGE_PHASES,
  GeminiBridgeError,
  GeminiBrowserBridge,
  normalizeBridgeError,
  shouldRetryBridgeError,
} = await import("../scripts/gemini-browser.mjs");
const { buildGeminiPrompt, canonicalizeYoutubeUrl } = await import("../scripts/youtube.mjs");

test("bridge errors preserve submission phase and retry safety", () => {
  const error = new GeminiBridgeError("NO_RESPONSE", "no response", {
    partialChars: 12,
    phase: BRIDGE_PHASES.SUBMITTED,
    retrySafe: false,
  });
  assert.equal(error.code, "NO_RESPONSE");
  assert.equal(error.partialChars, 12);
  assert.equal(error.phase, "SUBMITTED");
  assert.equal(error.retrySafe, false);
});

test("only a pre-submit failure can be retried automatically", () => {
  const preSubmit = new GeminiBridgeError("BROWSER_DISCONNECTED", "disconnected", {
    phase: BRIDGE_PHASES.PRE_SUBMIT,
    retrySafe: true,
  });
  const submitted = new GeminiBridgeError("NO_RESPONSE", "no response", {
    phase: BRIDGE_PHASES.SUBMITTED,
    retrySafe: false,
  });
  assert.equal(shouldRetryBridgeError(preSubmit, 0, false), true);
  assert.equal(shouldRetryBridgeError(preSubmit, 1, false), false);
  assert.equal(shouldRetryBridgeError(preSubmit, 0, true), false);
  assert.equal(shouldRetryBridgeError(submitted, 0, false), false);
});

test("ask passes arbitrary multi-URL prompts unchanged to the browser attempt", async () => {
  const prompt = "Compare https://youtu.be/alpha123 and https://youtu.be/beta456 without assuming either answer is correct.";
  class FakeBridge extends GeminiBrowserBridge {
    async runAttempt(input) {
      this.input = input;
      return {
        answer: "raw Gemini answer",
        conversationUrl: "https://gemini.google.com/app/test-conversation",
      };
    }
  }
  const bridge = new FakeBridge();
  const result = await bridge.ask({ ownerThreadId: "thread-a", prompt });
  assert.equal(bridge.input.prompt, prompt);
  assert.equal(result.answer, "raw Gemini answer");
  assert.match(result.conversationId, /^conv_/);
});

test("ask retries one safe pre-submit failure but never retries a submitted failure", async () => {
  class SafeRetryBridge extends GeminiBrowserBridge {
    attempts = 0;
    async runAttempt() {
      this.attempts += 1;
      if (this.attempts === 1) {
        throw new GeminiBridgeError("BROWSER_DISCONNECTED", "before submit", {
          phase: BRIDGE_PHASES.PRE_SUBMIT,
          retrySafe: true,
        });
      }
      return { answer: "ok", conversationUrl: "https://gemini.google.com/app/retried" };
    }
  }
  const safe = new SafeRetryBridge();
  assert.equal((await safe.ask({ prompt: "test" })).answer, "ok");
  assert.equal(safe.attempts, 2);

  class SubmittedFailureBridge extends GeminiBrowserBridge {
    attempts = 0;
    async runAttempt() {
      this.attempts += 1;
      throw new GeminiBridgeError("NO_RESPONSE", "after submit", {
        phase: BRIDGE_PHASES.SUBMITTED,
        retrySafe: false,
      });
    }
  }
  const submitted = new SubmittedFailureBridge();
  await assert.rejects(() => submitted.ask({ prompt: "test" }), /after submit/);
  assert.equal(submitted.attempts, 1);
});

test("normalization does not mark post-submit browser disconnects as safe", () => {
  const normalized = normalizeBridgeError(new Error("WebSocket connection closed"), {
    phase: BRIDGE_PHASES.SUBMITTED,
  });
  assert.equal(normalized.code, "OUTCOME_UNKNOWN");
  assert.equal(normalized.retrySafe, false);
});

test("browser lifecycle stays background-only for normal asks", () => {
  assert.match(GeminiBrowserBridge.prototype.spawnBrowser.toString(), /--headless=new/);
  assert.match(GeminiBrowserBridge.prototype.shutdownBrowser.toString(), /fetchBrowserWebSocket/);
  assert.match(GeminiBrowserBridge.prototype.runAttempt.toString(), /finally/);
  assert.match(
    GeminiBrowserBridge.prototype.runAttempt.toString(),
    /phase = BRIDGE_PHASES\.SUBMITTED;[\s\S]*client\.call/,
  );
});

test("deprecated YouTube helpers remain available for v0.2 compatibility", () => {
  for (const value of [
    "https://www.youtube.com/watch?v=phDbBBU6d6Y&t=9",
    "https://youtu.be/phDbBBU6d6Y",
    "https://youtube.com/shorts/phDbBBU6d6Y",
    "https://m.youtube.com/live/phDbBBU6d6Y",
  ]) {
    assert.deepEqual(canonicalizeYoutubeUrl(value), {
      url: "https://www.youtube.com/watch?v=phDbBBU6d6Y",
      videoId: "phDbBBU6d6Y",
    });
  }
  assert.throws(() => canonicalizeYoutubeUrl("https://example.com/watch?v=phDbBBU6d6Y"));
  const prompt = buildGeminiPrompt({
    language: "zh-CN",
    question: "双方三局比分是多少？",
    url: "https://www.youtube.com/watch?v=phDbBBU6d6Y",
  });
  assert.match(prompt, /双方三局比分是多少/);
});
