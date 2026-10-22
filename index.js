/**
 * dsh-diff-review — Host half.
 *
 * Records the file mutations the Agent makes in each chat (edit/write, including
 * Code-Mode sub-dispatches, recognised by the tool result shape rather than by
 * tool name), groups them by turn, and serves three authenticated routes:
 *
 *   GET  /api/diff-review.changes?sessionId=…   the newest turn's changed files
 *   GET  /api/diff-review.diff?sessionId=…&path=…  one file's line diff
 *   POST /api/diff-review.revert                put the recorded before-state back
 *
 * The browser half renders a "N 个文件已更改" dock above the composer and the
 * review page in the right sidebar. Read-only apart from the explicit revert.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const name = 'dsh-diff-review';
export const inject = ['connection'];

const CHANGES_PATH = '/api/diff-review.changes';
const DIFF_PATH = '/api/diff-review.diff';
const REVERT_PATH = '/api/diff-review.revert';

/** Line cap per side of one comparison: beyond it the diff is truncated. */
const MAX_DIFF_LINES = 4000;
/** Retained turns per chat; older turns fall off. */
const MAX_TURNS = 12;

/** @typedef {{ before: string | null, after: string, turn: number, at: number, added: number, deleted: number }} FileChange */

/** One chat's ledger: the working directory and the changes grouped by turn. */
class Ledger {
  /** @type {string | undefined} */
  cwd;
  /** @type {number} */
  turn = 0;
  /** @type {Map<string, FileChange>} */
  files = new Map();

  /** @param {string} cwd @param {number} turn @param {string} path @param {string | null} before @param {string} after */
  record(cwd, turn, path, before, after) {
    this.cwd = cwd;
    const previous = this.files.get(path);
    // A later change in the same turn keeps the first before-state AND measures
    // against it: both the diff and the +/− counters must describe the whole
    // turn (turn start → newest content), not just the last edit of many.
    if (previous !== undefined && previous.turn === turn) {
      previous.after = after;
      previous.at = Date.now();
      const counts = countLines(previous.before, after);
      previous.added = counts.added;
      previous.deleted = counts.deleted;
      return;
    }
    this.files.set(path, { before, after, turn, at: Date.now(), ...countLines(before, after) });
  }

  /** Forget turns older than the retention window. */
  prune() {
    let newest = 0;
    for (const change of this.files.values()) newest = Math.max(newest, change.turn);
    const floor = newest - MAX_TURNS;
    for (const [path, change] of this.files) if (change.turn <= floor) this.files.delete(path);
  }

  /**
   * The turn the badge speaks for: the open turn, or — before any turn has
   * started — the newest turn a change was recorded under.
   */
  activeTurn() {
    if (this.turn > 0) return this.turn;
    let newest = 0;
    for (const change of this.files.values()) newest = Math.max(newest, change.turn);
    return newest;
  }

  /** The active turn's files, newest first. */
  current() {
    const turn = this.activeTurn();
    const files = [];
    for (const [path, change] of this.files) {
      if (change.turn !== turn) continue;
      files.push({ path, added: change.added, deleted: change.deleted, created: change.before === null, at: change.at });
    }
    files.sort((a, b) => b.at - a.at);
    return { turn, files };
  }
}

/** @type {Map<string, Ledger>} */
const ledgers = new Map();

/** @param {string} sessionId */
function ledgerOf(sessionId) {
  let ledger = ledgers.get(sessionId);
  if (ledger === undefined) {
    ledger = new Ledger();
    ledgers.set(sessionId, ledger);
  }
  return ledger;
}

/** Added/deleted line counts between two texts. */
function countLines(before, after) {
  const previous = before === null ? [] : before.split('\n');
  const { added, deleted } = diffRows(previous, after.split('\n'));
  return { added, deleted };
}

/**
 * Line diff of two texts: a longest-common-subsequence walk that emits context,
 * deletions and additions, folded into hunks with three lines of context.
 * @param {string[]} before
 * @param {string[]} after
 * @returns {{ rows: Array<{ type: 'ctx' | 'add' | 'del', text: string, old?: number, new?: number }>, added: number, deleted: number, truncated: boolean }}
 */
function diffRows(before, after) {
  const truncated = before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES;
  const a = before.slice(0, MAX_DIFF_LINES);
  const b = after.slice(0, MAX_DIFF_LINES);
  // Trim the common prefix and suffix so the DP table stays small on big files.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const table = lcsTable(midA, midB);
  const rows = [];
  for (let i = 0; i < head; i += 1) rows.push({ type: 'ctx', text: a[i], old: i + 1, new: i + 1 });
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      rows.push({ type: 'ctx', text: midA[i], old: head + i + 1, new: head + j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ type: 'del', text: midA[i], old: head + i + 1 });
      i += 1;
    } else {
      rows.push({ type: 'add', text: midB[j], new: head + j + 1 });
      j += 1;
    }
  }
  while (i < midA.length) {
    rows.push({ type: 'del', text: midA[i], old: head + i + 1 });
    i += 1;
  }
  while (j < midB.length) {
    rows.push({ type: 'add', text: midB[j], new: head + j + 1 });
    j += 1;
  }
  for (let k = 0; k < tail; k += 1) {
    rows.push({
      type: 'ctx',
      text: a[a.length - tail + k],
      old: a.length - tail + k + 1,
      new: b.length - tail + k + 1
    });
  }
  let added = 0;
  let deleted = 0;
  for (const row of rows) {
    if (row.type === 'add') added += 1;
    else if (row.type === 'del') deleted += 1;
  }
  return { rows: foldHunks(rows), added, deleted, truncated };
}

/** LCS length table; the (m+1)×(n+1) suffix table drives the walk above. */
function lcsTable(a, b) {
  const table = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i += 1) table[i] = new Uint32Array(b.length + 1);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** Keep three context lines around every change and mark the gaps as hunk breaks. */
function foldHunks(rows) {
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].type === 'ctx') continue;
    for (let k = Math.max(0, i - 3); k <= Math.min(rows.length - 1, i + 3); k += 1) keep[k] = true;
  }
  const out = [];
  let gap = false;
  for (let i = 0; i < rows.length; i += 1) {
    if (keep[i]) {
      if (gap) out.push({ type: 'gap', text: '⋯' });
      gap = false;
      out.push(rows[i]);
    } else {
      gap = true;
    }
  }
  return out;
}

/** JSON response helper. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

const isText = (value) => typeof value === 'string' && value.length > 0;

/** Resolve a recorded path inside the chat's working directory. */
function absoluteOf(ledger, path) {
  if (ledger.cwd === undefined) throw new Error('session has no workspace directory');
  const root = resolve(ledger.cwd);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const inside = relative(root, target);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('path is outside the workspace');
  return target;
}

/** Path as recorded: bare and slash-separated inside the workspace, absolute outside it. */
function displayPathOf(cwd, path) {
  const root = resolve(cwd);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const relativePath = relative(root, target);
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) return target;
  return relativePath.split('\\').join('/');
}

/**
 * Register the recorder and the routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const off = ctx.on('tools/post-execute', async (rawExec, rawResult, next) => {
      const decision = await next();
      if (decision.kind !== 'accept') return decision;
      const exec = /** @type {any} */ (rawExec);
      const value = /** @type {any} */ (rawResult)?.value;
      if (exec?.agent === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return decision;
      if (typeof value.path !== 'string' || typeof value.after !== 'string') return decision;
      if (value.before !== null && typeof value.before !== 'string') return decision;
      const sessionId = String(exec.agent.id);
      const cwd = exec.agent.session?.header?.cwd;
      if (!isText(cwd)) return decision;
      const ledger = ledgerOf(sessionId);
      ledger.record(cwd, ledger.turn, displayPathOf(cwd, value.path), value.before ?? null, value.after);
      ledger.prune();
      return decision;
    });
    return () => off();
  }, 'dsh-diff-review: mutation recorder');

  // Every turn boundary moves the ledger's turn counter, so the badge counts the
  // files the newest turn touched rather than the whole chat.
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/start') return;
      const ledger = ledgerOf(String(session.id));
      ledger.turn = event.data.turn;
    });
    return () => off();
  }, 'dsh-diff-review: turn tracking');

  ctx.connection.fetch.register({
    path: CHANGES_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const sessionId = new URL(request.url).searchParams.get('sessionId');
      if (!isText(sessionId)) return json({ error: 'bad request' }, 400);
      const ledger = ledgers.get(sessionId);
      if (ledger === undefined) return json({ turn: 0, files: [] });
      const { turn, files } = ledger.current();
      const added = files.reduce((sum, file) => sum + file.added, 0);
      const deleted = files.reduce((sum, file) => sum + file.deleted, 0);
      return json({ turn, files, added, deleted });
    }
  });

  ctx.connection.fetch.register({
    path: DIFF_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const query = new URL(request.url).searchParams;
      const sessionId = query.get('sessionId');
      const path = query.get('path');
      if (!isText(sessionId) || !isText(path)) return json({ error: 'bad request' }, 400);
      const change = ledgers.get(sessionId)?.files.get(path);
      if (change === undefined) return json({ error: 'not found' }, 404);
      const beforeText = change.before ?? '';
      const afterText = change.after;
      // Cap both sides on line count before diffing, so a huge write cannot
      // produce a table the browser chokes on.
      const beforeLines = beforeText.split('\n');
      const afterLines = afterText.split('\n');
      const truncated = beforeLines.length > MAX_DIFF_LINES || afterLines.length > MAX_DIFF_LINES;
      const before = beforeLines.slice(0, MAX_DIFF_LINES);
      const after = afterLines.slice(0, MAX_DIFF_LINES);
      const result = diffRows(before, after);
      return json({
        path,
        created: change.before === null,
        added: result.added,
        deleted: result.deleted,
        truncated,
        rows: result.rows,
        // The two full sides, so the browser can highlight whole-file context
        // (block comments, template literals) instead of isolated lines.
        beforeText: before.join('\n'),
        afterText: after.join('\n')
      });
    }
  });

  ctx.connection.fetch.register({
    path: REVERT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad request' }, 400);
      }
      const sessionId = body?.sessionId;
      if (!isText(sessionId)) return json({ error: 'bad request' }, 400);
      const ledger = ledgers.get(sessionId);
      if (ledger === undefined) return json({ files: [] });
      const wanted = Array.isArray(body?.paths) ? body.paths.filter(isText) : [...ledger.files.keys()];
      const results = [];
      for (const path of wanted) {
        const change = ledger.files.get(path);
        if (change === undefined) {
          results.push({ path, state: 'missing' });
          continue;
        }
        try {
          const target = absoluteOf(ledger, path);
          if (change.before === null) {
            await rm(target, { force: true });
            ledger.files.delete(path);
            results.push({ path, state: 'deleted' });
            continue;
          }
          // Refuse a blind overwrite: the file must still hold what was recorded.
          const current = await readFile(target, 'utf8').catch(() => undefined);
          if (current !== change.after) {
            results.push({ path, state: 'conflict' });
            continue;
          }
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, change.before);
          ledger.files.delete(path);
          results.push({ path, state: 'restored' });
        } catch (error) {
          results.push({ path, state: 'error', reason: String(error?.message ?? error) });
        }
      }
      return json({ files: results });
    }
  });
}
