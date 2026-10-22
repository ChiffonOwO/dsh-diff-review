/**
 * Requirement 4: the diff dock renders ABOVE the native todo dock, and the
 * native list keeps dsh's own markup. A real turn creates the todo dock; the
 * diff routes are stubbed so the dock is present on any turn.
 * Usage: BASE=… TOKEN=… node test/order.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
const PORT = 9357;

const chrome = spawn(CHROME, [
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/dsh-diff-review/.tmp/chrome-order5',
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

const pressEnter = async (ws) => {
  for (const type of ['keyDown', 'keyUp']) {
    await send(ws, 'Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
};

const FIXTURE = `
  const FILES = [{ path: 'lib/widgets/counter.dart', added: 3, deleted: 2 }];
  const rf = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (url.includes('diff-review.changes')) {
      return Promise.resolve(new Response(JSON.stringify({ turn: 1, files: FILES, added: 3, deleted: 2 }),
        { headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('diff-review.diff')) {
      return Promise.resolve(new Response(JSON.stringify({ rows: [{ type: 'ctx', text: 'x', old: 1, new: 1 }],
        beforeText: 'x', afterText: 'x' }), { headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('diff-review.revert')) {
      return Promise.resolve(new Response('{"files":[]}', { headers: { 'content-type': 'application/json' } }));
    }
    return rf(input, init);
  };
  // Find dsh's own todo dock by its panel class or its label.
  window.__todoHost = () => {
    const dock = document.querySelector('[data-diff-review-dock]');
    const stack = dock?.parentElement;
    return [...(stack?.children ?? [])].find((node) => node !== dock && (
      node.querySelector('[class*="TodoPanel"]') !== null || /任务|Todos/.test(node.innerText ?? '')
    ));
  };
`;

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
  await send(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: FIXTURE });
  await send(ws, 'Page.navigate', { url: `${BASE}/?token=${TOKEN}` });
  await delay(10000);
  await evaluate(ws, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续')?.click()`);
  await delay(600);
  await evaluate(ws, `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('新会话'))?.click()`);
  await delay(3500);

  await click(ws, '[role="textbox"]');
  await delay(300);
  await send(ws, 'Input.insertText', { text: '用 todo_write 建 3 条待办（内容随意），全部完成后回复一句。' });
  await delay(500);
  await pressEnter(ws);

  let state;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await delay(500);
    const allow = await evaluate(ws, `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '允许一次');
      b?.click();
      return b !== undefined;
    })()`);
    if (allow) await delay(600);
    state = await evaluate(ws, `(() => {
      const dock = document.querySelector('[data-diff-review-dock]');
      const stack = dock?.parentElement;
      const todo = window.__todoHost?.();
      if (dock === null || todo === undefined) return null;
      const order = [...stack.children].map((n) => n === dock ? 'diff' : n === todo ? 'todo' : (n.querySelector('[role="textbox"]') ? 'composer' : 'other'));
      const d = dock.getBoundingClientRect();
      const t = todo.getBoundingClientRect();
      return {
        order,
        diffAboveTodo: d.top < t.top,
        diffRect: [Math.round(d.top), Math.round(d.bottom)],
        todoRect: [Math.round(t.top), Math.round(t.bottom)],
        todoNativeMarkup: todo.querySelector('[class*="TodoPanel"]') !== null,
        todoText: (todo.innerText ?? '').replace(/\\n/g, ' / ').slice(0, 40)
      };
    })()`);
    if (state !== null) break;
  }
  console.log('STATE', JSON.stringify(state, null, 1));

  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync('D:/dsh-diff-review/docs/order.png', Buffer.from(shot.data, 'base64'));
  console.log('shot');
} finally {
  chrome.kill();
}
