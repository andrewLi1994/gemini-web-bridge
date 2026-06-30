export function inspectGeminiPage() {
  const composer = document.querySelector(
    'div[contenteditable="true"], .prompt-textfield, textarea',
  );
  const signInVisible = Array.from(document.querySelectorAll('a, button')).some((element) => {
    const text = element.innerText?.trim() ?? '';
    return /^(sign in|登录|登入)$/i.test(text) && element.getClientRects().length > 0;
  });
  return {
    composerReady: composer != null && composer.getClientRects().length > 0,
    signedOut: signInVisible,
    title: document.title,
    url: location.href,
  };
}

export async function submitGeminiPrompt(prompt, requestMarker) {
  const responseSelectors = [
    '.model-response-text',
    '[data-test-id="model-response"]',
    'parsed-content',
    '.message-content .markdown',
  ];
  const sendSelectors = [
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[aria-label*="发送"]',
    'button[data-test-id*="send"]',
    '.send-button',
  ];
  const stopSelectors = [
    'button[aria-label*="Stop"]',
    'button[aria-label*="stop"]',
    'button[aria-label*="停止"]',
    'button[data-test-id*="stop"]',
  ];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isVisible = (element) =>
    element != null &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden';
  const find = (selectors) => {
    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find(isVisible);
      if (element != null) return element;
    }
    return null;
  };
  const snapshot = () => {
    const completedCount = document.querySelectorAll('.response-footer.complete').length;
    for (const selector of responseSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length === 0) continue;
      const text = elements[elements.length - 1].innerText?.trim() ?? '';
      if (text) return { completedCount, count: elements.length, selector, text };
    }
    return { completedCount, count: 0, selector: null, text: '' };
  };
  const input = document.querySelector(
    'div[contenteditable="true"], .prompt-textfield, textarea',
  );
  if (input == null) throw new Error('找不到 Gemini 输入框。');
  input.focus();
  if (input.matches('textarea, input')) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    if (descriptor?.set) descriptor.set.call(input, prompt);
    else input.value = prompt;
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.removeAllRanges();
    selection.addRange(range);
    try { document.execCommand('delete', false, null); } catch { input.textContent = ''; }
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, prompt); } catch {}
    if (!inserted || (input.innerText ?? '').trim() !== prompt) input.textContent = prompt;
  }
  input.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    data: prompt,
    inputType: 'insertText',
  }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(300);

  let send = null;
  const readyDeadline = Date.now() + 12_000;
  while (Date.now() < readyDeadline) {
    send = find(sendSelectors);
    if (send != null && !send.disabled && send.getAttribute('aria-disabled') !== 'true') break;
    await wait(200);
  }
  if (send == null || send.disabled || send.getAttribute('aria-disabled') === 'true') {
    throw new Error('找不到可用的 Gemini 发送按钮。');
  }

  const before = snapshot();
  const titleBefore = document.title;
  send.click();
  const startDeadline = Date.now() + 8_000;
  while (Date.now() < startDeadline) {
    const editorText = (input.innerText ?? input.value ?? '').trim();
    const markerRendered = document.body.innerText.includes(requestMarker);
    if (
      markerRendered &&
      !editorText.includes(requestMarker)
    ) {
      return { before, titleBefore, url: location.href };
    }
    await wait(150);
  }
  throw new Error('提示词已写入，但 Gemini 没有开始生成。');
}

export function readGeminiGenerationState(before) {
  const responseSelectors = [
    '.model-response-text',
    '[data-test-id="model-response"]',
    'parsed-content',
    '.message-content .markdown',
  ];
  const sendSelectors = [
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[aria-label*="发送"]',
    'button[data-test-id*="send"]',
    '.send-button',
  ];
  const stopSelectors = [
    'button[aria-label*="Stop"]',
    'button[aria-label*="stop"]',
    'button[aria-label*="停止"]',
    'button[data-test-id*="stop"]',
  ];
  const isVisible = (element) =>
    element != null &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden';
  const find = (selectors) => {
    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find(isVisible);
      if (element != null) return element;
    }
    return null;
  };
  const failurePatterns = [
    {
      kind: 'RATE_LIMITED',
      pattern: /reached (?:your )?(?:limit|quota)|too many requests|rate limit|已达到.*(?:上限|限额)|请求过多/i,
    },
    {
      kind: 'INTERACTION_REQUIRED',
      pattern: /verify (?:that )?you(?:'re| are) human|captcha|unusual traffic|验证您是真人|异常流量/i,
    },
    {
      kind: 'TRANSIENT',
      pattern: /something went wrong|an error occurred|try again|failed to generate|出了点问题|发生错误|重试|生成失败/i,
    },
  ];
  let failure = null;
  const failureCandidates = document.querySelectorAll(
    '[role="alert"], [aria-live="assertive"], .error-message, button',
  );
  for (const element of failureCandidates) {
    if (!isVisible(element)) continue;
    const text = [
      element.innerText,
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
    ].filter(Boolean).join(' ').trim();
    if (!text) continue;
    const matched = failurePatterns.find(({ pattern }) => pattern.test(text));
    if (matched != null) {
      failure = { kind: matched.kind, text: text.slice(0, 240) };
      break;
    }
  }
  const completedCount = document.querySelectorAll('.response-footer.complete').length;
  let snapshot = { completedCount, count: 0, selector: null, text: '' };
  for (const selector of responseSelectors) {
    const elements = document.querySelectorAll(selector);
    if (elements.length === 0) continue;
    const text = elements[elements.length - 1].innerText?.trim() ?? '';
    if (text) {
      snapshot = { completedCount, count: elements.length, selector, text };
      break;
    }
  }
  const send = find(sendSelectors);
  const isNew = Boolean(
    snapshot.text &&
      (!before?.text || snapshot.count > before.count || snapshot.text !== before.text),
  );
  return {
    isNew,
    sendReady: send != null && !send.disabled && send.getAttribute('aria-disabled') !== 'true',
    snapshot,
    stopVisible: find(stopSelectors) != null,
    failure,
    title: document.title,
    url: location.href,
  };
}

export async function cancelGeminiGeneration() {
  const selectors = [
    'button[aria-label*="Stop"]',
    'button[aria-label*="stop"]',
    'button[aria-label*="停止"]',
    'button[data-test-id*="stop"]',
  ];
  for (const selector of selectors) {
    const button = Array.from(document.querySelectorAll(selector)).find(
      (element) => element.getClientRects().length > 0 && !element.disabled,
    );
    if (button == null) continue;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return true;
  }
  return false;
}
