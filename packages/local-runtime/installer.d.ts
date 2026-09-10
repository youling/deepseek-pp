export const LOCAL_RUNTIME_HOST_NAME: string;
export const FIREFOX_EXTENSION_ID: string;
export const SUPPORTED_BROWSER_NAMES: string[];

export interface LocalRuntimeInstallerArgs {
  command: string;
  extensionId: string | null;
  browser: string;
  binary: string | null;
}

export interface LocalRuntimeNativeHostLocations {
  appDataRoot: string;
  hostInstallDir: string;
  manifestDir: string;
  manifestPath: string;
  registryKey: string | null;
}

export function resolveNativeHostLocations(input: {
  os?: string;
  browser: string;
  home?: string;
  localAppData?: string;
}): LocalRuntimeNativeHostLocations;
export function createNativeHostManifest(
  args: Pick<LocalRuntimeInstallerArgs, 'browser' | 'extensionId'>,
  binaryPath: string,
): Record<string, unknown>;
export function parseArgs(argv: string[]): LocalRuntimeInstallerArgs;
export function main(argv?: string[]): Promise<void>;
