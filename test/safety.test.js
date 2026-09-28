import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCommand, resolveInWorkspace, splitArgs } from '../src/safety.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
fs.symlinkSync(outside, path.join(ws, 'shortcut'));
const cfg = { workspace: ws, allowedCommands: ['ls', 'cat', 'find', 'echo', 'sort', 'uniq', 'file'] };

test('paths inside the workspace', () => {
  assert.equal(resolveInWorkspace(ws, 'a/b.txt'), path.join(fs.realpathSync(ws), 'a/b.txt'));
  assert.equal(resolveInWorkspace(ws, '.'), fs.realpathSync(ws));
  assert.equal(resolveInWorkspace(ws, '~/x'), path.join(fs.realpathSync(ws), 'x'));
});

test('blocks escapes from the workspace', () => {
  assert.throws(() => resolveInWorkspace(ws, '../x'));
  assert.throws(() => resolveInWorkspace(ws, '/etc/passwd'));
  assert.throws(() => resolveInWorkspace(ws, 'shortcut/secret.txt'), /outside/);
  assert.throws(() => resolveInWorkspace(ws, 'shortcut/new.txt'), /outside/);
  assert.throws(() => resolveInWorkspace(ws, 'a\0b'));
});

test('splits arguments without a shell', () => {
  assert.deepEqual(splitArgs('ls -la "my folder"'), ['ls', '-la', 'my folder']);
  assert.deepEqual(splitArgs("echo 'a b' c\\ d"), ['echo', 'a b', 'c d']);
  for (const bad of ['ls | sh', 'ls; rm x', 'echo $HOME', 'echo `id`', 'ls > x', 'ls && id', 'echo "unclosed']) {
    assert.throws(() => splitArgs(bad), bad);
  }
});

test('command allowlist', () => {
  assert.deepEqual(checkCommand('ls -la', cfg), { program: 'ls', args: ['-la'] });
  assert.throws(() => checkCommand('rm -rf x', cfg), /allowlist/);
  assert.throws(() => checkCommand('/bin/ls', cfg), /program name/);
  assert.throws(() => checkCommand('sh -c id', cfg), /allowlist/);
});

test('dangerous options and paths in arguments', () => {
  assert.throws(() => checkCommand('find . -exec id', cfg), /-exec/);
  assert.throws(() => checkCommand('find . -delete', cfg), /-delete/);
  assert.throws(() => checkCommand('cat /etc/passwd', cfg), /outside/);
  assert.throws(() => checkCommand('cat ../x', cfg), /outside/);
  assert.throws(() => checkCommand('ls --dir=/etc', cfg), /outside/);
  assert.doesNotThrow(() => checkCommand('cat notes/a.txt', cfg));
  assert.doesNotThrow(() => checkCommand('echo hello/bye', { ...cfg }));
  assert.doesNotThrow(() => checkCommand('cat /etc/hostname', { ...cfg, allowPathsOutsideWorkspace: true }));
});

test('write/exec options are blocked in every form', () => {
  // sort -o writes; caught whether spaced, --long, or glued to the flag.
  assert.throws(() => checkCommand('sort -o /etc/x input.txt', cfg), /not allowed/);
  assert.throws(() => checkCommand('sort --output=/etc/x input.txt', cfg), /not allowed/);
  assert.throws(() => checkCommand('sort -o/etc/x input.txt', cfg), /not allowed/);
  // sort can run any program to compress its temp files -> arbitrary execution.
  assert.throws(() => checkCommand('sort --compress-program=sh input.txt', cfg), /not allowed/);
  // file -f reads a caller-controlled list of targets.
  assert.throws(() => checkCommand('file -f/etc/passwd', cfg), /not allowed/);
  assert.throws(() => checkCommand('file -f /etc/passwd', cfg), /not allowed/);
  // uniq's second operand is an output file it writes.
  assert.throws(() => checkCommand('uniq input.txt out.txt', cfg), /single input file/);
  // The safe forms still work.
  assert.doesNotThrow(() => checkCommand('sort input.txt', cfg));
  assert.doesNotThrow(() => checkCommand('sort -r -u input.txt', cfg));
  assert.doesNotThrow(() => checkCommand('uniq input.txt', cfg));
});
