import type { DesktopSettings, Environment, InstanceConfig, InstanceOverrides, Profile } from './config.ts';
import type { JsonObject, JsonSchema } from './schema.ts';

export type Capability =
  | 'application.exec'
  | 'capture.output' | 'capture.region' | 'capture.window'
  | 'input.text' | 'input.key' | 'pointer.relative' | 'pointer.absolute'
  | 'pointer.click' | 'pointer.scroll' | 'pointer.drag'
  | 'windows.list' | 'windows.focus';

export interface CapabilityStatus {
  available: boolean;
  /** e.g. grim, compositor-native, sway-ipc; diagnostic information only. */
  provider?: string;
  reason?: string;
  limitations?: string[];
}
export type Capabilities = Record<Capability, CapabilityStatus>;

export interface DependencyStatus {
  id: string;
  executable: string;
  status: 'found' | 'missing' | 'incompatible';
  resolvedPath?: string;
  version?: string;
  reason?: string;
  requiredFor: Array<'start' | 'exec' | 'probe' | Capability>;
}

export type DriverKind = 'managed' | 'host';
export type HostScope = 'inspect' | 'capture';
export interface HostAccessSummary {
  scopes: HostScope[];
  confirmedAt: string;
}
export type HostInput =
  | { action: 'connect'; reason: string; scopes: HostScope[]; options?: JsonObject }
  | { action: 'disconnect'; instanceId: string };
export type HostOutput =
  | { instance: Extract<InstanceDetails, { kind: 'host' }> }
  | { disconnectedInstanceId: string };

export interface DriverSummary {
  id: string;
  kind: DriverKind;
  title: string;
  description: string;
}
export interface DriverDetails extends DriverSummary {
  optionsSchema: JsonSchema;
  defaultConfig: InstanceConfig;
  notes: string[];
}
export type DriversInput =
  | { action: 'list' }
  | { action: 'describe'; driverId: string }
  | { action: 'check'; config: InstanceConfig };
export interface ProbeReport {
  driverId: string;
  /** Only startup requirements determine ready; optional features can be unavailable. */
  ready: boolean;
  dependencies: DependencyStatus[];
  /** Preflight estimates. start() confirms capabilities against the actual instance. */
  capabilities: Capabilities;
  warnings: string[];
}
export type DriversOutput = { drivers: DriverSummary[] } | { driver: DriverDetails } | ProbeReport;

export type ProfileInput =
  | { action: 'list' }
  | { action: 'get'; profileId: string }
  | { action: 'put'; profileId: string; description?: string; config: InstanceConfig }
  | { action: 'delete'; profileId: string };
export type ProfileOutput =
  | { profiles: Array<Pick<Profile, 'id' | 'description'>> }
  | { profile: Profile }
  | { deletedProfileId: string };

export interface StartInput {
  /** Omitted: create an empty instance using the built-in Cage defaults. */
  source?: { kind: 'profile'; profileId: string } | { kind: 'inline'; config: InstanceConfig };
  overrides?: InstanceOverrides;
}
export interface ExecInput {
  instanceId: string;
  command: { executable: string; args?: string[] };
  cwd?: string;
  env?: Environment;
  /** Application spawn/readiness timeout, not its maximum lifetime. */
  startupTimeoutMs?: number;
}

export type ApplicationState = 'starting' | 'running' | 'exited' | 'failed';
export interface ApplicationRun {
  applicationId: string;
  instanceId: string;
  command: { executable: string; args: string[] };
  state: ApplicationState;
  createdAt: string;
  pid?: number;
  exitCode?: number;
  signal?: string;
  logPath: string;
}
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
/** Actual enforcement, not a profile option or a permission request. */
export type SandboxStatus =
  | { mode: 'danger-full-access'; enforcement: 'unconfined'; workspaceRoot: string }
  | { mode: 'read-only' | 'workspace-write'; enforcement: 'full' | 'partial'; workspaceRoot: string; runner: string };

export type InstanceState = 'starting' | 'running' | 'exited' | 'stopping' | 'stopped' | 'failed';
interface InstanceIdentity {
  instanceId: string;
  driverId: string;
  createdAt: string;
}
export type InstanceSummary = InstanceIdentity & (
  | { kind: 'managed'; state: InstanceState; applicationCounts: Record<ApplicationState, number> }
  | { kind: 'host'; state: 'connected' | 'disconnected'; access: HostAccessSummary }
);
export interface OutputInfo {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}
export interface WindowInfo { id: string; title: string; appId?: string; focused: boolean }
export type InstanceDetails = (
  | (Extract<InstanceSummary, { kind: 'managed' }> & { effectiveConfig: InstanceConfig; desktopSettings: DesktopSettings })
  | (Extract<InstanceSummary, { kind: 'host' }> & { effectiveOptions: JsonObject })
) & {
  capabilities: Capabilities;
  outputs: OutputInfo[];
  windows?: WindowInfo[];
  /** Monotonic token changes when capture/input geometry becomes invalid. */
  layoutRevision: string;
  artifactDirectory: string;
  sandbox: SandboxStatus;
  warnings: string[];
}
export interface StartOutput { instance: Extract<InstanceDetails, { kind: 'managed' }> }
export interface ExecOutput { application: ApplicationRun }

export type CaptureTarget =
  | { kind: 'output'; outputId?: string }
  | { kind: 'region'; outputId: string; x: number; y: number; width: number; height: number }
  | { kind: 'window'; windowId: string };
export interface CaptureInput {
  instanceId: string;
  target?: CaptureTarget;
  includeCursor?: boolean;
}
export interface CaptureArtifact {
  captureId: string;
  instanceId: string;
  path: string;
  attachmentId: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  capturedAt: string;
  layoutRevision: string;
  /** xLayout=a*xImage+c*yImage+e; yLayout=b*xImage+d*yImage+f. */
  imageToLayout?: { a: number; b: number; c: number; d: number; e: number; f: number };
}
export interface CaptureOutput { capture: CaptureArtifact }

export interface CapturePoint { captureId: string; x: number; y: number }
export type MouseButton = 'left' | 'middle' | 'right';
export type Modifier = 'ctrl' | 'alt' | 'shift' | 'super';
export type InputAction =
  | { type: 'text'; text: string }
  | { type: 'key'; key: string; modifiers?: Modifier[]; holdMs?: number }
  | { type: 'move'; mode: 'relative'; dx: number; dy: number }
  | { type: 'move'; mode: 'absolute'; point: CapturePoint }
  | { type: 'click'; button?: MouseButton; point?: CapturePoint; count?: number }
  | { type: 'scroll'; dx: number; dy: number }
  | { type: 'drag'; from: CapturePoint; to: CapturePoint; button?: MouseButton; durationMs?: number }
  | { type: 'focus'; windowId: string }
  | { type: 'wait'; durationMs: number };
export interface InputInput {
  instanceId: string;
  actions: InputAction[];
  captureAfter?: boolean;
}
export interface InputOutput {
  instanceId: string;
  completedActions: number;
  /** A batch stops at its first failure and is not rolled back. */
  failedAction?: { index: number; code: ErrorCode; message: string };
  capture?: CaptureArtifact;
  captureError?: { code: ErrorCode; message: string };
}

export type InspectInput =
  | { action: 'list'; limit?: number; cursor?: string }
  | { action: 'status'; instanceId: string }
  | { action: 'applications'; instanceId: string; limit?: number; cursor?: string }
  | { action: 'logs'; instanceId: string; source?: { kind: 'driver' } | { kind: 'application'; applicationId: string }; cursor?: string; maxBytes?: number };
export type InspectOutput =
  | { instances: InstanceSummary[]; nextCursor?: string }
  | { instance: InstanceDetails }
  | { applications: ApplicationRun[]; nextCursor?: string }
  | { instanceId: string; applicationId?: string; text: string; nextCursor: string; truncated: boolean };
export interface StopInput { instanceId: string }
export interface StopOutput {
  instanceId: string;
  state: 'stopped' | 'failed';
  remainingProcessIds: string[];
  artifactDirectory: string;
}

export type ErrorCode =
  | 'INVALID_CONFIG' | 'UNKNOWN_DRIVER' | 'PROFILE_NOT_FOUND' | 'INSTANCE_NOT_FOUND' | 'APPLICATION_NOT_FOUND'
  | 'DEPENDENCY_MISSING' | 'DEPENDENCY_INCOMPATIBLE' | 'PROTOCOL_UNAVAILABLE'
  | 'UNSUPPORTED_CAPABILITY' | 'START_FAILED' | 'INSTANCE_NOT_RUNNING'
  | 'CAPTURE_NOT_FOUND' | 'STALE_CAPTURE' | 'INPUT_FAILED' | 'CAPTURE_FAILED'
  | 'EXEC_FAILED' | 'SANDBOX_UNAVAILABLE' | 'SANDBOX_DENIED' | 'POLICY_MISMATCH'
  | 'UNSUPPORTED_OPERATION' | 'HOST_CONFIRMATION_REQUIRED' | 'HOST_CONFIRMATION_REJECTED'
  | 'HOST_CONFIRMATION_UNAVAILABLE' | 'HOST_ACCESS_REVOKED'
  | 'STOP_FAILED' | 'TIMEOUT' | 'CANCELLED';
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string; instanceId?: string; applicationId?: string; dependencyIds?: string[] } };
