// Opt-in Linux integration lane. Run from the repository, with its already-built devShell tools on PATH.
// Uses the installed DSH subprocess/fs/sandbox providers, synthetic test-session identities and private headless displays.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
// Set GUI_DEBUG_BUNDLE_DIR to exercise an installed package in this isolated test process.
const bundleDirectory = process.env.GUI_DEBUG_BUNDLE_DIR ? path.resolve(process.env.GUI_DEBUG_BUNDLE_DIR) : undefined;
const runtimeModule = name => bundleDirectory ? pathToFileURL(path.join(bundleDirectory, 'dist/src/runtime', `${name}.mjs`)).href : new URL(`../src/runtime/${name}.mjs`, import.meta.url).href;
const [{ GuiEngine }, { DshPlatform }, { pngDimensions }] = await Promise.all(['engine', 'platform', 'geometry'].map(name => import(runtimeModule(name))));

const manifest = process.env.GUI_DEBUG_DSH_MANIFEST;
if (!manifest) throw new Error('Set GUI_DEBUG_DSH_MANIFEST to the installed DSH package.json. This test never installs packages.');
const requireDsh = createRequire(path.resolve(manifest));
const { Context } = await import(requireDsh.resolve('@deepseek-ai/cordis'));
const context = new Context(), fibers = [];
for (const name of ['@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-sandbox-local']) {
  const plugin = await import(requireDsh.resolve(name));
  const fiber = context.plugin(plugin.default, {}); fibers.push(fiber); await fiber.await();
}
const workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gui-')));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const resourceRoot = bundleDirectory ?? repositoryRoot;
const outputRoot = path.join(repositoryRoot, '.dsh', 'gui-debug', 'development', 'integration', String(Date.now()));
await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
assert.equal(await fs.realpath(outputRoot), outputRoot, 'Evidence directory must not be redirected by a symlink.');
const sentinel = path.join(outputRoot, 'sandbox-sentinel');
await fs.writeFile(sentinel, 'protected', { flag: 'wx', mode: 0o600 });
const agent = { id: `gui-integration-${Date.now()}` }, session = { id: agent.id };
let mode = 'danger-full-access', attachmentCounter = 0;
const ctx = { fs: context.fs, subprocess: context.subprocess, sandbox: context.sandbox,
  agents: { get: key => key === agent.id ? agent : undefined, roots: () => [agent] }, sessions: { get: key => key === agent.id ? session : undefined },
  sandboxPolicy: { resolve: () => ({ mode, workspaceRoot, sessionId: agent.id }) },
  approval: { overrideOf: () => 'never' }, userQuestions: { ask: () => { throw new Error('This integration lane must never ask for or observe the real desktop.'); } },
  attachments: { saveImage: async ({ data, mediaType, name }) => ({ attachmentId: `native-image-${++attachmentCounter}`, mediaType, bytes: data.length, name,
    width: data.readUInt32BE(16), height: data.readUInt32BE(20) }) },
};
const platform = new DshPlatform(ctx); platform.desktop = () => ({});
const engine = new GuiEngine(platform, { resourceRoot });
const exec = { agent, signal: new AbortController().signal, callId: 'native-integration' };
const runtimeBundle = bundleDirectory ? { directory: bundleDirectory, version: JSON.parse(await fs.readFile(path.join(bundleDirectory, 'package.json'), 'utf8')).version } : { directory: resourceRoot, source: true };
const results = { workspaceRoot, outputRoot, runtimeBundle, providers: ['fs-local', 'subprocess-local', 'sandbox-local'], drivers: {}, sandbox: {} };
const call = async (name, args) => { const result = await engine.execute(name, args, exec); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
try {
  for (const driverId of ['cage', 'sway']) {
    const config = { schemaVersion: 1, driver: { id: driverId, options: {} }, mode: 'headless', display: { width: 640, height: 400, scale: 1 }, startupTimeoutMs: 15000 };
    const preflight = await call('gui_debug_drivers', { action: 'check', config }); assert.equal(preflight.ready, true, JSON.stringify(preflight));
    const { instance } = await call('gui_debug_start', { source: { kind: 'inline', config } });
    const instanceId = instance.instanceId;
    assert.equal(instance.state, 'running'); assert.equal(instance.applicationCounts.running, 0);
    assert.equal(instance.outputs[0].width, 640); assert.equal(instance.outputs[0].height, 400);
    const { application } = await call('gui_debug_exec', { instanceId, command: { executable: 'foot', args: ['--title', 'GUI Debug Runtime Verification', '--', 'bash', '--noprofile', '--norc'] } });
    await delay(600);
    const injected = await call('gui_debug_input', { instanceId, actions: [{ type: 'text', text: "printf 'GUI_DEBUG_ENGINE_OK\\n'" }, { type: 'key', key: 'Return' }, { type: 'move', mode: 'relative', dx: 8, dy: 4 }] });
    assert.equal(injected.completedActions, 3, JSON.stringify(injected)); await delay(250);
    const image = await call('gui_debug_capture', { instanceId });
    assert.equal(image.capture.width, 640); assert.equal(image.capture.height, 400);
    const evidence = path.join(outputRoot, `${driverId}.png`); await fs.copyFile(image.capture.path, evidence, fs.constants.COPYFILE_EXCL);
    const region = await call('gui_debug_capture', { instanceId, target: { kind: 'region', outputId: instance.outputs[0].id, x: 12, y: 16, width: 160, height: 100 } });
    assert.equal(region.capture.width, 160); assert.equal(region.capture.height, 100); assert.equal(region.capture.imageToLayout.e, 12); assert.equal(region.capture.imageToLayout.f, 16);
    await call('gui_debug_input', { instanceId, actions: [{ type: 'text', text: 'exit' }, { type: 'key', key: 'Return' }] });
    let applications;
    for (let attempt = 0; attempt < 30; attempt++) { ({ applications } = await call('gui_debug_inspect', { action: 'applications', instanceId })); if (applications[0].state === 'exited') break; await delay(100); }
    assert.equal(applications[0].state, 'exited');
    assert.equal((await call('gui_debug_inspect', { action: 'status', instanceId })).instance.state, 'running');
    const stop = await call('gui_debug_stop', { instanceId }); assert.equal(stop.state, 'stopped'); assert.deepEqual(stop.remainingProcessIds, []);
    assert.deepEqual((await call('gui_debug_stop', { instanceId })).remainingProcessIds, []);
    assert.equal((await pngDimensions(evidence)).width, 640);
    results.drivers[driverId] = { emptyStart: true, appExitKeepsEnvironment: true, applicationId: application.applicationId, input: injected.completedActions, image: evidence, region: true, stop };
    console.log(JSON.stringify({ driverId, passed: true, image: evidence }));
  }
  mode = 'workspace-write';
  const invocation = await platform.invocation(exec);
  const policy = await platform.policy(invocation); results.sandbox = { mode, enforcement: policy.enforcement, runner: policy.runner };
  const inside = path.join(workspaceRoot, 'allowed-write');
  const code = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(inside)},'allowed');try{fs.writeFileSync(${JSON.stringify(sentinel)},'changed');console.log('OUTSIDE_WRITE_ALLOWED')}catch(e){console.log('OUTSIDE_WRITE_BLOCKED:'+e.code)}`;
  const handle = await platform.spawn({ argv: [process.execPath, '-e', code], cwd: workspaceRoot, env: {} }, invocation, policy, exec.signal);
  let diagnostic = ''; const drain = async stream => { for await (const chunk of stream) diagnostic += chunk.toString(); };
  const [outcome] = await Promise.all([handle.done, drain(handle.stdout), drain(handle.stderr)]);
  assert.equal(outcome.exitCode, 0, diagnostic); assert.match(diagnostic, /OUTSIDE_WRITE_BLOCKED:/); assert.equal(await fs.readFile(sentinel, 'utf8'), 'protected'); assert.equal(await fs.readFile(inside, 'utf8'), 'allowed');
  assert.equal(await handle.waitForExit(AbortSignal.timeout(5000)), true);
  results.sandbox.writeBoundary = true;
  const confinedResult = await engine.execute('gui_debug_start', { source: { kind: 'inline', config: { schemaVersion: 1, driver: { id: 'cage' }, display: { width: 320, height: 240, scale: 1 } } } }, exec);
  if (confinedResult.ok) {
    const confined = confinedResult.value;
    assert.equal(confined.instance.sandbox.mode, 'workspace-write');
    const confinedImage = await call('gui_debug_capture', { instanceId: confined.instance.instanceId }); assert.equal(confinedImage.capture.width, 320);
    const confinedStop = await call('gui_debug_stop', { instanceId: confined.instance.instanceId }); assert.deepEqual(confinedStop.remainingProcessIds, []); results.sandbox.managedCapture = true;
  } else {
    assert.equal(confinedResult.error.code, 'SANDBOX_UNAVAILABLE', JSON.stringify(confinedResult));
    const failed = engine.instances.get(confinedResult.error.instanceId); assert.ok(failed);
    assert.match(await fs.readFile(failed.paths.driverLog, 'utf8'), /Failed to allocate buffer/);
    const log = path.join(outputRoot, 'sandbox-renderer.log'); await fs.copyFile(failed.paths.driverLog, log, fs.constants.COPYFILE_EXCL);
    assert.deepEqual((await call('gui_debug_stop', { instanceId: failed.id })).remainingProcessIds, []);
    const after = await platform.policy(await platform.invocation(exec)); assert.equal(after.mode, 'workspace-write'); assert.equal(after.runner, policy.runner); assert.notEqual(after.enforcement, 'unconfined');
    results.sandbox.managedCapture = false;
    results.sandbox.renderingRestriction = { code: confinedResult.error.code, message: confinedResult.error.message, log, cleanupVerified: true, policyUnchanged: true };
  }
  mode = 'read-only';
  const readonly = await engine.execute('gui_debug_start', {}, exec); assert.equal(readonly.ok, false); assert.equal(readonly.error.code, 'SANDBOX_DENIED'); results.sandbox.readOnlyRejectsStart = true;
  await fs.writeFile(path.join(outputRoot, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ passed: true, outputRoot, runtimeBundle, sandbox: results.sandbox }));
} catch (error) {
  for (const record of engine.instances.values()) {
    try { await fs.copyFile(record.paths.driverLog, path.join(outputRoot, `${record.driverId}-${record.id}.log`), fs.constants.COPYFILE_EXCL); }
    catch (copyError) { if (copyError.code !== 'ENOENT') console.error(`Evidence copy failed: ${copyError.code}`); }
  }
  await fs.writeFile(path.join(outputRoot, 'error.json'), `${JSON.stringify({ error: String(error), results }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.error(`Native evidence: ${outputRoot}`);
  throw error;
} finally {
  await engine.closeAll();
  for (const fiber of fibers.toReversed()) await fiber.dispose();
  // Only the fresh temporary workspace and this run's own sentinel may be removed.
  const resolvedWorkspace = await fs.realpath(workspaceRoot);
  assert.equal(resolvedWorkspace, workspaceRoot); assert.equal(path.dirname(resolvedWorkspace), await fs.realpath(os.tmpdir())); assert.ok(/^gui-[a-zA-Z0-9]{6}$/.test(path.basename(resolvedWorkspace)));
  await fs.rm(resolvedWorkspace, { recursive: true, force: true });
  assert.equal(path.resolve(sentinel), path.join(outputRoot, 'sandbox-sentinel')); await fs.unlink(sentinel);
}
