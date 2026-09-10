/**
 * Shared Native Messaging request-channel primitive (P1A).
 *
 * Single authority owning Chrome Native Messaging Port lifecycle,
 * pending-request correlation, timeout/AbortSignal, disconnect cleanup,
 * unmatched-response handling, and the transport-level max-envelope ceiling.
 *
 * Protocol-agnostic by design: this module knows nothing about MCP JSON-RPC
 * envelopes (`deepseek-pp-mcp-native`) nor Local Runtime operation envelopes
 * (`deepseek-pp-local-runtime`). Callers supply:
 * - the native host string,
 * - the already-built envelope to post,
 * - a per-request id extractor for correlation,
 * - error factories so MCP vs Local Runtime keep their own error taxonomy.
 *
 * MCP envelope semantics stay in `core/mcp/transports/native.ts`;
 * Local Runtime contract semantics stay in `core/local-runtime/*`.
 * No other module may keep a second Port cache, pending map, correlation,
 * or disconnect authority.
 */

export const NATIVE_MESSAGE_MAX_BYTES = 1 * 1024 * 1024;

export type NativeRequestId = string | number;

export interface NativeChannelErrors {
  unavailable: () => Error;
  disconnected: (detail?: string) => Error;
  timeout: (timeoutMs: number) => Error;
  payloadTooLarge: (bytes: number, ceiling: number) => Error;
  aborted: (signal: AbortSignal) => Error;
}

interface PendingEntry {
  requestId: NativeRequestId;
  extractResponseId: (response: unknown) => NativeRequestId | null | undefined;
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  errors: NativeChannelErrors;
}

interface NativePortState {
  port: chrome.runtime.Port;
  pending: Map<NativeRequestId, PendingEntry>;
}

const portStates = new Map<string, NativePortState>();

function readChromeRuntime(): typeof chrome.runtime | undefined {
  const candidate = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  return candidate ?? undefined;
}

function measureEnvelopeBytes(message: unknown): number {
  return new Blob([JSON.stringify(message)]).size;
}

function assertWithinTransportCeiling(
  message: unknown,
  maxMessageBytes: number,
  createPayloadTooLargeError: (bytes: number, ceiling: number) => Error,
): void {
  const bytes = measureEnvelopeBytes(message);
  if (bytes > maxMessageBytes) {
    throw createPayloadTooLargeError(bytes, maxMessageBytes);
  }
}

function getOrCreatePort(
  nativeHost: string,
  createUnavailableError: () => Error,
): NativePortState {
  const existing = portStates.get(nativeHost);
  if (existing) return existing;

  const runtime = readChromeRuntime();
  if (!runtime?.connectNative) {
    throw createUnavailableError();
  }

  const port = runtime.connectNative(nativeHost);
  const state: NativePortState = { port, pending: new Map() };
  portStates.set(nativeHost, state);

  port.onMessage.addListener((response: unknown) => {
    // Snapshot: resolving one entry mutates the map.
    for (const entry of [...state.pending.values()]) {
      let responseId: NativeRequestId | null | undefined;
      try {
        responseId = entry.extractResponseId(response);
      } catch {
        continue;
      }
      if (responseId == null) continue;
      if (responseId !== entry.requestId) continue;
      state.pending.delete(entry.requestId);
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      entry.resolve(response as never);
      break;
    }
    // Unmatched / malformed responses are intentionally ignored here:
    // they must never resolve or reject a different pending request.
  });

  port.onDisconnect.addListener(() => {
    const detail = readChromeRuntime()?.lastError?.message;
    for (const entry of state.pending.values()) {
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      try {
        entry.reject(entry.errors.disconnected(detail));
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    state.pending.clear();
    portStates.delete(nativeHost);
  });

  return state;
}

/**
 * Post a correlated request on the shared channel and await its response.
 * Throws (rejects) with caller-supplied errors; never opens a second channel.
 */
export function requestNativeHost<TResponse>(
  nativeHost: string,
  message: unknown,
  options: {
    requestId: NativeRequestId;
    extractResponseId: (response: unknown) => NativeRequestId | null | undefined;
    timeoutMs: number;
    signal?: AbortSignal;
    maxMessageBytes?: number;
    errors: NativeChannelErrors;
  },
): Promise<TResponse> {
  const { requestId, extractResponseId, timeoutMs, signal, errors } = options;
  const maxMessageBytes = options.maxMessageBytes ?? NATIVE_MESSAGE_MAX_BYTES;

  if (signal?.aborted) {
    throw errors.aborted(signal);
  }
  assertWithinTransportCeiling(message, maxMessageBytes, errors.payloadTooLarge);

  const state = getOrCreatePort(nativeHost, errors.unavailable);

  if (signal?.aborted) {
    throw errors.aborted(signal);
  }
  if (state.pending.has(requestId)) {
    throw new Error(`Duplicate native request id: ${String(requestId)}`);
  }

  return new Promise<TResponse>((resolve, reject) => {
    if (signal?.aborted) {
      reject(errors.aborted(signal));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      state.pending.delete(requestId);
      try {
        reject(errors.timeout(timeoutMs));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      state.pending.delete(requestId);
      try {
        const reason = signal?.reason;
        if (reason instanceof Error) {
          reject(reason);
          return;
        }
        reject(errors.aborted(signal!));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    state.pending.set(requestId, {
      requestId,
      extractResponseId,
      resolve: resolve as (value: never) => void,
      reject,
      timer,
      signal,
      onAbort: signal ? onAbort : undefined,
      errors,
    });

    try {
      state.port.postMessage(message);
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      state.pending.delete(requestId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Fire-and-forget post on the shared channel (MCP notifications).
 * Still enforces the transport ceiling before touching the Port.
 */
export function notifyNativeHost(
  nativeHost: string,
  message: unknown,
  options: {
    maxMessageBytes?: number;
    errors: Pick<NativeChannelErrors, 'unavailable' | 'payloadTooLarge'>;
  },
): void {
  const maxMessageBytes = options.maxMessageBytes ?? NATIVE_MESSAGE_MAX_BYTES;
  assertWithinTransportCeiling(message, maxMessageBytes, options.errors.payloadTooLarge);
  const state = getOrCreatePort(nativeHost, options.errors.unavailable);
  state.port.postMessage(message);
}

/** Test-only: drop cached Ports/timers. Call only with no settled-pending callers. */
export function __unsafeResetNativeChannelForTests(): void {
  for (const state of portStates.values()) {
    for (const entry of state.pending.values()) {
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
    }
    state.pending.clear();
  }
  portStates.clear();
}
