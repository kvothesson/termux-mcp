import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCommand, resolveInWorkspace, splitArgs } from '../src/safety.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
fs.writeFileSync(path.join(outside, 'secreto.txt'), 'x');
fs.symlinkSync(outside, path.join(ws, 'atajo'));
const cfg = { workspace: ws, allowedCommands: ['ls', 'cat', 'find', 'echo'] };

test('rutas dentro de la carpeta de trabajo', () => {
  assert.equal(resolveInWorkspace(ws, 'a/b.txt'), path.join(fs.realpathSync(ws), 'a/b.txt'));
  assert.equal(resolveInWorkspace(ws, '.'), fs.realpathSync(ws));
  assert.equal(resolveInWorkspace(ws, '~/x'), path.join(fs.realpathSync(ws), 'x'));
});

test('bloquea escapes de la carpeta de trabajo', () => {
  assert.throws(() => resolveInWorkspace(ws, '../x'));
  assert.throws(() => resolveInWorkspace(ws, '/etc/passwd'));
  assert.throws(() => resolveInWorkspace(ws, 'atajo/secreto.txt'), /fuera/);
  assert.throws(() => resolveInWorkspace(ws, 'atajo/nuevo.txt'), /fuera/);
  assert.throws(() => resolveInWorkspace(ws, 'a\0b'));
});

test('divide argumentos sin shell', () => {
  assert.deepEqual(splitArgs('ls -la "mi carpeta"'), ['ls', '-la', 'mi carpeta']);
  assert.deepEqual(splitArgs("echo 'a b' c\\ d"), ['echo', 'a b', 'c d']);
  for (const bad of ['ls | sh', 'ls; rm x', 'echo $HOME', 'echo `id`', 'ls > x', 'ls && id', 'echo "abierto']) {
    assert.throws(() => splitArgs(bad), bad);
  }
});

test('lista blanca de comandos', () => {
  assert.deepEqual(checkCommand('ls -la', cfg), { program: 'ls', args: ['-la'] });
  assert.throws(() => checkCommand('rm -rf x', cfg), /lista blanca/);
  assert.throws(() => checkCommand('/bin/ls', cfg), /ruta/);
  assert.throws(() => checkCommand('sh -c id', cfg), /lista blanca/);
});

test('opciones peligrosas y rutas en argumentos', () => {
  assert.throws(() => checkCommand('find . -exec id', cfg), /-exec/);
  assert.throws(() => checkCommand('find . -delete', cfg), /-delete/);
  assert.throws(() => checkCommand('cat /etc/passwd', cfg), /fuera/);
  assert.throws(() => checkCommand('cat ../x', cfg), /fuera/);
  assert.throws(() => checkCommand('ls --dir=/etc', cfg), /fuera/);
  assert.doesNotThrow(() => checkCommand('cat notas/a.txt', cfg));
  assert.doesNotThrow(() => checkCommand('echo hola/chau', { ...cfg }));
  assert.doesNotThrow(() => checkCommand('cat /etc/hostname', { ...cfg, allowPathsOutsideWorkspace: true }));
});
