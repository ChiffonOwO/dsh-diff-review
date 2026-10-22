/**
 * Requirement 1, end to end: three edits to the SAME file inside ONE turn must
 * show the cumulative turn count (3 additions, 0 deletions) and a diff spanning
 * all three edits — not just the last edit's numbers.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
const PORT = 9356;

const chrome = spawn(CHROME, [
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/dsh-diff-review/.tmp/chrome-multi',
  '--window-size=1500,950',
  'about:blank'
], { stdio: 'ignore' });

let id = 0;
const pending = new Map();

async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((target) => target.type === 'page');
      if (page !== undefined) return page.webSocketDebuggerUrl;
    } catch { /* not up */ }
    await delay(400);
  }
  throw new Error('no debug target');
}

function send(ws, method, params = {}) {
  const callId = ++id;
  ws.send(JSON.stringify({ id: callId, method, params }));
  return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
}

async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}

async function click(ws, selector) {
  const box = await evaluate(ws, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (box === null) return 'missing';
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return 'clicked';
}

try {
  const ws = new WebSocket(await connect());
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame.id !== undefined && pending.has(frame.id)) {
      const entry = pending.get(frame.id);
      pending.delete(frame.id);
      frame.error === undefined ? entry.resolve(frame.result) : entry.reject(new Error(frame.error.message));
    }
  });
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  // Record the Host's diff payload so the rows can be inspected, not just the text.
  await send(ws, 'Page.addScriptToEvaluateOnNewDocument', {
    source: `
      const rf = window.fetch.bind(window);
      window.__diffPayload = null;
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        const response = await rf(input, init);
        if (url.includes('diff-review.diff')) {
          response.clone().json().then((body) => { window.__diffPayload = body; }).catch(() => {});
        }
        return response;
      };
    `
  });
  await send(ws, 'Page.navigate', { url: `${BASE}/?token=${TOKEN}` });
  await delay(10000);
  await evaluate(ws, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续')?.click()`);
  await delay(600);
  await evaluate(ws, `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('新会话'))?.click()`);
  await delay(3500);

  await click(ws, '[role="textbox"]');
  await delay(300);
  await send(ws, 'Input.insertText', {
    text: '写一个 three_edits.txt，内容第一行 one。然后用 edit 追加第二行 two，再用 edit 追加第三行 three。三次编辑分开做，不要用 write 一次写完，不要运行命令。'
  });
  await delay(400);
  for (const type of ['keyDown', 'keyUp']) {
    await send(ws, 'Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }

  // Open the review page as soon as the file is listed, then let the turn run:
  // with the page on screen it re-reads the diff while edits keep landing.
  let docked = false;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await delay(1500);
    const allow = await evaluate(ws, `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '允许一次');
      b?.click();
      return b !== undefined;
    })()`);
    if (allow) await delay(800);
    docked = await evaluate(ws, `document.querySelector('[data-diff-review-dock]') !== null`);
    if (docked) break;
  }
  console.log('DOCKED', docked);
  await evaluate(ws, `(async () => {
    const pill = document.querySelector('[data-diff-review-dock] button');
    pill?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    document.querySelector('[data-diff-review-popover] button')?.click();
  })()`);

  // Wait until all three lines have landed in the recorded diff.
  let addedRows = [];
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await delay(2000);
    const payload = await evaluate(ws, `JSON.stringify(window.__diffPayload ?? null)`);
    const parsed = payload === undefined || payload === 'null' ? null : JSON.parse(payload);
    addedRows = (parsed?.rows ?? []).filter((row) => row.type === 'add').map((row) => row.text);
    if (['one', 'two', 'three'].every((word) => addedRows.includes(word))) break;
  }
  const counts = await evaluate(ws, `[...document.querySelectorAll('[data-diff-review-dock] .dsh-diff-review-bump')].map((n) => n.textContent)`);
  console.log('COUNTERS', JSON.stringify(counts));
  console.log('ADDED_ROWS', JSON.stringify(addedRows));
  console.log('HAS_ALL_THREE', ['one', 'two', 'three'].every((word) => addedRows.includes(word)));
  const shown = await evaluate(ws, `document.querySelector('[data-diff-review-page] pre')?.innerText ?? '(no diff)'`);
  console.log('RENDERED_HAS_THREE', shown.includes('three'));
} finally {
  chrome.kill();
}
