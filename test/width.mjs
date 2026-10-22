/**
 * Expanded-list width check: the box must hug its longest row (no stretched
 * right side), and the name→counts gap must stay small. Also screenshots both
 * a short-name and a long-name fixture.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
const PORT = 9354;
const LONG = process.env.LONG === '1';

const FILES = process.env.ONE === '1'
  ? [{ path: 'a.dart', added: 12, deleted: 3 }]
  : LONG
    ? [
      { path: 'lib/features/counter/domain/counter_repository_impl.dart', added: 12, deleted: 3 },
      { path: 'lib/widgets/counter.dart', added: 3, deleted: 2 }
    ]
    : [
      { path: 'a.dart', added: 1, deleted: 0 },
      { path: 'b.js', added: 2, deleted: 1 }
    ];

const WIN = process.env.WIN ?? '1500,950';

const chrome = spawn(CHROME, [
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/dsh-diff-review/.tmp/chrome-width',
  `--window-size=${WIN}`,
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
  const FILES = ${JSON.stringify(FILES)};
  const rf = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (url.includes('diff-review.changes')) {
      return Promise.resolve(new Response(JSON.stringify({ turn: 1, files: FILES, added: 30, deleted: 6 }),
        { headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('diff-review.')) {
      return Promise.resolve(new Response(JSON.stringify({ rows: [], beforeText: '', afterText: '' }),
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
  await delay(800);
  await evaluate(ws, `document.querySelector('[data-diff-review-dock] button')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
  await delay(500);

  const metrics = await evaluate(ws, `(() => {
    const dock = document.querySelector('[data-diff-review-dock]');
    const list = document.querySelector('[data-diff-review-popover]');
    if (list == null) return { list: false };
    const rows = [...list.children];
    const listRect = list.getBoundingClientRect();
    const pill = dock.querySelector('button').getBoundingClientRect();
    const widestRow = Math.max(...rows.map((r) => r.getBoundingClientRect().width));
    const gaps = rows.map((row) => {
      const kids = [...row.children];
      const name = kids.find((k) => k.textContent.includes('.'));
      const next = kids[kids.indexOf(name) + 1];
      return next === undefined ? null : Math.round(next.getBoundingClientRect().left - name.getBoundingClientRect().right);
    });
    const lastRowRight = Math.max(...rows.map((r) => r.getBoundingClientRect().right));
    return {
      listWidth: Math.round(listRect.width),
      listRightSlack: Math.round(listRect.right - lastRowRight),
      widestRow: Math.round(widestRow),
      pillWidth: Math.round(pill.width),
      widerThanPill: listRect.width > pill.width + 8,
      gaps
    };
  })()`);
  console.log('METRICS', JSON.stringify(metrics, null, 1));

  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync(LONG ? 'D:/dsh-diff-review/.tmp/width-long.png' : 'D:/dsh-diff-review/docs/dock-expanded.png', Buffer.from(shot.data, 'base64'));
  console.log('saved');
} finally {
  chrome.kill();
}
