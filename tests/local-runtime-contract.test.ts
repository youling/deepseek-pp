import { describe, expect, it } from 'vitest';
import {
  LOCAL_RUNTIME_CANARY_PROFILE,
  LOCAL_RUNTIME_HOST_ID,
  LOCAL_RUNTIME_MAX_ARGS_PER_REQUEST,
  LOCAL_RUNTIME_MAX_ARG_BYTES,
  LOCAL_RUNTIME_PROTOCOL,
  LOCAL_RUNTIME_VERSION,
  LocalRuntimeContractError,
  buildLocalRuntimeExecRequest,
  buildLocalRuntimeStatusRequest,
  validateLocalRuntimeRequest,
} from '../core/local-runtime/contract';
import {
  createLocalRuntimeToolDescriptors,
  LOCAL_RUNTIME_TOOL_PROVIDER,
} from '../core/local-runtime/provider';

describe('Local Runtime contract (TS mirror of runtime/src/contract.rs)', () => {
  it('freezes contract identities', () => {
    expect(LOCAL_RUNTIME_PROTOCOL).toBe('deepseek-pp-local-runtime');
    expect(LOCAL_RUNTIME_VERSION).toBe(1);
    expect(LOCAL_RUNTIME_HOST_ID).toBe('com.deepseek_pp.runtime.canary');
    expect(LOCAL_RUNTIME_CANARY_PROFILE).toBe('canary.echo');
    expect(LOCAL_RUNTIME_MAX_ARGS_PER_REQUEST).toBe(8);
    expect(LOCAL_RUNTIME_MAX_ARG_BYTES).toBe(1024);
  });

  it('accepts a valid status request', () => {
    const request = buildLocalRuntimeStatusRequest('req-1');
    expect(request.protocol).toBe(LOCAL_RUNTIME_PROTOCOL);
    expect(request.version).toBe(LOCAL_RUNTIME_VERSION);
    expect(request.operation).toBe('runtime_status');
  });

  it('rejects a future contract version fail-closed', () => {
    const request = buildLocalRuntimeStatusRequest('req-1');
    const future = { ...request, version: LOCAL_RUNTIME_VERSION + 1 };
    expect(() => validateLocalRuntimeRequest(future)).toThrowError(LocalRuntimeContractError);
    try {
      validateLocalRuntimeRequest(future);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as LocalRuntimeContractError).code).toBe('runtime_version_unsupported');
    }
  });

  it('rejects an unknown protocol fail-closed', () => {
    expect(() =>
      validateLocalRuntimeRequest({ ...buildLocalRuntimeStatusRequest('r'), protocol: 'deepseek-pp-future' }),
    ).toThrowError(/unsupported protocol/);
  });

  it('rejects an unknown operation as malformed', () => {
    expect(() =>
      validateLocalRuntimeRequest({ ...buildLocalRuntimeStatusRequest('r'), operation: 'runtime_future' }),
    ).toThrowError(LocalRuntimeContractError);
  });

  it('rejects an empty request_id', () => {
    expect(() =>
      validateLocalRuntimeRequest({ ...buildLocalRuntimeStatusRequest('r'), request_id: '' }),
    ).toThrowError(LocalRuntimeContractError);
  });

  it('rejects args above the per-request cap', () => {
    const over = Array.from({ length: LOCAL_RUNTIME_MAX_ARGS_PER_REQUEST + 1 }, (_, i) => `a${i}`);
    const request = {
      ...buildLocalRuntimeExecRequest({
        requestId: 'r',
        grantId: 'grant-1',
        profileId: LOCAL_RUNTIME_CANARY_PROFILE,
      }),
      args: over,
    };
    expect(() => validateLocalRuntimeRequest(request)).toThrowError(LocalRuntimeContractError);
  });

  it('rejects an oversized single arg', () => {
    const request = {
      ...buildLocalRuntimeExecRequest({
        requestId: 'r',
        grantId: 'grant-1',
        profileId: LOCAL_RUNTIME_CANARY_PROFILE,
      }),
      args: ['x'.repeat(LOCAL_RUNTIME_MAX_ARG_BYTES + 1)],
    };
    expect(() => validateLocalRuntimeRequest(request)).toThrowError(LocalRuntimeContractError);
  });

  it('rejects an out-of-range timeout fail-closed', () => {
    const request = {
      ...buildLocalRuntimeExecRequest({
        requestId: 'r',
        grantId: 'grant-1',
        profileId: LOCAL_RUNTIME_CANARY_PROFILE,
      }),
      timeout_ms: 3_600_001,
    };
    expect(() => validateLocalRuntimeRequest(request)).toThrowError(/timeout_ms/);
  });
});

describe('Local Runtime tool provider', () => {
  it('advertises exactly the two canary tools under the local provider identity', () => {
    const descriptors = createLocalRuntimeToolDescriptors('zh-CN');
    expect(descriptors).toHaveLength(2);
    for (const descriptor of descriptors) {
      expect(descriptor.provider.kind).toBe('local');
      expect(descriptor.provider.id).toBe('local-runtime');
      expect(descriptor.provider.transport).toBe('in_process');
      expect(descriptor.provider.kind).toBe(LOCAL_RUNTIME_TOOL_PROVIDER.kind);
    }
    const names = descriptors.map((d) => d.invocationName).sort();
    expect(names).toEqual(['runtime.exec', 'runtime.status']);
  });

  it('marks runtime.exec as high-risk and runtime.status as low-risk', () => {
    const descriptors = createLocalRuntimeToolDescriptors('zh-CN');
    const exec = descriptors.find((d) => d.invocationName === 'runtime.exec')!;
    const status = descriptors.find((d) => d.invocationName === 'runtime.status')!;
    expect(exec.execution.risk).toBe('high');
    expect(status.execution.risk).toBe('low');
    expect(exec.inputSchema.required).toContain('grant_id');
  });
});
