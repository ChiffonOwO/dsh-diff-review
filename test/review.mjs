/**
 * Review-page check: tab strip on top, full-width diff under it, syntax colors
 * on a .dart/.cpp row. Stubbed routes; real rendering.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
const PORT = 9341;
const OUT = 'D:/dsh-diff-review/docs/review.png';
mkdirSync('D:/dsh-diff-review/docs', { recursive: true });

const chrome = spawn(CHROME, [
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/dsh-diff-review/.tmp/chrome-review',
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

const BEFORE = `class Counter {
  int count = 0;
  // keep the widget alive
  bool alive = true;
  void bump() { count++; }
}
`;
const AFTER = `class Counter {
  int count = 0;
  // keep the widget alive across rebuilds
  bool alive = true;
  final label = 'count: 0';
  void bump() { count += 2; }
}
`;

const FIXTURE = `
  const FILES = [
    { path: 'lib/widgets/counter.dart', added: 3, deleted: 2, created: false },
    { path: 'plugin/client.js', added: 12, deleted: 3, created: false },
    { path: 'docs/notes.md', added: 5, deleted: 0, created: true }
  ];
  const ROWS = [
    { type: 'ctx', text: 'class Counter {', old: 1, new: 1 },
    { type: 'ctx', text: '  int count = 0;', old: 2, new: 2 },
    { type: 'del', text: '  // keep the widget alive', old: 3 },
    { type: 'add', text: '  // keep the widget alive across rebuilds', new: 3 },
    { type: 'ctx', text: '  bool alive = true;', old: 4, new: 4 },
    { type: 'add', text: "  final label = 'count: 0';", new: 5 },
    { type: 'del', text: '  void bump() { count++; }', old: 5 },
    { type: 'add', text: '  void bump() { count += 2; }', new: 6 },
    { type: 'ctx', text: '}', old: 6, new: 7 }
  ];
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (url.includes('diff-review.changes')) {
      return Promise.resolve(new Response(JSON.stringify({ turn: 3, files: FILES, added: 20, deleted: 5 }),
        { headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('diff-review.diff')) {
      return Promise.resolve(new Response(JSON.stringify({ path: 'counter.dart', rows: ROWS, added: 3, deleted: 2,
        beforeText: ${JSON.stringify(BEFORE)}, afterText: ${JSON.stringify(AFTER)} }),
        { headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('diff-review.revert')) {
      return Promise.resolve(new Response(JSON.stringify({ files: [] }), { headers: { 'content-type': 'application/json' } }));
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
  await evaluate(ws, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续')?.click()`);
  await delay(800);
  // No "review" button any more: open the popover, then click a file row.
  await evaluate(ws, `(async () => {
    const pill = document.querySelector('[data-diff-review-dock] button');
    pill?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    document.querySelector('[data-diff-review-popover] button')?.click();
    return document.querySelector('[data-diff-review-popover]') !== null;
  })()`);
  await delay(3000);

  const layout = await evaluate(ws, `(() => {
    const page = document.querySelector('[data-diff-review-page]');
    const tabs = document.querySelector('[data-diff-review-tabs]');
    const diff = page?.querySelector('pre');
    if (page === null || tabs === null || diff === null) return { page: !!page, tabs: !!tabs, diff: !!diff };
    const p = page.getBoundingClientRect();
    const t = tabs.getBoundingClientRect();
    const d = diff.getBoundingClientRect();
    const colored = [...diff.querySelectorAll('span[style*="color"]')].map((s) => s.style.color);
    const rowTexts = [...diff.children].map((c) => c.textContent);
    return {
      tabsOnTop: t.bottom <= d.top + 2,
      tabsFullWidthShare: Math.round((t.width / p.width) * 100),
      diffWidthShare: Math.round((d.width / p.width) * 100),
      tabCount: tabs.querySelectorAll('[role="tab"]').length,
      coloredRuns: colored.length,
      distinctColors: [...new Set(colored)].length,
      sampleColors: [...new Set(colored)].slice(0, 5),
      firstRows: rowTexts.slice(0, 4)
    };
  })()`);
  console.log('LAYOUT', JSON.stringify(layout, null, 1));

  // Tab switching: click the JS tab and see the strip's aria-selected move.
  const switched = await evaluate(ws, `(() => {
    const tabs = [...document.querySelectorAll('[data-diff-review-tabs] [role="tab"]')];
    if (tabs.length < 2) return 'too few tabs';
    tabs[1].click();
    return 'clicked second';
  })()`);
  await delay(900);
  console.log('SWITCH', switched, await evaluate(ws, `document.querySelectorAll('[data-diff-review-tabs] [aria-selected="true"]').length`));

  await evaluate(ws, `document.querySelectorAll('[data-diff-review-tabs] [role="tab"]')[0].click()`);
  await delay(900);
  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('saved', OUT);
  console.log('EXCEPTIONS', JSON.stringify(logs).slice(0, 300));
} finally {
  chrome.kill();
}
