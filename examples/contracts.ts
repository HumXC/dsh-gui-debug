import type { InstanceConfig } from '../src/config.ts';
import type { StartInput, ExecInput, CaptureInput, InputInput, HostInput } from '../src/api.ts';

export const hostConnectExample = {
  action: 'connect',
  reason: '检查当前桌面上用户指出的渲染问题。',
  scopes: ['inspect', 'capture'],
} satisfies HostInput;

export const cageConfig = {
  schemaVersion: 1,
  driver: { id: 'cage' },
} satisfies InstanceConfig;

export const swayConfig = {
  schemaVersion: 1,
  driver: { id: 'sway', options: { config: { source: 'bundled', name: 'minimal' } } },
  mode: 'headless',
  display: { width: 1280, height: 720, scale: 1 },
} satisfies InstanceConfig;

export const startExample = {
  source: { kind: 'inline', config: swayConfig },
  overrides: { desktopSettings: 'inherit', env: { LANG: 'C.UTF-8' } },
} satisfies StartInput;

export const execExample = {
  instanceId: 'instance-example',
  command: { executable: './build/demo', args: ['--verbose'] },
  env: { DEBUG: '1', OLD_FLAG: null },
} satisfies ExecInput;

export const privateDesktopConfig = {
  schemaVersion: 1,
  driver: { id: 'cage' },
  desktopSettings: 'private',
} satisfies InstanceConfig;

export const captureExample = {
  instanceId: 'instance-example',
  target: { kind: 'output' },
} satisfies CaptureInput;

export const inputExample = {
  instanceId: 'instance-example',
  actions: [
    { type: 'text', text: 'Hello' },
    { type: 'key', key: 'Return' },
    { type: 'move', mode: 'relative', dx: 30, dy: 20 },
    { type: 'click' },
  ],
  captureAfter: true,
} satisfies InputInput;

/** Valid request shape; dispatch requires pointer.absolute plus a usable capture mapping. */
export const absoluteClickExample = {
  instanceId: 'instance-example',
  actions: [{ type: 'click', point: { captureId: 'capture-example', x: 400, y: 200 } }],
  captureAfter: true,
} satisfies InputInput;
