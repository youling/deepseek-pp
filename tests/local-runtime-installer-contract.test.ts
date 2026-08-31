import { describe, expect, it } from 'vitest';
import {
  LOCAL_RUNTIME_HOST_NAME,
  FIREFOX_EXTENSION_ID,
  SUPPORTED_BROWSER_NAMES,
  createNativeHostManifest,
  parseArgs,
  resolveNativeHostLocations,
} from '../packages/local-runtime/installer.mjs';
import { LOCAL_RUNTIME_HOST_ID } from '../core/local-runtime/contract';

describe('Local Runtime installer contract', () => {
  it('freezes the native host identity consistent with the TS+Rust contract', () => {
    expect(LOCAL_RUNTIME_HOST_NAME).toBe(LOCAL_RUNTIME_HOST_ID);
    expect(LOCAL_RUNTIME_HOST_NAME).toBe('com.deepseek_pp.runtime.canary');
    expect(FIREFOX_EXTENSION_ID).toBe('deepseek-pp@zhu1090093659.github');
    expect(SUPPORTED_BROWSER_NAMES).toEqual(['chrome', 'chromium', 'edge', 'firefox']);
  });

  it('freezes Windows manifest/location and registry shapes', () => {
    for (const browser of ['chrome', 'edge', 'chromium', 'firefox']) {
      const loc = resolveNativeHostLocations({
        os: 'win32',
        browser,
        home: 'C:/Users/test',
        localAppData: 'C:/Users/test/AppData/Local',
      });
      expect(loc.manifestDir).toBe('C:\\Users\\test\\AppData\\Local\\DeepSeek++\\NativeMessagingHosts');
      expect(loc.hostInstallDir).toBe('C:\\Users\\test\\AppData\\Local\\DeepSeek++\\NativeHost');
      expect(loc.manifestPath).toBe(
        `C:\\Users\\test\\AppData\\Local\\DeepSeek++\\NativeMessagingHosts\\${LOCAL_RUNTIME_HOST_NAME}.${browser}.json`,
      );
      expect(loc.registryKey).toContain(`NativeMessagingHosts\\${LOCAL_RUNTIME_HOST_NAME}`);
    }
  });

  it('builds the Chromium manifest with the extension origin', () => {
    const manifest = createNativeHostManifest(
      { browser: 'chrome', extensionId: 'abcdefghijklmnop' },
      'C:/tmp/deepseek-pp-local-runtime.exe',
    );
    expect(manifest.name).toBe(LOCAL_RUNTIME_HOST_NAME);
    expect(manifest.type).toBe('stdio');
    expect(manifest.allowed_origins).toEqual(['chrome-extension://abcdefghijklmnop/']);
    expect(manifest.allowed_extensions).toBeUndefined();
  });

  it('builds the Firefox manifest with allowed extensions', () => {
    const manifest = createNativeHostManifest(
      { browser: 'firefox', extensionId: null },
      '/tmp/deepseek-pp-local-runtime',
    );
    expect(manifest.allowed_extensions).toEqual([FIREFOX_EXTENSION_ID]);
    expect(manifest.allowed_origins).toBeUndefined();
  });

  it('requires an extension id for Chromium browsers', () => {
    expect(() => createNativeHostManifest({ browser: 'chrome', extensionId: null }, 'x'))
      .toThrowError(/extension-id is required/);
  });

  it('parses CLI arguments and rejects unknown options', () => {
    expect(parseArgs(['install', '--browser', 'edge', '--extension-id', 'abc'])).toMatchObject({
      command: 'install',
      browser: 'edge',
      extensionId: 'abc',
    });
    expect(() => parseArgs(['--bogus'])).toThrowError(/Unknown option/);
  });
});
