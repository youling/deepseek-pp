#!/usr/bin/env node
// DeepSeek++ Local Runtime (canary) native-host installer.
//
// Registers `com.deepseek_pp.runtime.canary` for Chrome/Edge/Chromium/Firefox,
// pointing at the compiled Rust canary binary `deepseek-pp-local-runtime(.exe)`.
// This is a P1 developer-oriented installer: the Rust binary is built with
// `cargo build --release` before installing (see runtime/README).

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_RUNTIME_HOST_NAME = 'com.deepseek_pp.runtime.canary';
export const FIREFOX_EXTENSION_ID = 'deepseek-pp@zhu1090093659.github';
export const SUPPORTED_BROWSER_NAMES = ['chrome', 'chromium', 'edge', 'firefox'];

const BINARY_NAME = platform() === 'win32'
  ? 'deepseek-pp-local-runtime.exe'
  : 'deepseek-pp-local-runtime';

const defaultBinaryCandidates = [
  resolve(process.cwd(), 'runtime', 'target', 'release', BINARY_NAME),
  resolve(process.cwd(), 'target', 'release', BINARY_NAME),
];

const commands = new Set(['install', 'status', 'uninstall']);

function assertSupportedBrowser(browser) {
  if (!SUPPORTED_BROWSER_NAMES.includes(browser)) {
    throw new Error(`Unsupported browser: ${browser}`);
  }
}

function locateBinary(provided) {
  if (provided) {
    if (!existsSync(provided)) throw new Error(`Native host binary not found: ${provided}`);
    return resolve(provided);
  }
  const found = defaultBinaryCandidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(
    'Local Runtime native host binary not found. Build it first: `cargo build --release --manifest-path runtime/Cargo.toml`, then pass `--binary <path>`.',
  );
}

function resolveLocations({ os = platform(), browser, home = homedir(), localAppData = process.env.LOCALAPPDATA }) {
  assertSupportedBrowser(browser);
  const path = os === 'win32' ? win32 : posix;
  let appDataRoot;
  let manifestDir;
  if (os === 'darwin') {
    appDataRoot = path.resolve(home, 'Library', 'Application Support', 'DeepSeek++');
    const segments = {
      chrome: ['Google', 'Chrome', 'NativeMessagingHosts'],
      chromium: ['Chromium', 'NativeMessagingHosts'],
      edge: ['Microsoft Edge', 'NativeMessagingHosts'],
      firefox: ['Mozilla', 'NativeMessagingHosts'],
    }[browser];
    manifestDir = path.resolve(home, 'Library', 'Application Support', ...segments);
  } else if (os === 'linux') {
    appDataRoot = path.resolve(home, '.local', 'share', 'deepseek-pp');
    const segments = {
      chrome: ['.config', 'google-chrome', 'NativeMessagingHosts'],
      chromium: ['.config', 'chromium', 'NativeMessagingHosts'],
      edge: ['.config', 'microsoft-edge', 'NativeMessagingHosts'],
      firefox: ['.mozilla', 'native-messaging-hosts'],
    }[browser];
    manifestDir = path.resolve(home, ...segments);
  } else if (os === 'win32') {
    const appData = localAppData || path.resolve(home, 'AppData', 'Local');
    appDataRoot = path.resolve(appData, 'DeepSeek++');
    manifestDir = path.resolve(appDataRoot, 'NativeMessagingHosts');
  } else {
    throw new Error(`Unsupported platform: ${os}`);
  }

  const hostInstallDir = path.resolve(appDataRoot, os === 'linux' ? 'native-host' : 'NativeHost');
  const manifestFileName = os === 'win32' ? `${LOCAL_RUNTIME_HOST_NAME}.${browser}.json` : `${LOCAL_RUNTIME_HOST_NAME}.json`;
  return {
    appDataRoot,
    hostInstallDir,
    manifestDir,
    manifestPath: resolve(manifestDir, manifestFileName),
    registryKey: os === 'win32' ? getWindowsRegistryKey(browser) : null,
  };
}

export function resolveNativeHostLocations(input) {
  return resolveLocations(input);
}

function getWindowsRegistryKey(browser) {
  switch (browser) {
    case 'chrome': return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${LOCAL_RUNTIME_HOST_NAME}`;
    case 'edge': return `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${LOCAL_RUNTIME_HOST_NAME}`;
    case 'chromium': return `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${LOCAL_RUNTIME_HOST_NAME}`;
    case 'firefox': return `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${LOCAL_RUNTIME_HOST_NAME}`;
    default: return null;
  }
}

export function createNativeHostManifest(args, binaryPath) {
  const manifest = {
    name: LOCAL_RUNTIME_HOST_NAME,
    description: 'DeepSeek++ Local Coding Runtime - isolated, host-owned bounded execution via Native Messaging',
    path: binaryPath,
    type: 'stdio',
  };
  if (args.browser === 'firefox') {
    manifest.allowed_extensions = [FIREFOX_EXTENSION_ID];
  } else {
    if (!args.extensionId) throw new Error('--extension-id is required for Chrome/Edge/Chromium.');
    manifest.allowed_origins = [`chrome-extension://${args.extensionId}/`];
  }
  return manifest;
}

export function parseArgs(argv) {
  const args = {
    command: 'install',
    extensionId: null,
    browser: 'chrome',
    binary: null,
  };
  const tokens = [...argv];
  if (tokens[0] && commands.has(tokens[0])) args.command = tokens.shift();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--extension-id' && tokens[index + 1]) args.extensionId = tokens[++index];
    else if (token === '--browser' && tokens[index + 1]) args.browser = tokens[++index].toLowerCase();
    else if (token === '--binary' && tokens[index + 1]) args.binary = tokens[++index];
    else if (token === '--help' || token === '-h') { printHelp(); process.exit(0); }
    else throw new Error(`Unknown option: ${token} -- use --help`);
  }
  assertSupportedBrowser(args.browser);
  return args;
}

function printHelp() {
  console.log(`DeepSeek++ Local Runtime (canary) native-host installer

Usage:
  node packages/local-runtime/installer.mjs install --browser chrome --extension-id <id> [--binary <path>]
  node packages/local-runtime/installer.mjs status --browser chrome
  node packages/local-runtime/installer.mjs uninstall --browser chrome

Commands:
  install     Register the canary native host pointing at the Rust binary
  status      Show manifest, binary, and registry status
  uninstall   Remove the manifest and registry key

Options:
  --extension-id <id>  Chrome/Edge/Chromium extension ID
  --browser <name>     chrome, chromium, edge, firefox (default: chrome)
  --binary <path>      Path to the compiled Rust binary (default: runtime/target/release)
  --help               Show this help
`);
}

function writeWindowsRegistry(browser, manifestPath) {
  const registryKey = getWindowsRegistryKey(browser);
  if (!registryKey) return;
  try {
    execFileSync('reg', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'pipe' });
    console.log(`Registry: ${registryKey}`);
  } catch {
    console.error('Warning: Failed to write registry key. You may need to run as Administrator.');
    console.error(`  Manual: reg add "${registryKey}" /ve /t REG_SZ /d "${manifestPath}" /f`);
  }
}

function removeWindowsRegistry(browser) {
  const registryKey = getWindowsRegistryKey(browser);
  if (!registryKey) return;
  try {
    execFileSync('reg', ['delete', registryKey, '/f'], { stdio: 'pipe' });
    console.log(`Removed registry key: ${registryKey}`);
  } catch {
    console.log(`Registry key not removed or was already absent: ${registryKey}`);
  }
}

function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function install(args) {
  const binaryPath = locateBinary(args.binary);
  const loc = resolveNativeHostLocations({ browser: args.browser });
  const hostBinary = resolve(loc.hostInstallDir, BINARY_NAME);

  mkdirSync(loc.hostInstallDir, { recursive: true });
  copyFileSync(binaryPath, hostBinary);
  const manifest = createNativeHostManifest(args, hostBinary);
  mkdirSync(dirname(loc.manifestPath), { recursive: true });
  writeFileSync(loc.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (platform() === 'win32') writeWindowsRegistry(args.browser, loc.manifestPath);

  console.log('\nInstalled Local Runtime native messaging host manifest:');
  console.log(`  ${loc.manifestPath}\n`);
  console.log(`Host binary: ${hostBinary}`);
  console.log(`Host name:   ${LOCAL_RUNTIME_HOST_NAME}`);
  console.log(`Browser:     ${args.browser}`);
  if (manifest.allowed_origins) console.log(`Origin:      ${manifest.allowed_origins[0]}`);
  if (manifest.allowed_extensions) console.log(`Extension:   ${manifest.allowed_extensions[0]}`);
  console.log(`\nVerify the host: "${hostBinary}" --status`);
}

function status(args) {
  const loc = resolveNativeHostLocations({ browser: args.browser });
  const hostBinary = resolve(loc.hostInstallDir, BINARY_NAME);
  const manifest = readManifest(loc.manifestPath);
  const binaryOk = existsSync(hostBinary);
  const isReady = Boolean(manifest && binaryOk && existsSync(manifest.path ?? hostBinary));

  console.log('DeepSeek++ Local Runtime (canary) status');
  console.log(`Browser:      ${args.browser}`);
  console.log(`Host name:    ${LOCAL_RUNTIME_HOST_NAME}`);
  console.log(`Install dir:  ${loc.hostInstallDir}`);
  console.log(`Host binary:  ${binaryOk ? 'found' : 'missing'} (${hostBinary})`);
  console.log(`Manifest:     ${manifest ? 'found' : 'missing'} (${loc.manifestPath})`);
  if (manifest) {
    console.log(`Target path:  ${manifest.path}`);
    if (manifest.allowed_origins) console.log(`Origins:      ${manifest.allowed_origins.join(', ')}`);
    if (manifest.allowed_extensions) console.log(`Extensions:   ${manifest.allowed_extensions.join(', ')}`);
  }
  if (platform() === 'win32') console.log(`Registry:     ${loc.registryKey}`);
  console.log(`Ready:        ${isReady ? 'yes' : 'no'}`);
  if (!isReady) process.exitCode = 1;
}

function uninstall(args) {
  const loc = resolveNativeHostLocations({ browser: args.browser });
  rmSync(loc.manifestPath, { force: true });
  if (platform() === 'win32') removeWindowsRegistry(args.browser);
  const hostBinary = resolve(loc.hostInstallDir, BINARY_NAME);
  rmSync(hostBinary, { force: true });
  console.log(`Removed Local Runtime native host for ${args.browser}.`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === 'status') return status(args);
  if (args.command === 'uninstall') return uninstall(args);
  install(args);
  console.log(`\nDone. Restart ${args.browser} to activate.`);
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error(`\nInstall failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
