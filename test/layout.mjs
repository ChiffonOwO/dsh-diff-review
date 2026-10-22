/**
 * Layout check: the dock must sit centered above the composer (and above it,
 * not in any sidebar), with stub route data. Also grabs a screenshot.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
const PORT = 9338;
mkdirSync('D:/dsh-diff-review/.tmp/shots', { recursive: true });

const chrome = spawn(CHROME, [
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/dsh-diff-review/.tmp/chrome-layout',
  '--window-size=860,700',
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

const FIXTURE = `
  const FILES = [
    { path: 'plugin/client.js', added: 12, deleted: 3, created: false },
    { path: 'plugin/index.js', added: 40, deleted: 0, created: false }
  ];
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (url.includes('diff-review.changes')) {
      return Promise.resolve(new Response(JSON.stringify({ turn: 3, files: FILES, added: 52, deleted: 3 }),
        { headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('diff-review.')) {
      return Promise.resolve(new Response(JSON.stringify({ path: 'x', rows: [], added: 0, deleted: 0 }),
        { headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
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
      return;
    }
    if (frame.method === 'Runtime.exceptionThrown') logs.push(frame.params.exceptionDetails.exception?.description ?? frame.params.exceptionDetails.text);
  });
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await send(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: FIXTURE });
  await send(ws, 'Page.navigate', { url: `${BASE}/?token=${TOKEN}` });
  await delay(9000);

  const geometry = await evaluate(ws, `(() => {
    const dock = document.querySelector('[data-diff-review-dock]');
    const bar = document.querySelector('[role="textbox"]')?.closest('[data-conversation-region="composer"]')
      ?? document.querySelector('[role="textbox"]')?.closest('[data-composer-seat], div');
    const box = document.querySelector('[role="textbox"]');
    if (dock === null) return { dock: null };
    const d = dock.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const row = dock.firstElementChild.getBoundingClientRect();
    return {
      dockTop: Math.round(d.top),
      dockBottom: Math.round(d.bottom),
      dockCenterX: Math.round(d.left + d.width / 2),
      rowCenterX: Math.round(row.left + row.width / 2),
      composerCenterX: Math.round(b.left + b.width / 2),
      composerTop: Math.round(b.top),
      viewportCenterX: Math.round(innerWidth / 2),
      aboveComposer: d.bottom <= b.top + 2,
      inSidebar: dock.closest('[data-sidebar-right]') !== null
        || (dock.closest('[class*="SidebarRight"]') !== null),
      dockWidth: Math.round(d.width),
      rowWidth: Math.round(row.width)
    };
  })()`);
  console.log('GEOMETRY', JSON.stringify(geometry, null, 1));

  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync('D:/dsh-diff-review/.tmp/shots/dock.png', Buffer.from(shot.data, 'base64'));
  console.log('SHOT saved');
  console.log('EXCEPTIONS', JSON.stringify(logs).slice(0, 400));
} finally {
  chrome.kill();
}
