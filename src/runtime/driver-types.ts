import type { Environment } from '../config.ts';
import type { DriverProcess, ResolvedConfig } from '../driver.ts';
import type { OutputInfo, WindowInfo } from '../api.ts';
import type { CageOptions } from '../drivers/cage.ts';
import type { SwayOptions } from '../drivers/sway.ts';
import type { HostOptions } from '../drivers/host.ts';
export interface ObservedOutput extends OutputInfo { physicalWidth: number; physicalHeight: number; transform: string; globalId?: string }
export interface DisplayInfo { protocols: Set<string>; outputs: ObservedOutput[] }

export type ManagedOptions = CageOptions & SwayOptions;
export interface ManagedHandle {
  driverId: string;
  config: ResolvedConfig<ManagedOptions>;
  env: Environment;
  info?: DisplayInfo;
  process?: DriverProcess;
  ipcSocket?: string;
  socketIdentity?: string;
  windows?: WindowInfo[];
}
export interface HostHandle {
  driverId: 'host';
  config: { options: HostOptions; cwd: string };
  env: Environment;
  info?: DisplayInfo;
}
