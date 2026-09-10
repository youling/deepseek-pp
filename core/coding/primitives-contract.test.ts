import { describe, expect, it } from 'vitest';

import { projectToolResultForInjection } from '../tool/result-budget';
import {
  CODING_COMPATIBILITY_POLICY,
  CODING_CONTRACT_VERSION,
  CODING_PRIMITIVE_EFFECTS,
  CODING_PRIMITIVE_NAMES,
  CODING_PRIMITIVE_SCHEMAS,
  CODING_PROCESS_LIFECYCLE_FIELDS,
  CODING_PROCESS_STREAM_FIELDS,
  classifyCodingMatches,
  declareCodingWorkspace,
  projectCodingToolResultForInjection,
  requireExplicitProjectRoot,
  validateCanonicalReference,
  validateCodingPrimitiveInput,
  validateCodingPrimitiveName,
  validateCodingPrimitiveOutput,
  validateWorkspaceRelativePath,
  type CanonicalRepoRoot,
  type CodingProcessSnapshotOutput,
  type DeclaredCodingWorkspace,
} from './primitives-contract';

const PROJECT_ROOT: CanonicalRepoRoot = {
  identity: 'repo:project',
  canonicalPath: '/canonical/project',
};

function workspace(auxiliaryRepoRoots: readonly CanonicalRepoRoot[] = []): DeclaredCodingWorkspace {
  const result = declareCodingWorkspace({
    projectRoot: PROJECT_ROOT,
    auxiliaryRepoRoots,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function exitedProcessSnapshot(): CodingProcessSnapshotOutput {
  return {
    version: CODING_CONTRACT_VERSION,
    requestId: 'request-7',
    runId: 'run-42',
    lifecycle: {
      state: 'exited',
      exitCode: 0,
      exitSignal: null,
      timedOut: false,
      cancelled: false,
      teardownConfirmed: true,
    },
    stdout: {
      data: 'ok',
      bytesSeen: 2,
      bytesRetained: 2,
      moreAvailable: false,
      nextOffset: 2,
    },
    stderr: {
      data: '',
      bytesSeen: 0,
      bytesRetained: 0,
      moreAvailable: false,
      nextOffset: 0,
    },
  };
}

describe('P2 coding-primitives contract prep', () => {
  it('freezes the exact 12-name v0 inventory from ARCHITECT_BUILD_DISPATCH', () => {
    expect(CODING_PRIMITIVE_NAMES).toEqual([
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
    ]);
    expect(new Set(CODING_PRIMITIVE_NAMES).size).toBe(12);
    for (const unauthorized of [
      'fs.write',
      'fs.patch',
      'repo.apply_patch',
      'repo.branch',
      'repo.checkout',
      'repo.show',
    ]) {
      expect(CODING_PRIMITIVE_NAMES).not.toContain(unauthorized);
    }
  });

  it('keeps coding_apply_patch as the only direct file-mutation primitive', () => {
    const directFileMutations = CODING_PRIMITIVE_NAMES.filter(
      (name) => CODING_PRIMITIVE_EFFECTS[name] === 'file-mutation',
    );

    expect(directFileMutations).toEqual(['coding_apply_patch']);
    expect(CODING_PRIMITIVE_EFFECTS.coding_process_exec).toBe('process-control');
    expect(CODING_PRIMITIVE_EFFECTS.coding_git_status).toBe('read-only');
    expect(CODING_PRIMITIVE_EFFECTS.coding_git_diff).toBe('read-only');
    expect(CODING_PRIMITIVE_EFFECTS.coding_git_log).toBe('read-only');
  });

  it('accepts only workspace-relative intent and rejects absolute, UNC, NUL, and parent escapes', () => {
    expect(validateWorkspaceRelativePath('src/./core/file.ts')).toMatchObject({
      ok: true,
      value: 'src/core/file.ts',
    });
    expect(validateWorkspaceRelativePath('/etc/passwd')).toMatchObject({
      ok: false,
      error: { code: 'P2_ABSOLUTE_PATH_FORBIDDEN' },
    });
    expect(validateWorkspaceRelativePath('C:\\Users\\model\\repo')).toMatchObject({
      ok: false,
      error: { code: 'P2_ABSOLUTE_PATH_FORBIDDEN' },
    });
    expect(validateWorkspaceRelativePath('\\\\server\\share\\repo')).toMatchObject({
      ok: false,
      error: { code: 'P2_ABSOLUTE_PATH_FORBIDDEN' },
    });
    expect(validateWorkspaceRelativePath('../outside.txt')).toMatchObject({
      ok: false,
      error: { code: 'P2_PATH_ESCAPE_FORBIDDEN' },
    });
    expect(validateWorkspaceRelativePath('safe/../outside.txt')).toMatchObject({
      ok: false,
      error: { code: 'P2_PATH_ESCAPE_FORBIDDEN' },
    });
    expect(validateWorkspaceRelativePath('safe\0name')).toMatchObject({
      ok: false,
      error: { code: 'P2_INVALID_FIELD' },
    });
  });

  it('keeps trusted project/auxiliary canonical roots outside model authority', () => {
    expect(requireExplicitProjectRoot(undefined)).toMatchObject({
      ok: false,
      error: { code: 'P2_PROJECT_ROOT_REQUIRED' },
    });

    const auxiliary: CanonicalRepoRoot = {
      identity: 'repo:docs',
      canonicalPath: '/canonical/docs',
    };
    const declared = workspace([auxiliary]);

    expect(validateCanonicalReference(declared, {
      kind: 'path',
      requested: 'README.md',
      canonicalPath: '/canonical/docs/README.md',
      rootIdentity: auxiliary.identity,
      rootRole: 'auxiliary',
      repoRelativeIdentity: 'README.md',
    })).toMatchObject({
      ok: true,
      value: {
        rootIdentity: 'repo:docs',
        rootRole: 'auxiliary',
        repoRelativeIdentity: 'README.md',
      },
    });

    expect(validateCanonicalReference(workspace(), {
      kind: 'path',
      requested: 'README.md',
      canonicalPath: '/canonical/docs/README.md',
      rootIdentity: 'repo:docs',
      rootRole: 'auxiliary',
      repoRelativeIdentity: 'README.md',
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_AUXILIARY_REPO_NOT_DECLARED' },
    });
  });

  it('fails closed on model/page attempts to supply root or capability authority', () => {
    expect(validateCodingPrimitiveInput('coding_process_exec', {
      version: CODING_CONTRACT_VERSION,
      requestId: 'req-1',
      executable: 'git',
      canonicalPath: '/model/claimed/root',
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_MODEL_WORKSPACE_ROOT_FORBIDDEN' },
    });

    expect(validateCodingPrimitiveInput('coding_process_exec', {
      version: CODING_CONTRACT_VERSION,
      requestId: 'req-1',
      executable: 'git',
      capability: 'model-supplied-mutation-grant',
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_MODEL_CAPABILITY_FORBIDDEN' },
    });
  });

  it('applies the path guard inside the sole structured patch mutation surface', () => {
    expect(validateCodingPrimitiveInput('coding_apply_patch', {
      version: CODING_CONTRACT_VERSION,
      files: [{ path: 'core/./types.ts', patch: '@@ example @@' }],
    })).toMatchObject({
      ok: true,
      value: {
        files: [{ path: 'core/types.ts', patch: '@@ example @@' }],
      },
    });

    expect(validateCodingPrimitiveInput('coding_apply_patch', {
      version: CODING_CONTRACT_VERSION,
      files: [{ path: '../outside.ts', patch: '@@ example @@' }],
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_PATH_ESCAPE_FORBIDDEN' },
    });

    expect(validateCodingPrimitiveInput('coding_apply_patch', {
      version: CODING_CONTRACT_VERSION,
      files: [{ path: '/absolute.ts', patch: '@@ example @@' }],
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_ABSOLUTE_PATH_FORBIDDEN' },
    });
  });

  it('freezes typed lifecycle, retention, and continuation fields for all four process primitives', () => {
    expect(CODING_PROCESS_LIFECYCLE_FIELDS).toEqual([
      'state',
      'exitCode',
      'exitSignal',
      'timedOut',
      'cancelled',
      'teardownConfirmed',
    ]);
    expect(CODING_PROCESS_STREAM_FIELDS).toEqual([
      'data',
      'bytesSeen',
      'bytesRetained',
      'moreAvailable',
      'nextOffset',
    ]);

    for (const primitive of [
      'coding_process_exec',
      'coding_process_read',
      'coding_process_write',
      'coding_process_kill',
    ] as const) {
      const outputFields = Object.keys(CODING_PRIMITIVE_SCHEMAS[primitive].output.fields);
      expect(outputFields).toContain('requestId');
      expect(outputFields).toContain('runId');
      expect(outputFields).toContain('lifecycle');
      expect(outputFields).toContain('stdout');
      expect(outputFields).toContain('stderr');
    }

    expect(Object.keys(CODING_PRIMITIVE_SCHEMAS.coding_process_read.input.fields)).toEqual([
      'version',
      'requestId',
      'runId',
      'stdoutOffset',
      'stderrOffset',
      'maxBytes',
    ]);
  });

  it('validates dedicated process outputs rather than accepting arbitrary nested objects', () => {
    const snapshot = exitedProcessSnapshot();

    expect(validateCodingPrimitiveOutput('coding_process_exec', snapshot)).toMatchObject({
      ok: true,
      value: { requestId: 'request-7', runId: 'run-42' },
    });
    expect(validateCodingPrimitiveOutput('coding_process_read', snapshot)).toMatchObject({ ok: true });
    expect(validateCodingPrimitiveOutput('coding_process_write', {
      ...snapshot,
      acceptedBytes: 3,
      stdinClosed: false,
    })).toMatchObject({ ok: true });
    expect(validateCodingPrimitiveOutput('coding_process_kill', {
      ...snapshot,
      cancelRequested: true,
    })).toMatchObject({ ok: true });

    expect(validateCodingPrimitiveOutput('coding_process_exec', {
      ...snapshot,
      lifecycle: {
        state: 'future-state',
        exitCode: 0,
        exitSignal: null,
        timedOut: false,
        cancelled: false,
        teardownConfirmed: true,
      },
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_INVALID_FIELD' },
    });

    expect(validateCodingPrimitiveOutput('coding_process_exec', {
      ...snapshot,
      stdout: {
        ...snapshot.stdout,
        futureCursor: 'opaque',
      },
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_UNKNOWN_FIELD' },
    });
  });

  it('fails closed at runtime on unknown primitive names from raw/untyped input', () => {
    const rawPrimitive = JSON.parse('"coding_file_delete"') as unknown;
    const rawPayload = JSON.parse('{"version":1,"path":"README.md"}') as unknown;

    expect(validateCodingPrimitiveName(rawPrimitive)).toMatchObject({
      ok: false,
      error: { code: 'P2_UNKNOWN_PRIMITIVE' },
    });
    expect(validateCodingPrimitiveInput(rawPrimitive, rawPayload)).toMatchObject({
      ok: false,
      error: { code: 'P2_UNKNOWN_PRIMITIVE' },
    });
    expect(validateCodingPrimitiveOutput('coding_future_tool' as unknown, {
      version: CODING_CONTRACT_VERSION,
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_UNKNOWN_PRIMITIVE' },
    });
  });

  it('rejects future versions and unknown fields from raw JSON instead of relying on TypeScript unions', () => {
    expect(CODING_COMPATIBILITY_POLICY).toMatchObject({
      currentVersion: 1,
      unknownPrimitive: 'reject',
      unknownRequestFields: 'reject',
      unknownResponseFields: 'reject',
      unsupportedVersion: 'reject',
    });

    const futureVersion = JSON.parse('{"version":2,"path":"README.md"}') as unknown;
    expect(validateCodingPrimitiveInput('coding_file_read', futureVersion)).toMatchObject({
      ok: false,
      error: { code: 'P2_UNSUPPORTED_VERSION' },
    });

    const futureField = JSON.parse('{"version":1,"path":"README.md","futureOption":true}') as unknown;
    expect(validateCodingPrimitiveInput('coding_file_read', futureField)).toMatchObject({
      ok: false,
      error: { code: 'P2_UNKNOWN_FIELD' },
    });

    expect(validateCodingPrimitiveOutput('coding_git_status', {
      version: CODING_CONTRACT_VERSION,
      content: {
        text: 'clean',
        bytesSeen: 5,
        bytesRetained: 5,
        moreAvailable: false,
      },
      futureField: 'not silently accepted',
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_UNKNOWN_FIELD' },
    });
  });

  it('keeps authorization evidence out of every primitive descriptor', () => {
    const forbiddenAuthorityFields = new Set([
      'authorization',
      'authorizationId',
      'grant',
      'grantId',
      'capability',
      'capabilities',
      'capabilityToken',
      'token',
      'workspaceRoot',
      'projectRoot',
      'rootIdentity',
      'canonicalPath',
    ]);

    for (const name of CODING_PRIMITIVE_NAMES) {
      for (const direction of ['input', 'output'] as const) {
        const fields = Object.keys(CODING_PRIMITIVE_SCHEMAS[name][direction].fields);
        expect(fields.filter((field) => forbiddenAuthorityFields.has(field))).toEqual([]);
      }
    }
  });

  it('keeps zero-match success distinct from adapter hard errors', () => {
    expect(classifyCodingMatches({ ok: true, matches: [] })).toEqual({
      ok: true,
      outcome: 'zero-match',
      matches: [],
    });

    expect(classifyCodingMatches({
      ok: false,
      adapterCode: 'ENOENT',
      message: 'adapter could not read the declared root',
    })).toMatchObject({
      ok: false,
      outcome: 'hard-error',
      error: {
        code: 'P2_ADAPTER_HARD_ERROR',
        details: { adapterCode: 'ENOENT' },
      },
    });
  });

  it('treats a file-search zero match as a valid structured output', () => {
    expect(validateCodingPrimitiveOutput('coding_file_search', {
      version: CODING_CONTRACT_VERSION,
      query: 'needle',
      matches: [],
      totalMatches: 0,
      retainedMatches: 0,
      moreAvailable: false,
    })).toMatchObject({
      ok: true,
      value: {
        matches: [],
        totalMatches: 0,
        retainedMatches: 0,
        moreAvailable: false,
      },
    });
  });

  it('delegates oversized result projection to the exact existing P0 budget/provenance authority', () => {
    expect(projectCodingToolResultForInjection).toBe(projectToolResultForInjection);

    const input = {
      detail: 'detail',
      output: 'x'.repeat(40),
      truncated: false,
      truncation: undefined,
    };
    const limits = {
      detailMaxLength: 8,
      outputMaxLength: 12,
    };

    const directP0Projection = projectToolResultForInjection(input, limits);
    const codingProjection = projectCodingToolResultForInjection(input, limits);

    expect(codingProjection).toEqual(directP0Projection);
    expect(codingProjection.truncated).toBe(true);
    expect(codingProjection.truncation).toMatchObject({
      transport: false,
      fields: ['output'],
      overflow: {
        output: {
          originalChars: 40,
          projectedChars: 12,
        },
      },
    });
  });
});
