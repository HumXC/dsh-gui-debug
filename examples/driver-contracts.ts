import type { HostGuiDriver, ManagedGuiDriver } from '../src/driver.ts';
import type { HostInput, StartOutput, HostOutput } from '../src/api.ts';
import type { HostOptions } from '../src/drivers/host.ts';
import type { CageOptions } from '../src/drivers/cage.ts';

type RequireTrue<Check extends true> = Check;
type Host = HostGuiDriver<HostOptions, unknown>;
type Managed = ManagedGuiDriver<CageOptions, unknown>;
type ForbiddenHostMethods = 'start' | 'exec' | 'input' | 'stop';

// Compile-time regression boundaries; no runtime handler or process is created.
export type HostHasNoManagement = RequireTrue<Extract<keyof Host, ForbiddenHostMethods> extends never ? true : false>;
export type ManagedHasLifecycle = RequireTrue<ForbiddenHostMethods extends keyof Managed ? true : false>;
export type StartReturnsManaged = RequireTrue<StartOutput['instance']['kind'] extends 'managed' ? true : false>;
export type ConnectReturnsHost = RequireTrue<Extract<HostOutput, { instance: unknown }>['instance']['kind'] extends 'host' ? true : false>;
export type ToolCannotConfirm = RequireTrue<Extract<'approved' | 'confirmed' | 'consent', keyof Extract<HostInput, { action: 'connect' }>> extends never ? true : false>;
