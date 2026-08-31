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

/**
 * Fail-closed validation mirroring `RuntimeRequest::validate()` on the Rust
 * host. `protocol`, `version`, and `operation` are authoritative; payload
 * claims (`grant_id`, `workspace_id`, `profile_id`, `args`) are never
 * authorization evidence by themselves — the host owner authorizes execution.
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
    if (typeof arg !== 'string' || (arg as string).length > LOCAL_RUNTIME_MAX_ARG_BYTES) {
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

/** Build a well-formed, validated `runtime_exec` request. */
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
