import type { DesktopSettings, DisplayConfig, Environment, InstanceConfig } from './config.ts';
import type {
  ApplicationRun, Capability, Capabilities, CaptureArtifact, CaptureTarget, InputAction,
  DriverKind, HostScope, InstanceState, OutputInfo, WindowInfo, ProbeReport, Result, SandboxStatus,
} from './api.ts';
import type { JsonObject, JsonSchema } from './schema.ts';

export interface CapabilityPlan {
  implementation:
    | { kind: 'native'; facility: string }
    | { kind: 'external'; toolIds: string[] };
  protocols?: string[];
  limitations?: string[];
}
export interface DriverDeclaration<Options extends object = JsonObject, Kind extends DriverKind = DriverKind> {
  id: string;
  kind: Kind;
  title: string;
  description: string;
  optionsSchema: JsonSchema;
  defaultOptions: Options;
  /** Complete recipe exposed by gui_debug_drivers describe; no application command. */
  defaultConfig: InstanceConfig;
  externalTools: Array<{ id: string; executable: string; purpose: string }>;
  /** Discovery hints, not claims that the installed version supports these features. */
  capabilityPlans: Partial<Record<Capability, CapabilityPlan>>;
  /** Resource paths are relative to the driver package, not the user's workspace/XDG dirs. */
  resources: Array<{ id: string; path: string; description: string }>;
  notes: string[];
}

export interface ResolvedConfig<Options extends object> {
  driverId: string;
  options: Options;
  mode: 'headless' | 'nested';
  display: DisplayConfig;
  cwd: string;
  env: Environment;
  desktopSettings: DesktopSettings;
  startupTimeoutMs: number;
  stopTimeoutMs: number;
}
export interface DriverProcessRequest {
  argv: string[];
  cwd: string;
  env: Environment;
  role: 'compositor' | 'application' | 'helper';
  logPath: string;
  maxOutputBytes?: number;
}
export interface DriverProcess {
  /** Host-owned identity; not an assumed OS PID or a serializable subprocess handle. */
  processId: string;
  done: Promise<Result<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean }>>;
  terminate(): Promise<Result<null>>;
}
/** Host-owned wrapper over DSH subprocess + per-call sandboxPolicy/sandbox services. */
export interface DriverProcessScope {
  /** Register ownership before launch; enforce policy and preserve the scrubbed parent environment. */
  launch(request: DriverProcessRequest): Promise<Result<DriverProcess>>;
  /** Callable even when start failed before producing a driver Handle. */
  terminateAll(): Promise<Result<{ remainingProcessIds: string[] }>>;
}

declare const hostConsentBrand: unique symbol;
/** Host-issued receipt, never accepted from tool arguments; check its live registry entry on every use. */
export interface HostConsent {
  readonly [hostConsentBrand]: true;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly scopes: readonly HostScope[];
  readonly displayIdentity: string;
  readonly configDigest: string;
  readonly confirmedAt: string;
}
export interface HostHelperScope {
  /** Only frozen, consent-bound observation helpers; no application/compositor role. */
  run(operation: HostScope, request: Omit<DriverProcessRequest, 'role'>): Promise<Result<DriverProcess>>;
  terminateHelpers(): Promise<Result<null>>;
}
export interface HostDriverContext {
  instanceId: string;
  workspaceRoot: string;
  paths: { artifactDirectory: string; cacheDirectory: string; driverLog: string };
  executables: Readonly<Record<string, string>>;
  /** Existing desktop connection; never overwritten with an owned compositor socket. */
  display: { identity: string; runtimeDirectory: string; waylandDisplay?: string; x11Display?: string; xauthority?: string };
  sandbox: SandboxStatus;
  consent: HostConsent;
  helpers: HostHelperScope;
  signal: AbortSignal;
}
export interface HostDriverSnapshot extends Omit<DriverSnapshot, 'state'> {
  state: 'connected' | 'disconnected';
}

export interface DriverContext {
  instanceId: string;
  workspaceRoot: string;
  paths: {
    runtimeDirectory: string;
    artifactDirectory: string;
    /** Driver-generated compositor configuration; independent of XDG_CONFIG_HOME. */
    wmConfigDirectory: string;
    cacheDirectory: string;
    privateSettingsDirectory: string;
    driverLog: string;
  };
  /** Values resolved for this invocation; never looked up again via ambient PATH. */
  executables: Readonly<Record<string, string>>;
  /** Parent connection is used only to create the nested compositor window. */
  parentDisplay?: { runtimeDirectory: string; waylandDisplay?: string; x11Display?: string; xauthority?: string };
  sandbox: SandboxStatus;
  processes: DriverProcessScope;
  /** Cancels the current operation; must not become the successful instance's lifetime signal. */
  signal: AbortSignal;
  lifetimeSignal: AbortSignal;
}
/** Environment snapshot; the host tracks applications through owned process handles. */
export interface DriverSnapshot {
  state: InstanceState;
  capabilities: Capabilities;
  outputs: OutputInfo[];
  windows?: WindowInfo[];
  layoutRevision: string;
  warnings: string[];
}
export interface DriverStart<Handle> {
  /** Driver-private live object. The host must not serialize it into profiles. */
  handle: Handle;
  snapshot: DriverSnapshot;
}
export interface DriverExecRequest {
  applicationId: string;
  command: { executable: string; args: string[] };
  cwd: string;
  env: Environment;
  startupTimeoutMs: number;
  logPath: string;
}
export interface DriverApplicationStart {
  process: DriverProcess;
  application: ApplicationRun;
}
export interface LayoutPoint { x: number; y: number }

/** Host resolves capture-relative pixels before dispatch. Drivers receive logical layout coordinates. */
export type DriverInputAction =
  | Exclude<InputAction, { type: 'move' | 'click' | 'drag' | 'wait' }>
  | { type: 'move'; mode: 'relative'; dx: number; dy: number }
  | { type: 'move'; mode: 'absolute'; point: LayoutPoint }
  | { type: 'click'; button?: 'left' | 'middle' | 'right'; point?: LayoutPoint; count?: number }
  | { type: 'drag'; from: LayoutPoint; to: LayoutPoint; button?: 'left' | 'middle' | 'right'; durationMs?: number };
export type DriverCapture = Pick<CaptureArtifact, 'path' | 'mimeType' | 'width' | 'height' | 'layoutRevision' | 'imageToLayout'>;

/** Internal driver contract. No DSH tool registration, installer or handler implementation. */
export interface ManagedGuiDriver<Options extends object, Handle> {
  readonly kind: 'managed';
  readonly declaration: DriverDeclaration<Options, 'managed'>;
  /** Read-only preflight. Must not start a compositor or install dependencies. */
  probe(config: ResolvedConfig<Options>, signal: AbortSignal): Promise<Result<ProbeReport>>;
  /** Start only the owned display, without a keepalive/dummy application. */
  start(context: DriverContext, config: ResolvedConfig<Options>): Promise<Result<DriverStart<Handle>>>;
  /** Launch in the already running display; application exit leaves that display running. */
  exec(context: DriverContext, handle: Handle, request: DriverExecRequest): Promise<Result<DriverApplicationStart>>;
  inspect(context: DriverContext, handle: Handle): Promise<Result<DriverSnapshot>>;
  /** May use a native facility, grim or any other driver-selected implementation. */
  capture(context: DriverContext, handle: Handle, target: CaptureTarget, includeCursor: boolean): Promise<Result<DriverCapture>>;
  /** Complete one action and release held keys/buttons, including on cancellation/error. */
  input(context: DriverContext, handle: Handle, action: DriverInputAction): Promise<Result<null>>;
  /** Stop every owned process; screenshots/logs remain. Retrying must be safe. */
  stop(context: DriverContext, handle: Handle, timeoutMs: number): Promise<Result<{ remainingProcessIds: string[] }>>;
}

/** Observe an existing desktop. There are deliberately no start/exec/input/stop methods. */
export interface HostGuiDriver<Options extends object, Handle> {
  readonly kind: 'host';
  readonly declaration: DriverDeclaration<Options, 'host'>;
  /** Dependency-only preflight; no desktop connection or observation before user confirmation. */
  probe(config: { options: Options }, signal: AbortSignal): Promise<Result<ProbeReport>>;
  connect(context: HostDriverContext, options: Options): Promise<Result<{ handle: Handle; snapshot: HostDriverSnapshot }>>;
  inspect(context: HostDriverContext, handle: Handle): Promise<Result<HostDriverSnapshot>>;
  capture(context: HostDriverContext, handle: Handle, target: CaptureTarget, includeCursor: boolean): Promise<Result<DriverCapture>>;
  /** Release this plugin's reference/helpers; never stop or reconfigure the desktop. */
  disconnect(context: HostDriverContext, handle: Handle): Promise<Result<null>>;
}

/** The single driver entry type, narrowed by kind before dispatch. */
export type GuiDriver<Options extends object, Handle> =
  | ManagedGuiDriver<Options, Handle>
  | HostGuiDriver<Options, Handle>;
