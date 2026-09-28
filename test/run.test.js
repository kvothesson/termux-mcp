import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { runProgram } from '../src/tools.js';

const cfg = { workspace: os.tmpdir(), commandTimeoutMs: 5000, maxOutputBytes: 1000 };

test('corta un comando colgado a tiempo, aunque tenga hijos', async () => {
  const t = Date.now();
  const r = await runProgram('sh', ['-c', 'sleep 30 & sleep 30'], cfg, { timeoutMs: 400 });
  assert.equal(r.code, 124);
  assert.ok(Date.now() - t < 2000, `tardó ${Date.now() - t} ms`);
});

test('no espera a hijos que quedan con la salida abierta', async () => {
  const t = Date.now();
  const r = await runProgram('sh', ['-c', 'sleep 30 & echo hola'], cfg);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hola/);
  assert.ok(Date.now() - t < 2000, `tardó ${Date.now() - t} ms`);
});

test('programa inexistente y salida recortada', async () => {
  assert.equal((await runProgram('no-existe-xyz', [], cfg)).code, 127);
  const r = await runProgram('sh', ['-c', 'yes | head -c 100000'], cfg);
  assert.ok(r.stdout.length <= 1000);
  assert.match(r.stderr, /recortada/);
});

test('entrada por stdin', async () => {
  const r = await runProgram('cat', [], cfg, { input: 'texto' });
  assert.equal(r.stdout, 'texto');
});
