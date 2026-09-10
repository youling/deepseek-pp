import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_RUNTIME_CANARY_PROFILE,
  LOCAL_RUNTIME_HOST_ID,
  LOCAL_RUNTIME_MAX_ARG_BYTES,
  LOCAL_RUNTIME_MAX_REQUEST_BYTES,
  LOCAL_RUNTIME_PROTOCOL,
  LOCAL_RUNTIME_VERSION,
  LocalRuntimeContractError,
  validateLocalRuntimeEnvelope,
  validateLocalRuntimeRequest,
} from '../core/local-runtime/contract';
import {
  createLocalRuntimeToolDescriptors,
  executeLocalRuntimeToolCall,
} from '../core/local-runtime/provider';
import { __unsafeResetNativeChannelForTests } from '../core/native/request-channel';
import { sendLocalRuntimeRequest } from '../core/local-runtime/native-client';

// Ensure single native channel authority is preserved — helper to assert no duplicate port caches
describe('P1C1 authority: model payload cannot override grant/profile/workspace', () => {
  beforeEach(() => {
    __unsafeResetNativeChannelForTests();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    __unsafeResetNativeChannelForTests();
    vi.unstubAllGlobals();
  });

  it('descriptor does not expose authority fields', () => {
    const exec = createLocalRuntimeToolDescriptors('zh-CN').find((d) => d.invocationName === 'runtime.exec')!;
    const props = exec.inputSchema.properties ?? {};
    expect(props).not.toHaveProperty('grant_id');
    expect(props).not.toHaveProperty('profile_id');
    expect(props).not.toHaveProperty('workspace_id');
    expect(props).not.toHaveProperty('workspace_root');
    expect(props).not.toHaveProperty('path');
    expect(exec.inputSchema.required ?? []).not.toContain('grant_id');
    // Only args is model-visible
    expect(Object.keys(props)).toEqual(['args']);
  });

  it('execute ignores payload grant_id/profile_id/workspace_id and uses background-owned fixed profile', async () => {
    let postedEnvelope: Record<string, unknown> | null = null;
    let onMessage: ((msg: unknown) => void) | null = null;
    const postMessage = vi.fn((msg: unknown) => {
      postedEnvelope = msg as Record<string, unknown>;
      // Simulate host reply with a strict-valid envelope
      setTimeout(() => {
        if (!onMessage || !postedEnvelope) return;
        onMessage({
          protocol: LOCAL_RUNTIME_PROTOCOL,
          version: LOCAL_RUNTIME_VERSION,
          request_id: postedEnvelope.request_id,
          operation: 'runtime.exec',
          ok: true,
          result: {
            run_id: 'run-1',
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

    const maliciousPayload = {
      args: ['hello'],
      grant_id: 'attacker-grant',
      profile_id: 'canary.spawn_sleeper',
      workspace_id: '/etc/passwd',
      workspace_root: '/tmp/hacked',
      path: '/evil',
    };

    const context = {
      locale: 'zh-CN' as const,
      capabilityScope: {
        kind: 'grant' as const,
        scopeId: 'req-authorized-123',
        trigger: 'manual_chat' as const,
        chatSessionId: null,
      },
    };

    const result = await executeLocalRuntimeToolCall(
      {
        name: 'runtime.exec',
        payload: maliciousPayload,
        raw: '<runtime.exec>{"args":["hello"]}</runtime.exec>',
      } as unknown as import('../core/tool/types').ToolCall,
      createLocalRuntimeToolDescriptors('zh-CN').find((d) => d.id === 'local-runtime.exec')!,
      context as unknown as import('../core/tool/provider-registry').ToolProviderExecutionContext,
    );

    expect(result.ok).toBe(true);
    expect(postedEnvelope).not.toBeNull();
    // Internal grant derived from capabilityScope, not attacker-grant
    expect(postedEnvelope!.grant_id).toBe('lr:req-authorized-123');
    expect(postedEnvelope!.grant_id).not.toBe('attacker-grant');
    // Fixed canary.echo, not sleeper
    expect(postedEnvelope!.profile_id).toBe(LOCAL_RUNTIME_CANARY_PROFILE);
    expect(postedEnvelope!.profile_id).not.toBe('canary.spawn_sleeper');
    // Workspace_id is not taken from payload (P1C1: model cannot choose workspace)
    // The provider does not forward payload workspace_id; internal wire may have no workspace_id or internal default
    expect(postedEnvelope!.workspace_id ?? null).not.toBe('/etc/passwd');
    const output = result.output as Record<string, unknown>;
    expect(output.profile_id).toBe(LOCAL_RUNTIME_CANARY_PROFILE);
  });

  it('without capabilityScope execution fails closed', async () => {
    const result = await executeLocalRuntimeToolCall(
      { name: 'runtime.exec', payload: { args: ['hi'] }, raw: '' } as unknown as import('../core/tool/types').ToolCall,
      createLocalRuntimeToolDescriptors('zh-CN').find((d) => d.id === 'local-runtime.exec')!,
      // no context
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('runtime_authorization_missing');
  });
});

describe('P1C1 byte parity: UTF-8 args + 64 KiB ceiling', () => {
  it('rejects multibyte arg exceeding 1024 UTF-8 bytes while JS length <1024', () => {
    // 😀 is 4 bytes in UTF-8, 2 code units in JS. 256 * 😀 = 1024 bytes, 257* = 1028 bytes >1024
    const okArg = '😀'.repeat(256); // 256*4=1024 bytes, 512 code units
    const badArg = '😀'.repeat(257); // 1028 bytes
    expect(okArg.length).toBe(512);
    expect(badArg.length).toBe(514);
    expect(() => validateLocalRuntimeRequest({
      protocol: LOCAL_RUNTIME_PROTOCOL,
      version: LOCAL_RUNTIME_VERSION,
      request_id: 'r',
      operation: 'runtime_exec',
      args: [okArg],
    })).not.toThrow();
    expect(() => validateLocalRuntimeRequest({
      protocol: LOCAL_RUNTIME_PROTOCOL,
      version: LOCAL_RUNTIME_VERSION,
      request_id: 'r',
      operation: 'runtime_exec',
      args: [badArg],
    })).toThrowError(LocalRuntimeContractError);
  });

  it('enforces 64 KiB serialized request ceiling at TS boundary', () => {
    const small = 'a'.repeat(100);
    const bigArg = 'a'.repeat(70000); // exceeds per-arg 1024 cap, fails at arg gate before 64KiB
    // Small should pass
    expect(() => validateLocalRuntimeRequest({
      protocol: LOCAL_RUNTIME_PROTOCOL,
      version: LOCAL_RUNTIME_VERSION,
      request_id: 'r',
      operation: 'runtime_exec',
      args: [small],
    })).not.toThrow();
    expect(() => validateLocalRuntimeRequest({
      protocol: LOCAL_RUNTIME_PROTOCOL,
      version: LOCAL_RUNTIME_VERSION,
      request_id: 'r',
      operation: 'runtime_exec',
      args: [bigArg],
    })).toThrowError(LocalRuntimeContractError);

    // Exactly at limit: construct payload that serializes just under 64KiB
    // 8 args * 1024 bytes = 8192 plus envelope overhead < 64KiB → should pass
    const maxArgs = Array.from({ length: 8 }, () => 'a'.repeat(1024));
    expect(() => validateLocalRuntimeRequest({
      protocol: LOCAL_RUNTIME_PROTOCOL,
      version: LOCAL_RUNTIME_VERSION,
      request_id: 'r',
      operation: 'runtime_exec',
      args: maxArgs,
    })).not.toThrow();

    const hugeRequest: Record<string, unknown> = {
      protocol: LOCAL_RUNTIME_PROTOCOL,
      version: LOCAL_RUNTIME_VERSION,
      request_id: 'r',
      operation: 'runtime_exec',
      grant_id: 'g'.repeat(70000),
      args: ['a'],
    };
    expect(() => validateLocalRuntimeRequest(hugeRequest)).toThrowError(/exceeds 65536/);
  });

  it('outer 1 MiB channel guard does not replace 64 KiB runtime ceiling', async () => {
    const { sendLocalRuntimeRequest } = await import('../core/local-runtime/native-client');
    const connectNative = vi.fn(() => ({
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    }));
    vi.stubGlobal('chrome', { runtime: { connectNative } } as unknown as typeof chrome);
    __unsafeResetNativeChannelForTests();

    const huge = 'a'.repeat(70000);
    const req = {
      protocol: LOCAL_RUNTIME_PROTOCOL,
      version: LOCAL_RUNTIME_VERSION,
      request_id: 'over-64k',
      operation: 'runtime_exec' as const,
      grant_id: huge,
      args: ['a'],
    };
    // validate throws synchronously at TS boundary before touching native channel
    expect(() => sendLocalRuntimeRequest(req as unknown as import('../core/local-runtime/contract').LocalRuntimeRequest)).toThrow(/exceeds 65536/);
    expect(connectNative).not.toHaveBeenCalled();
  });
});

describe('P1C1 strict incoming response validation', () => {
  const baseStatus = {
    protocol: LOCAL_RUNTIME_PROTOCOL,
    version: LOCAL_RUNTIME_VERSION,
    request_id: 'req-1',
    operation: 'runtime.status' as const,
    ok: true as const,
    host: {
      host_id: LOCAL_RUNTIME_HOST_ID,
      runtime_version: '0.1.0',
      contract_version: LOCAL_RUNTIME_VERSION,
      platform: 'test',
      pty_supported: true,
      profiles: [LOCAL_RUNTIME_CANARY_PROFILE],
    },
  };
  const baseExecOk = {
    protocol: LOCAL_RUNTIME_PROTOCOL,
    version: LOCAL_RUNTIME_VERSION,
    request_id: 'req-1',
    operation: 'runtime.exec' as const,
    ok: true as const,
    result: {
      run_id: 'run-1',
      exit_status: { code: 0, signal: null },
      timed_out: false,
      cancelled: false,
      teardown_confirmed: true,
      bytes_seen: 10,
      bytes_retained: 5,
      more_available: false,
      output: 'hi',
    },
  };

  it('accepts valid status and exec envelopes', () => {
    expect(() => validateLocalRuntimeEnvelope(baseStatus, { requestId: 'req-1', operation: 'runtime.status' })).not.toThrow();
    expect(() => validateLocalRuntimeEnvelope(baseExecOk, { requestId: 'req-1', operation: 'runtime.exec' })).not.toThrow();
  });

  it('rejects unknown/future protocol and version', () => {
    expect(() => validateLocalRuntimeEnvelope({ ...baseStatus, protocol: 'deepseek-pp-future' } as unknown as object)).toThrowError(/unsupported protocol/);
    expect(() => validateLocalRuntimeEnvelope({ ...baseStatus, version: 999 } as unknown as object)).toThrowError(/unsupported contract version/);
  });

  it('rejects operation mismatch and request_id mismatch', () => {
    expect(() => validateLocalRuntimeEnvelope(baseStatus, { requestId: 'other', operation: 'runtime.status' })).toThrowError(/request_id mismatch/);
    expect(() => validateLocalRuntimeEnvelope(baseStatus, { requestId: 'req-1', operation: 'runtime.exec' })).toThrowError(/operation mismatch/);
    expect(() => validateLocalRuntimeEnvelope({ ...baseExecOk, operation: 'runtime.status' } as unknown as object, { operation: 'runtime.exec' as const })).toThrowError(/operation mismatch/);
  });

  it('rejects malformed host/result/error shapes', () => {
    expect(() => validateLocalRuntimeEnvelope({ ...baseStatus, host: null } as unknown as object)).toThrowError(/host must be/);
    expect(() => validateLocalRuntimeEnvelope({ ...baseStatus, host: { ...baseStatus.host, host_id: '' } } as unknown as object)).toThrowError(/host_id/);
    expect(() => validateLocalRuntimeEnvelope({ ...baseExecOk, result: { ...baseExecOk.result, run_id: '' } } as unknown as object)).toThrowError(/run_id/);
    expect(() => validateLocalRuntimeEnvelope({ ...baseExecOk, result: null } as unknown as object)).toThrowError(/result must be/);
    // error discriminant
    const execErr = { protocol: LOCAL_RUNTIME_PROTOCOL, version: LOCAL_RUNTIME_VERSION, request_id: 'req-1', operation: 'runtime.exec' as const, ok: false as const, error: { code: 'x', message: 'm' } };
    expect(() => validateLocalRuntimeEnvelope(execErr as unknown as object)).not.toThrow();
    expect(() => validateLocalRuntimeEnvelope({ ...execErr, error: { code: '', message: 'm' } } as unknown as object)).toThrowError(/error.code/);
    expect(() => validateLocalRuntimeEnvelope({ ...baseExecOk, ok: true, error: { code: 'x', message: 'm' } } as unknown as object)).toThrowError(/ok:true must have exactly result/);
    expect(() => validateLocalRuntimeEnvelope({ ...execErr, result: baseExecOk.result } as unknown as object)).toThrowError(/ok:false must have exactly error/);
  });

  it('rejects byte counter invariants', () => {
    expect(() => validateLocalRuntimeEnvelope({ ...baseExecOk, result: { ...baseExecOk.result, bytes_seen: -1 } } as unknown as object)).toThrowError(/bytes_seen/);
    expect(() => validateLocalRuntimeEnvelope({ ...baseExecOk, result: { ...baseExecOk.result, bytes_seen: 5.5 } } as unknown as object)).toThrowError(/bytes_seen/);
    expect(() => validateLocalRuntimeEnvelope({ ...baseExecOk, result: { ...baseExecOk.result, bytes_retained: 20, bytes_seen: 10 } } as unknown as object)).toThrowError(/bytes_retained must not exceed bytes_seen/);
  });

  it('rejects future/unknown/malformed via native client after correlation', async () => {
    __unsafeResetNativeChannelForTests();
    let onMessage: ((msg: unknown) => void) | null = null;
    vi.stubGlobal('chrome', {
      runtime: {
        connectNative: vi.fn(() => ({
          postMessage: vi.fn((_msg: unknown) => {
            const req = _msg as Record<string, unknown>;
            setTimeout(() => onMessage?.({
              protocol: 'deepseek-pp-future',
              version: 999,
              request_id: req.request_id,
              operation: 'runtime.status',
              ok: true,
              host: baseStatus.host,
            }), 0);
          }),
          onMessage: { addListener: vi.fn((h: (m: unknown) => void) => { onMessage = h; }) },
          onDisconnect: { addListener: vi.fn() },
        })),
      },
    } as unknown as typeof chrome);
    const req = {
      protocol: LOCAL_RUNTIME_PROTOCOL,
      version: LOCAL_RUNTIME_VERSION,
      request_id: 'req-future',
      operation: 'runtime_status' as const,
    };
    await expect(sendLocalRuntimeRequest(req as unknown as import('../core/local-runtime/contract').LocalRuntimeRequest)).rejects.toThrow(/unsupported protocol|unsupported contract version|unknown response operation/);
  });

  it('does not use `as LocalRuntimeEnvelope` without validation — negative case is throwing', async () => {
    __unsafeResetNativeChannelForTests();
    let onMessage: ((msg: unknown) => void) | null = null;
    vi.stubGlobal('chrome', {
      runtime: {
        connectNative: vi.fn(() => ({
          postMessage: vi.fn((msg: unknown) => {
            const req = msg as Record<string, unknown>;
            setTimeout(() => onMessage?.({
              protocol: LOCAL_RUNTIME_PROTOCOL,
              version: LOCAL_RUNTIME_VERSION,
              request_id: req.request_id,
              operation: 'runtime.exec',
              ok: true,
              result: {
                run_id: 'r',
                exit_status: { code: 0, signal: null },
                timed_out: false,
                cancelled: false,
                teardown_confirmed: true,
                bytes_seen: 5,
                bytes_retained: 10,
                more_available: false,
                output: 'hi',
              },
            }), 0);
          }),
          onMessage: { addListener: vi.fn((h: (m: unknown) => void) => { onMessage = h; }) },
          onDisconnect: { addListener: vi.fn() },
        })),
      },
    } as unknown as typeof chrome);
    await expect(sendLocalRuntimeRequest({
      protocol: LOCAL_RUNTIME_PROTOCOL,
      version: LOCAL_RUNTIME_VERSION,
      request_id: 'req-bad-bytes',
      operation: 'runtime_exec',
      args: ['a'],
    } as unknown as import('../core/local-runtime/contract').LocalRuntimeRequest)).rejects.toThrow(/bytes_retained/);
  });
});

describe('P1C1 single native channel not regressed', () => {
  it('still routes concurrent correlation after strict validator added', async () => {
    // Reuse existing primitive test via direct channel + validate path
    const { requestNativeHost } = await import('../core/native/request-channel');
    let onMessage: ((msg: unknown) => void) | null = null;
    const connectNative = vi.fn(() => ({
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn((h: (m: unknown) => void) => { onMessage = h; }) },
      onDisconnect: { addListener: vi.fn() },
    }));
    vi.stubGlobal('chrome', { runtime: { connectNative } } as unknown as typeof chrome);
    __unsafeResetNativeChannelForTests();
    const errors = {
      unavailable: () => new Error('unavailable'),
      disconnected: () => new Error('disconnected'),
      timeout: () => new Error('timeout'),
      payloadTooLarge: () => new Error('too_large'),
      aborted: () => new Error('aborted'),
    };
    const p1 = requestNativeHost('host-a', { id: 1 }, { requestId: 1, extractResponseId: (r: unknown) => (r as { id?: number })?.id, timeoutMs: 500, errors });
    const p2 = requestNativeHost('host-a', { id: 2 }, { requestId: 2, extractResponseId: (r: unknown) => (r as { id?: number })?.id, timeoutMs: 500, errors });
    // correlation still works
    setTimeout(() => {
      onMessage?.({ id: 2 });
      onMessage?.({ id: 1 });
    }, 0);
    await expect(p2).resolves.toEqual({ id: 2 });
    await expect(p1).resolves.toEqual({ id: 1 });
  });
});
