import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GuiError, redact, secretValues, unavailableCapabilities } from '../src/runtime/common.mjs';
import { resolveConfig, effectiveConfig, resolveHostOptions, validateArgs, validateEnv } from '../src/runtime/config.mjs';
import { WorkspaceStore } from '../src/runtime/storage.mjs';
import { captureRegion, mapPoint, parseSwayOutputs, parseWaylandInfo, prepareAction, publicOutputs, revision, swayWindows } from '../src/runtime/geometry.mjs';

const configRoot = path.join(os.tmpdir(), 'gui-debug-config-fixture');
const cageRecipe = () => ({ schemaVersion: 1, driver: { id: 'cage', options: {} } });
const hasCode = code => error => error instanceof GuiError && error.code === code;
const missing = error => error?.code === 'ENOENT';

async function temporaryWorkspace(t) {
  const tempParent = await fs.realpath(os.tmpdir());
  const created = await fs.mkdtemp(path.join(tempParent, 'dsh-gui-debug-core-'));
  const tempRoot = await fs.realpath(created);
  t.after(async () => {
    // Only remove the exact directory created by this test, never a computed workspace/plugin path.
    assert.equal(path.resolve(created), tempRoot);
    assert.equal(path.dirname(tempRoot), tempParent);
    assert.match(path.basename(tempRoot), /^dsh-gui-debug-core-[a-zA-Z0-9]+$/);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  const workspace = path.join(tempRoot, 'workspace');
  const outside = path.join(tempRoot, 'outside');
  await fs.mkdir(workspace); await fs.mkdir(outside);
  return { workspace, outside, store: new WorkspaceStore(workspace), policy: { mode: 'workspace-write', workspaceRoot: workspace } };
}

test('config overlays preserve explicit removals, replace nested driver options and leave the recipe intact', () => {
  const recipe = { ...cageRecipe(), cwd: 'profile-cwd', env: { KEEP: 'profile', DROP: 'inherited', GTK_THEME: 'Adwaita' },
    driver: { id: 'cage', options: { debug: true, executables: { grim: '/profile/grim', wtype: '/profile/wtype' } } } };
  const overrides = { cwd: 'run-cwd', display: { width: 900, height: 600, scale: 1.5 },
    env: { KEEP: 'call', DROP: null }, driverOptions: { executables: { grim: '/call/grim' } } };
  const originalRecipe = structuredClone(recipe), originalOverrides = structuredClone(overrides);
  const result = resolveConfig(configRoot, recipe, overrides);
  assert.equal(result.cwd, path.join(configRoot, 'run-cwd'));
  assert.deepEqual(result.env, { KEEP: 'call', DROP: null, GTK_THEME: 'Adwaita' });
  assert.deepEqual(result.display, { width: 900, height: 600, scale: 1.5 });
  assert.deepEqual(result.options.executables, { grim: '/call/grim' });
  assert.equal(result.options.debug, true);
  assert.equal(result.options.decorations, false);
  assert.equal(result.desktopSettings, 'inherit');
  assert.equal(result.driverId, 'cage');
  assert.deepEqual(recipe, originalRecipe); assert.deepEqual(overrides, originalOverrides);
  const snapshot = effectiveConfig(result);
  assert.equal(snapshot.driver.id, 'cage'); assert.equal(snapshot.env.DROP, null);
  assert.ok(!('driverOptions' in snapshot));
});

test('Sway config sources replace the entire base source rather than leaking prior inline text', () => {
  const recipe = { schemaVersion: 1, driver: { id: 'sway', options: { config: { source: 'inline', text: 'set $secret value' }, debug: true } } };
  const result = resolveConfig(configRoot, recipe, { driverOptions: { config: { source: 'file', path: 'fixtures/sway.conf' } } });
  assert.deepEqual(result.options.config, { source: 'file', path: 'fixtures/sway.conf' });
  assert.equal(result.options.debug, true);
});

test('final configuration validation rejects incomplete or out-of-range call overrides', () => {
  for (const overrides of [
    { display: { width: 640 } },
    { display: { width: 640, height: 480, scale: 0 } },
    { startupTimeoutMs: -1 },
    { mode: 'host' },
  ]) assert.throws(() => resolveConfig(configRoot, cageRecipe(), overrides), hasCode('INVALID_CONFIG'), JSON.stringify(overrides));
});

test('reserved connection/backend/cache variables cannot redirect managed applications to another desktop', () => {
  for (const key of ['XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'WAYLAND_DISPLAY', 'DISPLAY', 'XAUTHORITY', 'SWAYSOCK', 'I3SOCK', 'WLR_BACKENDS', 'WLR_HEADLESS_OUTPUTS', 'DSH_SESSION_ID']) {
    assert.throws(() => resolveConfig(configRoot, { ...cageRecipe(), env: { [key]: '/other/desktop' } }), hasCode('INVALID_CONFIG'), key);
    assert.throws(() => validateEnv({ [key]: null }), hasCode('INVALID_CONFIG'), `${key}=null`);
  }
  assert.doesNotThrow(() => validateEnv({ HOME: '/home/test', GTK_THEME: 'Adwaita', FONTCONFIG_FILE: '/fonts.conf', XDG_CONFIG_HOME: '/user/config' }));
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    assert.throws(() => validateEnv({ [key]: '/foreign' }, 'private'), hasCode('INVALID_CONFIG'), key);
  }
});

test('host references cannot enter managed start, and host options cannot manage environments or supply consent', () => {
  assert.throws(() => resolveConfig(configRoot, { schemaVersion: 1, driver: { id: 'host' } }), hasCode('UNSUPPORTED_OPERATION'));
  for (const options of [{ desktopSettings: 'private' }, { mode: 'headless' }, { config: { source: 'inline', text: 'exec anything' } }, { approved: true }, { consent: 'model-provided' }]) {
    assert.throws(() => resolveHostOptions(options), hasCode('INVALID_CONFIG'), JSON.stringify(options));
  }
  assert.deepEqual(resolveHostOptions({ executables: { grim: '/installed/grim' } }), { captureBackend: 'grim', executables: { grim: '/installed/grim' } });
  const request = { action: 'connect', reason: 'Read the screen requested by the user.', scopes: ['capture'] };
  assert.doesNotThrow(() => validateArgs('gui_debug_host', request));
  for (const invalid of [
    { ...request, approved: true }, { ...request, confirmed: true }, { ...request, consent: {} },
    { ...request, scopes: ['input'] }, { ...request, scopes: [] },
    { action: 'start' }, { action: 'stop', instanceId: 'host-fixture' }, { action: 'confirm' },
  ]) assert.throws(() => validateArgs('gui_debug_host', invalid), hasCode('INVALID_CONFIG'));
});

test('diagnostic redaction removes configured credentials from nested output without mutating evidence', () => {
  const env = { API_TOKEN: 'test-private-value', GTK_THEME: 'Adwaita' };
  const evidence = { env, logs: ['failure: test-private-value', { stderr: 'test-private-value appeared' }], output: 'ok' };
  const copy = structuredClone(evidence);
  const result = redact(evidence, secretValues(env));
  assert.equal(result.env.API_TOKEN, '[redacted]');
  assert.equal(result.env.GTK_THEME, 'Adwaita');
  assert.ok(!JSON.stringify(result).includes('test-private-value'));
  assert.deepEqual(evidence, copy);
});

test('profiles survive a new store instance and complete replacements preserve JSON values', async t => {
  const { workspace, store, policy } = await temporaryWorkspace(t);
  const file = store.profilePath('render-check');
  const first = { id: 'render-check', description: '字体与主题', config: { ...cageRecipe(), env: { GTK_THEME: 'Adwaita', DROP: null } } };
  await store.writeJSON(file, first, policy);
  const reopened = new WorkspaceStore(workspace);
  assert.deepEqual(await reopened.profiles(), ['render-check']);
  assert.deepEqual(await reopened.readJSON(reopened.profilePath('render-check')), first);
  const replacement = { id: 'render-check', config: { schemaVersion: 1, driver: { id: 'sway' } } };
  await reopened.writeJSON(file, replacement, policy);
  assert.deepEqual(await store.readJSON(file), replacement);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await reopened.deleteProfile('render-check', policy);
  assert.deepEqual(await store.profiles(), []);
  assert.equal(await store.readJSON(file), undefined);
});

test('workspace storage rejects traversal and prefix lookalikes without touching outside evidence', async t => {
  const { store, outside, policy } = await temporaryWorkspace(t);
  const evidence = path.join(outside, 'keep.json'); await fs.writeFile(evidence, '{"keep":true}');
  for (const target of [evidence, path.join(store.base, '..', 'other-plugin', 'state.json'), `${store.base}-lookalike/state.json`]) {
    await assert.rejects(store.writeJSON(target, { overwrite: true }, policy), hasCode('INVALID_CONFIG'));
    await assert.rejects(store.readJSON(target), hasCode('INVALID_CONFIG'));
  }
  for (const name of ['../outside/keep', '.', '..', 'bad/name', '/absolute', 'bad\\name']) {
    assert.throws(() => store.profilePath(name), hasCode('INVALID_CONFIG'));
  }
  assert.equal(await fs.readFile(evidence, 'utf8'), '{"keep":true}');
});

test('symlinked .dsh ancestor cannot redirect plugin reads or writes', async t => {
  const { workspace, outside, store, policy } = await temporaryWorkspace(t);
  await fs.symlink(outside, path.join(workspace, '.dsh'), 'dir');
  await assert.rejects(store.writeJSON(store.profilePath('redirected'), { secret: true }, policy), hasCode('INVALID_CONFIG'));
  await assert.rejects(store.profiles(), hasCode('INVALID_CONFIG'));
  assert.deepEqual(await fs.readdir(outside), []);
});

test('symlinked profile files are neither read nor deleted as normal profiles', async t => {
  const { outside, store, policy } = await temporaryWorkspace(t);
  const evidence = path.join(outside, 'private.json'); await fs.writeFile(evidence, '{"private":"keep"}');
  const file = store.profilePath('linked'); await store.verify(file, { create: true }); await fs.symlink(evidence, file);
  await assert.rejects(store.readJSON(file), error => error?.code === 'ELOOP' || hasCode('INVALID_CONFIG')(error));
  await assert.rejects(store.deleteProfile('linked', policy), hasCode('INVALID_CONFIG'));
  assert.equal(await fs.readFile(evidence, 'utf8'), '{"private":"keep"}');
  assert.ok((await fs.lstat(file)).isSymbolicLink());
});

test('read-only policy prevents profile mutation and new runtime directories', async t => {
  const { workspace, store, policy } = await temporaryWorkspace(t);
  const original = { id: 'keep', config: cageRecipe() }, file = store.profilePath('keep');
  await store.writeJSON(file, original, policy);
  const readOnly = { mode: 'read-only', workspaceRoot: workspace };
  await assert.rejects(store.writeJSON(file, { overwritten: true }, readOnly), hasCode('SANDBOX_DENIED'));
  await assert.rejects(store.deleteProfile('keep', readOnly), hasCode('SANDBOX_DENIED'));
  await assert.rejects(store.instancePaths('gui-0123456789ab', 'managed', 'private', readOnly), hasCode('SANDBOX_DENIED'));
  assert.deepEqual(await store.readJSON(file), original);
  await assert.rejects(fs.stat(path.join(store.base, 'instances')), missing);
});

test('read-only rejection does not create a plugin storage tree in a clean workspace', async t => {
  const { workspace, store } = await temporaryWorkspace(t);
  await assert.rejects(store.writeJSON(store.profilePath('new'), {}, { mode: 'read-only', workspaceRoot: workspace }), hasCode('SANDBOX_DENIED'));
  await assert.rejects(fs.stat(path.join(workspace, '.dsh')), missing);
});

test('host storage allocates observation artifacts without manufacturing compositor or WM directories', async t => {
  const { store, policy } = await temporaryWorkspace(t);
  const paths = await store.instancePaths('host-0123456789ab', 'host', 'inherit', policy);
  assert.equal(paths.artifactDirectory, path.join(store.base, 'instances', 'host-0123456789ab', 'artifacts'));
  for (const name of ['runtimeDirectory', 'wmConfigDirectory', 'privateSettingsDirectory']) assert.ok(!(name in paths), name);
  for (const name of ['runtime', 'wm', 'settings']) await assert.rejects(fs.stat(path.join(paths.root, name)), missing);
  assert.equal((await fs.stat(paths.artifactDirectory)).mode & 0o777, 0o700);
});

function captureFixture(overrides = {}) {
  return { instanceId: 'gui-owner', layoutRevision: 'layout-a', width: 400, height: 200,
    imageToLayout: { a: 0, b: 0.5, c: -0.5, d: 0, e: 1000, f: -300 }, ...overrides };
}

test('capture pixels map through rotation, scaling and translation into negative layout coordinates', () => {
  const capture = captureFixture(), captures = new Map([['capture-a', capture]]);
  assert.deepEqual(mapPoint({ captureId: 'capture-a', x: 120, y: 80 }, captures, 'gui-owner', 'layout-a'), { x: 960, y: -240 });
  assert.deepEqual(mapPoint({ captureId: 'capture-a', x: 0, y: 0 }, captures, 'gui-owner', 'layout-a'), { x: 1000, y: -300 });
  assert.deepEqual(mapPoint({ captureId: 'capture-a', x: 399, y: 199 }, captures, 'gui-owner', 'layout-a'), { x: 900.5, y: -100.5 });
});

test('capture ownership, layout revision and image mapping availability are required before input', () => {
  const captures = new Map([['capture-a', captureFixture()]]), point = { captureId: 'capture-a', x: 1, y: 1 };
  assert.throws(() => mapPoint(point, captures, 'gui-other', 'layout-a'), hasCode('CAPTURE_NOT_FOUND'));
  assert.throws(() => mapPoint({ ...point, captureId: 'missing' }, captures, 'gui-owner', 'layout-a'), hasCode('CAPTURE_NOT_FOUND'));
  assert.throws(() => mapPoint(point, captures, 'gui-owner', 'layout-b'), hasCode('STALE_CAPTURE'));
  captures.set('capture-a', captureFixture({ imageToLayout: undefined }));
  assert.throws(() => mapPoint(point, captures, 'gui-owner', 'layout-a'), hasCode('STALE_CAPTURE'));
});

test('original capture pixel bounds are half-open and reject non-finite coordinates', () => {
  const captures = new Map([['capture-a', captureFixture()]]);
  for (const [x, y] of [[400, 0], [0, 200], [-1, 0], [0, -1], [NaN, 0], [0, Infinity]]) {
    assert.throws(() => mapPoint({ captureId: 'capture-a', x, y }, captures, 'gui-owner', 'layout-a'), hasCode('INVALID_CONFIG'));
  }
});

test('pointed clicks require both click and absolute-motion capability before any dispatch', () => {
  const capabilities = unavailableCapabilities(); capabilities['pointer.click'] = { available: true };
  const record = { id: 'gui-owner', snapshot: { layoutRevision: 'layout-a', capabilities }, captures: new Map([['capture-a', captureFixture()]]) };
  const action = { type: 'click', point: { captureId: 'capture-a', x: 120, y: 80 } };
  assert.throws(() => prepareAction(action, record), hasCode('UNSUPPORTED_CAPABILITY'));
  capabilities['pointer.absolute'] = { available: true };
  assert.deepEqual(prepareAction(action, record), { type: 'click', point: { x: 960, y: -240 } });
  assert.deepEqual(action.point, { captureId: 'capture-a', x: 120, y: 80 });
});

test('capture regions use output-local bounds and add the selected output layout origin', () => {
  const outputs = [{ id: 'left', name: 'left', x: -1920, y: 40, width: 1920, height: 1080, scale: 1 },
    { id: 'right', name: 'right', x: 0, y: 0, width: 1280, height: 720, scale: 2 }];
  const selected = captureRegion(outputs, { kind: 'region', outputId: 'left', x: 20, y: 10, width: 1900, height: 1070 });
  assert.equal(selected.x, -1900); assert.equal(selected.y, 50);
  assert.equal(selected.region.width, 1900); assert.equal(selected.output.id, 'left');
  assert.equal(captureRegion(outputs, { kind: 'output', outputId: 'right' }).region.width, 1280);
  for (const region of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 },
    { x: 1919, y: 0, width: 2, height: 1 }, { x: 0, y: 1079, width: 1, height: 2 }, { x: NaN, y: 0, width: 1, height: 1 }]) {
    assert.throws(() => captureRegion(outputs, { kind: 'region', outputId: 'left', ...region }), hasCode('INVALID_CONFIG'));
  }
  assert.throws(() => captureRegion(outputs, { kind: 'output', outputId: 'unknown' }), hasCode('INVALID_CONFIG'));
  assert.throws(() => captureRegion(outputs, { kind: 'window', windowId: '12' }), hasCode('UNSUPPORTED_CAPABILITY'));
});

// Text shape checked against wayland-utils 1.3.0 print_global_info/print_output_info:
// https://sources.debian.org/data/main/w/wayland-utils/1.3.0-1/wayland-info/wayland-info.c
const waylandNormal = `interface: 'wl_compositor',                             version:  6, name:  1
interface: 'zwlr_screencopy_manager_v1',                 version:  3, name:  2
interface: 'wl_output',                                 version:  4, name:  7
\tname: HEADLESS-1
\tdescription: Headless output
\tx: -1280, y: 30, scale: 2,
\tphysical_width: 0 mm, physical_height: 0 mm,
\tmake: 'headless', model: 'headless',
\tsubpixel_orientation: unknown, output_transform: normal,
\tmode:
\t\twidth: 1280 px, height: 720 px, refresh: 60.000 Hz,
\t\tflags: preferred
\tmode:
\t\twidth: 2560 px, height: 1440 px, refresh: 60.000 Hz,
\t\tflags: current preferred
interface: 'wl_seat',                                   version:  9, name:  8
\tname: seat0
\tcapabilities: pointer keyboard
`;

test('wayland-info fixture selects current mode, not preferred-only mode or seat metadata', () => {
  const result = parseWaylandInfo(waylandNormal);
  assert.ok(result.protocols.has('zwlr_screencopy_manager_v1'));
  assert.deepEqual(publicOutputs(result.outputs), [{ id: 'HEADLESS-1', name: 'HEADLESS-1', x: -1280, y: 30, width: 1280, height: 720, scale: 2 }]);
  assert.equal(result.outputs[0].physicalWidth, 2560);
  assert.equal(result.outputs[0].physicalHeight, 1440);
});

test('wayland-info rotated mode produces transposed logical extents', () => {
  const text = waylandNormal.replace('output_transform: normal', 'output_transform: 90°');
  const [output] = parseWaylandInfo(text).outputs;
  assert.equal(output.width, 720);
  assert.equal(output.height, 1280);
});

test('wayland-info xdg logical geometry overrides wl_output integer-scale estimates', () => {
  // The logical fields and quoted name follow print_xdg_output_v1_info in the same source.
  const text = `${waylandNormal}interface: 'zxdg_output_manager_v1',                       version:  3, name:  9
\txdg_output_v1
\t\toutput: 7
\t\tname: 'HEADLESS-1'
\t\tdescription: 'Fractionally scaled output'
\t\tlogical_x: -2048, logical_y: 25
\t\tlogical_width: 2048, logical_height: 1152
`;
  const [output] = parseWaylandInfo(text).outputs;
  assert.deepEqual({ x: output.x, y: output.y, width: output.width, height: output.height }, { x: -2048, y: 25, width: 2048, height: 1152 });
});

// Field names and meaning checked against Sway 1.12 sway-ipc(7), GET_OUTPUTS/GET_TREE:
// https://raw.githubusercontent.com/swaywm/sway/1.12/sway/sway-ipc.7.scd
const swayOutputFixture = [{ name: 'DP-1', active: true, scale: 1.5, transform: '90', current_mode: { width: 1920, height: 1080, refresh: 60000 },
  rect: { x: -720, y: 50, width: 720, height: 1280 } },
{ name: 'disabled', active: false, scale: -1, current_mode: null, rect: { x: 0, y: 0, width: 0, height: 0 } }];

test('Sway output parser trusts IPC logical rect for fractional scale and rotated displays', () => {
  const outputs = parseSwayOutputs(swayOutputFixture);
  assert.deepEqual(publicOutputs(outputs), [{ id: 'DP-1', name: 'DP-1', x: -720, y: 50, width: 720, height: 1280, scale: 1.5 }]);
  assert.equal(outputs[0].physicalWidth, 1920); assert.equal(outputs[0].transform, '90');
  const original = revision(outputs);
  for (const changed of [{ ...outputs[0], x: -721 }, { ...outputs[0], scale: 2 }, { ...outputs[0], transform: 'normal' }]) assert.notEqual(revision([changed]), original);
});

test('Sway tree parsing includes nested native and floating XWayland windows, excluding containers', () => {
  const tree = { id: 1, type: 'root', name: 'root', nodes: [{ id: 2, type: 'workspace', name: '1', nodes: [
    { id: 5, type: 'con', app_id: 'org.test.App', pid: 111, name: 'Native window', focused: true, nodes: [] },
  ], floating_nodes: [{ id: 6, type: 'floating_con', name: 'Floating container', nodes: [
    { id: 7, type: 'con', app_id: null, pid: 112, name: 'Legacy window', window_properties: { class: 'LegacyClass' }, focused: false },
  ] }] }] };
  assert.deepEqual(swayWindows(tree), [{ id: '5', title: 'Native window', appId: 'org.test.App', focused: true },
    { id: '7', title: 'Legacy window', appId: 'LegacyClass', focused: false }]);
  const capabilities = unavailableCapabilities(); capabilities['windows.focus'] = { available: true };
  const record = { snapshot: { capabilities, windows: swayWindows(tree) } };
  assert.doesNotThrow(() => prepareAction({ type: 'focus', windowId: '7' }, record));
  assert.throws(() => prepareAction({ type: 'focus', windowId: 'foreign-window' }, record), hasCode('INVALID_CONFIG'));
});
