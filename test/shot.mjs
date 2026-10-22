/**
 * Screenshots of the dock (collapsed + expanded) with stub data, and a
 * measurement of the gap between a file name and its counts.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
const PORT = 9351;

const chrome = spawn(CHROME, [
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/dsh-diff-review/.tmp/chrome-shot3',
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

const FIXTURE = `
  const FILES = [
    { path: 'lib/widgets/counter.dart', added: 3, deleted: 2, created: false },
    { path: 'plugin/client.js', added: 12, deleted: 3, created: false },
    { path: 'docs/notes.md', added: 5, deleted: 0, created: true }
  ];
  const rf = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (url.includes('diff-review.changes')) {
      return Promise.resolve(new Response(JSON.stringify({ turn: 3, files: FILES, added: 20, deleted: 5 }),
        { headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('diff-review.')) {
      return Promise.resolve(new Response(JSON.stringify({ rows: [], added: 0, deleted: 0, beforeText: '', afterText: '' }),
        { headers: { 'content-type': 'application/json' } }));
    }
    return rf(input, init);
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
  await send(ws, 'Page.enable');
  await send(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: FIXTURE });
  await send(ws, 'Page.navigate', { url: `${BASE}/?token=${TOKEN}` });
  await delay(9000);
  await evaluate(ws, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续')?.click()`);
  await delay(1000);

  const collapsed = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync('D:/dsh-diff-review/docs/dock.png', Buffer.from(collapsed.data, 'base64'));

  await evaluate(ws, `document.querySelector('[data-diff-review-dock] button')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
  await delay(700);

  const gap = await evaluate(ws, `(() => {
    const rows = [...(document.querySelector('[data-diff-review-popover]')?.children ?? [])];
    return rows.map((row) => {
      const kids = [...row.children];
      const name = kids.find((k) => k.textContent.includes('.'));
      const first = kids[kids.indexOf(name) + 1];
      return { name: name?.textContent, gapPx: Math.round(first.getBoundingClientRect().left - name.getBoundingClientRect().right) };
    });
  })()`);
  console.log('GAPS', JSON.stringify(gap));

  const expanded = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync('D:/dsh-diff-review/docs/dock-expanded.png', Buffer.from(expanded.data, 'base64'));
  console.log('saved');
} finally {
  chrome.kill();
}
