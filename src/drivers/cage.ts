import { commonDefaults } from '../config.ts';
import type { DriverDeclaration } from '../driver.ts';

export interface CageOptions {
  debug?: boolean;
  decorations?: boolean;
  xwayland?: boolean;
  executables?: { cage?: string; grim?: string; wtype?: string; wlrctl?: string; waylandInfo?: string; wlrRandr?: string; xwayland?: string };
}

export const cageDriver = {
  id: 'cage',
  kind: 'managed',
  title: 'Cage',
  description: 'Isolated kiosk compositor for single-application GUI debugging.',
  optionsSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      debug: { type: 'boolean', default: false },
      decorations: { type: 'boolean', default: false },
      xwayland: { type: 'boolean', default: false },
      executables: {
        type: 'object', additionalProperties: false,
        properties: {
          cage: { type: 'string', minLength: 1 }, grim: { type: 'string', minLength: 1 },
          wtype: { type: 'string', minLength: 1 }, wlrctl: { type: 'string', minLength: 1 },
          waylandInfo: { type: 'string', minLength: 1 }, wlrRandr: { type: 'string', minLength: 1 },
          xwayland: { type: 'string', minLength: 1 },
        },
      },
    },
  },
  defaultOptions: { debug: false, decorations: false, xwayland: false },
  defaultConfig: { schemaVersion: 1, driver: { id: 'cage', options: {} }, ...commonDefaults },
  externalTools: [
    { id: 'cage', executable: 'cage', purpose: 'Create the compositor.' },
    { id: 'grim', executable: 'grim', purpose: 'Output and region screenshots.' },
    { id: 'wtype', executable: 'wtype', purpose: 'Text, keys, shortcuts and timed key holds.' },
    { id: 'wlrctl', executable: 'wlrctl', purpose: 'Relative pointer motion, clicks and scrolling.' },
    { id: 'waylandInfo', executable: 'wayland-info', purpose: 'Inspect the instance protocol registry.' },
    { id: 'wlrRandr', executable: 'wlr-randr', purpose: 'Set and verify requested output geometry.' },
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
  },
  resources: [],
  notes: [
    'No compositor config file is needed; empty driver options select defaults.',
    'Headless uses an owned virtual output; nested uses a separate window on the parent display.',
    'Requested geometry must be applied and verified, using output management when necessary; never silently substitute another resolution.',
    'The initial driver does not promise absolute pointer motion, dragging or direct window capture.',
    'Start Cage without an application; require an installed version supporting this mode, such as the verified 0.3.1 source.',
    'Application exit does not terminate the empty-mode Cage environment; no dummy keepalive command is needed.',
    'Cage needs no WM config file. Desktop XDG settings are inherited independently of the private Wayland runtime.',
  ],
} satisfies DriverDeclaration<CageOptions, 'managed'>;
