import type { JsonValue } from '../tool/types';
import {
  projectToolResultForInjection,
  type ToolResultTruncationProvenance,
} from '../tool/result-budget';

/**
 * P2 PREP / NON-EXECUTABLE.
 *
 * This file freezes the coding contract only. It must not register a provider,
 * invoke Native Messaging, execute a process, or touch the filesystem.
 */
export const CODING_CONTRACT_VERSION = 1 as const;
export type CodingContractVersion = typeof CODING_CONTRACT_VERSION;

export const CODING_PRIMITIVE_NAMES = [
  'coding_workspace_info',
  'coding_file_read',
  'coding_file_list',
  'coding_file_search',
  'coding_apply_patch',
  'coding_process_exec',
  'coding_process_read',
  'coding_process_write',
  'coding_process_kill',
  'coding_git_status',
  'coding_git_diff',
  'coding_git_log',
] as const;

export type CodingPrimitiveName = typeof CODING_PRIMITIVE_NAMES[number];

/**
 * Direct file mutation is intentionally a single-authority surface:
 * `coding_apply_patch`. Process control is separate; controlled git mutation,
 * if later permitted by the existing authorization path, goes through
 * `coding_process_exec` rather than new git-mutation primitives.
 */
export type CodingPrimitiveEffect = 'read-only' | 'file-mutation' | 'process-control';

export const CODING_PRIMITIVE_EFFECTS: Readonly<Record<CodingPrimitiveName, CodingPrimitiveEffect>> = {
  coding_workspace_info: 'read-only',
  coding_file_read: 'read-only',
  coding_file_list: 'read-only',
  coding_file_search: 'read-only',
  coding_apply_patch: 'file-mutation',
  coding_process_exec: 'process-control',
  coding_process_read: 'read-only',
  coding_process_write: 'process-control',
  coding_process_kill: 'process-control',
  coding_git_status: 'read-only',
  coding_git_diff: 'read-only',
  coding_git_log: 'read-only',
};

export const CODING_CONTRACT_ERROR_CODES = [
  'P2_INVALID_OBJECT',
  'P2_UNSUPPORTED_VERSION',
  'P2_UNKNOWN_FIELD',
  'P2_MISSING_FIELD',
  'P2_INVALID_FIELD',
  'P2_MODEL_WORKSPACE_ROOT_FORBIDDEN',
  'P2_ABSOLUTE_PATH_FORBIDDEN',
  'P2_PATH_ESCAPE_FORBIDDEN',
] as const;

export const CODING_RUNTIME_ERROR_CODES = [
  'P2_NOT_FOUND',
  'P2_PATCH_CONFLICT',
  'P2_PROCESS_NOT_FOUND',
  'P2_RUNTIME_UNAVAILABLE',
  'P2_IO_ERROR',
  'P2_PROTOCOL_ERROR',
] as const;

export type CodingContractErrorCode = typeof CODING_CONTRACT_ERROR_CODES[number];
export type CodingRuntimeErrorCode = typeof CODING_RUNTIME_ERROR_CODES[number];
export type CodingErrorCode = CodingContractErrorCode | CodingRuntimeErrorCode;

export interface CodingError {
  code: CodingErrorCode;
  message: string;
  retryable: boolean;
  details?: Readonly<Record<string, JsonValue>>;
}

export type CodingContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CodingError };

function pass<T>(value: T): CodingContractResult<T> {
  return { ok: true, value };
}

function fail(
  code: CodingContractErrorCode,
  message: string,
  details?: Readonly<Record<string, JsonValue>>,
): CodingContractResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: false,
      ...(details ? { details } : {}),
    },
  };
}

declare const workspaceRelativePathBrand: unique symbol;
export type WorkspaceRelativePath = string & {
  readonly [workspaceRelativePathBrand]: true;
};

/**
 * All model-visible paths express workspace-relative intent only. The trusted
 * P1/P2 adapter remains responsible for realpath/symlink containment before
 * execution; a model-supplied workspace root is never accepted as authority.
 */
export function validateWorkspaceRelativePath(
  input: string,
): CodingContractResult<WorkspaceRelativePath> {
  if (!input || input.includes('\0')) {
    return fail('P2_INVALID_FIELD', 'workspace-relative path must be a non-empty string without NUL');
  }

  const normalizedSeparators = input.replace(/\\/g, '/');
  if (normalizedSeparators.startsWith('/') || /^[A-Za-z]:/.test(normalizedSeparators)) {
    return fail(
      'P2_ABSOLUTE_PATH_FORBIDDEN',
      'absolute or drive-qualified paths are forbidden; use workspace-relative intent',
    );
  }

  const segments = normalizedSeparators.split('/');
  if (segments.some((segment) => segment === '..')) {
    return fail(
      'P2_PATH_ESCAPE_FORBIDDEN',
      'workspace-relative path must not traverse above the bound workspace',
    );
  }

  const normalized = segments.filter((segment) => segment && segment !== '.').join('/') || '.';
  return pass(normalized as WorkspaceRelativePath);
}

export interface CodingWorkspaceInfoInput {
  version: CodingContractVersion;
}

export interface CodingWorkspaceInfoOutput {
  version: CodingContractVersion;
  workspaceId: string;
  cwd: string;
}

export interface CodingFileReadInput {
  version: CodingContractVersion;
  path: string;
  maxBytes?: number;
}

export interface CodingBoundedText {
  text: string;
  bytesSeen: number;
  bytesRetained: number;
  moreAvailable: boolean;
}

export interface CodingFileReadOutput {
  version: CodingContractVersion;
  path: string;
  content: CodingBoundedText;
}

export interface CodingFileListInput {
  version: CodingContractVersion;
  path?: string;
  recursive?: boolean;
  maxEntries?: number;
}

export interface CodingFileListEntry {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
}

export interface CodingFileListOutput {
  version: CodingContractVersion;
  path: string;
  entries: readonly CodingFileListEntry[];
  totalEntries: number;
  retainedEntries: number;
  moreAvailable: boolean;
}

export interface CodingFileSearchInput {
  version: CodingContractVersion;
  query: string;
  path?: string;
  maxMatches?: number;
}

export interface CodingFileSearchMatch {
  path: string;
  line?: number;
  text: string;
}

export interface CodingFileSearchOutput {
  version: CodingContractVersion;
  query: string;
  matches: readonly CodingFileSearchMatch[];
  totalMatches: number;
  retainedMatches: number;
  moreAvailable: boolean;
}

export interface CodingPatchFile {
  /** Structured authority path; patch text must not override this path. */
  path: string;
  patch: string;
}

export interface CodingApplyPatchInput {
  version: CodingContractVersion;
  files: readonly CodingPatchFile[];
}

export interface CodingApplyPatchOutput {
  version: CodingContractVersion;
  changedPaths: readonly string[];
}

export interface CodingProcessExecInput {
  version: CodingContractVersion;
  requestId: string;
  executable: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface CodingProcessReadInput {
  version: CodingContractVersion;
  requestId: string;
  runId: string;
  stdoutOffset?: number;
  stderrOffset?: number;
  maxBytes?: number;
}

export interface CodingProcessWriteInput {
  version: CodingContractVersion;
  requestId: string;
  runId: string;
  data: string;
  closeStdin?: boolean;
}

export interface CodingProcessKillInput {
  version: CodingContractVersion;
  requestId: string;
  runId: string;
}

/**
 * Lifecycle fields are explicit rather than inferred from a missing exit code.
 * `teardownConfirmed` is independent from cancel/timeout so cleanup cannot be
 * reported complete merely because cancellation was requested.
 */
export interface CodingProcessLifecycle {
  state: 'running' | 'exited' | 'failed';
  exitCode: number | null;
  exitSignal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  teardownConfirmed: boolean;
}

export interface CodingProcessStream {
  data: string;
  bytesSeen: number;
  bytesRetained: number;
  moreAvailable: boolean;
}

export const CODING_PROCESS_LIFECYCLE_FIELDS = [
  'state',
  'exitCode',
  'exitSignal',
  'timedOut',
  'cancelled',
  'teardownConfirmed',
] as const;

export const CODING_PROCESS_STREAM_FIELDS = [
  'data',
  'bytesSeen',
  'bytesRetained',
  'moreAvailable',
] as const;

export interface CodingProcessSnapshotOutput {
  version: CodingContractVersion;
  requestId: string;
  runId: string;
  lifecycle: CodingProcessLifecycle;
  stdout: CodingProcessStream;
  stderr: CodingProcessStream;
}

export type CodingProcessExecOutput = CodingProcessSnapshotOutput;
export type CodingProcessReadOutput = CodingProcessSnapshotOutput;

export interface CodingProcessWriteOutput {
  version: CodingContractVersion;
  requestId: string;
  runId: string;
  acceptedBytes: number;
  stdinClosed: boolean;
  lifecycle: CodingProcessLifecycle;
}

export interface CodingProcessKillOutput {
  version: CodingContractVersion;
  requestId: string;
  runId: string;
  cancelRequested: boolean;
  lifecycle: CodingProcessLifecycle;
}

export interface CodingGitStatusInput {
  version: CodingContractVersion;
  cwd?: string;
}

export interface CodingGitDiffInput {
  version: CodingContractVersion;
  cwd?: string;
  staged?: boolean;
  paths?: readonly string[];
}

export interface CodingGitLogInput {
  version: CodingContractVersion;
  cwd?: string;
  ref?: string;
  maxEntries?: number;
}

export interface CodingGitTextOutput {
  version: CodingContractVersion;
  content: CodingBoundedText;
}

export type CodingGitStatusOutput = CodingGitTextOutput;
export type CodingGitDiffOutput = CodingGitTextOutput;
export type CodingGitLogOutput = CodingGitTextOutput;

export interface CodingPrimitiveInputMap {
  coding_workspace_info: CodingWorkspaceInfoInput;
  coding_file_read: CodingFileReadInput;
  coding_file_list: CodingFileListInput;
  coding_file_search: CodingFileSearchInput;
  coding_apply_patch: CodingApplyPatchInput;
  coding_process_exec: CodingProcessExecInput;
  coding_process_read: CodingProcessReadInput;
  coding_process_write: CodingProcessWriteInput;
  coding_process_kill: CodingProcessKillInput;
  coding_git_status: CodingGitStatusInput;
  coding_git_diff: CodingGitDiffInput;
  coding_git_log: CodingGitLogInput;
}

export interface CodingPrimitiveOutputMap {
  coding_workspace_info: CodingWorkspaceInfoOutput;
  coding_file_read: CodingFileReadOutput;
  coding_file_list: CodingFileListOutput;
  coding_file_search: CodingFileSearchOutput;
  coding_apply_patch: CodingApplyPatchOutput;
  coding_process_exec: CodingProcessExecOutput;
  coding_process_read: CodingProcessReadOutput;
  coding_process_write: CodingProcessWriteOutput;
  coding_process_kill: CodingProcessKillOutput;
  coding_git_status: CodingGitStatusOutput;
  coding_git_diff: CodingGitDiffOutput;
  coding_git_log: CodingGitLogOutput;
}

export type CodingFieldKind =
  | 'version'
  | 'string'
  | 'boolean'
  | 'nonNegativeInteger'
  | 'stringArray'
  | 'workspacePath'
  | 'workspacePathArray'
  | 'patchFiles'
  | 'object'
  | 'array';

export interface CodingFieldSchema {
  kind: CodingFieldKind;
  required: boolean;
}

export interface CodingObjectSchema {
  fields: Readonly<Record<string, CodingFieldSchema>>;
  additionalProperties: false;
}

export interface CodingPrimitiveSchema {
  effect: CodingPrimitiveEffect;
  input: CodingObjectSchema;
  output: CodingObjectSchema;
}

const req = (kind: CodingFieldKind): CodingFieldSchema => ({ kind, required: true });
const opt = (kind: CodingFieldKind): CodingFieldSchema => ({ kind, required: false });
const strict = (fields: Record<string, CodingFieldSchema>): CodingObjectSchema => ({
  fields,
  additionalProperties: false,
});

/**
 * Non-registered schema catalog. It is contract data only, not a second tool
 * registry and intentionally contains no grant/token/authorization evidence.
 */
export const CODING_PRIMITIVE_SCHEMAS: Readonly<Record<CodingPrimitiveName, CodingPrimitiveSchema>> = {
  coding_workspace_info: {
    effect: 'read-only',
    input: strict({ version: req('version') }),
    output: strict({ version: req('version'), workspaceId: req('string'), cwd: req('workspacePath') }),
  },
  coding_file_read: {
    effect: 'read-only',
    input: strict({ version: req('version'), path: req('workspacePath'), maxBytes: opt('nonNegativeInteger') }),
    output: strict({ version: req('version'), path: req('workspacePath'), content: req('object') }),
  },
  coding_file_list: {
    effect: 'read-only',
    input: strict({ version: req('version'), path: opt('workspacePath'), recursive: opt('boolean'), maxEntries: opt('nonNegativeInteger') }),
    output: strict({ version: req('version'), path: req('workspacePath'), entries: req('array'), totalEntries: req('nonNegativeInteger'), retainedEntries: req('nonNegativeInteger'), moreAvailable: req('boolean') }),
  },
  coding_file_search: {
    effect: 'read-only',
    input: strict({ version: req('version'), query: req('string'), path: opt('workspacePath'), maxMatches: opt('nonNegativeInteger') }),
    output: strict({ version: req('version'), query: req('string'), matches: req('array'), totalMatches: req('nonNegativeInteger'), retainedMatches: req('nonNegativeInteger'), moreAvailable: req('boolean') }),
  },
  coding_apply_patch: {
    effect: 'file-mutation',
    input: strict({ version: req('version'), files: req('patchFiles') }),
    output: strict({ version: req('version'), changedPaths: req('workspacePathArray') }),
  },
  coding_process_exec: {
    effect: 'process-control',
    input: strict({ version: req('version'), requestId: req('string'), executable: req('string'), args: opt('stringArray'), cwd: opt('workspacePath'), timeoutMs: opt('nonNegativeInteger') }),
    output: strict({ version: req('version'), requestId: req('string'), runId: req('string'), lifecycle: req('object'), stdout: req('object'), stderr: req('object') }),
  },
  coding_process_read: {
    effect: 'read-only',
    input: strict({ version: req('version'), requestId: req('string'), runId: req('string'), stdoutOffset: opt('nonNegativeInteger'), stderrOffset: opt('nonNegativeInteger'), maxBytes: opt('nonNegativeInteger') }),
    output: strict({ version: req('version'), requestId: req('string'), runId: req('string'), lifecycle: req('object'), stdout: req('object'), stderr: req('object') }),
  },
  coding_process_write: {
    effect: 'process-control',
    input: strict({ version: req('version'), requestId: req('string'), runId: req('string'), data: req('string'), closeStdin: opt('boolean') }),
    output: strict({ version: req('version'), requestId: req('string'), runId: req('string'), acceptedBytes: req('nonNegativeInteger'), stdinClosed: req('boolean'), lifecycle: req('object') }),
  },
  coding_process_kill: {
    effect: 'process-control',
    input: strict({ version: req('version'), requestId: req('string'), runId: req('string') }),
    output: strict({ version: req('version'), requestId: req('string'), runId: req('string'), cancelRequested: req('boolean'), lifecycle: req('object') }),
  },
  coding_git_status: {
    effect: 'read-only',
    input: strict({ version: req('version'), cwd: opt('workspacePath') }),
    output: strict({ version: req('version'), content: req('object') }),
  },
  coding_git_diff: {
    effect: 'read-only',
    input: strict({ version: req('version'), cwd: opt('workspacePath'), staged: opt('boolean'), paths: opt('workspacePathArray') }),
    output: strict({ version: req('version'), content: req('object') }),
  },
  coding_git_log: {
    effect: 'read-only',
    input: strict({ version: req('version'), cwd: opt('workspacePath'), ref: opt('string'), maxEntries: opt('nonNegativeInteger') }),
    output: strict({ version: req('version'), content: req('object') }),
  },
};

export const CODING_COMPATIBILITY_POLICY = {
  currentVersion: CODING_CONTRACT_VERSION,
  unknownRequestFields: 'reject',
  unknownResponseFields: 'reject',
  unsupportedVersion: 'reject',
  rule: 'Additive or semantic changes require an explicit contract update/version; v1 never guesses future semantics.',
} as const;

const FORBIDDEN_MODEL_ROOT_FIELDS = new Set([
  'workspaceRoot',
  'projectRoot',
  'rootPath',
  'canonicalRoot',
  'canonicalPath',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePatchFiles(value: unknown): CodingContractResult<readonly CodingPatchFile[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return fail('P2_INVALID_FIELD', 'files must be a non-empty array of structured patch entries');
  }

  const files: CodingPatchFile[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return fail('P2_INVALID_FIELD', 'each patch entry must be an object');
    }
    const keys = Object.keys(entry);
    if (keys.some((key) => key !== 'path' && key !== 'patch')) {
      return fail('P2_UNKNOWN_FIELD', 'patch entries accept only path and patch');
    }
    if (typeof entry.path !== 'string' || typeof entry.patch !== 'string') {
      return fail('P2_INVALID_FIELD', 'patch entry path and patch must be strings');
    }
    const path = validateWorkspaceRelativePath(entry.path);
    if (!path.ok) return path;
    files.push({ path: path.value, patch: entry.patch });
  }
  return pass(files);
}

function validateField(kind: CodingFieldKind, value: unknown): CodingContractResult<unknown> {
  switch (kind) {
    case 'version':
      return value === CODING_CONTRACT_VERSION
        ? pass(value)
        : fail('P2_UNSUPPORTED_VERSION', `only coding contract v${CODING_CONTRACT_VERSION} is accepted`);
    case 'string':
      return typeof value === 'string'
        ? pass(value)
        : fail('P2_INVALID_FIELD', 'expected string');
    case 'boolean':
      return typeof value === 'boolean'
        ? pass(value)
        : fail('P2_INVALID_FIELD', 'expected boolean');
    case 'nonNegativeInteger':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? pass(value)
        : fail('P2_INVALID_FIELD', 'expected non-negative safe integer');
    case 'stringArray':
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? pass(value)
        : fail('P2_INVALID_FIELD', 'expected string array');
    case 'workspacePath':
      return typeof value === 'string'
        ? validateWorkspaceRelativePath(value)
        : fail('P2_INVALID_FIELD', 'expected workspace-relative path string');
    case 'workspacePathArray': {
      if (!Array.isArray(value)) return fail('P2_INVALID_FIELD', 'expected workspace-relative path array');
      const paths: WorkspaceRelativePath[] = [];
      for (const item of value) {
        if (typeof item !== 'string') return fail('P2_INVALID_FIELD', 'expected workspace-relative path array');
        const path = validateWorkspaceRelativePath(item);
        if (!path.ok) return path;
        paths.push(path.value);
      }
      return pass(paths);
    }
    case 'patchFiles':
      return validatePatchFiles(value);
    case 'object':
      return isRecord(value) ? pass(value) : fail('P2_INVALID_FIELD', 'expected object');
    case 'array':
      return Array.isArray(value) ? pass(value) : fail('P2_INVALID_FIELD', 'expected array');
  }
}

function validateSchemaObject(
  primitive: CodingPrimitiveName,
  direction: 'input' | 'output',
  value: unknown,
): CodingContractResult<Record<string, unknown>> {
  if (!isRecord(value)) {
    return fail('P2_INVALID_OBJECT', `${primitive} ${direction} must be an object`);
  }

  if (direction === 'input') {
    const forbiddenRoot = Object.keys(value).find((key) => FORBIDDEN_MODEL_ROOT_FIELDS.has(key));
    if (forbiddenRoot) {
      return fail(
        'P2_MODEL_WORKSPACE_ROOT_FORBIDDEN',
        'workspace binding is receiver-owned; model-supplied workspace roots are forbidden',
        { field: forbiddenRoot },
      );
    }
  }

  const schema = CODING_PRIMITIVE_SCHEMAS[primitive][direction];
  const allowed = new Set(Object.keys(schema.fields));
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    return fail('P2_UNKNOWN_FIELD', `${primitive} ${direction} contains unknown field ${unknown}`, {
      field: unknown,
    });
  }

  for (const [fieldName, fieldSchema] of Object.entries(schema.fields)) {
    if (!(fieldName in value)) {
      if (fieldSchema.required) {
        return fail('P2_MISSING_FIELD', `${primitive} ${direction} is missing ${fieldName}`, {
          field: fieldName,
        });
      }
      continue;
    }
    const validated = validateField(fieldSchema.kind, value[fieldName]);
    if (!validated.ok) {
      return {
        ok: false,
        error: {
          ...validated.error,
          message: `${primitive}.${fieldName}: ${validated.error.message}`,
          details: {
            ...(validated.error.details ?? {}),
            field: fieldName,
          },
        },
      };
    }
  }

  return pass(value);
}

/** Strict v1 request validator; no execution or I/O. */
export function validateCodingPrimitiveInput<N extends CodingPrimitiveName>(
  primitive: N,
  value: unknown,
): CodingContractResult<CodingPrimitiveInputMap[N]> {
  const result = validateSchemaObject(primitive, 'input', value);
  return result.ok ? pass(result.value as unknown as CodingPrimitiveInputMap[N]) : result;
}

/** Strict v1 response-shape validator for the future P1C/P2 adapter seam. */
export function validateCodingPrimitiveOutput<N extends CodingPrimitiveName>(
  primitive: N,
  value: unknown,
): CodingContractResult<CodingPrimitiveOutputMap[N]> {
  const result = validateSchemaObject(primitive, 'output', value);
  return result.ok ? pass(result.value as unknown as CodingPrimitiveOutputMap[N]) : result;
}

/**
 * Typed result wrapper. Error codes are machine-readable; P0 truncation
 * provenance remains the sole truncation provenance model.
 */
export type CodingPrimitiveResult<N extends CodingPrimitiveName> =
  | {
      version: CodingContractVersion;
      primitive: N;
      ok: true;
      summary: string;
      output: CodingPrimitiveOutputMap[N];
      truncated: boolean;
      truncation: ToolResultTruncationProvenance;
    }
  | {
      version: CodingContractVersion;
      primitive: N;
      ok: false;
      summary: string;
      error: CodingError;
      truncated: boolean;
      truncation: ToolResultTruncationProvenance;
    };

/**
 * Exact alias to the existing P0 projection/budget authority. P2 introduces no
 * competing 4k/8k constants, clamp policy, or truncation-provenance producer.
 */
export const projectCodingToolResultForInjection = projectToolResultForInjection;
