import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import path from 'node:path';
import { commonDefaults, defaultInstanceConfig, instanceConfigSchema, instanceOverridesSchema } from '../config.ts';
import { cageDriver } from '../drivers/cage.ts';
import { swayDriver } from '../drivers/sway.ts';
import { hostDriver } from '../drivers/host.ts';
import { toolDeclarations } from '../tools.ts';
import { check, fail } from './common.mjs';

export const declarations = new Map([cageDriver, swayDriver, hostDriver].map(driver => [driver.id, driver]));
const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
const configuration = ajv.compile(instanceConfigSchema);
const overrideCheck = ajv.compile(instanceOverridesSchema);
const optionChecks = new Map([...declarations].map(([key, driver]) => [key, ajv.compile(driver.optionsSchema)]));
const toolChecks = new Map(toolDeclarations.map(tool => [tool.name, ajv.compile(tool.parameters)]));
function validate(validator, value, label) {
  check(validator(value), 'INVALID_CONFIG', `${label}: ${ajv.errorsText(validator.errors, { separator: '; ' })}`);
}
export function validateArgs(name, args) { validate(toolChecks.get(name), args, name); }
export function declaration(driverId) {
  const result = declarations.get(driverId);
  check(result, 'UNKNOWN_DRIVER', `Unknown driver: ${driverId}.`); return result;
}
export function validateOptions(driverId, options = {}) { validate(optionChecks.get(driverId), options, `${driverId} options`); }
export function validateConfig(config) {
  validate(configuration, config, 'Instance configuration'); declaration(config.driver.id); validateOptions(config.driver.id, config.driver.options ?? {});
}
const reserved = new Set(['XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'WAYLAND_DISPLAY', 'DISPLAY', 'XAUTHORITY', 'SWAYSOCK', 'I3SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'WLR_BACKENDS', 'WLR_HEADLESS_OUTPUTS']);
export function validateEnv(env, settings = 'inherit') {
  for (const key of Object.keys(env ?? {})) {
    check(!reserved.has(key) && !(settings === 'private' && ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].includes(key)), 'INVALID_CONFIG', `${key} is owned by the instance.`);
    check(!key.startsWith('DSH_'), 'INVALID_CONFIG', 'DSH environment facts cannot be overridden.');
  }
}
/**
 * @param {string} workspaceRoot
 * @param {import('../config.ts').InstanceConfig} [config]
 * @param {import('../config.ts').InstanceOverrides} [overrides]
 */
export function resolveConfig(workspaceRoot, config = defaultInstanceConfig, overrides = {}) {
  validateConfig(config);
  validate(overrideCheck, overrides, 'Instance overrides');
  const metadata = declaration(config.driver.id);
  check(metadata.kind === 'managed', 'UNSUPPORTED_OPERATION', 'Host drivers cannot be started; use gui_debug_host connect.');
  const options = { ...metadata.defaultOptions, ...config.driver.options, ...overrides.driverOptions };
  validateOptions(metadata.id, options);
  const { driver, schemaVersion, ...base } = config;
  const { driverOptions, ...changes } = overrides;
  const resolved = { ...commonDefaults, ...base, ...changes, driverId: metadata.id, options,
    cwd: path.resolve(workspaceRoot, overrides.cwd ?? config.cwd ?? '.'), env: { ...config.env, ...overrides.env } };
  validateConfig(effectiveConfig(resolved));
  validateEnv(resolved.env, resolved.desktopSettings);
  return resolved;
}
export function effectiveConfig(config) {
  return { schemaVersion: 1, driver: { id: config.driverId, options: config.options }, mode: config.mode, display: config.display,
    cwd: config.cwd, env: config.env, desktopSettings: config.desktopSettings, startupTimeoutMs: config.startupTimeoutMs, stopTimeoutMs: config.stopTimeoutMs };
}
export function resolveHostOptions(options = {}) {
  validateOptions('host', options); return { ...hostDriver.defaultOptions, ...options };
}
