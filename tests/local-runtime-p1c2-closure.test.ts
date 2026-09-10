import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_RUNTIME_CANARY_PROFILE } from '../core/local-runtime/contract';
import {
  createLocalRuntimeToolDescriptors,
  executeLocalRuntimeToolCall,
} from '../core/local-runtime/provider';
import { __unsafeResetNativeChannelForTests } from '../core/native/request-channel';

function mockNativeHost(postedCapture: { envelope: Record<string, unknown> | null }) {
  let onMessage: ((msg: unknown) => void) | null = null;
  const postMessage = vi.fn((msg: unknown) => {
    postedCapture.envelope = msg as Record<string, unknown>;
    setTimeout(() => {
      if (!onMessage || !postedCapture.envelope) return;
      onMessage({
        protocol: 'deepseek-pp-local-runtime',
        version: 1,
        request_id: postedCapture.envelope.request_id,
        operation: 'runtime.exec',
        ok: true,
        result: {
          run_id: 'run-p1c2',
          exit_status: { code: 0, signal: null },
          timed_out: false,
          cancelled: false,
          teardown_confirmed: true,
          bytes_seen: 5,
          bytes_retained: 5,
          more_available: false,
          output: 'hello',
        },
      });
    }, 0);
  });
  vi.stubGlobal('chrome', {
    runtime: {
      connectNative: vi.fn(() => ({
        postMessage,
        onMessage: { addListener: vi.fn((h: (m: unknown) => void) => { onMessage = h; }) },
        onDisconnect: { addListener: vi.fn() },
      })),
    },
  } as unknown as typeof chrome);
}

describe('P1C2 closure: receiver-owned workspace binding', () => {
  beforeEach(() => {
    __unsafeResetNativeChannelForTests();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    __unsafeResetNativeChannelForTests();
    vi.unstubAllGlobals();
  });

  it('forwards only background receiverWorkspaceRoot, never payload workspace', async () => {
    const posted: { envelope: Record<string, unknown> | null } = { envelope: null };
    mockNativeHost(posted);
    const exec = createLocalRuntimeToolDescriptors('zh-CN').find((d) => d.id === 'local-runtime.exec')!;
    const result = await executeLocalRuntimeToolCall(
      {
        name: 'runtime.exec',
        payload: {
          args: ['hello'],
          workspace_id: '/etc/passwd',
          workspace_root: '/tmp/hacked',
          path: '/evil',
          grant_id: 'attacker-grant',
          profile_id: 'canary.spawn_sleeper',
        },
        raw: '<runtime.exec>{"args":["hello"]}</runtime.exec>',
      } as unknown as import('../core/tool/types').ToolCall,
      exec,
      {
        locale: 'zh-CN',
        capabilityScope: {
          kind: 'grant',
          scopeId: 'req-p1c2-1',
          trigger: 'manual_chat',
          chatSessionId: null,
        },
        receiverWorkspaceRoot: '/tmp/background-owned-canary',
      } as unknown as import('../core/tool/provider-registry').ToolProviderExecutionContext,
    );
    expect(result.ok).toBe(true);
    expect(posted.envelope).not.toBeNull();
    expect(posted.envelope!.profile_id).toBe(LOCAL_RUNTIME_CANARY_PROFILE);
    expect(posted.envelope!.grant_id).toBe('lr:req-p1c2-1');
    // Background binding forwarded; attacker paths never forwarded.
    expect(posted.envelope!.workspace_id).toBe('/tmp/background-owned-canary');
    expect(posted.envelope!.workspace_id).not.toBe('/etc/passwd');
  });

  it('omits workspace_id when receiver binding is absent (host default)', async () => {
    const posted: { envelope: Record<string, unknown> | null } = { envelope: null };
    mockNativeHost(posted);
    const exec = createLocalRuntimeToolDescriptors('en').find((d) => d.id === 'local-runtime.exec')!;
    const result = await executeLocalRuntimeToolCall(
      {
        name: 'runtime.exec',
        payload: { args: ['hi'], workspace_id: '/etc/passwd' },
        raw: '',
      } as unknown as import('../core/tool/types').ToolCall,
      exec,
      {
        locale: 'en',
        capabilityScope: {
          kind: 'grant',
          scopeId: 'req-p1c2-2',
          trigger: 'manual_chat',
          chatSessionId: null,
        },
      } as unknown as import('../core/tool/provider-registry').ToolProviderExecutionContext,
    );
    expect(result.ok).toBe(true);
    expect(posted.envelope!.workspace_id).toBeUndefined();
  });
});

describe('P1C2 closure: i18n descriptor/summary migration', () => {
  it('uses locale resources for descriptors (no hardcoded bypass)', () => {
    const zh = createLocalRuntimeToolDescriptors('zh-CN');
    const en = createLocalRuntimeToolDescriptors('en');
    const zhExec = zh.find((d) => d.id === 'local-runtime.exec')!;
    const enExec = en.find((d) => d.id === 'local-runtime.exec')!;
    // zh-CN preserves the accepted copy byte-for-byte (prompt freeze safe).
    expect(zhExec.title).toBe('本地受限执行（canary）');
    expect(enExec.title).toBe('Local bounded execution (canary)');
    expect(enExec.title).not.toBe(zhExec.title);
    // Model surface still exposes only args.
    expect(Object.keys(enExec.inputSchema.properties ?? {})).toEqual(['args']);
  });
});
