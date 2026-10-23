import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { GuiError, check, cancelled, errorValue, id, redact, secretValues } from './common.mjs';

const success = value => ({ ok: true, value });
export class ProcessScope {
  constructor(platform, invocation, policy, store, lifetime = new AbortController()) {
    this.platform = platform;
    this.invocation = invocation;
    this.policy = policy;
    this.store = store;
    this.lifetime = lifetime;
    this.stopTimeoutMs = 5000;
    this.entries = new Map(); this.closed = false; this.logBytes = new Map(); this.logChains = new Map();
  }
  operation(signal) { return { launch: request => this.launch(request, signal), terminateAll: () => this.terminateAll() }; }
  async append(file, text, secrets) {
    if (!file || !text) return;
    const previous = this.logChains.get(file) ?? Promise.resolve();
    const pending = previous.then(async () => {
      const used = this.logBytes.get(file) ?? 0;
      if (used >= 8 * 1024 * 1024) return;
      await this.store.verify(file, { create: true });
      const bytes = Buffer.from(redact(text, secrets));
      const content = bytes.subarray(0, Math.max(0, 8 * 1024 * 1024 - used));
      const handle = await fs.open(file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.write(content); } finally { await handle.close(); }
      this.logBytes.set(file, used + content.length);
    });
    this.logChains.set(file, pending.catch(() => {}));
    await pending;
  }
  async launch(request, operationSignal) {
    const processId = id('process');
    const entry = { id: processId, raw: undefined, settled: false, role: request.role, controller: new AbortController() };
    let finishStarting = () => {};
    entry.ready = new Promise(resolve => { finishStarting = () => resolve(undefined); });
    // Register before executable resolution, confinement or spawn can fail.
    this.entries.set(processId, entry);
    const abortOperation = () => entry.controller.abort(operationSignal.reason);
    const releaseOperation = () => operationSignal?.removeEventListener('abort', abortOperation);
    if (operationSignal) {
      operationSignal.addEventListener('abort', abortOperation, { once: true });
      if (operationSignal.aborted) abortOperation();
    }
    try {
      check(!this.closed && !this.lifetime.signal.aborted, 'INSTANCE_NOT_RUNNING', 'Process scope has been closed.');
      cancelled(operationSignal);
      this.store.writable(this.policy);
      if (request.logPath) await this.store.verify(request.logPath, { create: true });
      // The operation owns preparation for every role. Persistent processes detach only at handoff.
      const signal = AbortSignal.any([this.lifetime.signal, entry.controller.signal]);
      cancelled(signal);
      const raw = await this.platform.spawn(request, this.invocation, this.policy, signal);
      entry.raw = raw;
      const terminate = async () => {
        releaseOperation(); entry.controller.abort();
        try { raw.terminate(); const exited = await raw.waitForExit(AbortSignal.timeout(this.stopTimeoutMs)); return exited ? success(null) : { ok: false, error: { code: 'STOP_FAILED', message: `Process range ${processId} has not exited.` } }; }
        catch (error) { return { ok: false, error: errorValue(error, { code: 'STOP_FAILED' }) }; }
      };
      entry.terminate = terminate;
      const secrets = secretValues(request.env);
      const maximum = request.maxOutputBytes ?? 256 * 1024;
      const collected = { stdout: '', stderr: '', truncated: false };
      const read = async (stream, name) => {
        if (!stream) return;
        const decoder = new StringDecoder('utf8');
        let pending = '';
        const hold = Math.max(0, ...secrets.map(value => value.length));
        const accept = async text => {
          pending += text;
          // Hold credential tails across chunks. Expand a boundary to include any crossing match.
          let boundary = Math.max(0, pending.length - hold);
          for (const secret of secrets) {
            let at = pending.indexOf(secret);
            while (at !== -1) { if (at < boundary && at + secret.length > boundary) boundary = at; at = pending.indexOf(secret, at + 1); }
          }
          const clean = redact(pending.slice(0, boundary), secrets); pending = pending.slice(boundary);
          const remaining = maximum - Buffer.byteLength(collected[name]);
          if (remaining > 0) collected[name] += Buffer.from(clean).subarray(0, remaining).toString('utf8');
          if (Buffer.byteLength(clean) > remaining) collected.truncated = true;
          await this.append(request.logPath, clean, secrets);
        };
        for await (const chunk of stream) await accept(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        await accept(decoder.end());
        const tail = redact(pending, secrets), remaining = maximum - Buffer.byteLength(collected[name]);
        if (remaining > 0) collected[name] += Buffer.from(tail).subarray(0, remaining).toString('utf8');
        if (Buffer.byteLength(tail) > remaining) collected.truncated = true;
        await this.append(request.logPath, tail, secrets);
      };
      const readers = Promise.all([read(raw.stdout, 'stdout'), read(raw.stderr, 'stderr')]);
      // Observe reader failures immediately, even for a long-lived application.
      readers.catch(() => { entry.controller.abort(); try { raw.terminate(); } catch {} });
      entry.done = (async () => {
        try {
          const outcome = await raw.done;
          if (request.role === 'helper') {
            // Readers already run concurrently. Reclaim descendants before awaiting EOF:
            // an exited wrapper can leave a descendant holding its stdout/stderr open.
            let gone = await raw.waitForExit(AbortSignal.timeout(1000)).catch(() => false);
            if (!gone) {
              try { raw.terminate(); } catch (error) { check(false, 'STOP_FAILED', `Cannot terminate helper range ${processId}: ${error.message}`); }
              gone = await raw.waitForExit(AbortSignal.timeout(5000)).catch(() => false);
            }
            check(gone, 'STOP_FAILED', `Helper range ${processId} has not exited.`);
            let drainTimer;
            try {
              await Promise.race([readers, new Promise((resolve, reject) => {
                drainTimer = setTimeout(() => reject(new GuiError('TIMEOUT', `Helper ${processId} diagnostic pipes did not close after its range exited.`)), Math.min(1000, this.stopTimeoutMs));
              })]);
            } catch (error) {
              raw.stdout?.destroy(); raw.stderr?.destroy();
              throw error;
            } finally { clearTimeout(drainTimer); }
            releaseOperation();
            this.entries.delete(processId);
          }
          entry.settled = true;
          const diagnostic = `${collected.stdout}\n${collected.stderr}`;
          return success({ ...outcome, ...collected,
            sandboxDenial: (raw.denialSignatures ?? []).some(text => diagnostic.includes(text)),
            sandboxRunnerFailure: (raw.runnerFailureRules ?? []).some(rule => rule.fatalSignatures.some(text => diagnostic.includes(text))) });
        } catch (error) { entry.settled = true; return { ok: false, error: errorValue(error) }; }
      })();
      cancelled(signal);
      if (request.role !== 'helper') releaseOperation();
      // Do not discard root-exited entries: a managed range can still contain descendants.
      return success({ processId, done: entry.done, terminate });
    } catch (error) {
      releaseOperation();
      let gone = !entry.raw;
      if (entry.terminate) {
        try { gone = (await entry.terminate()).ok; } catch { gone = false; }
      }
      // A late raw handoff can arrive after cancellation. Keep a failed cleanup tracked for stop retry.
      if (gone) this.entries.delete(processId);
      return { ok: false, error: errorValue(error) };
    } finally { finishStarting(); }
  }
  async terminateAll() {
    this.closed = true; this.lifetime.abort();
    const starting = [...this.entries.values()];
    for (const entry of starting) entry.controller.abort();
    await Promise.all(starting.map(entry => entry.ready));
    const remainingProcessIds = [];
    await Promise.all([...this.entries.values()].map(async entry => {
      if (!entry.raw) { entry.controller.abort(); return; }
      const result = await entry.terminate();
      if (!result.ok) remainingProcessIds.push(entry.id);
      else this.entries.delete(entry.id);
    }));
    await Promise.all([...this.logChains.values()]);
    return success({ remainingProcessIds });
  }
}
