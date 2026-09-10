/**
 * Dedicated `deepseek-pp-local-runtime` v1 contract (TypeScript mirror).
 *
 * This mirrors `runtime/src/contract.rs` byte-for-byte in shape and stays the
 * TS-side trust-boundary validator for the Local Runtime native host
 * (`com.deepseek_pp.runtime.canary`).
 *
 * Architectural boundary: this module is a pure contract surface. It imports
 * no browser/DOM/provider/entrypoint implementation, so it can be validated on
 * both the extension front-end and in Node tests against the same rules the
 * Rust host enforces. The Local Runtime is an *execution-only* subordinate; it
 * is never a second model/agent-loop/router/authorization authority.
 *
 * The envelope here is intentionally NOT the generic `deepseek-pp-mcp-native`
 * v1 launcher envelope (`server.command/args/cwd/env`). The Local Runtime uses
 * its own operation-level contract, and a launcher envelope is never treated as
 * semantic authority by the host.
 */

export const LOCAL_RUNTIME_PROTOCOL = 'deepseek-pp-local-runtime' as const;
export const LOCAL_RUNTIME_VERSION = 1 as const;
export const LOCAL_RUNTIME_HOST_ID = 'com.deepseek_pp.runtime.canary' as const;

export const LOCAL_RUNTIME_MAX_REQUEST_BYTES = 64 * 1024;
export const LOCAL_RUNTIME_MAX_ARGS_PER_REQUEST = 8;
export const LOCAL_RUNTIME_MAX_ARG_BYTES = 1024;

export const LOCAL_RUNTIME_CANARY_PROFILE = 'canary.echo' as const;
export const LOCAL_RUNTIME_CANARY_SPAWN_SLEEPER_PROFILE = 'canary.spawn_sleeper' as const;

export type LocalRuntimeOperation = 'runtime_status' | 'runtime_exec';
export const LOCAL_RUNTIME_OPERATIONS: readonly LocalRuntimeOperation[] = [
  'runtime_status',
  'runtime_exec',
] as const;

/** Wire operation string echoed back on responses (matches Rust `Envelope`). */
export type LocalRuntimeResponseOperation = 'runtime.status' | 'runtime.exec';

export interface LocalRuntimeRequest {
  protocol: string;
  version: number;
  request_id: string;
  operation: LocalRuntimeOperation;
  /** Internal correlation/metadata only — never model-visible authority. */
  grant_id?: string;
  workspace_id?: string;
  profile_id?: string;
  timeout_ms?: number;
  max_output_bytes?: number;
  args?: string[];
}

export interface LocalRuntimeExitStatus {
  code: number | null;
  signal: string | null;
}

export interface LocalRuntimeHostInfo {
  host_id: string;
  runtime_version: string;
  contract_version: number;
  platform: string;
  pty_supported: boolean;
  profiles: string[];
}

export interface LocalRuntimeExecResult {
  run_id: string;
  exit_status: LocalRuntimeExitStatus;
  timed_out: boolean;
  cancelled: boolean;
  teardown_confirmed: boolean;
  bytes_seen: number;
  bytes_retained: number;
  more_available: boolean;
  output: string;
}

export interface LocalRuntimeError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface LocalRuntimeStatusEnvelope {
  protocol: string;
  version: number;
  request_id: string;
  operation: 'runtime.status';
  ok: true;
  host: LocalRuntimeHostInfo;
  result?: never;
  error?: never;
}

export interface LocalRuntimeExecEnvelope {
  protocol: string;
  version: number;
  request_id: string;
  operation: 'runtime.exec';
  ok: boolean;
  host?: never;
  result?: LocalRuntimeExecResult;
  error?: LocalRuntimeError;
}

export type LocalRuntimeEnvelope = LocalRuntimeStatusEnvelope | LocalRuntimeExecEnvelope;

export type LocalRuntimeValidationErrorCode =
  | 'runtime_protocol_unknown'
  | 'runtime_version_unsupported'
  | 'runtime_request_invalid'
  | 'runtime_request_malformed';

export class LocalRuntimeContractError extends Error {
  constructor(
    public readonly code: LocalRuntimeValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocalRuntimeContractError';
  }
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }
  return new Blob([value]).size;
}

/**
 * Fail-closed validation mirroring `RuntimeRequest::validate()` on the Rust
 * host. `protocol`, `version`, and `operation` are authoritative; payload
 * claims (`grant_id`, `workspace_id`, `profile_id`, `args`) are never
 * authorization evidence by themselves — the host owner authorizes execution.
 * Args are measured in UTF-8 bytes (not JS .length) and the serialized
 * request must fit the 64 KiB runtime framing ceiling (outer 1 MiB channel
 * guard does not replace it).
 */
export function validateLocalRuntimeRequest(
  value: unknown,
): asserts value is LocalRuntimeRequest {
  if (typeof value !== 'object' || value === null) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'request must be a JSON object');
  }
  const request = value as Record<string, unknown>;

  if (request.protocol !== LOCAL_RUNTIME_PROTOCOL) {
    throw new LocalRuntimeContractError(
      'runtime_protocol_unknown',
      `unsupported protocol: ${String(request.protocol)}`,
    );
  }
  if (request.version !== LOCAL_RUNTIME_VERSION) {
    throw new LocalRuntimeContractError(
      'runtime_version_unsupported',
      `unsupported contract version: ${String(request.version)}`,
    );
  }
  if (
    typeof request.request_id !== 'string' ||
    request.request_id.length === 0 ||
    request.request_id.length > 128
  ) {
    throw new LocalRuntimeContractError(
      'runtime_request_invalid',
      'request_id must be a non-empty string <= 128 chars',
    );
  }
  if (
    typeof request.operation !== 'string' ||
    !(LOCAL_RUNTIME_OPERATIONS as readonly string[]).includes(request.operation)
  ) {
    throw new LocalRuntimeContractError(
      'runtime_request_malformed',
      'unknown operation',
    );
  }

  const args = request.args === undefined ? [] : request.args;
  if (!Array.isArray(args) || args.length > LOCAL_RUNTIME_MAX_ARGS_PER_REQUEST) {
    throw new LocalRuntimeContractError(
      'runtime_request_invalid',
      `args exceed per-request cap ${LOCAL_RUNTIME_MAX_ARGS_PER_REQUEST}`,
    );
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string' || utf8ByteLength(arg as string) > LOCAL_RUNTIME_MAX_ARG_BYTES) {
      throw new LocalRuntimeContractError(
        'runtime_request_invalid',
        `arg[${index}] exceeds ${LOCAL_RUNTIME_MAX_ARG_BYTES} bytes`,
      );
    }
  }

  if (request.timeout_ms !== undefined) {
    const timeout = request.timeout_ms;
    if (typeof timeout !== 'number' || timeout <= 0 || timeout > 3_600_000) {
      throw new LocalRuntimeContractError(
        'runtime_request_invalid',
        'timeout_ms must be within (0, 3600000]',
      );
    }
  }

  if (request.max_output_bytes !== undefined) {
    const budget = request.max_output_bytes;
    if (typeof budget !== 'number' || budget <= 0 || budget > 1_000_000) {
      throw new LocalRuntimeContractError(
        'runtime_request_invalid',
        'max_output_bytes must be within (0, 1000000]',
      );
    }
  }

  // 64 KiB runtime framing ceiling (aligns with Rust framing.rs, not the outer 1 MiB channel).
  const serializedBytes = new Blob([JSON.stringify(value)]).size;
  if (serializedBytes > LOCAL_RUNTIME_MAX_REQUEST_BYTES) {
    throw new LocalRuntimeContractError(
      'runtime_request_invalid',
      `serialized request exceeds ${LOCAL_RUNTIME_MAX_REQUEST_BYTES} bytes (${serializedBytes} bytes)`,
    );
  }
}

/** Build a well-formed, validated `runtime_status` request. */
export function buildLocalRuntimeStatusRequest(requestId: string): LocalRuntimeRequest {
  const request: LocalRuntimeRequest = {
    protocol: LOCAL_RUNTIME_PROTOCOL,
    version: LOCAL_RUNTIME_VERSION,
    request_id: requestId,
    operation: 'runtime_status',
  };
  validateLocalRuntimeRequest(request);
  return request;
}

/** Build a well-formed, validated `runtime_exec` request (internal wire, not model-visible). */
export function buildLocalRuntimeExecRequest(input: {
  requestId: string;
  grantId: string;
  profileId: string;
  args?: string[];
  workspaceId?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): LocalRuntimeRequest {
  const request: LocalRuntimeRequest = {
    protocol: LOCAL_RUNTIME_PROTOCOL,
    version: LOCAL_RUNTIME_VERSION,
    request_id: input.requestId,
    operation: 'runtime_exec',
    grant_id: input.grantId,
    profile_id: input.profileId,
    workspace_id: input.workspaceId,
    timeout_ms: input.timeoutMs,
    max_output_bytes: input.maxOutputBytes,
    args: input.args,
  };
  validateLocalRuntimeRequest(request);
  return request;
}

/**
 * Strict, fail-closed validation for incoming Local Runtime envelopes.
 * Must be called after shared-channel correlation and before any typed wrapper
 * accepts the payload. Never use `as LocalRuntimeEnvelope` without this.
 */
export function validateLocalRuntimeEnvelope(
  value: unknown,
  expected?: { requestId?: string; operation?: LocalRuntimeResponseOperation },
): asserts value is LocalRuntimeEnvelope {
  if (typeof value !== 'object' || value === null) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'envelope must be a JSON object');
  }
  const env = value as Record<string, unknown>;
  if (env.protocol !== LOCAL_RUNTIME_PROTOCOL) {
    throw new LocalRuntimeContractError('runtime_protocol_unknown', `unsupported protocol: ${String(env.protocol)}`);
  }
  if (env.version !== LOCAL_RUNTIME_VERSION) {
    throw new LocalRuntimeContractError('runtime_version_unsupported', `unsupported contract version: ${String(env.version)}`);
  }
  if (typeof env.request_id !== 'string' || env.request_id.length === 0 || env.request_id.length > 128) {
    throw new LocalRuntimeContractError('runtime_request_invalid', 'request_id must be a non-empty string <= 128 chars');
  }
  if (expected?.requestId !== undefined && env.request_id !== expected.requestId) {
    throw new LocalRuntimeContractError('runtime_request_invalid', `request_id mismatch: expected ${expected.requestId}, got ${String(env.request_id)}`);
  }
  if (typeof env.operation !== 'string' || (env.operation !== 'runtime.status' && env.operation !== 'runtime.exec')) {
    throw new LocalRuntimeContractError('runtime_request_malformed', `unknown response operation: ${String(env.operation)}`);
  }
  if (expected?.operation !== undefined && env.operation !== expected.operation) {
    throw new LocalRuntimeContractError('runtime_request_invalid', `operation mismatch: expected ${expected.operation}, got ${String(env.operation)}`);
  }
  if (typeof env.ok !== 'boolean') {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'ok must be boolean');
  }

  if (env.operation === 'runtime.status') {
    if (env.ok !== true) {
      throw new LocalRuntimeContractError('runtime_request_invalid', 'runtime.status must have ok:true');
    }
    if (env.result !== undefined) {
      throw new LocalRuntimeContractError('runtime_request_malformed', 'runtime.status must not have result');
    }
    if (env.error !== undefined) {
      throw new LocalRuntimeContractError('runtime_request_malformed', 'runtime.status must not have error');
    }
    validateLocalRuntimeHostInfo(env.host);
    return;
  }

  // operation === 'runtime.exec'
  if (env.host !== undefined) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'runtime.exec must not have host');
  }
  const hasResult = env.result !== undefined;
  const hasError = env.error !== undefined;
  if (env.ok === true) {
    if (!hasResult || hasError) {
      throw new LocalRuntimeContractError('runtime_request_malformed', 'runtime.exec ok:true must have exactly result');
    }
    validateLocalRuntimeExecResult(env.result);
    return;
  }
  // ok === false
  if (!hasError || hasResult) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'runtime.exec ok:false must have exactly error');
  }
  validateLocalRuntimeError(env.error);
}

function validateLocalRuntimeHostInfo(value: unknown): asserts value is LocalRuntimeHostInfo {
  if (typeof value !== 'object' || value === null) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'host must be an object');
  }
  const host = value as Record<string, unknown>;
  if (typeof host.host_id !== 'string' || host.host_id.length === 0) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'host.host_id must be non-empty string');
  }
  if (host.host_id !== LOCAL_RUNTIME_HOST_ID) {
    throw new LocalRuntimeContractError('runtime_request_invalid', `host_id must be ${LOCAL_RUNTIME_HOST_ID}`);
  }
  if (typeof host.runtime_version !== 'string' || host.runtime_version.length === 0) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'host.runtime_version must be non-empty string');
  }
  if (host.contract_version !== LOCAL_RUNTIME_VERSION) {
    throw new LocalRuntimeContractError('runtime_version_unsupported', `host contract_version must be ${LOCAL_RUNTIME_VERSION}`);
  }
  if (typeof host.platform !== 'string' || host.platform.length === 0) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'host.platform must be non-empty string');
  }
  if (typeof host.pty_supported !== 'boolean') {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'host.pty_supported must be boolean');
  }
  if (!Array.isArray(host.profiles) || host.profiles.length === 0) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'host.profiles must be non-empty array');
  }
  for (const p of host.profiles) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new LocalRuntimeContractError('runtime_request_malformed', 'host.profiles entries must be non-empty strings');
    }
  }
}

function validateLocalRuntimeExecResult(value: unknown): asserts value is LocalRuntimeExecResult {
  if (typeof value !== 'object' || value === null) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'result must be an object');
  }
  const result = value as Record<string, unknown>;
  if (typeof result.run_id !== 'string' || result.run_id.length === 0) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'result.run_id must be non-empty string');
  }
  const exit = result.exit_status;
  if (typeof exit !== 'object' || exit === null) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'result.exit_status must be an object');
  }
  const exitRec = exit as Record<string, unknown>;
  const code = exitRec.code;
  const signal = exitRec.signal;
  if (!(code === null || (typeof code === 'number' && Number.isInteger(code)))) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'result.exit_status.code must be integer or null');
  }
  if (!(signal === null || typeof signal === 'string')) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'result.exit_status.signal must be string or null');
  }
  for (const key of ['timed_out', 'cancelled', 'teardown_confirmed', 'more_available'] as const) {
    if (typeof result[key] !== 'boolean') {
      throw new LocalRuntimeContractError('runtime_request_malformed', `result.${key} must be boolean`);
    }
  }
  for (const key of ['bytes_seen', 'bytes_retained'] as const) {
    const v = result[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new LocalRuntimeContractError('runtime_request_malformed', `result.${key} must be non-negative integer`);
    }
  }
  const bytesSeen = result.bytes_seen as number;
  const bytesRetained = result.bytes_retained as number;
  if (bytesRetained > bytesSeen) {
    throw new LocalRuntimeContractError('runtime_request_invalid', 'bytes_retained must not exceed bytes_seen');
  }
  if (typeof result.output !== 'string') {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'result.output must be string');
  }
}

function validateLocalRuntimeError(value: unknown): asserts value is LocalRuntimeError {
  if (typeof value !== 'object' || value === null) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'error must be an object');
  }
  const err = value as Record<string, unknown>;
  if (typeof err.code !== 'string' || err.code.length === 0) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'error.code must be non-empty string');
  }
  if (typeof err.message !== 'string' || err.message.length === 0) {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'error.message must be non-empty string');
  }
  if (err.retryable !== undefined && typeof err.retryable !== 'boolean') {
    throw new LocalRuntimeContractError('runtime_request_malformed', 'error.retryable must be boolean if present');
  }
}
