import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ProcessScope } from '../src/runtime/processes.mjs';
import { cancelled } from '../src/runtime/common.mjs';

// Pure in-memory ranges: no real subprocesses, files, sockets, GUI or desktop access.
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle without external cleanup`)), 500);
    })]);
  } finally { clearTimeout(timer); }
}
function syntheticRange({ cleanupFails = false, terminationOutput = {} } = {}) {
  const root = deferred(), stdout = new PassThrough(), stderr = new PassThrough();
  let rootExited = false, rangeEmpty = false, abortSignal, onAbort;
  const range = {
    stdout, stderr, done: root.promise, terminateCalls: 0, waits: [],
    bind(signal) {
      abortSignal = signal; range.signal = signal;
      onAbort = () => range.terminate();
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    finishRoot({ keepChild = false, stdout: out = '', stderr: err = '' } = {}) {
      if (rootExited) return;
      if (out) stdout.write(out);
      if (err) stderr.write(err);
      rootExited = true; root.resolve({ exitCode: 0 });
      if (!keepChild) range.forceExit();
    },
    terminate() {
      range.terminateCalls++;
      if (!cleanupFails) range.forceExit(terminationOutput);
    },
    async waitForExit(signal) {
      range.waits.push(signal);
      return rangeEmpty;
    },
    forceExit({ stdout: out = '', stderr: err = '' } = {}) {
      if (rangeEmpty) return;
      rangeEmpty = true;
      abortSignal?.removeEventListener('abort', onAbort);
      stdout.end(out); stderr.end(err);
      if (!rootExited) { rootExited = true; root.resolve({ exitCode: null, signal: 'SIGTERM' }); }
    },
    get empty() { return rangeEmpty; },
  };
  return range;
}
function fixture(t, spawn) {
  const ranges = [], calls = [];
  const platform = {
    async spawn(request, invocation, policy, signal) {
      calls.push({ request, signal });
      if (spawn) return spawn(request, signal, ranges);
      const range = syntheticRange(); ranges.push(range); range.bind(signal); return range;
    },
  };
  const scope = new ProcessScope(platform, { sessionId: 'process-regressions' }, { mode: 'danger-full-access' }, {
    writable() {}, async verify() { return true; },
  });
  t.after(async () => {
    // Release synthetic writers even when an assertion fails, before asking the scope to settle.
    for (const range of ranges) range.forceExit();
    await scope.terminateAll();
  });
  return { scope, calls, ranges };
}
const request = (role, extra = {}) => ({ argv: ['/synthetic/program'], cwd: '/unused', env: {}, role, ...extra });
function waitingForAbort(signal) {
  return new Promise((_, reject) => {
    const abort = () => {
      try { cancelled(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

for (const role of ['application', 'compositor']) {
  test(`ProcessScope cancels a pending ${role} spawn before handoff`, async t => {
    const entered = deferred(), operation = new AbortController();
    const { scope } = fixture(t, async (_request, signal) => {
      entered.resolve(signal); return waitingForAbort(signal);
    });
    const launch = scope.launch(request(role), operation.signal);
    const spawnSignal = await entered.promise;
    operation.abort(new DOMException('launch cancelled', 'AbortError'));
    const result = await within(launch, 'cancelled launch');
    assert.equal(spawnSignal.aborted, true);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CANCELLED');
    assert.equal(scope.entries.size, 0);
  });

  test(`ProcessScope preserves a handed-off ${role} when its launching operation is cancelled`, async t => {
    const operation = new AbortController(), { scope, ranges, calls } = fixture(t);
    const result = await scope.launch(request(role), operation.signal);
    assert.equal(result.ok, true);
    operation.abort(); await turn();
    assert.equal(calls[0].signal.aborted, false);
    assert.equal(ranges[0].terminateCalls, 0);
    assert.equal(ranges[0].empty, false);
    const stopped = await scope.terminateAll();
    assert.deepEqual(stopped, { ok: true, value: { remainingProcessIds: [] } });
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(ranges[0].empty, true);
    await result.value.done;
  });
}

test('ProcessScope propagates a startup deadline during asynchronous spawn preparation', async t => {
  const entered = deferred(), operation = new AbortController();
  const { scope } = fixture(t, async (_request, signal) => {
    entered.resolve(signal); return waitingForAbort(signal);
  });
  const launch = scope.launch(request('application'), operation.signal);
  await entered.promise;
  operation.abort(new DOMException('startup deadline elapsed', 'TimeoutError'));
  const result = await within(launch, 'expired launch');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(scope.entries.size, 0);
});

test('ProcessScope reclaims a late raw handoff that arrives after operation cancellation', async t => {
  const entered = deferred(), release = deferred(), operation = new AbortController();
  const { scope, ranges } = fixture(t, async (_request, signal, owned) => {
    entered.resolve(); await release.promise;
    const range = syntheticRange(); owned.push(range); range.bind(signal); return range;
  });
  const launch = scope.launch(request('application'), operation.signal);
  await entered.promise; operation.abort(); release.resolve();
  const result = await within(launch, 'late cancelled handoff');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(ranges[0].empty, true);
  assert.equal(scope.entries.size, 0);
});

test('ProcessScope keeps a handed-off helper bound to operation cancellation', async t => {
  const operation = new AbortController(), { scope, ranges, calls } = fixture(t);
  const result = await scope.launch(request('helper'), operation.signal);
  assert.equal(result.ok, true);
  operation.abort();
  assert.equal(calls[0].signal.aborted, true);
  assert.ok(ranges[0].terminateCalls > 0);
  const outcome = await within(result.value.done, 'cancelled helper');
  assert.equal(outcome.ok, true);
  assert.equal(scope.entries.size, 0);
});

test('ProcessScope reclaims helper descendants holding stdout before draining final diagnostics', async t => {
  const range = syntheticRange({ terminationOutput: { stdout: 'value\nchild ended\n', stderr: 'Sandbox runner unavailable\n' } });
  range.denialSignatures = ['Permission denied'];
  range.runnerFailureRules = [{ fatalSignatures: ['Sandbox runner unavailable'] }];
  const { scope } = fixture(t, async (_request, signal, owned) => { owned.push(range); range.bind(signal); return range; });
  const result = await scope.launch(request('helper', { env: { API_TOKEN: 'sensitive-value' } }));
  assert.equal(result.ok, true);
  range.stdout.write('before sensitive-');
  range.finishRoot({ keepChild: true, stderr: 'Permission denied while inspecting\n' });
  const outcome = await within(result.value.done, 'helper descendant cleanup');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value.exitCode, 0);
  assert.ok(range.terminateCalls > 0);
  assert.equal(range.waits.length, 2);
  assert.equal(range.empty, true);
  assert.equal(outcome.value.stdout, 'before [redacted]\nchild ended\n');
  assert.match(outcome.value.stderr, /Permission denied while inspecting\nSandbox runner unavailable\n/);
  assert.equal(outcome.value.sandboxDenial, true);
  assert.equal(outcome.value.sandboxRunnerFailure, true);
  assert.equal(scope.entries.size, 0);
});

test('ProcessScope reports helper cleanup failure without waiting for child-held pipe EOF', async t => {
  const range = syntheticRange({ cleanupFails: true });
  const { scope } = fixture(t, async (_request, signal, owned) => { owned.push(range); range.bind(signal); return range; });
  const result = await scope.launch(request('helper'));
  assert.equal(result.ok, true);
  range.finishRoot({ keepChild: true, stdout: 'helper root finished\n' });
  const outcome = await within(result.value.done, 'failed helper cleanup');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'STOP_FAILED');
  assert.match(outcome.error.message, /has not exited/);
  assert.equal(range.empty, false);
  assert.equal(range.stdout.readableEnded, false);
  assert.ok(range.terminateCalls > 0);
  assert.equal(scope.entries.has(result.value.processId), true);
  const stopped = await scope.terminateAll();
  assert.equal(stopped.ok, true);
  assert.deepEqual(stopped.value.remainingProcessIds, [result.value.processId]);
});

test('ProcessScope bounds final pipe draining even when range exit precedes delayed pipe closure', async t => {
  const range = syntheticRange(); range.waitForExit = async () => true;
  const { scope } = fixture(t, async (_request, signal, owned) => { owned.push(range); range.bind(signal); return range; });
  scope.stopTimeoutMs = 10;
  const result = await scope.launch(request('helper'));
  range.finishRoot({ keepChild: true, stdout: 'root finished; delivery pipe still open\n' });
  const outcome = await within(result.value.done, 'bounded post-exit diagnostic drain');
  assert.equal(outcome.ok, false); assert.equal(outcome.error.code, 'TIMEOUT');
  assert.match(outcome.error.message, /diagnostic pipes/);
  assert.equal(range.stdout.destroyed, true); assert.equal(range.stderr.destroyed, true);
});
