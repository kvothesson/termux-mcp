import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { runProgram } from '../src/tools.js';

const cfg = { workspace: os.tmpdir(), commandTimeoutMs: 5000, maxOutputBytes: 1000 };

test('stops a hung command on time, even with children', async () => {
  const t = Date.now();
  const r = await runProgram('sh', ['-c', 'sleep 30 & sleep 30'], cfg, { timeoutMs: 400 });
  assert.equal(r.code, 124);
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t} ms`);
});

test('does not wait for children that keep the output open', async () => {
  const t = Date.now();
  const r = await runProgram('sh', ['-c', 'sleep 30 & echo hello'], cfg);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello/);
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t} ms`);
});

test('missing program and truncated output', async () => {
  assert.equal((await runProgram('does-not-exist-xyz', [], cfg)).code, 127);
  const r = await runProgram('sh', ['-c', 'yes | head -c 100000'], cfg);
  assert.ok(r.stdout.length <= 1000);
  assert.match(r.stderr, /truncated/);
});

test('stdin input', async () => {
  const r = await runProgram('cat', [], cfg, { input: 'text' });
  assert.equal(r.stdout, 'text');
});

