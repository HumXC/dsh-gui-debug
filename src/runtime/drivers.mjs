import fs from 'node:fs/promises';
import path from 'node:path';
import { check, fail, cancelled, sleep, id, now, unavailableCapabilities } from './common.mjs';
import { captureRegion, parseWaylandInfo, parseSwayOutputs, publicOutputs, revision, swayWindows, pngDimensions } from './geometry.mjs';

/** @template T @param {import('../api.ts').Result<T>} result @returns {T} */
export function unwrap(result) {
  if (!result.ok) fail(result.error.code, result.error.message, result.error);
  return result.value;
}
async function assertOwnedConnection(context, handle) {
  if (handle.driverId === 'host') return;
  const runtime = context.paths.runtimeDirectory;
  check(await fs.realpath(runtime) === runtime, 'POLICY_MISMATCH', 'Owned runtime directory was redirected.');
  const stat = await fs.lstat(path.join(runtime, handle.env.WAYLAND_DISPLAY));
  check(stat.isSocket() && (!handle.socketIdentity || handle.socketIdentity === `${stat.dev}:${stat.ino}`), 'POLICY_MISMATCH', 'Owned Wayland socket was replaced.');
}
async function run(context, handle, key, args, { operation = 'inspect', timeoutMs = 10000, env = handle.env } = {}) {
  await assertOwnedConnection(context, handle);
  check(context.executables[key], 'DEPENDENCY_MISSING', `Missing helper: ${key}.`, { dependencyIds: [key] });
  const request = { argv: [context.executables[key], ...args], cwd: handle.config?.cwd ?? context.workspaceRoot, env, role: 'helper', logPath: context.paths.driverLog, maxOutputBytes: 256 * 1024 };
  const process = unwrap(await (context.helpers ? context.helpers.run(operation, request) : context.processes.launch(request)));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void process.terminate(); }, timeoutMs); timer.unref();
  try {
    const result = unwrap(await process.done);
    check(!timedOut, 'TIMEOUT', `${key} timed out.`);
    check(!result.sandboxRunnerFailure, 'SANDBOX_UNAVAILABLE', `${key}: sandbox runner failed.`);
    check(!result.truncated, 'PROTOCOL_UNAVAILABLE', `${key} returned more diagnostic data than the bounded reader permits.`);
    check(result.exitCode === 0, result.sandboxDenial ? 'SANDBOX_DENIED' : 'PROTOCOL_UNAVAILABLE', `${key} failed: ${result.stderr.slice(-2048) || `exit ${result.exitCode}`}`);
    return result.stdout;
  } finally { clearTimeout(timer); }
}
function capabilities(context, info, managed, sway = false) {
  const result = unavailableCapabilities();
  const available = (name, condition, description) => { result[name] = condition ? { available: true } : { available: false, reason: description }; };
  available('application.exec', managed, 'Host connections cannot launch applications.');
  const capture = !!context.executables.grim && info.protocols.has('zwlr_screencopy_manager_v1');
  available('capture.output', capture, 'grim and the screencopy protocol are required.');
  available('capture.region', capture, 'grim and the screencopy protocol are required.');
  if (managed) {
    const keyboard = !!context.executables.wtype && info.protocols.has('zwp_virtual_keyboard_manager_v1');
    const pointer = !!context.executables.wlrctl && info.protocols.has('zwlr_virtual_pointer_manager_v1');
    available('input.text', keyboard, 'wtype and virtual-keyboard protocol are required.');
    available('input.key', keyboard, 'wtype and virtual-keyboard protocol are required.');
    for (const name of ['pointer.relative', 'pointer.click', 'pointer.scroll']) available(name, pointer, 'wlrctl and virtual-pointer protocol are required.');
    available('windows.list', sway, 'Window enumeration requires a supported WM IPC.');
    available('windows.focus', sway, 'Window focus requires a supported WM IPC.');
  }
  return result;
}
function baseEnv(config, paths) {
  const env = { ...config.env, XDG_RUNTIME_DIR: paths.runtimeDirectory, XDG_CACHE_HOME: paths.cacheDirectory,
    WAYLAND_DISPLAY: null, DISPLAY: null, XAUTHORITY: null, SWAYSOCK: null, I3SOCK: null, DBUS_SESSION_BUS_ADDRESS: null };
  if (config.desktopSettings === 'private') for (const [key, child] of [['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'], ['XDG_STATE_HOME', 'state']]) env[key] = path.join(paths.privateSettingsDirectory, child);
  return env;
}
async function connectedSocket(context, process, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let exited = false; process.done.then(() => { exited = true; });
  while (Date.now() < deadline) {
    cancelled(context.signal);
    check(await fs.realpath(context.paths.runtimeDirectory) === context.paths.runtimeDirectory, 'POLICY_MISMATCH', 'Owned runtime directory was redirected.');
    check(!exited, 'START_FAILED', 'Compositor exited before exposing its private socket; inspect driver logs.');
    for (const name of await fs.readdir(context.paths.runtimeDirectory)) {
      if (!/^wayland-\d+$/.test(name)) continue;
      const stat = await fs.lstat(path.join(context.paths.runtimeDirectory, name));
      if (stat.isSocket()) return name;
    }
    await sleep(50, context.signal);
  }
  fail('TIMEOUT', 'Compositor did not expose its private socket before startup timeout.');
}
async function startupLogHead(file) {
  let descriptor;
  try {
    descriptor = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(8192), { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; }
  finally { await descriptor?.close(); }
}
/** @returns {Promise<Omit<import('../driver.ts').DriverSnapshot, 'state'>>} */
async function observe(context, handle, operation = 'inspect') {
  const info = parseWaylandInfo(await run(context, handle, 'waylandInfo', [], { operation }));
  if (handle.driverId === 'sway') {
    const outputs = await run(context, handle, 'swaymsg', ['-s', handle.ipcSocket, '-r', '-t', 'get_outputs']);
    info.outputs = parseSwayOutputs(JSON.parse(outputs));
    const tree = await run(context, handle, 'swaymsg', ['-s', handle.ipcSocket, '-r', '-t', 'get_tree']);
    handle.windows = swayWindows(JSON.parse(tree));
  }
  if (handle.driverId === 'cage' && context.executables.wlrRandr && info.protocols.has('zwlr_output_manager_v1')) {
    const actual = JSON.parse(await run(context, handle, 'wlrRandr', ['--json'], { operation }));
    for (const output of info.outputs) {
      const reported = actual.find(item => item.name === output.name && item.enabled), mode = reported?.modes.find(item => item.current);
      if (mode) Object.assign(output, { scale: reported.scale, physicalWidth: mode.width, physicalHeight: mode.height });
    }
  }
  check(info.outputs.length > 0, 'PROTOCOL_UNAVAILABLE', 'No usable output geometry was reported.');
  handle.info = info;
  return { capabilities: capabilities(context, info, handle.driverId !== 'host', handle.driverId === 'sway'), outputs: publicOutputs(info.outputs),
    ...(handle.windows ? { windows: handle.windows } : {}), layoutRevision: revision(info.outputs), warnings: [] };
}
/** @returns {Promise<import('../driver.ts').DriverCapture>} */
async function capture(context, handle, target, includeCursor) {
  const snapshot = await observe(context, handle, 'capture');
  check(snapshot.capabilities[target.kind === 'region' ? 'capture.region' : target.kind === 'window' ? 'capture.window' : 'capture.output'].available, 'UNSUPPORTED_CAPABILITY', 'Requested capture operation is unavailable.');
  const selected = captureRegion(handle.info.outputs, target), file = path.join(context.paths.artifactDirectory, `${id('capture')}.png`);
  const args = ['-t', 'png', '-s', String(selected.output.scale)];
  if (target.kind === 'region') args.push('-g', `${selected.x},${selected.y} ${selected.region.width}x${selected.region.height}`);
  else args.push('-o', selected.output.name);
  if (includeCursor) args.push('-c'); args.push(file);
  await run(context, handle, 'grim', args, { operation: 'capture' });
  const image = await pngDimensions(file);
  const after = await observe(context, handle, 'capture');
  check(after.layoutRevision === snapshot.layoutRevision, 'STALE_CAPTURE', 'Output layout changed during capture. Retry with the current layout.');
  return { path: file, mimeType: 'image/png', width: image.width, height: image.height, layoutRevision: snapshot.layoutRevision,
    imageToLayout: { a: selected.region.width / image.width, b: 0, c: 0, d: selected.region.height / image.height, e: selected.x, f: selected.y } };
}
async function input(context, handle, action) {
  switch (action.type) {
    // Let the compositor activate this transient keyboard after its initial modifier/keymap state.
    case 'text': await run(context, handle, 'wtype', ['-m', 'shift', '-s', '100', '--', action.text]); break;
    case 'key': {
      const modifiers = (action.modifiers ?? []).map(modifier => modifier === 'super' ? 'logo' : modifier);
      const args = ['-m', 'shift', '-s', '100', ...modifiers.flatMap(modifier => ['-M', modifier])];
      if (action.holdMs) args.push('-P', action.key, '-s', String(action.holdMs), '-p', action.key); else args.push('-k', action.key);
      for (const modifier of modifiers.toReversed()) args.push('-m', modifier);
      // The helper budget includes the requested hold, keyboard activation and execution overhead.
      await run(context, handle, 'wtype', args, { timeoutMs: 10000 + 100 + (action.holdMs ?? 0) });
      break;
    }
    case 'move': check(action.mode === 'relative', 'UNSUPPORTED_CAPABILITY', 'Absolute positioning has not been verified for this driver.'); await run(context, handle, 'wlrctl', ['pointer', 'move', String(action.dx), String(action.dy)]); break;
    case 'click': check(!action.point, 'UNSUPPORTED_CAPABILITY', 'Pointed clicks require absolute positioning.'); for (let index = 0; index < (action.count ?? 1); index++) await run(context, handle, 'wlrctl', ['pointer', 'click', action.button ?? 'left']); break;
    case 'scroll': await run(context, handle, 'wlrctl', ['pointer', 'scroll', String(action.dy), String(action.dx)]); break;
    case 'focus': check(handle.driverId === 'sway' && /^\d+$/.test(action.windowId), 'INVALID_CONFIG', 'Invalid owned Sway window id.'); {
      const result = JSON.parse(await run(context, handle, 'swaymsg', ['-s', handle.ipcSocket, '-r', `[con_id=${action.windowId}] focus`]));
      check(Array.isArray(result) && result.every(item => item.success), 'INPUT_FAILED', 'Sway rejected the window focus command.'); break;
    }
    default: fail('UNSUPPORTED_CAPABILITY', 'This input action is unavailable.');
  }
}
export async function removeOwnedSockets(runtimeDirectory) {
  const directory = path.resolve(runtimeDirectory);
  check(await fs.realpath(directory) === directory, 'POLICY_MISMATCH', 'Refusing socket cleanup through a redirected runtime directory.');
  for (const name of await fs.readdir(directory)) {
    if (!/^wayland-\d+(\.lock)?$/.test(name) && name !== 'ipc.sock') continue;
    const target = path.resolve(directory, name);
    check(path.dirname(target) === directory, 'INVALID_CONFIG', 'Socket cleanup path escapes its runtime.');
    const stat = await fs.lstat(target).catch(() => undefined);
    if (stat?.isSocket() || (name.endsWith('.lock') && stat?.isFile())) await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
// Internal file-source reader, exported so regressions need no compositor or desktop.
export async function readSwayConfigFile(file, signal) {
  const ceiling = 1024 * 1024, chunks = [];
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let handle;
  /** @type {{ promise?: Promise<import('node:fs/promises').FileHandle> }} */
  const opening = {};
  let pendingIO = false, total = 0;
  const perform = async start => {
    cancelled(signal);
    const operation = Promise.resolve().then(() => { cancelled(signal); return start(); });
    pendingIO = true;
    operation.then(() => { pendingIO = false; }, () => { pendingIO = false; });
    if (!signal) return operation;
    let onAbort;
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => { try { cancelled(signal); } catch (error) { reject(error); } };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([operation, aborted]); }
    finally { signal.removeEventListener('abort', onAbort); }
  };
  cancelled(signal);
  try {
    // NONBLOCK prevents an unopened FIFO from stalling open; fstat is authoritative.
    const opened = await perform(() => (opening.promise = fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)));
    handle = opened;
    const initial = await perform(() => opened.stat());
    check(initial.isFile(), 'INVALID_CONFIG', 'WM configuration source must be a regular file.');
    check(initial.size <= ceiling, 'INVALID_CONFIG', 'WM configuration exceeds 1 MiB.');
    for (;;) {
      cancelled(signal);
      // Read at most one sentinel byte beyond the ceiling, including file growth.
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, ceiling + 1 - total));
      const { bytesRead } = await perform(() => opened.read(buffer, 0, buffer.length, total));
      cancelled(signal);
      if (!bytesRead) break;
      total += bytesRead;
      check(total <= ceiling, 'INVALID_CONFIG', 'WM configuration exceeds 1 MiB.');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const final = await perform(() => opened.stat());
    check(final.isFile() && final.size <= ceiling, 'INVALID_CONFIG', 'WM configuration source changed or exceeds 1 MiB.');
    cancelled(signal);
    return Buffer.concat(chunks, total).toString('utf8');
  } catch (error) {
    cancelled(signal);
    if (error.code === 'ELOOP') fail('INVALID_CONFIG', 'WM configuration source contains an unresolved symbolic-link loop.');
    throw error;
  } finally {
    if (handle) {
      const closing = handle.close();
      // FileHandle.close safely waits for outstanding kernel I/O. Do not let an
      // uncancellable filesystem request delay cancellation; closing is already queued.
      if (pendingIO) void closing.catch(() => {});
      else await closing;
    } else if (opening.promise) {
      // An abort may win before open returns its descriptor; close that late result.
      void opening.promise.then(opened => opened.close()).catch(() => {});
    }
  }
}
/**
 * @param {import('../driver.ts').DriverDeclaration<import('./driver-types.ts').ManagedOptions, 'managed'>} metadata
 * @param {{resourceRoot: string, probe: import('../driver.ts').ManagedGuiDriver<import('./driver-types.ts').ManagedOptions, import('./driver-types.ts').ManagedHandle>['probe']}} options
 * @returns {import('../driver.ts').ManagedGuiDriver<import('./driver-types.ts').ManagedOptions, import('./driver-types.ts').ManagedHandle>}
 */
export function createManagedDriver(metadata, { resourceRoot, probe }) {
  return { kind: 'managed', declaration: metadata, probe,
    async start(context, config) {
      check(!config.options.xwayland, 'UNSUPPORTED_CAPABILITY', 'XWayland application routing is not available in this version; use a native Wayland application.');
      check(Buffer.byteLength(path.join(context.paths.runtimeDirectory, 'wayland-0')) < 104, 'INVALID_CONFIG', 'Workspace path is too long for a private Unix socket. Use a shorter workspace path.');
      const env = baseEnv(config, context.paths), compositorEnv = { ...env, WLR_LIBINPUT_NO_DEVICES: '1' };
      if (config.mode === 'headless') Object.assign(compositorEnv, { WLR_BACKENDS: 'headless', WLR_HEADLESS_OUTPUTS: '1', WLR_RENDERER: config.env.WLR_RENDERER ?? 'pixman' });
      else {
        const parent = context.parentDisplay;
        check(parent?.waylandDisplay || parent?.x11Display, 'START_FAILED', 'Nested mode requires an existing parent display.');
        compositorEnv.WLR_BACKENDS = parent.waylandDisplay ? 'wayland' : 'x11';
        if (parent.waylandDisplay) compositorEnv.WAYLAND_DISPLAY = path.isAbsolute(parent.waylandDisplay) ? parent.waylandDisplay : path.join(parent.runtimeDirectory ?? '', parent.waylandDisplay);
        else Object.assign(compositorEnv, { DISPLAY: parent.x11Display, XAUTHORITY: parent.xauthority ?? null });
      }
      /** @type {import('./driver-types.ts').ManagedHandle} */
      const handle = { driverId: metadata.id, config, env };
      let args = metadata.id === 'cage' ? [...(config.options.debug ? ['-D'] : []), ...(config.options.decorations ? [] : ['-d'])] : [];
      if (metadata.id === 'sway') {
        // Sway 1.12 checks its generated socket address before honoring SWAYSOCK.
        check(process.getuid, 'UNSUPPORTED_OPERATION', 'Sway requires a POSIX user identity.');
        const maxPid = (await fs.readFile('/proc/sys/kernel/pid_max', 'utf8')).trim();
        check(/^\d{1,10}$/.test(maxPid), 'SANDBOX_UNAVAILABLE', 'Cannot determine Linux IPC path bounds.');
        const generatedSocket = path.join(context.paths.runtimeDirectory, `sway-ipc.${process.getuid()}.${maxPid}.sock`);
        check(Buffer.byteLength(generatedSocket) < 108, 'INVALID_CONFIG', 'Sway initial IPC address exceeds the Linux Unix-socket limit; use a shorter workspace path.', { pathBytes: Buffer.byteLength(generatedSocket), maxBytes: 107 });
        const source = config.options.config ?? { source: 'bundled', name: 'minimal' };
        const text = source.source === 'inline' ? source.text : await readSwayConfigFile(source.source === 'file' ? path.resolve(context.workspaceRoot, source.path) : path.join(resourceRoot, 'defaults', 'sway.config'), context.signal);
        check(Buffer.byteLength(text) <= 1024 * 1024, 'INVALID_CONFIG', 'WM configuration exceeds 1 MiB.');
        cancelled(context.signal);
        const configFile = path.join(context.paths.wmConfigDirectory, 'sway.config');
        await fs.writeFile(configFile, `${text}\nxwayland disable\n`, { mode: 0o600, flag: 'wx' });
        handle.ipcSocket = path.join(context.paths.runtimeDirectory, 'ipc.sock'); compositorEnv.SWAYSOCK = handle.ipcSocket; env.SWAYSOCK = handle.ipcSocket;
        args = ['--config', configFile, ...(config.options.debug ? ['--debug'] : [])];
      }
      check(context.executables[metadata.id], 'DEPENDENCY_MISSING', `Missing ${metadata.id}.`);
      const compositor = unwrap(await context.processes.launch({ argv: [context.executables[metadata.id], ...args], cwd: config.cwd, env: compositorEnv, role: 'compositor', logPath: context.paths.driverLog }));
      handle.process = compositor;
      env.WAYLAND_DISPLAY = await connectedSocket(context, handle.process, config.startupTimeoutMs);
      const socketStat = await fs.lstat(path.join(context.paths.runtimeDirectory, env.WAYLAND_DISPLAY));
      handle.socketIdentity = `${socketStat.dev}:${socketStat.ino}`;
      let snapshot, exited = false;
      compositor.done.then(() => { exited = true; });
      const deadline = Date.now() + config.startupTimeoutMs;
      for (;;) {
        check(!exited, 'START_FAILED', 'Compositor exited before readiness; inspect driver logs.');
        cancelled(context.signal);
        try { snapshot = await observe(context, handle); break; }
        catch (error) {
          if (error.code !== 'PROTOCOL_UNAVAILABLE' || Date.now() >= deadline) throw error;
          if (context.sandbox.mode !== 'danger-full-access' && /Failed to allocate buffer/.test(await startupLogHead(context.paths.driverLog))) {
            fail('SANDBOX_UNAVAILABLE', 'The compositor cannot allocate output buffers under the current confined executor; inspect driver logs. The execution policy was not relaxed.');
          }
          await new Promise(resolve => setTimeout(resolve, 75));
        }
      }
      check(handle.info, 'PROTOCOL_UNAVAILABLE', 'Output information is unavailable.');
      const first = handle.info.outputs[0], requested = config.display;
      if (first.physicalWidth !== requested.width || first.physicalHeight !== requested.height || first.scale !== requested.scale) {
        if (metadata.id === 'sway') {
          const command = `output ${JSON.stringify(first.name)} mode --custom ${requested.width}x${requested.height} scale ${requested.scale}`;
          const replies = JSON.parse(await run(context, handle, 'swaymsg', ['-s', handle.ipcSocket, '-r', command]));
          check(Array.isArray(replies) && replies.length > 0 && replies.every(reply => reply.success), 'START_FAILED', 'Sway rejected the requested output geometry.');
        } else {
          check(context.executables.wlrRandr && handle.info.protocols.has('zwlr_output_manager_v1'), 'PROTOCOL_UNAVAILABLE', 'Requested geometry needs wlr-randr and output-management protocol.');
          await run(context, handle, 'wlrRandr', ['--output', first.name, '--custom-mode', `${requested.width}x${requested.height}`, '--scale', String(requested.scale)]);
        }
        snapshot = await observe(context, handle);
      }
      const actual = handle.info.outputs[0];
      check(actual.physicalWidth === requested.width && actual.physicalHeight === requested.height && Math.abs(actual.scale - requested.scale) < 0.0001, 'START_FAILED', 'Compositor did not apply the requested display geometry.');
      return { ok: true, value: { handle, snapshot: { ...snapshot, state: 'running' } } };
    },
    async exec(context, handle, request) {
      await assertOwnedConnection(context, handle);
      const env = { ...handle.env, ...request.env };
      const process = unwrap(await context.processes.launch({ argv: [request.command.executable, ...(request.command.args ?? [])], cwd: request.cwd, env, role: 'application', logPath: request.logPath }));
      return { ok: true, value: { process, application: { applicationId: request.applicationId, instanceId: context.instanceId, command: request.command, state: 'running', createdAt: now(), logPath: request.logPath } } };
    },
    async inspect(context, handle) { return { ok: true, value: { ...await observe(context, handle), state: 'running' } }; },
    async capture(context, handle, target, includeCursor) { return { ok: true, value: await capture(context, handle, target, includeCursor) }; },
    async input(context, handle, action) { await input(context, handle, action); return { ok: true, value: null }; },
    async stop(context) { const result = await context.processes.terminateAll(); if (result.ok && result.value.remainingProcessIds.length === 0) await removeOwnedSockets(context.paths.runtimeDirectory); return result; },
  };
}
/**
 * @param {import('../driver.ts').DriverDeclaration<import('../drivers/host.ts').HostOptions, 'host'>} metadata
 * @param {{probe: import('../driver.ts').HostGuiDriver<import('../drivers/host.ts').HostOptions, import('./driver-types.ts').HostHandle>['probe']}} options
 * @returns {import('../driver.ts').HostGuiDriver<import('../drivers/host.ts').HostOptions, import('./driver-types.ts').HostHandle>}
 */
export function createHostDriver(metadata, { probe }) {
  return { kind: 'host', declaration: metadata, probe,
    async connect(context, options) {
      check(context.display.runtimeDirectory && context.display.waylandDisplay, 'PROTOCOL_UNAVAILABLE', 'The initial host adapter needs an existing compatible Wayland display.');
      /** @type {import('./driver-types.ts').HostHandle} */
      const handle = { driverId: 'host', config: { options, cwd: context.workspaceRoot }, env: { XDG_RUNTIME_DIR: context.display.runtimeDirectory, XDG_CACHE_HOME: context.paths.cacheDirectory, WAYLAND_DISPLAY: context.display.waylandDisplay, DISPLAY: null, XAUTHORITY: null, SWAYSOCK: null, I3SOCK: null } };
      const snapshot = await observe(context, handle, context.consent.scopes.includes('inspect') ? 'inspect' : 'capture');
      return { ok: true, value: { handle, snapshot: { ...snapshot, state: 'connected' } } };
    },
    async inspect(context, handle) { return { ok: true, value: { ...await observe(context, handle), state: 'connected' } }; },
    async capture(context, handle, target, includeCursor) { return { ok: true, value: await capture(context, handle, target, includeCursor) }; },
    async disconnect(context) { return context.helpers.terminateHelpers(); },
  };
}
