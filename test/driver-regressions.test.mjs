import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSwayConfigFile, createManagedDriver } from '../src/runtime/drivers.mjs';

const ceiling = 1024 * 1024;
const hasCode = code => error => error?.code === code;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function sourceFile(t, content = 'font monospace 10\n') {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'dgd-')));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^dgd-[a-zA-Z0-9]+$/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'sway.config');
  await fs.writeFile(file, content);
  return { root, file };
}

function trackOpen(t, decorate) {
  const actualOpen = fs.open.bind(fs), opened = [];
  t.mock.method(fs, 'open', async (...args) => {
    const raw = await actualOpen(...args), state = { raw, args, reads: 0, bytes: 0, closes: 0 };
    const handle = {
      stat: (...parameters) => raw.stat(...parameters),
      read: async (...parameters) => { state.reads++; const result = await raw.read(...parameters); state.bytes += result.bytesRead; return result; },
      close: () => { state.closes++; return (state.closing = raw.close()); },
    };
    opened.push(state);
    if (decorate) await decorate(handle, state);
    return handle;
  });
  return opened;
}

async function assertClosed(state) {
  assert.equal(state.closes, 1);
  await state.closing;
  assert.equal(state.raw.fd, -1);
}

test('Sway file source reads a small UTF-8 regular file and closes it', async t => {
  const text = 'font monospace 10\n# 字体\n', { file } = await sourceFile(t, text), opened = trackOpen(t);
  assert.equal(await readSwayConfigFile(file), text);
  assert.equal(opened.length, 1); await assertClosed(opened[0]);
});

test('Sway file source accepts exactly 1 MiB and checks EOF without exceeding one sentinel byte', async t => {
  const { file } = await sourceFile(t, Buffer.alloc(ceiling, 35)), opened = trackOpen(t);
  assert.equal(Buffer.byteLength(await readSwayConfigFile(file)), ceiling);
  assert.equal(opened[0].bytes, ceiling); await assertClosed(opened[0]);
});

test('Sway file source rejects an oversized regular file before reading any bytes', async t => {
  const { file } = await sourceFile(t, Buffer.alloc(ceiling + 1)), opened = trackOpen(t);
  await assert.rejects(readSwayConfigFile(file), hasCode('INVALID_CONFIG'));
  assert.equal(opened[0].reads, 0); await assertClosed(opened[0]);
});

test('Sway file source rejects /dev/zero without reading it', { skip: process.platform !== 'linux' }, async t => {
  const opened = trackOpen(t);
  await assert.rejects(readSwayConfigFile('/dev/zero'), hasCode('INVALID_CONFIG'));
  assert.equal(opened[0].reads, 0); await assertClosed(opened[0]);
});

test('Sway file source uses nonblocking open and rejects a FIFO descriptor before reading', { skip: process.platform !== 'linux' }, async t => {
  // Node exposes no native mkfifo; a synthetic fstat result verifies the FIFO path
  // and its kernel-open flags without depending on a command or loading native code.
  let reads = 0, closes = 0;
  t.mock.method(fs, 'open', async (file, flags) => {
    assert.equal(flags & fs.constants.O_NONBLOCK, fs.constants.O_NONBLOCK);
    return {
      stat: async () => ({ isFile: () => false, size: 0 }),
      read: async () => { reads++; assert.fail('FIFO contents must never be read'); },
      close: async () => { closes++; },
    };
  });
  await assert.rejects(readSwayConfigFile('/synthetic/fifo'), hasCode('INVALID_CONFIG'));
  assert.equal(reads, 0); assert.equal(closes, 1);
});

test('Sway file source preserves regular-file symlink support', { skip: process.platform === 'win32' }, async t => {
  const { root, file } = await sourceFile(t), link = path.join(root, 'linked.config');
  await fs.symlink(file, link);
  assert.equal(await readSwayConfigFile(link), 'font monospace 10\n');
});

test('Sway file source rejects a symlink to /dev/zero before reading any bytes', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await sourceFile(t), link = path.join(root, 'device.config'); await fs.symlink('/dev/zero', link);
  const opened = trackOpen(t);
  await assert.rejects(readSwayConfigFile(link), hasCode('INVALID_CONFIG'));
  assert.equal(opened[0].reads, 0); await assertClosed(opened[0]);
});

test('Sway file source enforces the byte ceiling when a regular file grows during reading', async t => {
  const { file } = await sourceFile(t, Buffer.alloc(ceiling, 35));
  let grown = false;
  const opened = trackOpen(t, handle => {
    const read = handle.read;
    handle.read = async (...args) => {
      const result = await read(...args);
      if (!grown) { grown = true; await fs.appendFile(file, 'x'); }
      return result;
    };
  });
  await assert.rejects(readSwayConfigFile(file), hasCode('INVALID_CONFIG'));
  assert.equal(opened[0].bytes, ceiling + 1); await assertClosed(opened[0]);
});

test('Sway file source checks growth that appears immediately after EOF', async t => {
  const { file } = await sourceFile(t, '');
  const opened = trackOpen(t, handle => {
    const read = handle.read;
    handle.read = async (...args) => { const result = await read(...args); await fs.appendFile(file, Buffer.alloc(ceiling + 1)); return result; };
  });
  await assert.rejects(readSwayConfigFile(file), hasCode('INVALID_CONFIG'));
  assert.equal(opened[0].bytes, 0); await assertClosed(opened[0]);
});

test('Sway file source rejects an already cancelled signal before opening', async t => {
  const controller = new AbortController(); controller.abort();
  t.mock.method(fs, 'open', async () => assert.fail('pre-cancelled read must not open a file'));
  await assert.rejects(readSwayConfigFile('/not/opened', controller.signal), hasCode('CANCELLED'));
});

for (const [name, reason, code] of [
  ['cancellation', undefined, 'CANCELLED'],
  ['startup deadline', new DOMException('Startup deadline elapsed', 'TimeoutError'), 'TIMEOUT'],
]) test(`Sway file source ${name} interrupts a pending read and closes the handle`, async t => {
  const { file } = await sourceFile(t), controller = new AbortController(), started = deferred(), pending = deferred();
  const opened = trackOpen(t, handle => { handle.read = () => { started.resolve(); return pending.promise; }; });
  const reading = readSwayConfigFile(file, controller.signal), rejected = assert.rejects(reading, hasCode(code));
  await started.promise; controller.abort(reason);
  await rejected; await assertClosed(opened[0]);
  pending.resolve({ bytesRead: 0 });
});

test('Sway file source closes a descriptor returned after cancellation won the open race', async t => {
  const { file } = await sourceFile(t), controller = new AbortController(), started = deferred(), release = deferred(), closing = deferred();
  const opened = trackOpen(t, async handle => {
    const close = handle.close;
    handle.close = () => { const result = close(); closing.resolve(); return result; };
    started.resolve(); await release.promise;
  });
  const reading = readSwayConfigFile(file, controller.signal), rejected = assert.rejects(reading, hasCode('CANCELLED'));
  await started.promise; controller.abort(); await rejected;
  assert.equal(opened[0].closes, 0);
  release.resolve(); await closing.promise; await assertClosed(opened[0]);
});

for (const phase of ['stat', 'read']) test(`Sway file source closes its descriptor after a ${phase} error`, async t => {
  const { file } = await sourceFile(t), failure = Object.assign(new Error(`Synthetic ${phase} failure`), { code: 'EIO' });
  const opened = trackOpen(t, handle => { handle[phase] = async () => { throw failure; }; });
  await assert.rejects(readSwayConfigFile(file), error => error === failure);
  await assertClosed(opened[0]);
});

test('Sway start preserves the UTF-8 byte bound for inline config before writing or launching', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await sourceFile(t), context = {
    workspaceRoot: root, signal: new AbortController().signal,
    paths: { runtimeDirectory: path.join(root, 'r'), cacheDirectory: path.join(root, 'c'), wmConfigDirectory: path.join(root, 'wm') },
    processes: { launch: async () => assert.fail('oversized inline config must not launch a compositor') },
  };
  const driver = createManagedDriver({ id: 'sway' }, { resourceRoot: root, probe: () => ({}) });
  await assert.rejects(driver.start(context, {
    mode: 'headless', env: {}, desktopSettings: 'inherit', options: { config: { source: 'inline', text: '界'.repeat(Math.ceil(ceiling / 3)) } },
  }), hasCode('INVALID_CONFIG'));
  await assert.rejects(fs.access(context.paths.wmConfigDirectory), error => error?.code === 'ENOENT');
});
