import { commonDefaults } from '../config.ts';
import type { DriverDeclaration } from '../driver.ts';

export type SwayConfigSource =
  | { source: 'bundled'; name: 'minimal' }
  | { source: 'file'; path: string }
  | { source: 'inline'; text: string };
export interface SwayOptions {
  config?: SwayConfigSource;
  debug?: boolean;
  xwayland?: boolean;
  executables?: { sway?: string; swaymsg?: string; grim?: string; wtype?: string; wlrctl?: string; waylandInfo?: string; xwayland?: string };
}

export const swayDriver = {
  id: 'sway',
  kind: 'managed',
  title: 'Sway',
  description: 'Isolated multi-window GUI debugging with Sway IPC and a minimal compositor configuration.',
  optionsSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      config: { type: 'object', oneOf: [
        { type: 'object', additionalProperties: false, properties: { source: { const: 'bundled' }, name: { const: 'minimal' } }, required: ['source', 'name'] },
        { type: 'object', additionalProperties: false, properties: { source: { const: 'file' }, path: { type: 'string', minLength: 1 } }, required: ['source', 'path'] },
        { type: 'object', additionalProperties: false, properties: { source: { const: 'inline' }, text: { type: 'string', minLength: 1 } }, required: ['source', 'text'] },
      ] },
      debug: { type: 'boolean', default: false },
      xwayland: { type: 'boolean', default: false },
      executables: {
        type: 'object', additionalProperties: false,
        properties: {
          sway: { type: 'string', minLength: 1 }, swaymsg: { type: 'string', minLength: 1 },
          grim: { type: 'string', minLength: 1 }, wtype: { type: 'string', minLength: 1 },
          wlrctl: { type: 'string', minLength: 1 }, waylandInfo: { type: 'string', minLength: 1 },
          xwayland: { type: 'string', minLength: 1 },
        },
      },
    },
  },
  defaultOptions: { config: { source: 'bundled', name: 'minimal' }, debug: false, xwayland: false },
  defaultConfig: {
    schemaVersion: 1,
    driver: { id: 'sway', options: { config: { source: 'bundled', name: 'minimal' } } },
    ...commonDefaults,
  },
  externalTools: [
    { id: 'sway', executable: 'sway', purpose: 'Create the compositor.' },
    { id: 'swaymsg', executable: 'swaymsg', purpose: 'Query and control owned windows, outputs and lifecycle.' },
    { id: 'grim', executable: 'grim', purpose: 'Output and region screenshots.' },
    { id: 'wtype', executable: 'wtype', purpose: 'Text, keys, shortcuts and timed key holds.' },
    { id: 'wlrctl', executable: 'wlrctl', purpose: 'Relative pointer motion, clicks and scrolling.' },
    { id: 'waylandInfo', executable: 'wayland-info', purpose: 'Inspect the instance protocol registry.' },
    { id: 'xwayland', executable: 'Xwayland', purpose: 'Optional X11 application compatibility.' },
  ],
  capabilityPlans: {
    'application.exec': { implementation: { kind: 'native', facility: 'Launch a managed application into the already running instance socket.' } },
    'capture.output': { implementation: { kind: 'external', toolIds: ['grim'] }, protocols: ['zwlr_screencopy_manager_v1'] },
    'capture.region': { implementation: { kind: 'external', toolIds: ['grim'] }, protocols: ['zwlr_screencopy_manager_v1'] },
    'input.text': { implementation: { kind: 'external', toolIds: ['wtype'] }, protocols: ['zwp_virtual_keyboard_manager_v1'] },
    'input.key': { implementation: { kind: 'external', toolIds: ['wtype'] }, protocols: ['zwp_virtual_keyboard_manager_v1'] },
    'pointer.relative': { implementation: { kind: 'external', toolIds: ['wlrctl'] }, protocols: ['zwlr_virtual_pointer_manager_v1'] },
    'pointer.click': { implementation: { kind: 'external', toolIds: ['wlrctl'] }, protocols: ['zwlr_virtual_pointer_manager_v1'] },
    'pointer.scroll': { implementation: { kind: 'external', toolIds: ['wlrctl'] }, protocols: ['zwlr_virtual_pointer_manager_v1'] },
    'windows.list': { implementation: { kind: 'native', facility: 'Sway get_tree IPC, transported by swaymsg' } },
    'windows.focus': { implementation: { kind: 'native', facility: 'Sway container focus IPC, transported by swaymsg' } },
  },
  resources: [{ id: 'minimal', path: 'defaults/sway.config', description: 'No bar, user-config includes, autostart commands or application keybindings.' }],
  notes: [
    'Pass sway --config with an explicit instance file from wmConfigDirectory, independently of XDG_CONFIG_HOME.',
    'The minimal resource is the base; runtime-owned output, socket and XWayland settings are generated separately.',
    'Create the environment first, then launch applications through the managed process scope.',
    'file/inline config replaces the base; runtime-owned settings remain controlled by the driver.',
    'Use the instance IPC socket explicitly for every swaymsg request.',
    'The default configuration does not require swaybar, swaybg, a terminal or a launcher.',
  ],
} satisfies DriverDeclaration<SwayOptions, 'managed'>;
