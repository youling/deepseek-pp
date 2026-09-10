/**
 * Native-messaging client for the Local Runtime host
 * (`com.deepseek_pp.runtime.canary`).
 *
 * Chrome's native messaging channel performs 4-byte little-endian length
 * framing automatically around every JSON message we post; the Rust host's
 * `framing.rs` reads the same framing. Port lifecycle, pending correlation,
 * timeout/abort, disconnect cleanup, unmatched handling, and the transport
 * ceiling are owned solely by `core/native/request-channel.ts` — this module
 * only speaks the dedicated `deepseek-pp-local-runtime` operation contract.
 *
 * Authorization boundary: this client never authorizes execution. It only
 * carries a background-issued `grant_id` claim to the host, whose owner gate is
 * the actual authority.
 */

import type {
  LocalRuntimeEnvelope,
  LocalRuntimeExecEnvelope,
  LocalRuntimeRequest,
  LocalRuntimeStatusEnvelope,
} from './contract';
import {
  LOCAL_RUNTIME_HOST_ID,
  LocalRuntimeContractError,
  validateLocalRuntimeEnvelope,
  validateLocalRuntimeRequest,
} from './contract';
import {
  requestNativeHost,
  type NativeRequestId,
} from '../native/request-channel';

export type LocalRuntimeClientErrorCode =
  | 'local_runtime_native_messaging_unavailable'
  | 'local_runtime_host_disconnected'
  | 'local_runtime_timeout'
  | 'local_runtime_unknown_error';

export class LocalRuntimeClientError extends Error {
  constructor(
    public readonly code: LocalRuntimeClientErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LocalRuntimeClientError';
  }
}

function createLocalRuntimeChannelErrors() {
  return {
    unavailable: () => new LocalRuntimeClientError(
      'local_runtime_native_messaging_unavailable',
      'Browser native messaging is unavailable.',
    ),
    disconnected: (detail?: string) => new LocalRuntimeClientError(
      'local_runtime_host_disconnected',
      detail || 'Local Runtime native host disconnected.',
    ),
    timeout: (timeoutMs: number) => new LocalRuntimeClientError(
      'local_runtime_timeout',
      `Local Runtime request exceeded ${timeoutMs} ms.`,
    ),
    payloadTooLarge: (bytes: number, ceiling: number) => new LocalRuntimeClientError(
      'local_runtime_unknown_error',
      `Local Runtime request is too large (${bytes} > ${ceiling} bytes).`,
    ),
    aborted: (signal: AbortSignal) => {
      if (signal.reason instanceof Error) return signal.reason;
      return new DOMException('Local Runtime request was aborted.', 'AbortError');
    },
  };
}

function extractLocalRuntimeResponseId(response: unknown): NativeRequestId | null | undefined {
  const record = response as { request_id?: unknown } | null;
  if (typeof record !== 'object' || record === null) return undefined;
  return typeof record.request_id === 'string' ? record.request_id : undefined;
}

/**
 * Send a validated Local Runtime request and await the correlated response.
 * Validates outgoing request (UTF-8 args + 64 KiB ceiling) and strict
 * incoming envelope (protocol/version/request_id/operation/host/result/error
 * and byte invariants) after shared-channel correlation.
 */
export function sendLocalRuntimeRequest(
  request: LocalRuntimeRequest,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<LocalRuntimeEnvelope> {
  validateLocalRuntimeRequest(request);

  const expectedOperation = request.operation === 'runtime_status' ? 'runtime.status' as const : 'runtime.exec' as const;
  const timeoutMs = options?.timeoutMs ?? 5_000;
  return requestNativeHost<unknown>(LOCAL_RUNTIME_HOST_ID, request, {
    requestId: request.request_id,
    extractResponseId: extractLocalRuntimeResponseId,
    timeoutMs,
    signal: options?.signal,
    errors: createLocalRuntimeChannelErrors(),
  }).then((raw) => {
    try {
      validateLocalRuntimeEnvelope(raw, { requestId: request.request_id, operation: expectedOperation });
    } catch (err) {
      if (err instanceof LocalRuntimeContractError) {
        throw new LocalRuntimeClientError('local_runtime_unknown_error', err.message, { cause: err });
      }
      throw err;
    }
    return raw as LocalRuntimeEnvelope;
  });
}

/** Convenience typed wrappers for the two operations. */
export function localRuntimeStatus(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<LocalRuntimeStatusEnvelope> {
  const request: LocalRuntimeRequest = {
    protocol: 'deepseek-pp-local-runtime',
    version: 1,
    request_id: newRequestId(),
    operation: 'runtime_status',
  };
  return sendLocalRuntimeRequest(request, options).then(assertStatus);
}

export function localRuntimeExec(input: {
  requestId?: string;
  grantId: string;
  profileId: string;
  args?: string[];
  workspaceId?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}): Promise<LocalRuntimeExecEnvelope> {
  const request: LocalRuntimeRequest = {
    protocol: 'deepseek-pp-local-runtime',
    version: 1,
    request_id: input.requestId ?? newRequestId(),
    operation: 'runtime_exec',
    grant_id: input.grantId,
    profile_id: input.profileId,
    workspace_id: input.workspaceId,
    timeout_ms: input.timeoutMs,
    max_output_bytes: input.maxOutputBytes,
    args: input.args,
  };
  return sendLocalRuntimeRequest(request, { timeoutMs: input.timeoutMs, signal: input.signal }).then(assertExec);
}

function assertStatus(envelope: LocalRuntimeEnvelope): LocalRuntimeStatusEnvelope {
  if (envelope.operation !== 'runtime.status') {
    throw new LocalRuntimeClientError(
      'local_runtime_unknown_error',
      `Unexpected operation: ${envelope.operation}`,
    );
  }
  return envelope;
}

function assertExec(envelope: LocalRuntimeEnvelope): LocalRuntimeExecEnvelope {
  if (envelope.operation !== 'runtime.exec') {
    throw new LocalRuntimeClientError(
      'local_runtime_unknown_error',
      `Unexpected operation: ${envelope.operation}`,
    );
  }
  return envelope;
}

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `lr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
