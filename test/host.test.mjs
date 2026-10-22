/**
 * Host-half harness: mounts the plugin on a stub context, fakes one turn of
 * edits, and exercises the three routes.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

const routes = new Map();
const listeners = new Map();
const ctx = {
  effect(fn) { fn(); },
  on(name, handler) {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  },
  connection: {
    fetch: {
      register(route) {
        routes.set(route.path, route);
      }
    }
  }
};
apply(ctx);
assert.deepEqual([...routes.keys()].sort(), [
  '/api/diff-review.changes',
  '/api/diff-review.diff',
  '/api/diff-review.revert'
]);

const dir = await mkdtemp(join(tmpdir(), 'diff-review-'));
const file = join(dir, 'note.txt');
const fresh = join(dir, 'fresh.txt');
await writeFile(file, 'alpha\nbeta\ngamma\n');

const session = { id: 'session-1' };
const agent = { id: 'session-1', session: { header: { cwd: dir } } };
const post = listeners.get('session/event');
const emit = listeners.get('tools/post-execute');

assert.equal(typeof post, 'function');
assert.equal(typeof emit, 'function');

post(session, { type: 'turn/start', data: { turn: 7 } });

const runEdit = async (path, before, after) => {
  const decision = await emit(
    { agent, name: 'edit' },
    { value: { path, before, after } },
    async () => ({ kind: 'accept' })
  );
  assert.equal(decision.kind, 'accept');
};

await runEdit('note.txt', 'alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n');
await runEdit('fresh.txt', null, 'hello\nworld\n');

const changes = await routes.get('/api/diff-review.changes').fetch(
  new Request('http://x/api/diff-review.changes?sessionId=session-1')
);
const summary = await changes.json();
assert.equal(summary.turn, 7);
assert.equal(summary.files.length, 2);
const note = summary.files.find((f) => f.path === 'note.txt');
assert.deepEqual({ added: note.added, deleted: note.deleted, created: note.created }, { added: 1, deleted: 1, created: false });
assert.equal(summary.files.find((f) => f.path === 'fresh.txt').created, true);

const diffResponse = await routes.get('/api/diff-review.diff').fetch(
  new Request('http://x/api/diff-review.diff?sessionId=session-1&path=note.txt')
);
const diff = await diffResponse.json();
assert.equal(diff.added, 1);
assert.equal(diff.deleted, 1);
const adds = diff.rows.filter((row) => row.type === 'add').map((row) => row.text);
const dels = diff.rows.filter((row) => row.type === 'del').map((row) => row.text);
assert.deepEqual(adds, ['BETA']);
assert.deepEqual(dels, ['beta']);
assert.ok(diff.rows.some((row) => row.type === 'ctx' && row.text === 'alpha'));

// A second edit in the SAME turn measures against the turn's start, not the
// previous edit: the counter and the diff describe the whole turn.
await runEdit('note.txt', 'alpha\nBETA\ngamma\n', 'alpha\nBETA\ngamma\ndelta\n');
const again = await (
  await routes.get('/api/diff-review.changes').fetch(new Request('http://x/api/diff-review.changes?sessionId=session-1'))
).json();
const noteAgain = again.files.find((f) => f.path === 'note.txt');
assert.deepEqual({ added: noteAgain.added, deleted: noteAgain.deleted }, { added: 2, deleted: 1 });
const fullDiff = await (
  await routes.get('/api/diff-review.diff').fetch(
    new Request('http://x/api/diff-review.diff?sessionId=session-1&path=note.txt')
  )
).json();
assert.deepEqual(fullDiff.rows.filter((r) => r.type === 'add').map((r) => r.text), ['BETA', 'delta']);
assert.deepEqual(fullDiff.rows.filter((r) => r.type === 'del').map((r) => r.text), ['beta']);
assert.equal(fullDiff.afterText, 'alpha\nBETA\ngamma\ndelta\n');

// The file on disk is the newest content, so the revert still restores the
// turn's start state in one step.
await writeFile(file, 'alpha\nBETA\ngamma\ndelta\n');

// A conflict refuses the revert while the file changed after the recording.
await writeFile(file, 'drifted\n');
const conflict = await (
  await routes.get('/api/diff-review.revert').fetch(
    new Request('http://x/api/diff-review.revert', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-1', paths: ['note.txt'] })
    })
  )
).json();
assert.equal(conflict.files[0].state, 'conflict');
assert.equal(await readFile(file, 'utf8'), 'drifted\n');

// Restore the recorded after-state, then revert for real (file + created file).
await writeFile(file, 'alpha\nBETA\ngamma\ndelta\n');
const reverted = await (
  await routes.get('/api/diff-review.revert').fetch(
    new Request('http://x/api/diff-review.revert', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-1' })
    })
  )
).json();
assert.deepEqual(reverted.files.map((f) => f.state).sort(), ['deleted', 'restored']);
assert.equal(await readFile(file, 'utf8'), 'alpha\nbeta\ngamma\n');
await assert.rejects(readFile(fresh, 'utf8'));

// Paths outside the workspace are refused.
const outside = await (
  await routes.get('/api/diff-review.revert').fetch(
    new Request('http://x/api/diff-review.revert', { method: 'POST', body: JSON.stringify({ sessionId: 'session-1', paths: ['../nope.txt'] }) })
  )
).json();
assert.equal(outside.files[0].state, 'missing');

// A new turn starts a fresh badge list; older turn files leave the summary.
post(session, { type: 'turn/start', data: { turn: 8 } });
const next = await (
  await routes.get('/api/diff-review.changes').fetch(new Request('http://x/api/diff-review.changes?sessionId=session-1'))
).json();
assert.equal(next.turn, 8);
assert.equal(next.files.length, 0);

// Rejects a non-accepted post-execute decision (a blocked write is not recorded).
const blocked = await emit({ agent, name: 'write' }, { value: { path: 'x.txt', before: null, after: 'x' } }, async () => ({ kind: 'reject' }));
assert.equal(blocked.kind, 'reject');
const afterBlocked = await (
  await routes.get('/api/diff-review.changes').fetch(new Request('http://x/api/diff-review.changes?sessionId=session-1'))
).json();
assert.equal(afterBlocked.files.length, 0);

await mkdir(join(dir, 'sub'), { recursive: true });
console.log('host half OK');
