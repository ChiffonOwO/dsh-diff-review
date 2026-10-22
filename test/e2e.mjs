/**
 * End-to-end check against a real Host: opens a chat, asks for one small file,
 * waits for the turn, and reports whether the dock appeared and the review page
 * renders. Real mouse/keyboard input events; no stubbing.
 * Usage: BASE=… TOKEN=… node test/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
const PORT = 9337;

const chrome = spawn(CHROME, [
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/dsh-diff-review/.tmp/chrome-e2e',
  '--window-size=1500,950',
  'about:blank'
], { stdio: 'ignore' });

let id = 0;
const pending = new Map();
const logs = [];

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

/** Real pointer click on the first element matching `selector`. */
async function click(ws, selector) {
  const box = await evaluate(ws, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (element === null) return null;
    element.scrollIntoView({ block: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (box === null) return 'missing';
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return 'clicked';
}

const pressEnter = async (ws) => {
  for (const type of ['keyDown', 'keyUp']) {
    await send(ws, 'Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    });
  }
};

try {
  const ws = new WebSocket(await connect());
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame.id !== undefined && pending.has(frame.id)) {
      const entry = pending.get(frame.id);
      pending.delete(frame.id);
      frame.error === undefined ? entry.resolve(frame.result) : entry.reject(new Error(frame.error.message));
      return;
    }
    if (frame.method === 'Runtime.consoleAPICalled') logs.push(`[${frame.params.type}] ${frame.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    if (frame.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${frame.params.exceptionDetails.exception?.description ?? frame.params.exceptionDetails.text}`);
  });
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await send(ws, 'Page.navigate', { url: `${BASE}/?token=${TOKEN}` });
  await delay(10000);

  // The preview banner covers the composer on a fresh profile: dismiss it.
  await evaluate(ws, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续')?.click()`);
  await delay(600);

  // Open the newest chat, then type into the composer with a real click.
  console.log('OPEN', await click(ws, '[data-row-key^="session:"]'));
  await delay(4000);
  console.log('FOCUS', await click(ws, '[role="textbox"]'));
  await delay(400);
  await send(ws, 'Input.insertText', {
    text: '新建文件 e2e-diff-review.txt，三行内容：alpha、beta、gamma。只做这一步，不要运行命令。'
  });
  await delay(700);
  console.log('TYPED', JSON.stringify(await evaluate(ws, `document.querySelector('[role="textbox"]')?.innerText`)));
  await pressEnter(ws);
  await delay(1500);
  console.log('SENT', JSON.stringify(await evaluate(ws, `document.querySelector('[role="textbox"]')?.innerText`)));

  // Poll for the dock while the turn runs.
  let dockText = '';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await delay(2000);
    dockText = await evaluate(ws, `document.querySelector('[data-diff-review-dock]')?.innerText ?? ''`);
    if (dockText !== '') break;
  }
  console.log('DOCK', JSON.stringify(dockText));

  if (dockText !== '') {
    await evaluate(ws, `(async () => {
      const pill = document.querySelector('[data-diff-review-dock] button');
      pill?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      document.querySelector('[data-diff-review-popover] button')?.click();
    })()`);
    await delay(2500);
    console.log('PAGE', await evaluate(ws, `document.querySelectorAll('[data-diff-review-page]').length`));
    console.log('PAGE_TEXT', JSON.stringify((await evaluate(ws, `document.querySelector('[data-diff-review-page]')?.innerText ?? ''`)).slice(0, 500)));
  }
  console.log('LOGS', JSON.stringify(logs.filter((line) => /diff-review|exception/i.test(line)).slice(0, 12)));
} finally {
  chrome.kill();
}
