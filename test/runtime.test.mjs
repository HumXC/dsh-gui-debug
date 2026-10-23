import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { GuiEngine } from '../src/runtime/engine.mjs';
import { ProcessScope } from '../src/runtime/processes.mjs';
import { DshPlatform } from '../src/runtime/platform.mjs';
import { WorkspaceStore } from '../src/runtime/storage.mjs';
import { validateArgs } from '../src/runtime/config.mjs';
import { GuiError } from '../src/runtime/common.mjs';

// Requests below are checked against the actual public tool schemas before dispatch.
// No subprocesses, external helpers, real desktop sockets, installations or teammates are used.
const resourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const recipe = (driver = 'cage') => ({ schemaVersion: 1, driver: { id: driver, options: driver === 'sway' ? { config: { source: 'inline', text: 'font monospace 10\n' } } : {} } });
function value(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
function code(result, expected) { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.error.code, expected, JSON.stringify(result)); }
async function eventually(predicate, detail) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(detail);
}
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function png(width, height) {
  const chunk = (kind, bytes) => { const name = Buffer.from(kind), out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); name.copy(out, 4); bytes.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([name, bytes])), out.length - 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
function waylandInfo({ width = 1280, height = 720, scale = 1 } = {}) {
  return `interface: 'wl_compositor', version: 6, name: 1\ninterface: 'zwlr_screencopy_manager_v1', version: 3, name: 2\ninterface: 'zwp_virtual_keyboard_manager_v1', version: 1, name: 3\ninterface: 'zwlr_virtual_pointer_manager_v1', version: 2, name: 4\ninterface: 'zwlr_output_manager_v1', version: 4, name: 5\ninterface: 'wl_output', version: 4, name: 7\n\tname: HEADLESS-1\n\tx: 0, y: 0, scale: ${scale},\n\toutput_transform: normal,\n\tmode:\n\t\twidth: ${width} px, height: ${height} px, refresh: 60.000 Hz,\n\t\tflags: current preferred\n`;
}
class FakeRange {
  constructor(signal, role) {
    this.role = role; this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.root = deferred(); this.done = this.root.promise;
    this.rangeAlive = true; this.rootExited = false; this.terminateCalls = 0; this.residual = false; this.closePromise = Promise.resolve();
    this.signal = signal; this.abort = () => this.terminate(); signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.terminate();
  }
  finish({ exitCode = 0, signal, stdout = '', stderr = '', keepRange = false } = {}) {
    if (this.rootExited) return;
    this.rootExited = true; this.stdout.end(stdout); this.stderr.end(stderr); this.root.resolve({ exitCode, ...(signal ? { signal } : {}) });
    if (!keepRange) { this.rangeAlive = false; this.signal?.removeEventListener('abort', this.abort); this.closeServer(); }
  }
  closeServer() { if (this.server?.listening) this.closePromise = new Promise(resolve => this.server.close(resolve)); }
  terminate() { this.terminateCalls++; this.finish({ exitCode: null, signal: 'SIGTERM', keepRange: this.residual }); if (!this.residual) { this.rangeAlive = false; this.signal?.removeEventListener('abort', this.abort); this.closeServer(); } }
  async waitForExit() { await this.closePromise; return !this.rangeAlive; }
  async forceClose() { this.residual = false; this.terminate(); await this.closePromise; }
}
class FakePlatform {
  constructor(root) { this.workspaceRoot = root; this.mode = 'danger-full-access'; this.calls = []; this.ranges = []; this.attachments = []; this.confirmations = []; this.identities = new Map(); this.geometry = { width: 1280, height: 720, scale: 1 }; this.display = { runtimeDirectory: path.join(root, 'parent-runtime'), waylandDisplay: 'wayland-parent' }; }
  async invocation(exec = {}) {
    const sessionId = exec.sessionId ?? 'root-a';
    if (!this.identities.has(sessionId)) this.identities.set(sessionId, { agent: { id: sessionId }, session: { id: sessionId } });
    return { ...this.identities.get(sessionId), sessionId, workspaceRoot: this.workspaceRoot, isRoot: exec.isRoot ?? true, signal: exec.signal ?? new AbortController().signal, callId: 'fake-tool-call' };
  }
  async policy() { return { mode: this.mode, enforcement: this.mode === 'danger-full-access' ? 'unconfined' : 'full', workspaceRoot: this.workspaceRoot, ...(this.mode !== 'danger-full-access' ? { runner: 'fake-bwrap' } : {}), raw: { mode: this.mode, workspaceRoot: this.workspaceRoot } }; }
  async resolve(executable) { if (this.missing?.has(executable)) return undefined; return path.isAbsolute(executable) ? executable : `/fake/bin/${executable}`; }
  async version() { return { exitCode: 0, text: 'cage version 0.3.1' }; }
  desktop() { return { ...this.display }; }
  async confirm(invocation, request, signal) { this.confirmations.push({ invocation, request, signal }); return this.onConfirm ? this.onConfirm(invocation, request, signal) : { questionId: 'fake-human-question', selected: ['允许本会话读取'] }; }
  async attach(file, name) {
    const bytes = await fs.readFile(file), width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), scale = this.deliveryScale ?? 1;
    const attachment = { attachmentId: `attachment-${this.attachments.length + 1}`, mediaType: 'image/png', bytes: bytes.length, name, width: Math.round(width * scale), height: Math.round(height * scale) };
    this.attachments.push(attachment); if (this.onAttach) await this.onAttach(attachment); return attachment;
  }
  async spawn(request, invocation, policy, signal) {
    this.calls.push({ ...request, argv: [...request.argv], env: { ...request.env }, sessionId: invocation.sessionId, policyMode: policy.mode });
    if (this.beforeSpawn) await this.beforeSpawn(request, signal);
    const range = new FakeRange(signal, request.role); this.ranges.push(range);
    if (request.role === 'compositor') {
      // A private inert IPC inode satisfies the compositor's socket discovery. No clients connect.
      const socket = path.resolve(request.env.XDG_RUNTIME_DIR, 'wayland-0'); this.inside(socket);
      range.server = net.createServer();
      await new Promise((resolve, reject) => { range.server.once('error', reject); range.server.listen(socket, resolve); });
      if (signal.aborted) range.terminate(); return range;
    }
    if (request.role === 'application') return range;
    queueMicrotask(async () => {
      try {
        if (this.onHelper && await this.onHelper(request, range)) return;
        const command = path.basename(request.argv[0]);
        if (command === 'wayland-info') range.finish({ stdout: waylandInfo(this.geometry) });
        else if (command === 'grim') {
          let { width, height } = this.geometry; const regionIndex = request.argv.indexOf('-g');
          if (regionIndex !== -1) { const match = request.argv[regionIndex + 1].match(/ (\d+)x(\d+)$/); width = Number(match[1]); height = Number(match[2]); }
          const target = request.argv.at(-1); this.inside(target); await fs.writeFile(target, png(width, height)); range.finish();
        } else if (command === 'swaymsg') {
          const query = request.argv.at(-1);
          if (query === 'get_outputs') range.finish({ stdout: JSON.stringify([{ name: 'HEADLESS-1', active: true, current_mode: { width: this.geometry.width, height: this.geometry.height }, scale: this.geometry.scale, rect: { x: 0, y: 0, width: this.geometry.width / this.geometry.scale, height: this.geometry.height / this.geometry.scale } }]) });
          else if (query === 'get_tree') range.finish({ stdout: JSON.stringify({ id: 1, nodes: [{ id: 44, app_id: 'fake-app', name: 'Fake window', focused: false, nodes: [], floating_nodes: [] }], floating_nodes: [] }) });
          else range.finish({ stdout: '[{"success":true}]' });
        } else if (command === 'wlr-randr') {
          if (request.argv.includes('--json')) range.finish({ stdout: JSON.stringify([{ name: 'HEADLESS-1', enabled: true, position: { x: 0, y: 0 }, scale: this.geometry.scale, transform: 'normal', modes: [{ width: this.geometry.width, height: this.geometry.height, refresh: 60000, preferred: true, current: true }] }]) });
          else { const mode = request.argv[request.argv.indexOf('--custom-mode') + 1].split('x').map(Number); this.geometry = { width: mode[0], height: mode[1], scale: Number(request.argv[request.argv.indexOf('--scale') + 1]) }; range.finish(); }
        }
        else range.finish();
      } catch (error) { range.finish({ exitCode: 1, stderr: error.message }); }
    });
    return range;
  }
  inside(target) { const absolute = path.resolve(target); assert.ok(absolute.startsWith(`${this.workspaceRoot}${path.sep}`), `Fake fixture write escaped mkdtemp: ${absolute}`); }
  async cleanup() { for (const range of this.ranges) await range.forceClose(); }
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gd-'))), platform = new FakePlatform(root), engine = new GuiEngine(platform, { resourceRoot }), extraCleanup = [];
  t.after(async () => { for (const cleanup of extraCleanup) await cleanup(); await engine.closeAll(); await platform.cleanup(); assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); assert.match(path.basename(root), /^gd-/); await fs.rm(root, { recursive: true, force: true }); });
  const call = (name, args, exec = {}) => { validateArgs(name, args); return engine.execute(name, args, exec); };
  return { root, platform, engine, call, addCleanup: cleanup => extraCleanup.push(cleanup) };
}
async function scopeFixture(t) {
  const fixtureValue = await fixture(t), { root, platform } = fixtureValue, invocation = await platform.invocation(), policy = await platform.policy(), store = new WorkspaceStore(root), scope = new ProcessScope(platform, invocation, policy, store);
  fixtureValue.addCleanup(() => scope.terminateAll());
  return { ...fixtureValue, scope, logPath: path.join(store.base, 'scope.log') };
}
const launchRequest = (role, extra = {}) => ({ argv: ['/fake/bin/app'], cwd: '/unused', env: {}, role, ...extra });

test('ProcessScope application lifetime survives completion/cancellation of its launching operation', async t => {
  const { scope, platform } = await scopeFixture(t), operation = new AbortController();
  const process = value(await scope.operation(operation.signal).launch(launchRequest('application'))); operation.abort(); await turn();
  assert.equal(platform.ranges[0].rangeAlive, true); assert.equal(platform.ranges[0].signal.aborted, false);
  value(await process.terminate()); assert.equal(platform.ranges[0].rangeAlive, false);
});
test('ProcessScope helper lifetime is cancelled with its current operation', async t => {
  const { scope, platform } = await scopeFixture(t), operation = new AbortController(); platform.onHelper = async () => true;
  const process = value(await scope.operation(operation.signal).launch(launchRequest('helper'))); operation.abort();
  await process.done; assert.equal(platform.ranges[0].rangeAlive, false); assert.ok(platform.ranges[0].terminateCalls > 0);
});
test('ProcessScope cleanup waits for a pending spawn and accounts for the late-created range', async t => {
  const { scope, platform } = await scopeFixture(t), entered = deferred(), release = deferred();
  platform.beforeSpawn = async () => { entered.resolve(); await release.promise; };
  const launching = scope.launch(launchRequest('application')); await entered.promise;
  let finished = false; const stopping = scope.terminateAll().then(result => { finished = true; return result; }); await turn();
  assert.equal(finished, false, 'cleanup must not claim success while spawn can still create an owned range');
  release.resolve(); await launching; assert.deepEqual(value(await stopping).remainingProcessIds, []); assert.equal(platform.ranges[0].rangeAlive, false);
});
test('ProcessScope redacts split credentials from helper output and durable logs, preserving split UTF-8', async t => {
  const { scope, platform, logPath } = await scopeFixture(t), secret = 'abc-SECRET-xyz';
  platform.onHelper = async (_request, range) => { const bytes = Buffer.from(`before 鍵 ${secret} after\n`); for (const byte of bytes) range.stdout.write(Buffer.from([byte])); range.finish(); return true; };
  const process = value(await scope.launch(launchRequest('helper', { env: { API_TOKEN: secret, EMPTY_PASSWORD: '' }, logPath })));
  const result = value(await process.done), stored = await fs.readFile(logPath, 'utf8');
  assert.equal(result.stdout, 'before 鍵 [redacted] after\n'); assert.equal(stored, result.stdout); assert.ok(!stored.includes(secret));
});
test('ProcessScope output truncation remains bounded without truncating the durable diagnostic log', async t => {
  const { scope, platform, logPath } = await scopeFixture(t); platform.onHelper = async (_request, range) => { range.finish({ stdout: '0123456789ABCDEFGHIJ' }); return true; };
  const process = value(await scope.launch(launchRequest('helper', { logPath, maxOutputBytes: 8 }))), result = value(await process.done);
  assert.equal(Buffer.byteLength(result.stdout), 8); assert.equal(result.truncated, true); assert.equal(await fs.readFile(logPath, 'utf8'), '0123456789ABCDEFGHIJ');
});
test('ProcessScope retains root-exited descendant ranges and reports ranges that cannot be terminated', async t => {
  const { scope, platform } = await scopeFixture(t), process = value(await scope.launch(launchRequest('application'))), range = platform.ranges[0];
  range.residual = true; range.finish({ keepRange: true }); await process.done;
  assert.deepEqual(value(await scope.terminateAll()).remainingProcessIds, [process.processId]); assert.equal(range.rangeAlive, true);
});
test('ProcessScope rejects writes under read-only policy before spawning', async t => {
  const { root, platform } = await fixture(t); platform.mode = 'read-only';
  const scope = new ProcessScope(platform, await platform.invocation(), await platform.policy(), new WorkspaceStore(root));
  code(await scope.launch(launchRequest('application')), 'SANDBOX_DENIED'); assert.equal(platform.calls.length, 0);
});

test('Real managed and host drivers expose the declared probe, snapshot and capture results', async t => {
  const { call, engine, platform } = await fixture(t);
  for (const driver of ['cage', 'sway', 'host']) {
    const instance = value(await call(driver === 'host' ? 'gui_debug_host' : 'gui_debug_start',
      driver === 'host' ? { action: 'connect', reason: 'Contract regression', scopes: ['capture', 'inspect'] }
        : { source: { kind: 'inline', config: recipe(driver) } })).instance;
    const record = engine.instances.get(instance.instanceId);
    const invocation = await platform.invocation();
    const context = engine.context(record, invocation);
    const report = value(await record.driver.probe(record.config ?? { options: record.options }, context.signal));
    assert.equal(report.driverId, driver);
    assert.equal(report.ready, true);
    assert.ok(Array.isArray(report.warnings));
    assert.equal(typeof report.capabilities['capture.output'].available, 'boolean');
    const snapshot = value(await record.driver.inspect(context, record.handle));
    assert.deepEqual(snapshot.warnings, []);
    assert.equal(snapshot.state, driver === 'host' ? 'connected' : 'running');
    const image = value(await record.driver.capture(context, record.handle, { kind: 'output' }, false));
    assert.equal(image.mimeType, 'image/png');
    assert.equal(typeof image.path, 'string');
    assert.equal('filePath' in image, false);
    assert.equal((await fs.stat(image.path)).isFile(), true);
  }
});

test('Wait-only batches avoid per-action display probes and the next input refreshes geometry', async t => {
  const { call, platform } = await fixture(t);
  const { instanceId } = value(await call('gui_debug_start', { source: { kind: 'inline', config: recipe('sway') } })).instance;
  platform.calls.length = 0;
  const result = value(await call('gui_debug_input', { instanceId, actions: Array.from({ length: 4 }, () => ({ type: 'wait', durationMs: 0 })) }));
  assert.equal(result.completedActions, 4);
  assert.equal(platform.calls.filter(item => path.basename(item.argv[0]) === 'wayland-info').length, 1);
  platform.calls.length = 0;
  value(await call('gui_debug_input', { instanceId, actions: [{ type: 'key', key: 'a' }] }));
  const keyIndex = platform.calls.findIndex(item => path.basename(item.argv[0]) === 'wtype');
  assert.ok(keyIndex > 0);
  assert.ok(platform.calls.slice(0, keyIndex).some(item => item.argv.at(-1) === 'get_outputs'));
});

test('Long key holds outlive the default helper timeout and still release the key', async t => {
  const { call, platform } = await fixture(t);
  const { instanceId } = value(await call('gui_debug_start', {})).instance;
  let held;
  platform.onHelper = async (request, range) => {
    if (path.basename(request.argv[0]) !== 'wtype') return false;
    held = { request, range };
    return true;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = call('gui_debug_input', { instanceId, actions: [{ type: 'key', key: 'a', holdMs: 10000 }] });
  for (let attempts = 0; !held && attempts < 1000; attempts++) await turn();
  assert.ok(held, 'key helper must start');
  for (let attempts = 0; attempts < 5; attempts++) await turn();
  t.mock.timers.tick(10001);
  await turn();
  assert.equal(held.range.terminateCalls, 0, 'the maximum 10-second hold needs additional keyboard activation time');
  assert.deepEqual(held.request.argv.slice(-6), ['-P', 'a', '-s', '10000', '-p', 'a']);
  held.range.finish();
  const result = value(await pending);
  assert.equal(result.completedActions, 1);
  assert.equal(result.failedAction, undefined);
  t.mock.timers.reset();
});

test('GuiEngine starts empty, tracks app exit independently, and repeated stop is safe', async t => {
  const { call, platform } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance;
  assert.equal(instance.kind, 'managed'); assert.equal(instance.state, 'running'); assert.equal(platform.calls.filter(item => item.role === 'application').length, 0);
  const application = value(await call('gui_debug_exec', { instanceId: instance.instanceId, command: { executable: 'fake-application', args: ['hello'] } })).application;
  assert.equal(application.instanceId, instance.instanceId); assert.equal(application.state, 'running');
  platform.ranges.find(item => item.role === 'application').finish({ exitCode: 0 });
  await eventually(async () => value(await call('gui_debug_inspect', { action: 'applications', instanceId: instance.instanceId })).applications[0].state === 'exited', 'application exit was not observed');
  assert.equal(value(await call('gui_debug_inspect', { action: 'status', instanceId: instance.instanceId })).instance.state, 'running');
  const first = value(await call('gui_debug_stop', { instanceId: instance.instanceId })), second = value(await call('gui_debug_stop', { instanceId: instance.instanceId }));
  assert.equal(first.state, 'stopped'); assert.deepEqual(first.remainingProcessIds, []); assert.equal(second.state, 'stopped');
});
test('GuiEngine public application records normalize omitted command args to an array', async t => {
  const { call } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance;
  const application = value(await call('gui_debug_exec', { instanceId: instance.instanceId, command: { executable: 'fake-application' } })).application;
  assert.deepEqual(application.command, { executable: 'fake-application', args: [] });
});
test('GuiEngine profile put/get preserves public id, description and configuration', async t => {
  const { call } = await fixture(t), config = recipe();
  const profile = value(await call('gui_debug_profile', { action: 'put', profileId: 'saved', description: 'Reusable fake GUI', config })).profile;
  assert.equal(profile.id, 'saved'); assert.equal(profile.description, 'Reusable fake GUI'); assert.deepEqual(profile.config, config);
  assert.deepEqual(value(await call('gui_debug_profile', { action: 'get', profileId: 'saved' })).profile, profile);
});
test('GuiEngine profile list returns contract summaries with id and description', async t => {
  const { call } = await fixture(t); value(await call('gui_debug_profile', { action: 'put', profileId: 'saved', description: 'Summary', config: recipe() }));
  assert.deepEqual(value(await call('gui_debug_profile', { action: 'list' })).profiles, [{ id: 'saved', description: 'Summary' }]);
});
test('GuiEngine drivers check accepts the public config input and returns a direct ProbeReport', async t => {
  const { call, platform } = await fixture(t), report = value(await call('gui_debug_drivers', { action: 'check', config: recipe() }));
  assert.equal(report.driverId, 'cage'); assert.equal(report.ready, true); assert.ok(report.dependencies.length > 0);
  for (const dependency of report.dependencies) assert.ok(['found', 'missing', 'incompatible'].includes(dependency.status), JSON.stringify(dependency));
  assert.equal(platform.calls.length, 0, 'preflight may resolve tools but must not start GUI processes');
});
test('GuiEngine session ownership prevents another caller from inspecting, executing or stopping an instance', async t => {
  const { call, platform } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance, before = platform.calls.length;
  for (const [name, args] of [['gui_debug_inspect', { action: 'status', instanceId: instance.instanceId }], ['gui_debug_exec', { instanceId: instance.instanceId, command: { executable: 'fake-application' } }], ['gui_debug_stop', { instanceId: instance.instanceId }]]) code(await call(name, args, { sessionId: 'root-b' }), 'INSTANCE_NOT_FOUND');
  assert.deepEqual(value(await call('gui_debug_inspect', { action: 'list' }, { sessionId: 'root-b' })).instances, []); assert.equal(platform.calls.length, before);
});
test('GuiEngine capture uses delivered attachment dimensions to preserve image-to-layout mapping', async t => {
  const { call, platform } = await fixture(t); platform.deliveryScale = 0.5;
  const instance = value(await call('gui_debug_start', {})).instance, capture = value(await call('gui_debug_capture', { instanceId: instance.instanceId, target: { kind: 'region', outputId: 'HEADLESS-1', x: 10, y: 20, width: 200, height: 100 } })).capture;
  assert.equal(capture.width, 100); assert.equal(capture.height, 50); assert.equal(capture.attachmentId, platform.attachments[0].attachmentId);
  assert.deepEqual(capture.imageToLayout, { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 }); assert.equal(capture.instanceId, instance.instanceId);
});
test('GuiEngine input output includes its instance identity', async t => {
  const { call } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance;
  const output = value(await call('gui_debug_input', { instanceId: instance.instanceId, actions: [{ type: 'text', text: 'hello' }], captureAfter: false }));
  assert.equal(output.instanceId, instance.instanceId); assert.equal(output.completedActions, 1);
});
test('GuiEngine omitted captureAfter obeys its false default without invoking grim', async t => {
  const { call, platform } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance;
  const output = value(await call('gui_debug_input', { instanceId: instance.instanceId, actions: [{ type: 'text', text: 'hello' }] }));
  assert.equal(output.capture, undefined); assert.equal(platform.calls.filter(item => path.basename(item.argv[0]) === 'grim').length, 0);
});
test('GuiEngine wait uses the public durationMs field', async t => {
  const { call } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance, started = performance.now();
  const output = value(await call('gui_debug_input', { instanceId: instance.instanceId, actions: [{ type: 'wait', durationMs: 150 }], captureAfter: false }));
  assert.equal(output.completedActions, 1); assert.ok(performance.now() - started >= 120, 'a 150 ms wait returned in less than 120 ms');
});
test('GuiEngine rejects public wait durations whose requested total exceeds 30 seconds', async t => {
  const { call, platform } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance, before = platform.calls.length;
  code(await call('gui_debug_input', { instanceId: instance.instanceId, actions: Array.from({ length: 4 }, () => ({ type: 'wait', durationMs: 10000 })), captureAfter: false }), 'INVALID_CONFIG');
  assert.ok(platform.calls.slice(before).every(item => !['wtype', 'wlrctl'].includes(path.basename(item.argv[0]))));
});
test('GuiEngine partial input failure stops later actions and returns flat failedAction fields', async t => {
  const { call, platform } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance;
  platform.onHelper = async (request, range) => { if (request.argv.at(-1) === 'FAIL_HERE') { range.finish({ exitCode: 1, stderr: 'controlled keyboard failure' }); return true; } return false; };
  const output = value(await call('gui_debug_input', { instanceId: instance.instanceId, actions: [{ type: 'text', text: 'first' }, { type: 'text', text: 'FAIL_HERE' }, { type: 'text', text: 'never' }], captureAfter: false }));
  assert.equal(output.completedActions, 1); assert.equal(output.failedAction.index, 1); assert.equal(typeof output.failedAction.code, 'string'); assert.match(output.failedAction.message, /controlled keyboard failure/);
  assert.deepEqual(platform.calls.filter(item => path.basename(item.argv[0]) === 'wtype').map(item => item.argv.at(-1)), ['first', 'FAIL_HERE']);
});
test('GuiEngine Sway focus uses an owned stable window id and checks the IPC result', async t => {
  const { call, platform } = await fixture(t), instance = value(await call('gui_debug_start', { source: { kind: 'inline', config: recipe('sway') } })).instance;
  assert.ok(instance.windows.some(window => window.id === '44'));
  const output = value(await call('gui_debug_input', { instanceId: instance.instanceId, actions: [{ type: 'focus', windowId: '44' }], captureAfter: false }));
  assert.equal(output.completedActions, 1); assert.ok(platform.calls.some(item => path.basename(item.argv[0]) === 'swaymsg' && item.argv.at(-1) === '[con_id=44] focus'));
});
test('GuiEngine application log pages carry public instance and application identities', async t => {
  const { call } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance;
  const application = value(await call('gui_debug_exec', { instanceId: instance.instanceId, command: { executable: 'fake-application', args: [] } })).application;
  const output = value(await call('gui_debug_inspect', { action: 'logs', instanceId: instance.instanceId, source: { kind: 'application', applicationId: application.applicationId }, maxBytes: 4 }));
  assert.equal(output.instanceId, instance.instanceId); assert.equal(output.applicationId, application.applicationId); assert.equal(typeof output.nextCursor, 'string');
});
test('GuiEngine logs without a cursor read the most recent bounded page', async t => {
  const { call, platform } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance;
  const application = value(await call('gui_debug_exec', { instanceId: instance.instanceId, command: { executable: 'fake-application', args: [] } })).application;
  platform.ranges.find(item => item.role === 'application').stdout.write('header-tail');
  await eventually(async () => (await fs.readFile(application.logPath, 'utf8').catch(() => '')).includes('header-tail'), 'application diagnostic was not stored');
  const output = value(await call('gui_debug_inspect', { action: 'logs', instanceId: instance.instanceId, source: { kind: 'application', applicationId: application.applicationId }, maxBytes: 4 }));
  assert.equal(output.text, 'tail');
});
test('GuiEngine stop reports failure rather than stopped when an owned range remains', async t => {
  const { call, platform } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance;
  platform.ranges.find(item => item.role === 'compositor').residual = true;
  const result = await call('gui_debug_stop', { instanceId: instance.instanceId });
  if (!result.ok) assert.equal(result.error.code, 'STOP_FAILED'); else { assert.equal(result.value.state, 'failed'); assert.ok(result.value.remainingProcessIds.length > 0); }
});
test('GuiEngine policy changes prevent further input and terminate the previous environment', async t => {
  const { call, platform } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance, before = platform.calls.length; platform.mode = 'read-only';
  code(await call('gui_debug_input', { instanceId: instance.instanceId, actions: [{ type: 'text', text: 'must-not-run' }], captureAfter: false }), 'POLICY_MISMATCH');
  assert.equal(platform.calls.length, before); assert.ok(platform.ranges.every(range => !range.rangeAlive));
});

test('GuiEngine host rejection starts no helpers and creates no observation instance', async t => {
  const { call, platform, root } = await fixture(t); platform.onConfirm = async () => { throw new GuiError('HOST_CONFIRMATION_REJECTED', 'User declined'); };
  code(await call('gui_debug_host', { action: 'connect', reason: 'Test rejection', scopes: ['capture'] }), 'HOST_CONFIRMATION_REJECTED');
  assert.equal(platform.calls.length, 0); assert.equal(platform.confirmations.length, 1); assert.equal(await fs.stat(path.join(root, '.dsh', 'gui-debug', 'instances')).then(() => true, () => false), false);
});
test('GuiEngine delegates cannot request host consent or borrow root-owned access', async t => {
  const { call, platform } = await fixture(t);
  code(await call('gui_debug_host', { action: 'connect', reason: 'Delegated request', scopes: ['inspect'] }, { sessionId: 'child', isRoot: false }), 'HOST_CONFIRMATION_UNAVAILABLE');
  assert.equal(platform.confirmations.length, 0); assert.equal(platform.calls.length, 0);
  const host = value(await call('gui_debug_host', { action: 'connect', reason: 'Root request', scopes: ['inspect'] })).instance;
  code(await call('gui_debug_inspect', { action: 'status', instanceId: host.instanceId }, { sessionId: 'child', isRoot: false }), 'INSTANCE_NOT_FOUND');
});
test('GuiEngine host scopes are enforced and connections cannot execute, inject input or stop the desktop', async t => {
  const { call, platform } = await fixture(t), host = value(await call('gui_debug_host', { action: 'connect', reason: 'Inspect only', scopes: ['inspect'] })).instance, before = platform.calls.length;
  code(await call('gui_debug_capture', { instanceId: host.instanceId }), 'HOST_CONFIRMATION_REQUIRED');
  code(await call('gui_debug_exec', { instanceId: host.instanceId, command: { executable: 'fake-app' } }), 'UNSUPPORTED_OPERATION');
  code(await call('gui_debug_input', { instanceId: host.instanceId, actions: [{ type: 'text', text: 'forbidden' }] }), 'UNSUPPORTED_OPERATION');
  code(await call('gui_debug_stop', { instanceId: host.instanceId }), 'UNSUPPORTED_OPERATION'); assert.equal(platform.calls.length, before);
});
test('GuiEngine host confirmation freezes the original options before helper execution', async t => {
  const { call, platform } = await fixture(t), entered = deferred(), approved = deferred(), options = { executables: { grim: '/fake/grim-approved', waylandInfo: '/fake/wayland-info' } };
  platform.onConfirm = async () => { entered.resolve(); await approved.promise; return { questionId: 'frozen-question', selected: ['允许本会话读取'] }; };
  const connecting = call('gui_debug_host', { action: 'connect', reason: 'Freeze configuration', scopes: ['inspect'], options });
  await entered.promise; options.executables.grim = '/fake/grim-changed'; approved.resolve();
  const host = value(await connecting).instance; assert.equal(host.effectiveOptions.executables.grim, '/fake/grim-approved');
  assert.ok(platform.calls.every(item => item.argv[0] !== '/fake/grim-changed'));
});
test('GuiEngine policy change during host confirmation prevents any desktop helper execution', async t => {
  const { call, platform } = await fixture(t); platform.onConfirm = async () => { platform.mode = 'workspace-write'; return { questionId: 'changed-policy', selected: ['允许本会话读取'] }; };
  code(await call('gui_debug_host', { action: 'connect', reason: 'Policy race', scopes: ['capture'] }), 'POLICY_MISMATCH'); assert.equal(platform.calls.length, 0);
});
test('GuiEngine changed desktop identity revokes use of an existing host grant', async t => {
  const { call, platform } = await fixture(t), host = value(await call('gui_debug_host', { action: 'connect', reason: 'Identity binding', scopes: ['capture'] })).instance, before = platform.calls.length;
  platform.display.waylandDisplay = 'different-display'; code(await call('gui_debug_capture', { instanceId: host.instanceId }), 'HOST_ACCESS_REVOKED'); assert.equal(platform.calls.length, before);
});
test('GuiEngine disconnect revokes consent before a pending attachment can be returned', async t => {
  const { call, platform } = await fixture(t), host = value(await call('gui_debug_host', { action: 'connect', reason: 'Delivery race', scopes: ['capture'] })).instance, attaching = deferred(), release = deferred();
  platform.onAttach = async () => { attaching.resolve(); await release.promise; };
  const capturing = call('gui_debug_capture', { instanceId: host.instanceId }); await attaching.promise;
  assert.equal(value(await call('gui_debug_host', { action: 'disconnect', instanceId: host.instanceId })).disconnectedInstanceId, host.instanceId);
  release.resolve(); code(await capturing, 'HOST_ACCESS_REVOKED');
  code(await call('gui_debug_capture', { instanceId: host.instanceId }), 'HOST_ACCESS_REVOKED');
});

test('DshPlatform full-access status uses the public unconfined enforcement value', async t => {
  const { root } = await fixture(t), agent = { id: 'root' }, session = {}, platform = new DshPlatform({ agents: { get: () => agent }, sessions: { get: () => session }, sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) } });
  const invocation = { sessionId: 'root', agent, session, workspaceRoot: root };
  assert.equal((await platform.policy(invocation)).enforcement, 'unconfined');
  await assert.rejects(platform.policy({ ...invocation, session: undefined }), error => error.code === 'INSTANCE_NOT_RUNNING');
  await assert.rejects(platform.policy({ ...invocation, session: {} }), error => error.code === 'INSTANCE_NOT_RUNNING');
});
test('DshPlatform disabled approval prompts reject host confirmation without asking', async () => {
  const agent = { id: 'root' }; let asked = 0;
  const platform = new DshPlatform({ agents: { roots: () => [agent] }, approval: { overrideOf: () => 'never' }, userQuestions: { ask: async () => { asked++; return {}; } } });
  await assert.rejects(platform.confirm({ agent, session: {}, isRoot: true }, { instanceId: 'host-test', scopes: ['capture'], detail: 'fake' }, new AbortController().signal), error => error.code === 'HOST_CONFIRMATION_UNAVAILABLE'); assert.equal(asked, 0);
});
test('DshPlatform free text cannot substitute for selecting the explicit human host grant', async () => {
  const agent = { id: 'root' };
  const platform = new DshPlatform({ agents: { roots: () => [agent] }, approval: { overrideOf: () => 'ask' }, userQuestions: { ask: async request => ({ answers: [{ id: request.questions[0].id, selected: [], custom: '允许本会话读取' }] }) } });
  await assert.rejects(platform.confirm({ agent, session: {}, isRoot: true }, { instanceId: 'host-test', scopes: ['inspect'], detail: 'fake' }, new AbortController().signal), error => error.code === 'HOST_CONFIRMATION_REJECTED');
});

test('GuiEngine reports confined renderer allocation failure without relaxing policy and cleans its ranges', async t => {
  const { call, platform, engine } = await fixture(t); platform.mode = 'workspace-write';
  platform.onHelper = async (request, range) => {
    if (path.basename(request.argv[0]) !== 'wayland-info') return false;
    platform.ranges.find(item => item.role === 'compositor').stderr.write('Failed to allocate buffer\n');
    range.finish({ stdout: "interface: 'wl_compositor', version: 6, name: 1\n" }); return true;
  };
  const result = await call('gui_debug_start', {}); code(result, 'SANDBOX_UNAVAILABLE');
  assert.match(result.error.message, /allocate output buffers/);
  assert.equal(platform.mode, 'workspace-write'); assert.ok(platform.calls.every(item => item.policyMode === 'workspace-write'));
  assert.ok(platform.ranges.every(range => !range.rangeAlive));
  assert.match(await fs.readFile(engine.instances.get(result.error.instanceId).paths.driverLog, 'utf8'), /Failed to allocate buffer/);
});

test('DshPlatform rechecks the policy after executable resolution and confinement', async t => {
  const { root } = await fixture(t), agent = { id: 'root' }, session = { id: 'root' };
  for (const stage of ['resolve', 'confine']) {
    let mode = stage === 'resolve' ? 'danger-full-access' : 'workspace-write';
    const spawns = [], controller = new AbortController();
    const context = {
      agents: { get: () => agent }, sessions: { get: () => session },
      sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: root }) },
      sandbox: { confine: async argv => { if (stage === 'confine' && argv[0] !== 'true') mode = 'read-only'; return { argv: ['test-runner', ...argv], enforcement: 'full' }; } },
      subprocess: { resolveExecutable: async executable => { if (stage === 'resolve') mode = 'read-only'; return executable; }, spawn: request => { spawns.push(request); throw new Error('unexpected spawn'); } },
    };
    const platform = new DshPlatform(context), invocation = { agent, session, sessionId: 'root', workspaceRoot: root, signal: controller.signal };
    await assert.rejects(platform.version('/mock/cage', ['-v'], invocation, {}), error => error.code === 'POLICY_MISMATCH');
    assert.equal(spawns.length, 0, stage); assert.equal(mode, 'read-only');
  }
});

test('GuiEngine cancels actual platform version preflight before an instance exists', async t => {
  const { root, engine, platform, call } = await fixture(t), entered = deferred();
  const native = new DshPlatform({
    agents: { get: id => platform.identities.get(id)?.agent }, sessions: { get: id => platform.identities.get(id)?.session },
    sandboxPolicy: { resolve: () => ({ mode: platform.mode, workspaceRoot: root }) },
    subprocess: { resolveExecutable: async executable => executable, spawn: request => {
      const range = new FakeRange(request.signal, 'preflight'); platform.ranges.push(range); entered.resolve(); return range;
    } },
  });
  platform.version = native.version.bind(native);
  const pending = call('gui_debug_start', {}); await entered.promise;
  assert.equal(engine.instances.size, 0); assert.equal(engine.reservations.size, 1);
  await engine.closeSession('root-a'); code(await pending, 'CANCELLED');
  assert.ok(platform.ranges.every(range => !range.rangeAlive));
  assert.equal(engine.instances.size, 0); assert.equal(engine.reservations.size, 0); assert.equal(engine.sessionScopes.size, 0);
});

test('GuiEngine reserves concurrent starts, reuses stopped capacity and releases disposed records', async t => {
  const { engine, platform, call } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 17 }, () => call('gui_debug_start', {})));
  const successful = results.filter(result => result.ok), refused = results.filter(result => !result.ok);
  assert.equal(successful.length, 16); assert.equal(refused.length, 1); code(refused[0], 'INVALID_CONFIG');
  assert.equal(engine.reservations.size, 0);
  value(await call('gui_debug_stop', { instanceId: successful[0].value.instance.instanceId }));
  value(await call('gui_debug_start', {}));
  assert.equal([...engine.instances.values()].filter(record => record.state === 'running').length, 16);
  await engine.closeSession('root-a');
  assert.equal(engine.instances.size, 0); assert.equal(engine.sessionScopes.size, 0);
  assert.ok(platform.ranges.every(range => !range.rangeAlive));
});

test('GuiEngine releases a capacity reservation when dependency preflight fails', async t => {
  const { engine, platform, call } = await fixture(t); platform.missing = new Set(['cage']);
  code(await call('gui_debug_start', {}), 'DEPENDENCY_MISSING');
  assert.equal(engine.reservations.size, 0); assert.equal(engine.instances.size, 0);
  platform.missing.clear(); value(await call('gui_debug_start', {})); assert.equal(engine.reservations.size, 0);
});

test('GuiEngine includes pending host confirmations in capacity and cancels them on session close', async t => {
  const { engine, platform, call } = await fixture(t);
  platform.onConfirm = async (_invocation, _request, signal) => new Promise((resolve, reject) => {
    const abort = () => reject(new GuiError('CANCELLED', 'Confirmation cancelled.'));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
  const attempts = Array.from({ length: 17 }, () => call('gui_debug_host', { action: 'connect', reason: 'capacity regression', scopes: ['inspect'] }));
  await eventually(() => platform.confirmations.length === 16, 'sixteen confirmations must acquire reservations');
  assert.equal(engine.reservations.size, 16); assert.equal(engine.pending.size, 16);
  await engine.closeSession('root-a'); const results = await Promise.all(attempts);
  assert.equal(results.filter(result => result.error?.code === 'INVALID_CONFIG').length, 1);
  assert.equal(results.filter(result => result.error?.code === 'CANCELLED').length, 16);
  assert.equal(engine.pending.size, 0); assert.equal(engine.reservations.size, 0); assert.equal(engine.instances.size, 0); assert.equal(platform.calls.length, 0);
});

test('GuiEngine permanently revokes host consent after desktop or configuration identity changes', async t => {
  for (const changed of ['desktop', 'config']) {
    const { engine, platform, call } = await fixture(t);
    const instance = value(await call('gui_debug_host', { action: 'connect', reason: 'revocation regression', scopes: ['inspect', 'capture'] })).instance;
    const record = engine.instances.get(instance.instanceId), before = platform.calls.length, original = structuredClone(platform.display);
    if (changed === 'desktop') platform.display.waylandDisplay = 'other-desktop';
    else record.options.captureBackend = 'changed-backend';
    code(await call('gui_debug_inspect', { action: 'status', instanceId: record.id }), 'HOST_ACCESS_REVOKED');
    assert.equal(record.active, false); assert.equal(record.consent, undefined);
    platform.display = original; record.options.captureBackend = 'grim';
    code(await call('gui_debug_capture', { instanceId: record.id }), 'HOST_ACCESS_REVOKED');
    assert.equal(platform.calls.length, before); assert.equal(platform.confirmations.length, 1);
    assert.equal(value(await call('gui_debug_inspect', { action: 'list' })).instances[0].state, 'disconnected');
  }
});

test('GuiEngine retains only cleanup ownership, not disposed Agent references, when a range cannot exit', async t => {
  const { engine, platform, call } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance;
  const record = engine.instances.get(instance.instanceId), compositor = platform.ranges.find(range => range.role === 'compositor'); compositor.residual = true;
  await engine.closeSession('root-a');
  assert.equal(engine.instances.get(record.id), record); assert.equal(record.state, 'failed');
  assert.equal(record.invocation.agent, undefined); assert.equal(record.invocation.session, undefined); assert.equal(record.invocation.sessionScope, undefined);
  assert.equal(record.processes.invocation, record.invocation); assert.equal(engine.sessionScopes.size, 0);
  compositor.residual = false; assert.deepEqual(value(await call('gui_debug_stop', { instanceId: record.id })).remainingProcessIds, []);
  await engine.closeSession('root-a'); assert.equal(engine.instances.size, 0);
});

test('GuiEngine session cleanup does not delete an instance admitted under the next session scope', async t => {
  const { engine, platform, call } = await fixture(t), first = value(await call('gui_debug_start', {})).instance;
  const oldScope = engine.sessionScopes.get('root-a'), compositor = platform.ranges.find(range => range.role === 'compositor'), entered = deferred(), release = deferred();
  const original = compositor.waitForExit.bind(compositor);
  compositor.waitForExit = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const closing = engine.closeSession('root-a'); await entered.promise;
  const second = value(await call('gui_debug_start', {})).instance, nextScope = engine.sessionScopes.get('root-a');
  assert.notEqual(oldScope, nextScope); assert.equal(oldScope.signal.aborted, true); assert.equal(nextScope.signal.aborted, false);
  release.resolve(); await closing;
  assert.equal(engine.instances.has(first.instanceId), false); assert.equal(engine.instances.get(second.instanceId).state, 'running');
});

test('GuiEngine failed session cleanup retains only failed ranges and drops the exited compositor handle', async t => {
  const { engine, platform, call } = await fixture(t), instance = value(await call('gui_debug_start', {})).instance;
  value(await call('gui_debug_exec', { instanceId: instance.instanceId, command: { executable: '/fake/bin/program' } }));
  const record = engine.instances.get(instance.instanceId), application = platform.ranges.find(range => range.role === 'application'); application.residual = true;
  await engine.closeSession('root-a');
  assert.equal(engine.instances.get(record.id), record); assert.equal(record.processes.entries.size, 1);
  assert.equal([...record.processes.entries.values()][0].raw, application); assert.equal(record.handle, undefined);
  assert.equal(record.invocation.agent, undefined); assert.equal(record.processes.invocation.session, undefined);
  await application.forceClose(); await engine.closeSession('root-a');
  assert.equal(engine.instances.size, 0); assert.equal(record.processes.entries.size, 0);
});
