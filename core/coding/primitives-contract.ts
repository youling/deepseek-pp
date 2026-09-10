import type { JsonValue } from '../tool/types';
import {
  projectToolResultForInjection,
  type ToolResultTruncationProvenance,
} from '../tool/result-budget';

/**
 * P2 PREP / NON-EXECUTABLE.
 *
 * This module freezes the coding contract only. It contains no provider
 * registration, Native Messaging hookup, process execution, or filesystem I/O.
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

export type CodingPrimitiveEffect = 'read-only' | 'file-mutation' | 'process-control';

/**
 * `coding_apply_patch` is the only direct file-mutation primitive. Git mutation
 * is intentionally not represented by a dedicated v0 primitive; any future
 * mutation through `coding_process_exec` remains subject to the existing
 * receiver-owned authorization/risk path.
 */
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
  'P2_UNKNOWN_PRIMITIVE',
  'P2_INVALID_OBJECT',
  'P2_UNSUPPORTED_VERSION',
  'P2_UNKNOWN_FIELD',
  'P2_MISSING_FIELD',
  'P2_INVALID_FIELD',
  'P2_MODEL_WORKSPACE_ROOT_FORBIDDEN',
  'P2_MODEL_CAPABILITY_FORBIDDEN',
  'P2_PROJECT_ROOT_REQUIRED',
  'P2_INVALID_CANONICAL_ROOT',
  'P2_DUPLICATE_REPO_ROOT_IDENTITY',
  'P2_INVALID_CANONICAL_REFERENCE',
  'P2_REFERENCE_OUTSIDE_DECLARED_WORKTREE',
  'P2_AUXILIARY_REPO_NOT_DECLARED',
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
  'P2_ADAPTER_HARD_ERROR',
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

const CODING_PRIMITIVE_NAME_SET = new Set<string>(CODING_PRIMITIVE_NAMES);

/** Runtime membership guard for primitive names arriving from raw JSON/unknown. */
export function validateCodingPrimitiveName(value: unknown): CodingContractResult<CodingPrimitiveName> {
  if (typeof value !== 'string' || !CODING_PRIMITIVE_NAME_SET.has(value)) {
    return fail('P2_UNKNOWN_PRIMITIVE', 'unknown or future coding primitive is not accepted');
  }
  return pass(value as CodingPrimitiveName);
}

declare const workspaceRelativePathBrand: unique symbol;
export type WorkspaceRelativePath = string & {
  readonly [workspaceRelativePathBrand]: true;
};

/**
 * Model/page paths express workspace-relative intent only. Absolute POSIX,
 * drive-qualified/UNC Windows paths, NUL, and parent traversal fail closed.
 * Canonical realpath/symlink containment belongs to the trusted adapter seam.
 */
export function validateWorkspaceRelativePath(
  input: unknown,
): CodingContractResult<WorkspaceRelativePath> {
  if (typeof input !== 'string' || !input || input.includes('\0')) {
    return fail('P2_INVALID_FIELD', 'workspace-relative path must be a non-empty string without NUL');
  }

  const normalizedSeparators = input.replace(/\\/g, '/');
  if (normalizedSeparators.startsWith('/') || /^[A-Za-z]:/.test(normalizedSeparators)) {
    return fail(
      'P2_ABSOLUTE_PATH_FORBIDDEN',
      'absolute, UNC, or drive-qualified paths are forbidden; use workspace-relative intent',
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

/** Backward-compatible name for the same validated workspace-relative identity. */
export type RepoRelativeIdentity = WorkspaceRelativePath;
export const validateRepoRelativeIdentity = validateWorkspaceRelativePath;

/** Receiver/trusted-adapter-owned canonical root. Never accepted from model input. */
export interface CanonicalRepoRoot {
  identity: string;
  canonicalPath: string;
}

export interface DeclaredCodingWorkspace {
  projectRoot: CanonicalRepoRoot;
  auxiliaryRepoRoots: readonly CanonicalRepoRoot[];
}

function validateCanonicalRoot(
  root: CanonicalRepoRoot,
  label: 'project' | 'auxiliary',
): CodingContractResult<CanonicalRepoRoot> {
  if (!root.identity.trim() || !root.canonicalPath.trim()) {
    return fail(
      'P2_INVALID_CANONICAL_ROOT',
      `${label} repo root requires non-empty trusted identity and canonicalPath`,
    );
  }
  return pass(root);
}

/** Trusted-only workspace declaration seam; no model/page field can populate it. */
export function requireExplicitProjectRoot(
  root: CanonicalRepoRoot | null | undefined,
): CodingContractResult<CanonicalRepoRoot> {
  if (!root) {
    return fail('P2_PROJECT_ROOT_REQUIRED', 'trusted adapter must provide an explicit project root');
  }
  return validateCanonicalRoot(root, 'project');
}

/**
 * Build the receiver-owned workspace boundary from a project root and exact
 * auxiliary-repository allowlist. This is trusted context, not primitive input.
 */
export function declareCodingWorkspace(input: {
  projectRoot: CanonicalRepoRoot | null | undefined;
  auxiliaryRepoRoots?: readonly CanonicalRepoRoot[];
}): CodingContractResult<DeclaredCodingWorkspace> {
  const project = requireExplicitProjectRoot(input.projectRoot);
  if (!project.ok) return project;

  const auxiliaryRepoRoots = input.auxiliaryRepoRoots ?? [];
  const seenIdentities = new Set<string>([project.value.identity]);
  const seenCanonicalPaths = new Set<string>([project.value.canonicalPath]);

  for (const root of auxiliaryRepoRoots) {
    const validated = validateCanonicalRoot(root, 'auxiliary');
    if (!validated.ok) return validated;
    if (seenIdentities.has(root.identity) || seenCanonicalPaths.has(root.canonicalPath)) {
      return fail(
        'P2_DUPLICATE_REPO_ROOT_IDENTITY',
        'project and auxiliary roots must have unique canonical identities and paths',
        { rootIdentity: root.identity },
      );
    }
    seenIdentities.add(root.identity);
    seenCanonicalPaths.add(root.canonicalPath);
  }

  return pass({
    projectRoot: project.value,
    auxiliaryRepoRoots: [...auxiliaryRepoRoots],
  });
}

export type CodingReferenceKind = 'path' | 'repo-ref';
export type CodingRepoRootRole = 'project' | 'auxiliary';

/** Candidate produced by the future trusted canonicalization adapter. */
export interface CanonicalCodingReferenceCandidate {
  kind: CodingReferenceKind;
  requested: string;
  canonicalPath: string;
  rootIdentity: string;
  rootRole: CodingRepoRootRole;
  repoRelativeIdentity: string;
}

export interface ValidatedCodingReference extends Omit<
  CanonicalCodingReferenceCandidate,
  'repoRelativeIdentity'
> {
  repoRelativeIdentity: WorkspaceRelativePath;
}

export interface CodingReferenceResolutionRequest {
  requested: string;
  kind: CodingReferenceKind;
  cwd: WorkspaceRelativePath;
  workspace: DeclaredCodingWorkspace;
}

export type CodingReferenceResolutionResult =
  | { ok: true; reference: CanonicalCodingReferenceCandidate }
  | { ok: false; adapterCode: string; message: string; retryable?: boolean };

/** Typed seam only; P2 PREP supplies no implementation. */
export interface CodingCanonicalizationAdapter {
  readonly adapterId: string;
  resolveReference(request: CodingReferenceResolutionRequest): Promise<CodingReferenceResolutionResult>;
}

function findDeclaredRoot(
  workspace: DeclaredCodingWorkspace,
  identity: string,
): { role: CodingRepoRootRole; root: CanonicalRepoRoot } | undefined {
  if (workspace.projectRoot.identity === identity) {
    return { role: 'project', root: workspace.projectRoot };
  }
  const auxiliary = workspace.auxiliaryRepoRoots.find((root) => root.identity === identity);
  return auxiliary ? { role: 'auxiliary', root: auxiliary } : undefined;
}

/**
 * Re-check trusted canonicalization output against the receiver-owned declared
 * worktree boundary before any future executor seam.
 */
export function validateCanonicalReference(
  workspace: DeclaredCodingWorkspace,
  candidate: CanonicalCodingReferenceCandidate,
): CodingContractResult<ValidatedCodingReference> {
  if (!candidate.canonicalPath.trim() || !candidate.rootIdentity.trim()) {
    return fail('P2_INVALID_CANONICAL_REFERENCE', 'canonical reference metadata is incomplete');
  }

  const declared = findDeclaredRoot(workspace, candidate.rootIdentity);
  if (!declared) {
    return fail(
      candidate.rootRole === 'auxiliary'
        ? 'P2_AUXILIARY_REPO_NOT_DECLARED'
        : 'P2_REFERENCE_OUTSIDE_DECLARED_WORKTREE',
      'canonical reference is not contained by a declared repo root',
      { rootIdentity: candidate.rootIdentity },
    );
  }

  if (declared.role !== candidate.rootRole) {
    return fail(
      'P2_INVALID_CANONICAL_REFERENCE',
      'canonical reference root role does not match the declared workspace root',
      { rootIdentity: candidate.rootIdentity },
    );
  }

  const relative = validateWorkspaceRelativePath(candidate.repoRelativeIdentity);
  if (!relative.ok) return relative;

  return pass({ ...candidate, repoRelativeIdentity: relative.value });
}

export interface CodingWorkspaceInfoInput {
  version: CodingContractVersion;
}

export interface CodingWorkspaceInfoOutput {
  version: CodingContractVersion;
  workspaceId: string;
  cwd: WorkspaceRelativePath;
}

export interface CodingFileReadInput {
  version: CodingContractVersion;
  path: WorkspaceRelativePath;
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
  path: WorkspaceRelativePath;
  content: CodingBoundedText;
}

export interface CodingFileListInput {
  version: CodingContractVersion;
  path?: WorkspaceRelativePath;
  recursive?: boolean;
  maxEntries?: number;
}

export interface CodingFileListEntry {
  path: WorkspaceRelativePath;
  kind: 'file' | 'directory' | 'symlink' | 'other';
}

export interface CodingFileListOutput {
  version: CodingContractVersion;
  path: WorkspaceRelativePath;
  entries: readonly CodingFileListEntry[];
  totalEntries: number;
  retainedEntries: number;
  moreAvailable: boolean;
}

export interface CodingFileSearchInput {
  version: CodingContractVersion;
  query: string;
  path?: WorkspaceRelativePath;
  maxMatches?: number;
}

export interface CodingFileSearchMatch {
  path: WorkspaceRelativePath;
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
  /** Structured authority path; patch text itself must never redefine this path. */
  path: WorkspaceRelativePath;
  patch: string;
}

export interface CodingApplyPatchInput {
  version: CodingContractVersion;
  files: readonly CodingPatchFile[];
}

export interface CodingApplyPatchOutput {
  version: CodingContractVersion;
  changedPaths: readonly WorkspaceRelativePath[];
}

export interface CodingProcessExecInput {
  version: CodingContractVersion;
  requestId: string;
  executable: string;
  args?: readonly string[];
  cwd?: WorkspaceRelativePath;
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
 * Process lifecycle is explicit. An exited process carries an exit status;
 * cancellation/timeout and teardown confirmation are independent facts.
 */
export interface CodingProcessLifecycle {
  state: 'running' | 'exited';
  exitCode: number | null;
  exitSignal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  teardownConfirmed: boolean;
}

/** Bounded retained stream plus deterministic continuation offset. */
export interface CodingProcessStream {
  data: string;
  bytesSeen: number;
  bytesRetained: number;
  moreAvailable: boolean;
  nextOffset: number;
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
  'nextOffset',
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

export interface CodingProcessWriteOutput extends CodingProcessSnapshotOutput {
  acceptedBytes: number;
  stdinClosed: boolean;
}

export interface CodingProcessKillOutput extends CodingProcessSnapshotOutput {
  cancelRequested: boolean;
}

export interface CodingGitStatusInput {
  version: CodingContractVersion;
  cwd?: WorkspaceRelativePath;
}

export interface CodingGitDiffInput {
  version: CodingContractVersion;
  cwd?: WorkspaceRelativePath;
  staged?: boolean;
  paths?: readonly WorkspaceRelativePath[];
}

export interface CodingGitLogInput {
  version: CodingContractVersion;
  cwd?: WorkspaceRelativePath;
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
  | 'nonEmptyString'
  | 'boolean'
  | 'nonNegativeInteger'
  | 'nullableExitCode'
  | 'nullableString'
  | 'stringArray'
  | 'workspacePath'
  | 'workspacePathArray'
  | 'patchFiles'
  | 'boundedText'
  | 'fileListEntries'
  | 'fileSearchMatches'
  | 'processLifecycle'
  | 'processStream';

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

/** Contract catalog only; this is not a production tool/provider registry. */
export const CODING_PRIMITIVE_SCHEMAS: Readonly<Record<CodingPrimitiveName, CodingPrimitiveSchema>> = {
  coding_workspace_info: {
    effect: 'read-only',
    input: strict({ version: req('version') }),
    output: strict({ version: req('version'), workspaceId: req('nonEmptyString'), cwd: req('workspacePath') }),
  },
  coding_file_read: {
    effect: 'read-only',
    input: strict({ version: req('version'), path: req('workspacePath'), maxBytes: opt('nonNegativeInteger') }),
    output: strict({ version: req('version'), path: req('workspacePath'), content: req('boundedText') }),
  },
  coding_file_list: {
    effect: 'read-only',
    input: strict({ version: req('version'), path: opt('workspacePath'), recursive: opt('boolean'), maxEntries: opt('nonNegativeInteger') }),
    output: strict({ version: req('version'), path: req('workspacePath'), entries: req('fileListEntries'), totalEntries: req('nonNegativeInteger'), retainedEntries: req('nonNegativeInteger'), moreAvailable: req('boolean') }),
  },
  coding_file_search: {
    effect: 'read-only',
    input: strict({ version: req('version'), query: req('string'), path: opt('workspacePath'), maxMatches: opt('nonNegativeInteger') }),
    output: strict({ version: req('version'), query: req('string'), matches: req('fileSearchMatches'), totalMatches: req('nonNegativeInteger'), retainedMatches: req('nonNegativeInteger'), moreAvailable: req('boolean') }),
  },
  coding_apply_patch: {
    effect: 'file-mutation',
    input: strict({ version: req('version'), files: req('patchFiles') }),
    output: strict({ version: req('version'), changedPaths: req('workspacePathArray') }),
  },
  coding_process_exec: {
    effect: 'process-control',
    input: strict({ version: req('version'), requestId: req('nonEmptyString'), executable: req('nonEmptyString'), args: opt('stringArray'), cwd: opt('workspacePath'), timeoutMs: opt('nonNegativeInteger') }),
    output: strict({ version: req('version'), requestId: req('nonEmptyString'), runId: req('nonEmptyString'), lifecycle: req('processLifecycle'), stdout: req('processStream'), stderr: req('processStream') }),
  },
  coding_process_read: {
    effect: 'read-only',
    input: strict({ version: req('version'), requestId: req('nonEmptyString'), runId: req('nonEmptyString'), stdoutOffset: opt('nonNegativeInteger'), stderrOffset: opt('nonNegativeInteger'), maxBytes: opt('nonNegativeInteger') }),
    output: strict({ version: req('version'), requestId: req('nonEmptyString'), runId: req('nonEmptyString'), lifecycle: req('processLifecycle'), stdout: req('processStream'), stderr: req('processStream') }),
  },
  coding_process_write: {
    effect: 'process-control',
    input: strict({ version: req('version'), requestId: req('nonEmptyString'), runId: req('nonEmptyString'), data: req('string'), closeStdin: opt('boolean') }),
    output: strict({ version: req('version'), requestId: req('nonEmptyString'), runId: req('nonEmptyString'), lifecycle: req('processLifecycle'), stdout: req('processStream'), stderr: req('processStream'), acceptedBytes: req('nonNegativeInteger'), stdinClosed: req('boolean') }),
  },
  coding_process_kill: {
    effect: 'process-control',
    input: strict({ version: req('version'), requestId: req('nonEmptyString'), runId: req('nonEmptyString') }),
    output: strict({ version: req('version'), requestId: req('nonEmptyString'), runId: req('nonEmptyString'), lifecycle: req('processLifecycle'), stdout: req('processStream'), stderr: req('processStream'), cancelRequested: req('boolean') }),
  },
  coding_git_status: {
    effect: 'read-only',
    input: strict({ version: req('version'), cwd: opt('workspacePath') }),
    output: strict({ version: req('version'), content: req('boundedText') }),
  },
  coding_git_diff: {
    effect: 'read-only',
    input: strict({ version: req('version'), cwd: opt('workspacePath'), staged: opt('boolean'), paths: opt('workspacePathArray') }),
    output: strict({ version: req('version'), content: req('boundedText') }),
  },
  coding_git_log: {
    effect: 'read-only',
    input: strict({ version: req('version'), cwd: opt('workspacePath'), ref: opt('string'), maxEntries: opt('nonNegativeInteger') }),
    output: strict({ version: req('version'), content: req('boundedText') }),
  },
};

export const CODING_COMPATIBILITY_POLICY = {
  currentVersion: CODING_CONTRACT_VERSION,
  unknownPrimitive: 'reject',
  unknownRequestFields: 'reject',
  unknownResponseFields: 'reject',
  unsupportedVersion: 'reject',
  rule: 'Contract v1 never guesses unknown primitive, field, or future-version semantics.',
} as const;

const FORBIDDEN_MODEL_ROOT_FIELDS = new Set([
  'workspaceRoot',
  'projectRoot',
  'rootIdentity',
  'rootRole',
  'rootPath',
  'canonicalRoot',
  'canonicalPath',
  'auxiliaryRepoRoots',
]);

const FORBIDDEN_MODEL_CAPABILITY_FIELDS = new Set([
  'authorization',
  'authorizationId',
  'grant',
  'grantId',
  'capability',
  'capabilities',
  'capabilityToken',
  'token',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateExactRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
): CodingContractResult<Record<string, unknown>> {
  if (!isRecord(value)) return fail('P2_INVALID_FIELD', `${label} must be an object`);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    return fail('P2_UNKNOWN_FIELD', `${label} contains unknown field ${unknown}`, { field: unknown });
  }
  const missing = requiredKeys.find((key) => !(key in value));
  if (missing) {
    return fail('P2_MISSING_FIELD', `${label} is missing ${missing}`, { field: missing });
  }
  return pass(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validatePatchFiles(value: unknown): CodingContractResult<readonly CodingPatchFile[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return fail('P2_INVALID_FIELD', 'files must be a non-empty array of structured patch entries');
  }

  const files: CodingPatchFile[] = [];
  for (const entry of value) {
    const exact = validateExactRecord(entry, 'patch entry', ['path', 'patch']);
    if (!exact.ok) return exact;
    if (typeof exact.value.patch !== 'string') {
      return fail('P2_INVALID_FIELD', 'patch entry patch must be a string');
    }
    const path = validateWorkspaceRelativePath(exact.value.path);
    if (!path.ok) return path;
    files.push({ path: path.value, patch: exact.value.patch });
  }
  return pass(files);
}

function validateBoundedText(value: unknown): CodingContractResult<CodingBoundedText> {
  const exact = validateExactRecord(
    value,
    'bounded text',
    ['text', 'bytesSeen', 'bytesRetained', 'moreAvailable'],
  );
  if (!exact.ok) return exact;
  const record = exact.value;
  if (
    typeof record.text !== 'string' ||
    !isNonNegativeInteger(record.bytesSeen) ||
    !isNonNegativeInteger(record.bytesRetained) ||
    typeof record.moreAvailable !== 'boolean' ||
    record.bytesRetained > record.bytesSeen
  ) {
    return fail('P2_INVALID_FIELD', 'bounded text retention fields are invalid');
  }
  return pass({
    text: record.text,
    bytesSeen: record.bytesSeen,
    bytesRetained: record.bytesRetained,
    moreAvailable: record.moreAvailable,
  });
}

function validateFileListEntries(value: unknown): CodingContractResult<readonly CodingFileListEntry[]> {
  if (!Array.isArray(value)) return fail('P2_INVALID_FIELD', 'entries must be an array');
  const entries: CodingFileListEntry[] = [];
  for (const item of value) {
    const exact = validateExactRecord(item, 'file-list entry', ['path', 'kind']);
    if (!exact.ok) return exact;
    const path = validateWorkspaceRelativePath(exact.value.path);
    if (!path.ok) return path;
    const kind = exact.value.kind;
    if (kind !== 'file' && kind !== 'directory' && kind !== 'symlink' && kind !== 'other') {
      return fail('P2_INVALID_FIELD', 'file-list entry kind is invalid');
    }
    entries.push({ path: path.value, kind });
  }
  return pass(entries);
}

function validateFileSearchMatches(value: unknown): CodingContractResult<readonly CodingFileSearchMatch[]> {
  if (!Array.isArray(value)) return fail('P2_INVALID_FIELD', 'matches must be an array');
  const matches: CodingFileSearchMatch[] = [];
  for (const item of value) {
    const exact = validateExactRecord(
      item,
      'file-search match',
      ['path', 'line', 'text'],
      ['path', 'text'],
    );
    if (!exact.ok) return exact;
    const path = validateWorkspaceRelativePath(exact.value.path);
    if (!path.ok) return path;
    if (typeof exact.value.text !== 'string') {
      return fail('P2_INVALID_FIELD', 'file-search match text must be a string');
    }
    if ('line' in exact.value && (!isNonNegativeInteger(exact.value.line) || exact.value.line === 0)) {
      return fail('P2_INVALID_FIELD', 'file-search match line must be a positive safe integer');
    }
    matches.push({
      path: path.value,
      text: exact.value.text,
      ...('line' in exact.value ? { line: exact.value.line as number } : {}),
    });
  }
  return pass(matches);
}

function validateProcessLifecycle(value: unknown): CodingContractResult<CodingProcessLifecycle> {
  const exact = validateExactRecord(value, 'process lifecycle', CODING_PROCESS_LIFECYCLE_FIELDS);
  if (!exact.ok) return exact;
  const record = exact.value;
  if (record.state !== 'running' && record.state !== 'exited') {
    return fail('P2_INVALID_FIELD', 'process lifecycle state must be running or exited');
  }
  if (!(record.exitCode === null || isNonNegativeInteger(record.exitCode))) {
    return fail('P2_INVALID_FIELD', 'process exitCode must be null or a non-negative safe integer');
  }
  if (!(record.exitSignal === null || typeof record.exitSignal === 'string')) {
    return fail('P2_INVALID_FIELD', 'process exitSignal must be null or a string');
  }
  if (
    typeof record.timedOut !== 'boolean' ||
    typeof record.cancelled !== 'boolean' ||
    typeof record.teardownConfirmed !== 'boolean'
  ) {
    return fail('P2_INVALID_FIELD', 'process lifecycle flags must be booleans');
  }
  if (record.state === 'running' && (record.exitCode !== null || record.exitSignal !== null)) {
    return fail('P2_INVALID_FIELD', 'running process cannot report an exit status');
  }
  if (record.state === 'running' && record.teardownConfirmed) {
    return fail('P2_INVALID_FIELD', 'running process cannot confirm teardown');
  }
  if (record.state === 'exited' && record.exitCode === null && record.exitSignal === null) {
    return fail('P2_INVALID_FIELD', 'exited process must report exitCode or exitSignal');
  }
  return pass({
    state: record.state,
    exitCode: record.exitCode,
    exitSignal: record.exitSignal,
    timedOut: record.timedOut,
    cancelled: record.cancelled,
    teardownConfirmed: record.teardownConfirmed,
  });
}

function validateProcessStream(value: unknown): CodingContractResult<CodingProcessStream> {
  const exact = validateExactRecord(value, 'process stream', CODING_PROCESS_STREAM_FIELDS);
  if (!exact.ok) return exact;
  const record = exact.value;
  if (
    typeof record.data !== 'string' ||
    !isNonNegativeInteger(record.bytesSeen) ||
    !isNonNegativeInteger(record.bytesRetained) ||
    typeof record.moreAvailable !== 'boolean' ||
    !isNonNegativeInteger(record.nextOffset) ||
    record.bytesRetained > record.bytesSeen ||
    record.nextOffset > record.bytesSeen
  ) {
    return fail('P2_INVALID_FIELD', 'process stream retention/continuation fields are invalid');
  }
  return pass({
    data: record.data,
    bytesSeen: record.bytesSeen,
    bytesRetained: record.bytesRetained,
    moreAvailable: record.moreAvailable,
    nextOffset: record.nextOffset,
  });
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
    case 'nonEmptyString':
      return typeof value === 'string' && value.length > 0
        ? pass(value)
        : fail('P2_INVALID_FIELD', 'expected non-empty string');
    case 'boolean':
      return typeof value === 'boolean'
        ? pass(value)
        : fail('P2_INVALID_FIELD', 'expected boolean');
    case 'nonNegativeInteger':
      return isNonNegativeInteger(value)
        ? pass(value)
        : fail('P2_INVALID_FIELD', 'expected non-negative safe integer');
    case 'nullableExitCode':
      return value === null || isNonNegativeInteger(value)
        ? pass(value)
        : fail('P2_INVALID_FIELD', 'expected null or non-negative safe integer');
    case 'nullableString':
      return value === null || typeof value === 'string'
        ? pass(value)
        : fail('P2_INVALID_FIELD', 'expected null or string');
    case 'stringArray':
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? pass(value)
        : fail('P2_INVALID_FIELD', 'expected string array');
    case 'workspacePath':
      return validateWorkspaceRelativePath(value);
    case 'workspacePathArray': {
      if (!Array.isArray(value)) return fail('P2_INVALID_FIELD', 'expected workspace-relative path array');
      const paths: WorkspaceRelativePath[] = [];
      for (const item of value) {
        const path = validateWorkspaceRelativePath(item);
        if (!path.ok) return path;
        paths.push(path.value);
      }
      return pass(paths);
    }
    case 'patchFiles':
      return validatePatchFiles(value);
    case 'boundedText':
      return validateBoundedText(value);
    case 'fileListEntries':
      return validateFileListEntries(value);
    case 'fileSearchMatches':
      return validateFileSearchMatches(value);
    case 'processLifecycle':
      return validateProcessLifecycle(value);
    case 'processStream':
      return validateProcessStream(value);
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
        'workspace/canonical binding is receiver-owned; model-supplied root facts are forbidden',
        { field: forbiddenRoot },
      );
    }
    const forbiddenCapability = Object.keys(value).find((key) => FORBIDDEN_MODEL_CAPABILITY_FIELDS.has(key));
    if (forbiddenCapability) {
      return fail(
        'P2_MODEL_CAPABILITY_FORBIDDEN',
        'authorization/capability is receiver-owned and cannot be supplied by model/page payload',
        { field: forbiddenCapability },
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

  const validatedObject: Record<string, unknown> = {};
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
    validatedObject[fieldName] = validated.value;
  }

  return pass(validatedObject);
}

/** Strict raw request validator. Unknown primitive/version/fields fail closed. */
export function validateCodingPrimitiveInput(
  primitive: unknown,
  value: unknown,
): CodingContractResult<CodingPrimitiveInputMap[CodingPrimitiveName]> {
  const name = validateCodingPrimitiveName(primitive);
  if (!name.ok) return name;
  const result = validateSchemaObject(name.value, 'input', value);
  return result.ok
    ? pass(result.value as unknown as CodingPrimitiveInputMap[CodingPrimitiveName])
    : result;
}

/** Strict raw response validator for the future trusted P1C/P2 adapter seam. */
export function validateCodingPrimitiveOutput(
  primitive: unknown,
  value: unknown,
): CodingContractResult<CodingPrimitiveOutputMap[CodingPrimitiveName]> {
  const name = validateCodingPrimitiveName(primitive);
  if (!name.ok) return name;
  const result = validateSchemaObject(name.value, 'output', value);
  return result.ok
    ? pass(result.value as unknown as CodingPrimitiveOutputMap[CodingPrimitiveName])
    : result;
}

export interface CodingAdapterMatchSuccess<T> {
  ok: true;
  matches: readonly T[];
}

export interface CodingAdapterMatchFailure {
  ok: false;
  adapterCode: string;
  message: string;
  retryable?: boolean;
}

export type CodingAdapterMatchResult<T> = CodingAdapterMatchSuccess<T> | CodingAdapterMatchFailure;

export type CodingMatchOutcome<T> =
  | { ok: true; outcome: 'matches'; matches: readonly T[] }
  | { ok: true; outcome: 'zero-match'; matches: readonly [] }
  | { ok: false; outcome: 'hard-error'; error: CodingError };

/** Zero matches are success; adapter failures remain typed hard errors. */
export function classifyCodingMatches<T>(result: CodingAdapterMatchResult<T>): CodingMatchOutcome<T> {
  if (!result.ok) {
    return {
      ok: false,
      outcome: 'hard-error',
      error: {
        code: 'P2_ADAPTER_HARD_ERROR',
        message: result.message,
        retryable: result.retryable ?? false,
        details: { adapterCode: result.adapterCode },
      },
    };
  }
  if (result.matches.length === 0) {
    return { ok: true, outcome: 'zero-match', matches: [] };
  }
  return { ok: true, outcome: 'matches', matches: result.matches };
}

/**
 * Typed result wrapper. Authorization evidence is intentionally absent;
 * truncation provenance is the existing P0 type/authority.
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

/** Exact alias to the existing P0 budget/truncation authority. */
export const projectCodingToolResultForInjection = projectToolResultForInjection;
