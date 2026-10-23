import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export class GuiError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'GuiError'; this.code = code; Object.assign(this, details); }
}
/** @returns {never} */
export function fail(code, message, details = {}) { throw new GuiError(code, message, details); }
/** @param {unknown} condition @returns {asserts condition} */
export function check(condition, code, message, details = {}) { if (!condition) fail(code, message, details); }
export const id = prefix => `${prefix}-${randomBytes(6).toString('hex')}`;
export const compactId = prefix => `${prefix}${randomBytes(6).toString('base64url')}`;
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export const now = () => new Date().toISOString();
export function cancelled(signal) { if (signal?.aborted) fail(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED', signal.reason?.name === 'TimeoutError' ? 'Operation timed out.' : 'Operation cancelled.'); }
export async function sleep(ms, signal) {
  try { await delay(ms, undefined, { signal }); } catch (error) { cancelled(signal); throw error; }
}
export function errorValue(error, details = {}) {
  return { code: error instanceof GuiError ? error.code : 'START_FAILED', message: String(error?.message ?? error).slice(0, 2048), ...details,
    ...Object.fromEntries(['instanceId', 'applicationId', 'dependencyIds'].filter(key => error?.[key] !== undefined).map(key => [key, error[key]])) };
}
export const capabilityNames = ['application.exec', 'capture.output', 'capture.region', 'capture.window', 'input.text', 'input.key', 'pointer.relative', 'pointer.absolute', 'pointer.click', 'pointer.scroll', 'pointer.drag', 'windows.list', 'windows.focus'];
/** @returns {import('../api.ts').Capabilities} */
export function unavailableCapabilities(reason = 'Not supported by this driver.') {
  return /** @type {import('../api.ts').Capabilities} */ (Object.fromEntries(capabilityNames.map(name => [name, { available: false, reason }])));
}
export function page(items, limit = 20, cursor) {
  check(cursor === undefined || /^(0|[1-9]\d{0,8})$/.test(cursor), 'INVALID_CONFIG', 'Invalid page cursor.');
  const offset = Number(cursor ?? 0), result = items.slice(offset, offset + limit);
  return { items: result, ...(offset + result.length < items.length ? { nextCursor: String(offset + result.length) } : {}) };
}
export function redact(value, secrets = []) {
  if (typeof value === 'string') return secrets.filter(secret => secret.length > 0).reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /KEY|PASSWORD|SECRET|TOKEN/i.test(key) && (typeof item === 'string') ? '[redacted]' : redact(item, secrets)]));
  return value;
}
export const secretValues = env => Object.entries(env ?? {}).filter(([key, value]) => /KEY|PASSWORD|SECRET|TOKEN/i.test(key) && typeof value === 'string' && value.length > 0).map(([, value]) => value);
export function policyKey(policy) { return digest({ mode: policy.mode, workspaceRoot: policy.workspaceRoot, runner: policy.runner, enforcement: policy.enforcement }); }
