/**
 * Scroll cost of the review page after chunking: a 2000-row diff must scroll
 * with frame times near a flat 60fps budget, and off-screen chunks must carry
 * `content-visibility: auto`. Also asserts the dock lost its review/refresh
 * buttons (one pill only).
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
const PORT = 9394;
mkdirSync('D:/dsh-diff-review/.tmp', { recursive: true });

const chrome = spawn(CHROME, [
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/dsh-diff-review/.tmp/chrome-perf2',
  '--window-size=1400,900',
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
  const LINES = Array.from({ length: 2000 }, (_, i) => i % 90 === 0
    ? 'const changed' + i + ' = compute(' + i + '); // touched'
    : 'export function fn' + i + '(value: number): number { return value + ' + i + '; }');
  const ROWS = LINES.map((text, i) => ({ type: i % 90 === 0 ? 'add' : 'ctx', text, old: i + 1, new: i + 1 }));
  const rf = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (url.includes('diff-review.changes')) {
      return Promise.resolve(new Response(JSON.stringify({ turn: 1, files: [{ path: 'src/big.ts', added: 22, deleted: 0 }], added: 22, deleted: 0 }),
        { headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('diff-review.diff')) {
      return Promise.resolve(new Response(JSON.stringify({ path: 'src/big.ts', added: 22, deleted: 0, rows: ROWS,
        beforeText: LINES.join('\\n'), afterText: LINES.join('\\n') }), { headers: { 'content-type': 'application/json' } }));
    }
    return rf(input, init);
  };
`;

const SCROLL_RUN = `(async () => {
  const scroller = document.querySelector('[data-diff-review-page] pre').parentElement;
  scroller.scrollTop = 0;
  await new Promise((r) => requestAnimationFrame(r));
  const frames = [];
  let last = performance.now();
  let stop = false;
  const tick = () => { const n = performance.now(); frames.push(n - last); last = n; if (!stop) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  for (let i = 0; i < 60; i += 1) { scroller.scrollTop += 200; await new Promise((r) => requestAnimationFrame(r)); }
  stop = true;
  await new Promise((r) => setTimeout(r, 40));
  const sorted = frames.slice(1).sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return { p50: at(0.5), p95: at(0.95), worst: sorted[sorted.length - 1] };
})()`;

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
  await delay(9000);
  await evaluate(ws, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续')?.click()`);
  await delay(800);
  console.log('DOCK_BUTTONS', await evaluate(ws, `document.querySelectorAll('[data-diff-review-dock] > div > button').length`));
  await evaluate(ws, `(async () => {
    document.querySelector('[data-diff-review-dock] button')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('[data-diff-review-popover] button')?.click();
  })()`);
  await delay(3500);

  const shape = await evaluate(ws, `(() => {
    const pre = document.querySelector('[data-diff-review-page] pre');
    const chunks = [...pre.children];
    const cv = chunks.map((c) => getComputedStyle(c).contentVisibility);
    return {
      chunks: chunks.length,
      rows: pre.querySelectorAll('div > div').length,
      allContained: cv.every((value) => value === 'auto'),
      chunkCv: cv[0],
      firstChunkHeight: Math.round(chunks[0].getBoundingClientRect().height)
    };
  })()`);
  console.log('SHAPE', JSON.stringify(shape));

  await evaluate(ws, SCROLL_RUN);
  const runs = [];
  for (let round = 0; round < 3; round += 1) runs.push(await evaluate(ws, SCROLL_RUN));
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log('PERF', JSON.stringify({
    p50: Math.round(median(runs.map((r) => r.p50)) * 10) / 10,
    p95: Math.round(median(runs.map((r) => r.p95)) * 10) / 10,
    worst: Math.round(Math.max(...runs.map((r) => r.worst)) * 10) / 10
  }));

  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync('D:/dsh-diff-review/.tmp/perf.png', Buffer.from(shot.data, 'base64'));
} finally {
  chrome.kill();
}
