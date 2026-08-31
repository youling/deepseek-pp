/**
 * Native-messaging client for the Local Runtime host
 * (`com.deepseek_pp.runtime.canary`).
 *
 * Chrome's native messaging channel performs 4-byte little-endian length
 * framing automatically around every JSON message we post; the Rust host's
 * `framing.rs` reads the same framing. This client reuses the request
 * correlation/timeout pattern from `core/mcp/transports/native.ts` but speaks
 * the dedicated `deepseek-pp-local-runtime` operation contract — NOT the MCP
 * native launcher envelope.
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
  validateLocalRuntimeRequest,
} from './contract';

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

interface PendingRequest {
  resolve: (value: LocalRuntimeEnvelope) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PortState {
  port: chrome.runtime.Port;
  pendingRequests: Map<string, PendingRequest>;
}

const MAX_NATIVE_MESSAGE_BYTES = 1 * 1024 * 1024;

const portStateByHost = new Map<string, PortState>();

function getPortState(): PortState {
  const existing = portStateByHost.get(LOCAL_RUNTIME_HOST_ID);
  if (existing) return existing;

  if (!chrome.runtime?.connectNative) {
    throw new LocalRuntimeClientError(
      'local_runtime_native_messaging_unavailable',
      'Browser native messaging is unavailable.',
    );
  }

  const port = chrome.runtime.connectNative(LOCAL_RUNTIME_HOST_ID);
  const state: PortState = { port, pendingRequests: new Map() };
  portStateByHost.set(LOCAL_RUNTIME_HOST_ID, state);

  port.onMessage.addListener((response: LocalRuntimeEnvelope) => {
    const requestId = response?.request_id;
    const pending = requestId != null ? state.pendingRequests.get(requestId) : undefined;
    if (!pending) return;
    state.pendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
  });

  port.onDisconnect.addListener(() => {
    const err = new LocalRuntimeClientError(
      'local_runtime_host_disconnected',
      chrome.runtime.lastError?.message || 'Local Runtime native host disconnected.',
    );
    for (const pending of state.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    state.pendingRequests.clear();
    portStateByHost.delete(LOCAL_RUNTIME_HOST_ID);
  });

  return state;
}

/**
 * Send a validated Local Runtime request and await the correlated response.
 * Validates the outgoing request at the TS trust boundary before it is posted.
 */
export function sendLocalRuntimeRequest(
  request: LocalRuntimeRequest,
  options?: { timeoutMs?: number },
): Promise<LocalRuntimeEnvelope> {
  validateLocalRuntimeRequest(request);

  const timeoutMs = options?.timeoutMs ?? 5_000;
  const bodyBytes = new Blob([JSON.stringify(request)]).size;
  if (bodyBytes > MAX_NATIVE_MESSAGE_BYTES) {
    throw new LocalRuntimeClientError(
      'local_runtime_unknown_error',
      `Local Runtime request is too large (${bodyBytes} > ${MAX_NATIVE_MESSAGE_BYTES} bytes).`,
    );
  }

  return new Promise((resolve, reject) => {
    let state: PortState;
    try {
      state = getPortState();
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      state.pendingRequests.delete(request.request_id);
      reject(new LocalRuntimeClientError(
        'local_runtime_timeout',
        `Local Runtime request exceeded ${timeoutMs} ms.`,
      ));
    }, timeoutMs);

    state.pendingRequests.set(request.request_id, { resolve, reject, timer });
    try {
      state.port.postMessage(request);
    } catch (err) {
      clearTimeout(timer);
      state.pendingRequests.delete(request.request_id);
      reject(err instanceof Error ? err : new LocalRuntimeClientError('local_runtime_unknown_error', String(err)));
    }
  });
}

/** Convenience typed wrappers for the two operations. */
export function localRuntimeStatus(options?: { timeoutMs?: number }): Promise<LocalRuntimeStatusEnvelope> {
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
  return sendLocalRuntimeRequest(request, { timeoutMs: input.timeoutMs }).then(assertExec);
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
