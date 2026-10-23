import type { DriverDeclaration } from '../driver.ts';

/** The initial observation adapter targets desktops exposing wlroots screencopy. */
export interface HostOptions {
  captureBackend?: 'grim';
  executables?: { grim?: string; waylandInfo?: string };
}

export const hostDriver = {
  id: 'host',
  kind: 'host',
  title: 'Current desktop',
  description: 'Observe an existing desktop after explicit user confirmation; never manage its compositor or applications.',
  optionsSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      captureBackend: { type: 'string', const: 'grim', default: 'grim' },
      executables: {
        type: 'object', additionalProperties: false,
        properties: { grim: { type: 'string', minLength: 1 }, waylandInfo: { type: 'string', minLength: 1 } },
      },
    },
  },
  defaultOptions: { captureBackend: 'grim' },
  // Discovery data only: gui_debug_start must reject this driver kind.
  defaultConfig: { schemaVersion: 1, driver: { id: 'host', options: {} } },
  externalTools: [
    { id: 'grim', executable: 'grim', purpose: 'Capture the existing desktop only after capture consent.' },
    { id: 'waylandInfo', executable: 'wayland-info', purpose: 'Inspect existing output/protocol information only after inspect consent.' },
  ],
  capabilityPlans: {
    'capture.output': { implementation: { kind: 'external', toolIds: ['grim'] }, protocols: ['zwlr_screencopy_manager_v1'] },
    'capture.region': { implementation: { kind: 'external', toolIds: ['grim'] }, protocols: ['zwlr_screencopy_manager_v1'] },
  },
  resources: [],
  notes: [
    'Use gui_debug_host connect, not gui_debug_start; require a live root user confirmation before connecting or observing.',
    'No start, stop, application exec, window management, configuration changes or input in this initial host contract.',
    'Disconnect revokes plugin access and stops only its owned observation helpers; never stop the host desktop.',
    'Consent is bound to the session, instance, scopes, display identity and frozen resolved helper configuration.',
    'Profile options, full-access sandbox mode and model-supplied flags cannot authorize host access.',
    'The initial grim adapter requires compatible Wayland protocols; it does not claim GNOME, KDE or X11 compatibility.',
    'Other native screenshot adapters may be added inside this driver without changing the unified capture interface.',
  ],
} satisfies DriverDeclaration<HostOptions, 'host'>;
