/**
 * Popover behavior: hovering the dock opens the list ABOVE the pills with a
 * fade/rise, leaving closes it, clicking pins it, and it never pushes the
 * composer down. Stubbed routes so the dock is always present.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe';
const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
const PORT = 9380;
mkdirSync('D:/dsh-diff-review/.tmp', { recursive: true });

const chrome = spawn(CHROME, [
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/dsh-diff-review/.tmp/chrome-pop',
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

const center = async (ws, selector) => evaluate(ws, `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()`);

async function moveTo(ws, point) {
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 });
}

async function clickAt(ws, point) {
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

const FIXTURE = `
  const FILES = [
    { path: 'lib/widgets/counter.dart', added: 3, deleted: 2 },
    { path: 'plugin/client.js', added: 12, deleted: 3 }
  ];
  const rf = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (url.includes('diff-review.changes')) {
      return Promise.resolve(new Response(JSON.stringify({ turn: 1, files: FILES, added: 15, deleted: 5 }),
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
  await delay(900);

  const geometry = () => evaluate(ws, `(() => {
    const dock = document.querySelector('[data-diff-review-dock]');
    const pop = document.querySelector('[data-diff-review-popover]');
    const pill = dock?.querySelector('button');
    const composer = document.querySelector('[role="textbox"]');
    if (dock === null || pill === null || composer === null) return { ready: false };
    const p = pill.getBoundingClientRect();
    const c = composer.getBoundingClientRect();
    const out = {
      ready: true,
      dockTop: Math.round(dock.getBoundingClientRect().top),
      pillTop: Math.round(p.top),
      composerTop: Math.round(c.top),
      popover: null
    };
    if (pop !== null) {
      const r = pop.getBoundingClientRect();
      const style = getComputedStyle(pop);
      out.popover = {
        state: pop.getAttribute('data-state'),
        opacity: Number(style.opacity).toFixed(2),
        visibility: style.visibility,
        bottom: Math.round(r.bottom),
        top: Math.round(r.top),
        abovePill: r.bottom <= p.top + 1,
        transform: style.transform
      };
    }
    return out;
  })()`);

  console.log('IDLE', JSON.stringify(await geometry()));

  // Hover the pill: the popover must appear above it.
  const pill = await center(ws, '[data-diff-review-dock] button');
  await moveTo(ws, pill);
  await delay(400);
  const hovered = await geometry();
  console.log('HOVER', JSON.stringify(hovered));

  const midFade = await evaluate(ws, `(() => {
    const pop = document.querySelector('[data-diff-review-popover]');
    return pop === null ? null : { opacity: getComputedStyle(pop).opacity, transition: getComputedStyle(pop).transitionProperty };
  })()`);
  console.log('TRANSITION', JSON.stringify(midFade));

  const composerStill = hovered.composerTop;
  await delay(300);

  // Move up through the gap into the popover body: the bridge must keep it open.
  const body = await evaluate(ws, `(() => {
    const pop = document.querySelector('[data-diff-review-popover]');
    const rect = pop.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, bottom: rect.bottom };
  })()`);
  await moveTo(ws, { x: body.x, y: body.bottom + 2 });
  await delay(80);
  await moveTo(ws, { x: body.x, y: body.y });
  await delay(300);
  console.log('IN_BODY', JSON.stringify((await geometry()).popover));

  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync('D:/dsh-diff-review/.tmp/pop-hover.png', Buffer.from(shot.data, 'base64'));

  // Leave from the body: it fades out and unmounts.
  await moveTo(ws, { x: body.x, y: 80 });
  await delay(120);
  const leaving = await geometry();
  console.log('LEAVING', JSON.stringify(leaving.popover));
  await delay(400);
  console.log('LEFT', JSON.stringify(await geometry()));

  // Click no longer pins: clicking the pill and then moving the pointer away
  // must close the list again.
  const pillAgain = await center(ws, '[data-diff-review-dock] button');
  await clickAt(ws, pillAgain);
  await moveTo(ws, { x: 20, y: 400 });
  await delay(500);
  console.log('AFTER_CLICK_AWAY', JSON.stringify((await geometry()).popover));

  // Caret: right when closed, pointing up while the list is open.
  console.log('CARET_CLOSED', await evaluate(ws, `document.querySelector('[data-diff-review-dock] button').children[0].textContent`));
  await moveTo(ws, pillAgain);
  await delay(350);
  console.log('CARET_OPEN', await evaluate(ws, `document.querySelector('[data-diff-review-dock] button').children[0].textContent`));
  console.log('OPEN_WHILE_HOVER', (await geometry()).popover !== null);
  await moveTo(ws, { x: 20, y: 400 });
  await delay(300);

  console.log('COMPOSER_STABLE', composerStill === (await geometry()).composerTop);
} finally {
  chrome.kill();
}
