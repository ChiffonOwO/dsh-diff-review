/**
 * One real turn creating a .dart file, then a look at the review tab: syntax
 * colors must appear for a real (non-stubbed) diff.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
const PORT = 9353;

const chrome = spawn(CHROME, [
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/dsh-diff-review/.tmp/chrome-dart',
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
  await send(ws, 'Page.navigate', { url: `${BASE}/?token=${TOKEN}` });
  await delay(10000);
  await evaluate(ws, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续')?.click()`);
  await delay(600);
  await evaluate(ws, `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('新会话'))?.click()`);
  await delay(3500);

  await click(ws, '[role="textbox"]');
  await delay(300);
  await send(ws, 'Input.insertText', {
    text: '新建 demo_syntax.dart：一个 class Counter { int count = 0; void bump() { count++; } }，再加一行注释 // 示例。只做这一步。'
  });
  await delay(400);
  for (const type of ['keyDown', 'keyUp']) {
    await send(ws, 'Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }

  let dock = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await delay(2000);
    dock = await evaluate(ws, `document.querySelector('[data-diff-review-dock]')?.innerText ?? ''`);
    if (dock !== '') break;
  }
  console.log('DOCK', JSON.stringify(dock));
  await evaluate(ws, `(async () => {
    const pill = document.querySelector('[data-diff-review-dock] button');
    pill?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    document.querySelector('[data-diff-review-popover] button')?.click();
  })()`);
  await delay(3500);

  const colors = await evaluate(ws, `(() => {
    const pre = document.querySelector('[data-diff-review-page] pre');
    if (pre === null) return { pre: false };
    const runs = [...pre.querySelectorAll('span[style*="color"]')];
    return {
      pre: true,
      coloredRuns: runs.length,
      distinct: [...new Set(runs.map((s) => s.style.color))],
      text: pre.innerText.slice(0, 200)
    };
  })()`);
  console.log('COLORS', JSON.stringify(colors, null, 1));
  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync('D:/dsh-diff-review/docs/review.png', Buffer.from(shot.data, 'base64'));
  console.log('shot');
} finally {
  chrome.kill();
}
