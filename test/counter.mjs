/**
 * Counter behavior: counts right-aligned, names left-aligned, and a bump
 * animation when a number changes (keyframes attached, remount key changes).
 * Stub route whose numbers can be changed from the test.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
const PORT = 9355;

const chrome = spawn(CHROME, [
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/dsh-diff-review/.tmp/chrome-bump',
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
  // Counts grow on a timer so the dock must bump without a full reload.
  window.__counts = { a: 1, b: 2, c: 9, d: 0 };
  const row = (path, key) => ({ path, added: window.__counts[key], deleted: key === 'b' ? 1 : 0 });
  const rf = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (url.includes('diff-review.changes')) {
      const files = [row('lib/widgets/counter.dart', 'a'), row('plugin/client.js', 'b'), row('docs/notes.md', 'c')];
      return Promise.resolve(new Response(JSON.stringify({ turn: 1, files, added: 12, deleted: 1 }),
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
  // Hover is the only trigger now: synthesize the pointer enter.
  await evaluate(ws, `document.querySelector('[data-diff-review-dock] button')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
  await delay(500);

  const layout = await evaluate(ws, `(() => {
    const list = document.querySelector('[data-diff-review-popover]');
    if (list == null) return { list: false };
    const rows = [...list.children];
    const names = rows.map((r) => r.children[0].getBoundingClientRect());
    const adds = rows.map((r) => r.children[1].getBoundingClientRect());
    const dels = rows.map((r) => r.children[2].getBoundingClientRect());
    const listRect = list.getBoundingClientRect();
    const rightEdges = adds.map((r) => Math.round(r.right));
    const delRightEdges = dels.map((r) => Math.round(r.right));
    return {
      listWidth: Math.round(listRect.width),
      listRightSlack: Math.round(listRect.right - Math.max(...dels.map((r) => r.right))),
      nameLefts: names.map((r) => Math.round(r.left)),
      addRightEdges: rightEdges,
      addRightAligned: new Set(rightEdges).size === 1,
      delRightAligned: new Set(delRightEdges).size === 1,
      delRightEdges
    };
  })()`);
  console.log('LAYOUT', JSON.stringify(layout, null, 1));

  // Bump: change one file's numbers, poll while the 2s refresh picks it up.
  const before = await evaluate(ws, `(() => {
    const dock = document.querySelector('[data-diff-review-dock]');
    return [...dock.querySelectorAll('.dsh-diff-review-bump')].map((n) => ({ text: n.textContent, fresh: n.hasAttribute('data-fresh') }));
  })()`);
  console.log('BEFORE', JSON.stringify(before));
  let seen = null;
  await evaluate(ws, `window.__counts.a = 7`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(400);
    seen = await evaluate(ws, `(() => {
      const dock = document.querySelector('[data-diff-review-dock]');
      const nodes = [...dock.querySelectorAll('.dsh-diff-review-bump')];
      const animating = nodes.filter((n) => n.getAnimations().some((a) => a.playState === 'running'));
      return {
        texts: nodes.map((n) => n.textContent),
        fresh: nodes.map((n) => n.hasAttribute('data-fresh')),
        animating: animating.length,
        animationNames: animating.map((n) => n.getAnimations()[0]?.animationName ?? '')
      };
    })()`);
    if (seen.texts.some((t) => t === '+7')) break;
  }
  console.log('AFTER', JSON.stringify(seen));

  const totalBump = await evaluate(ws, `(() => {
    const dock = document.querySelector('[data-diff-review-dock]');
    const totals = [...dock.firstElementChild.querySelectorAll('.dsh-diff-review-bump')].map((n) => n.textContent);
    return totals;
  })()`);
  console.log('TOTALS_BUMP_NODES', JSON.stringify(totalBump));

  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync('D:/dsh-diff-review/docs/dock-expanded.png', Buffer.from(shot.data, 'base64'));
  console.log('saved');
} finally {
  chrome.kill();
}
