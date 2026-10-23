import type { JsonObject, JsonSchema } from './schema.ts';

export interface DisplayConfig {
  width: number;
  height: number;
  scale: number;
}

/** null removes an inherited variable. Connection variables are reserved by the host. */
export type Environment = Record<string, string | null>;

/** A settings preference, independent of DSH's filesystem sandbox policy. */
export type DesktopSettings = 'inherit' | 'private';

/** A reusable recipe, not live process state. Relative paths use the workspace root. */
export interface InstanceConfig {
  schemaVersion: 1;
  driver: { id: string; options?: JsonObject };
  mode?: 'headless' | 'nested';
  display?: DisplayConfig;
  cwd?: string;
  env?: Environment;
  desktopSettings?: DesktopSettings;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** Arrays replace; env and driverOptions merge by key. Driver id cannot change here. */
export interface InstanceOverrides {
  mode?: 'headless' | 'nested';
  display?: DisplayConfig;
  cwd?: string;
  env?: Environment;
  desktopSettings?: DesktopSettings;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  driverOptions?: JsonObject;
}

export interface Profile {
  id: string;
  description?: string;
  config: InstanceConfig;
}

export const displaySchema = {
  type: 'object', additionalProperties: false,
  properties: {
    width: { type: 'integer', minimum: 1, maximum: 16384 },
    height: { type: 'integer', minimum: 1, maximum: 16384 },
    scale: { type: 'number', exclusiveMinimum: 0, maximum: 4 },
  },
  required: ['width', 'height', 'scale'],
} as const satisfies JsonSchema;

export const environmentSchema = {
  type: 'object', propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
  additionalProperties: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  description: 'Overlay inherited desktop/application environment; null unsets a key. Runtime/socket variables are reserved.',
} as const satisfies JsonSchema;

// Shared properties are declaration data, not a configuration merge implementation.
export const commonConfigProperties = {
  mode: { type: 'string', enum: ['headless', 'nested'], default: 'headless', description: 'nested opens a separate compositor window on the parent desktop.' },
  display: displaySchema,
  cwd: { type: 'string', minLength: 1, description: 'Working directory; relative to the workspace root.' },
  env: environmentSchema,
  desktopSettings: { type: 'string', enum: ['inherit', 'private'], default: 'inherit', description: 'inherit preserves user XDG config/data/state for fonts and themes; private uses instance directories. Runtime and cache are always instance-owned. Neither mode changes sandbox permissions.' },
  startupTimeoutMs: { type: 'integer', minimum: 100, maximum: 120000, default: 15000 },
  stopTimeoutMs: { type: 'integer', minimum: 100, maximum: 30000, default: 5000 },
} as const satisfies Record<string, JsonSchema>;

export const instanceConfigSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:dsh-gui-debug:instance-config:1',
  title: 'GUI debug instance configuration',
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    driver: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1, description: 'Registered driver id; discover with gui_debug_drivers.' },
        options: { type: 'object', additionalProperties: true, description: 'Validated separately against the selected driver optionsSchema.' },
      },
      required: ['id'],
    },
    ...commonConfigProperties,
  },
  required: ['schemaVersion', 'driver'],
} as const satisfies JsonSchema;

export const instanceOverridesSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    ...commonConfigProperties,
    driverOptions: { type: 'object', additionalProperties: true, description: 'Top-level option keys replace the corresponding driver defaults/profile options; nested values replace as a whole.' },
  },
} as const satisfies JsonSchema;

/** Applied explicitly by the future host; JSON Schema default annotations do not mutate input. */
export const commonDefaults = {
  mode: 'headless',
  display: { width: 1280, height: 720, scale: 1 },
  desktopSettings: 'inherit',
  startupTimeoutMs: 15000,
  stopTimeoutMs: 5000,
} as const;

export const defaultInstanceConfig = {
  schemaVersion: 1,
  driver: { id: 'cage', options: {} },
  ...commonDefaults,
} as const satisfies InstanceConfig;
