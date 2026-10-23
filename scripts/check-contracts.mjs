import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { commonDefaults, instanceConfigSchema, instanceOverridesSchema } from '../src/config.ts';
import { toolDeclarations, inputActionSchema } from '../src/tools.ts';
import { cageDriver } from '../src/drivers/cage.ts';
import { swayDriver } from '../src/drivers/sway.ts';
import { hostDriver } from '../src/drivers/host.ts';
import * as examples from '../examples/contracts.ts';

// An explicit alternate module path permits validation with an existing local Ajv.
// No fallback download or dependency installation is performed.
const require = createRequire(import.meta.url);
const Ajv2020 = require(process.env.GUI_DEBUG_AJV_MODULE || 'ajv/dist/2020.js').default;
const ajv = new Ajv2020({ strict: true, allErrors: true });
let checks = 0;
const compile = schema => ajv.compile(schema);
const expectValid = (validate, value, label) => {
  assert.equal(validate(value), true, `${label}: ${JSON.stringify(validate.errors)}`);
  checks++;
};
const expectInvalid = (validate, value, label) => {
  assert.equal(validate(value), false, `${label}: unexpectedly accepted`);
  checks++;
};

const validateConfig = compile(instanceConfigSchema);
expectValid(validateConfig, examples.cageConfig, 'minimal Cage recipe');
expectValid(validateConfig, examples.swayConfig, 'minimal Sway recipe');
expectValid(validateConfig, examples.privateDesktopConfig, 'private desktop settings');
assert.equal(commonDefaults.desktopSettings, 'inherit');
checks++;
expectInvalid(validateConfig, { ...examples.cageConfig, isolateAppState: true }, 'removed implicit settings isolation');
expectInvalid(validateConfig, { ...examples.cageConfig, desktopSettings: 'sandbox-off' }, 'settings cannot select sandbox policy');
expectInvalid(validateConfig, { ...examples.cageConfig, sandboxMode: 'danger-full-access' }, 'profiles cannot override DSH policy');
expectValid(validateConfig, { schemaVersion: 1, driver: { id: 'future-native-capture-driver', options: { nativeCapture: true } } }, 'extensible driver id');
expectInvalid(validateConfig, { schemaVersion: 1, driver: { id: 'cage' }, surprise: true }, 'unknown common field');
expectInvalid(validateConfig, { schemaVersion: 1, driver: { id: 'cage' }, display: { width: 0, height: 720, scale: 1 } }, 'invalid display geometry');
expectInvalid(compile(instanceOverridesSchema), { driver: { id: 'sway' } }, 'override cannot switch driver');

const drivers = [cageDriver, swayDriver, hostDriver];
for (const driver of drivers) {
  assert.equal(driver.defaultConfig.driver.id, driver.id);
  checks++;
  expectValid(validateConfig, driver.defaultConfig, `${driver.id} default config`);
  const validateOptions = compile(driver.optionsSchema);
  expectValid(validateOptions, driver.defaultOptions, `${driver.id} default options`);
  expectValid(validateOptions, driver.defaultConfig.driver.options, `${driver.id} recipe options`);
  expectValid(validateOptions, {}, `${driver.id} omitted options`);
  expectInvalid(validateOptions, { unknownOption: true }, `${driver.id} unknown option`);
  const toolIds = new Set(driver.externalTools.map(tool => tool.id));
  for (const plan of Object.values(driver.capabilityPlans)) {
    if (plan.implementation.kind === 'external') {
      for (const id of plan.implementation.toolIds) assert.ok(toolIds.has(id), `undeclared dependency ${id}`);
    }
  }
  for (const resource of driver.resources) {
    await readFile(new URL(`../${resource.path}`, import.meta.url), 'utf8');
    checks++;
  }
}

for (const value of [false, true]) expectInvalid(compile(swayDriver.optionsSchema), { legacyPointerIpc: value }, 'removed Sway pointer IPC option');

assert.equal(hostDriver.kind, 'host');
assert.equal(cageDriver.kind, 'managed');
assert.equal(swayDriver.kind, 'managed');
for (const capability of ['application.exec', 'input.text', 'input.key', 'pointer.absolute', 'windows.focus']) {
  assert.ok(!(capability in hostDriver.capabilityPlans), `host must not advertise ${capability}`);
  checks++;
}
expectInvalid(compile(hostDriver.optionsSchema), { desktopSettings: 'private' }, 'host cannot change desktop settings');
expectInvalid(compile(hostDriver.optionsSchema), { approved: true }, 'host options cannot grant consent');

const validators = new Map();
for (const tool of toolDeclarations) {
  assert.ok(!validators.has(tool.name), `duplicate tool ${tool.name}`);
  validators.set(tool.name, compile(tool.parameters));
  assert.ok(!('execute' in tool), 'declarations must not contain handlers');
  checks++;
}
const good = (name, value) => expectValid(validators.get(name), value, name);
const bad = (name, value) => expectInvalid(validators.get(name), value, name);
good('gui_debug_drivers', { action: 'list' });
good('gui_debug_drivers', { action: 'describe', driverId: 'sway' });
good('gui_debug_drivers', { action: 'check', config: examples.cageConfig });
good('gui_debug_profile', { action: 'put', profileId: 'sway-test', config: examples.swayConfig });
good('gui_debug_host', examples.hostConnectExample);
good('gui_debug_host', { action: 'connect', reason: '读取用户请求的屏幕截图', scopes: ['capture'] });
good('gui_debug_host', { action: 'disconnect', instanceId: 'host-example' });
bad('gui_debug_host', { action: 'start' });
bad('gui_debug_host', { action: 'stop', instanceId: 'host-example' });
bad('gui_debug_host', { action: 'confirm', approved: true });
bad('gui_debug_host', { ...examples.hostConnectExample, approved: true });
bad('gui_debug_host', { ...examples.hostConnectExample, consent: { scopes: ['capture'] } });
bad('gui_debug_host', { ...examples.hostConnectExample, scopes: [] });
bad('gui_debug_host', { ...examples.hostConnectExample, scopes: ['input'] });
bad('gui_debug_host', { action: 'connect', scopes: ['capture'] });
good('gui_debug_start', {});
good('gui_debug_start', examples.startExample);
good('gui_debug_exec', examples.execExample);
good('gui_debug_exec', { instanceId: 'instance-example', command: { executable: 'demo' } });
bad('gui_debug_start', { command: { executable: 'demo' } });
bad('gui_debug_exec', { command: { executable: 'demo' } });
bad('gui_debug_exec', { ...examples.execExample, source: { kind: 'inline', config: examples.swayConfig } });
good('gui_debug_capture', examples.captureExample);
good('gui_debug_input', examples.inputExample);
good('gui_debug_input', examples.absoluteClickExample);
good('gui_debug_inspect', { action: 'status', instanceId: 'instance-example' });
good('gui_debug_inspect', { action: 'applications', instanceId: 'instance-example', limit: 20 });
good('gui_debug_inspect', { action: 'logs', instanceId: 'instance-example', maxBytes: 8192 });
good('gui_debug_inspect', { action: 'logs', instanceId: 'instance-example', source: { kind: 'application', applicationId: 'application-example' } });
bad('gui_debug_inspect', { action: 'logs', instanceId: 'instance-example', source: { kind: 'application' } });
good('gui_debug_stop', { instanceId: 'instance-example' });
bad('gui_debug_drivers', { action: 'describe' });
bad('gui_debug_profile', { action: 'delete', profileId: '../outside' });
bad('gui_debug_exec', { instanceId: 'one', command: 'demo --flag' });
bad('gui_debug_start', { source: { kind: 'profile', profileId: 'one', config: examples.cageConfig } });
bad('gui_debug_capture', { instanceId: 'one', target: { kind: 'region', x: 0, y: 0, width: 10, height: 10 } });
bad('gui_debug_input', { instanceId: 'one', actions: [] });
bad('gui_debug_input', { instanceId: 'one', actions: [{ type: 'move', mode: 'absolute', dx: 10, dy: 10 }] });
bad('gui_debug_inspect', { action: 'list', instanceId: 'one' });
const action = compile(inputActionSchema);
expectValid(action, { type: 'key', key: 'w', holdMs: 300 }, 'timed key hold');
expectInvalid(action, { type: 'key', key: 'w', holdMs: 30000 }, 'bounded key hold');

// Keep the bundled base free of desktop integrations and extra processes.
const swayBase = await readFile(new URL('../defaults/sway.config', import.meta.url), 'utf8');
const directives = swayBase.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
assert.doesNotMatch(directives, /^\s*(bar\b|include\b|exec\b|exec_always\b|bindsym\b|bindcode\b)/m);
checks++;
console.log(`Contract validation passed: ${checks} checks; ${toolDeclarations.length} tool schemas; ${drivers.length} driver schemas.`);
console.log(`Workspace: ${fileURLToPath(new URL('..', import.meta.url))}`);
