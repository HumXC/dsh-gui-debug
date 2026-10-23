import { environmentSchema, instanceConfigSchema, instanceOverridesSchema } from './config.ts';
import type {
  DriversInput, DriversOutput, ProfileInput, ProfileOutput, StartInput, StartOutput, ExecInput, ExecOutput,
  CaptureInput, CaptureOutput, InputInput, InputOutput, InspectInput, InspectOutput,
  HostInput, HostOutput, StopInput, StopOutput, Result,
} from './api.ts';
import type { JsonSchema, ToolDeclaration } from './schema.ts';

// Pure schema composition. No tool handlers or registrations exist in this draft.
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
  ({ type: 'object', additionalProperties: false, properties, required });
const text: JsonSchema = { type: 'string', minLength: 1 };
const instanceId: JsonSchema = { ...text, description: 'Instance id from gui_debug_start, a confirmed gui_debug_host connection, or gui_debug_inspect.' };
const profileId: JsonSchema = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$' };
const number: JsonSchema = { type: 'number' };
const button: JsonSchema = { type: 'string', enum: ['left', 'middle', 'right'], default: 'left' };
const point = object({
  captureId: { ...text, description: 'Capture from this instance; layout revision must still match.' },
  x: { type: 'number', minimum: 0, description: 'Horizontal pixel coordinate in the original captured image.' },
  y: { type: 'number', minimum: 0, description: 'Vertical pixel coordinate in the original captured image.' },
}, ['captureId', 'x', 'y']);
const duration: JsonSchema = { type: 'integer', minimum: 0, maximum: 10000 };
const config: JsonSchema = instanceConfigSchema;

export const inputActionSchema: JsonSchema = {
  type: 'object', oneOf: [
    object({ type: { const: 'text' }, text: { type: 'string', minLength: 1, maxLength: 16384 } }, ['type', 'text']),
    object({
      type: { const: 'key' },
      key: { ...text, description: 'XKB keysym name, e.g. Return, Escape, Left or w. This is a key event, not text.' },
      modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'super'] }, maxItems: 4 },
      holdMs: { ...duration, default: 0, description: 'Hold within this action, then release; state never persists to the next tool call.' },
    }, ['type', 'key']),
    object({ type: { const: 'move' }, mode: { const: 'relative' }, dx: number, dy: number }, ['type', 'mode', 'dx', 'dy']),
    object({ type: { const: 'move' }, mode: { const: 'absolute' }, point }, ['type', 'mode', 'point']),
    object({ type: { const: 'click' }, button, point, count: { type: 'integer', minimum: 1, maximum: 3, default: 1 } }, ['type']),
    object({ type: { const: 'scroll' }, dx: number, dy: number }, ['type', 'dx', 'dy']),
    object({ type: { const: 'drag' }, from: point, to: point, button, durationMs: { ...duration, default: 300 } }, ['type', 'from', 'to']),
    object({ type: { const: 'focus' }, windowId: text }, ['type', 'windowId']),
    object({ type: { const: 'wait' }, durationMs: duration }, ['type', 'durationMs']),
  ],
};

export const driversTool = {
  name: 'gui_debug_drivers',
  description: 'List GUI drivers, describe their options and defaults, or check a configuration for dependencies and expected capabilities without starting an instance.',
  parameters: { type: 'object', oneOf: [
    object({ action: { const: 'list' } }, ['action']),
    object({ action: { const: 'describe' }, driverId: text }, ['action', 'driverId']),
    object({ action: { const: 'check' }, config }, ['action', 'config']),
  ] },
} satisfies ToolDeclaration<DriversInput, Result<DriversOutput>>;

export const profileTool = {
  name: 'gui_debug_profile',
  description: 'List, read, save or delete workspace GUI configuration profiles. Saving replaces the whole profile; changes do not alter running instances.',
  parameters: { type: 'object', oneOf: [
    object({ action: { const: 'list' } }, ['action']),
    object({ action: { const: 'get' }, profileId }, ['action', 'profileId']),
    object({ action: { const: 'put' }, profileId, description: { type: 'string', maxLength: 1024 }, config }, ['action', 'profileId', 'config']),
    object({ action: { const: 'delete' }, profileId }, ['action', 'profileId']),
  ] },
} satisfies ToolDeclaration<ProfileInput, Result<ProfileOutput>>;

export const hostTool = {
  name: 'gui_debug_host',
  description: 'Request explicit user confirmation to observe the current desktop, or disconnect and revoke this plugin connection. Host access is read-only and cannot start/stop the desktop, launch applications, change settings or inject input.',
  parameters: { type: 'object', oneOf: [
    object({
      action: { const: 'connect' },
      reason: { type: 'string', minLength: 1, maxLength: 1024, description: 'Explain the task requiring real desktop observation; show it in the user confirmation.' },
      scopes: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['inspect', 'capture'] }, description: 'Only these requested operations may be granted for this live session connection.' },
      options: { type: 'object', additionalProperties: true, description: 'Host driver options, validated against its optionsSchema and frozen before confirmation; cannot provide consent.' },
    }, ['action', 'reason', 'scopes']),
    object({ action: { const: 'disconnect' }, instanceId }, ['action', 'instanceId']),
  ] },
} satisfies ToolDeclaration<HostInput, Result<HostOutput>>;

export const startTool = {
  name: 'gui_debug_start',
  description: 'Start an empty managed GUI environment. Return its instance id, status, sandbox facts, outputs and available operations; applications are launched separately with gui_debug_exec. Host drivers cannot be started.',
  parameters: object({
    source: { type: 'object', description: 'Omit to use the built-in Cage configuration.', oneOf: [
      object({ kind: { const: 'profile' }, profileId }, ['kind', 'profileId']),
      object({ kind: { const: 'inline' }, config }, ['kind', 'config']),
    ] },
    overrides: { ...instanceOverridesSchema, description: 'Override this instance only. Driver id remains the same.' },
  }),
} satisfies ToolDeclaration<StartInput, Result<StartOutput>>;

export const execTool = {
  name: 'gui_debug_exec',
  description: 'Launch an application in an existing managed instance. Return its application id and process status. Application exit does not stop the environment; host connections cannot execute applications.',
  parameters: object({
    instanceId,
    command: object({
      executable: { ...text, description: 'Executable name or path; not a shell command string.' },
      args: { type: 'array', items: { type: 'string' }, default: [] },
    }, ['executable']),
    cwd: { ...text, description: 'Override the instance working directory for this application; relative to the workspace root.' },
    env: { ...environmentSchema, description: 'Overlay instance environment for this application only; null removes a key. Managed connection and cache variables remain reserved.' },
    startupTimeoutMs: { type: 'integer', minimum: 100, maximum: 120000, default: 15000, description: 'Application launch timeout, not its maximum runtime. A running process does not guarantee a mapped window.' },
  }, ['instanceId', 'command']),
} satisfies ToolDeclaration<ExecInput, Result<ExecOutput>>;

export const captureTool = {
  name: 'gui_debug_capture',
  description: 'Capture an instance as a PNG image attachment. Return its capture id and original image dimensions for subsequent coordinate input.',
  parameters: object({
    instanceId,
    target: { type: 'object', description: 'Omit for the primary output. Region coordinates use output-local logical units; window capture requires capture.window.', oneOf: [
      object({ kind: { const: 'output' }, outputId: text }, ['kind']),
      object({
        kind: { const: 'region' }, outputId: text,
        x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 },
        width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 },
      }, ['kind', 'outputId', 'x', 'y', 'width', 'height']),
      object({ kind: { const: 'window' }, windowId: text }, ['kind', 'windowId']),
    ] },
    includeCursor: { type: 'boolean', default: false },
  }, ['instanceId']),
} satisfies ToolDeclaration<CaptureInput, Result<CaptureOutput>>;

export const inputTool = {
  name: 'gui_debug_input',
  description: 'Send an ordered action batch to a managed instance, optionally capturing afterward. Stop at the first failed action and report completed actions; earlier actions are not rolled back. Host connections do not accept input.',
  parameters: object({
    instanceId,
    actions: {
      type: 'array', items: inputActionSchema, minItems: 1, maxItems: 64,
      description: 'Relative movement uses logical pixels; scrolling uses driver-normalized logical axis units (positive right/down). Absolute points use pixels in an original capture. Total requested waits/holds/drag durations must not exceed 30 seconds.',
    },
    captureAfter: { type: 'boolean', default: false, description: 'Capture the primary output after the batch, including after a partially executed batch.' },
  }, ['instanceId', 'actions']),
} satisfies ToolDeclaration<InputInput, Result<InputOutput>>;

export const inspectTool = {
  name: 'gui_debug_inspect',
  description: 'List workspace instances or application runs, inspect instance capabilities/windows, or read a bounded page of driver or application logs.',
  parameters: { type: 'object', oneOf: [
    object({ action: { const: 'list' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, cursor: text }, ['action']),
    object({ action: { const: 'status' }, instanceId }, ['action', 'instanceId']),
    object({ action: { const: 'applications' }, instanceId, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, cursor: text }, ['action', 'instanceId']),
    object({
      action: { const: 'logs' }, instanceId,
      source: { type: 'object', description: 'Omit for driver logs.', oneOf: [
        object({ kind: { const: 'driver' } }, ['kind']),
        object({ kind: { const: 'application' }, applicationId: text }, ['kind', 'applicationId']),
      ] },
      cursor: { ...text, description: 'Opaque continuation token; omit to read the most recent page.' },
      maxBytes: { type: 'integer', minimum: 1, maximum: 65536, default: 8192 },
    }, ['action', 'instanceId']),
  ] },
} satisfies ToolDeclaration<InspectInput, Result<InspectOutput>>;

export const stopTool = {
  name: 'gui_debug_stop',
  description: 'Stop a managed instance and its owned processes, retaining screenshots and logs. Repeating stop is safe. Host connections cannot be stopped; use gui_debug_host disconnect to revoke access.',
  parameters: object({ instanceId }, ['instanceId']),
} satisfies ToolDeclaration<StopInput, Result<StopOutput>>;

/** DSH adapter will project name/description/parameters and supply executable handlers. */
export const toolDeclarations = [driversTool, profileTool, hostTool, startTool, execTool, captureTool, inputTool, inspectTool, stopTool] as const;
