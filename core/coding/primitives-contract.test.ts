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
  projectCodingToolResultForInjection,
  validateCodingPrimitiveInput,
  validateCodingPrimitiveOutput,
  validateWorkspaceRelativePath,
} from './primitives-contract';

describe('P2 coding-primitives contract prep', () => {
  it('freezes the exact v0 primitive inventory from ARCHITECT_BUILD_DISPATCH', () => {
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
  });

  it('keeps coding_apply_patch as the only direct file-mutation primitive', () => {
    const directFileMutations = CODING_PRIMITIVE_NAMES.filter(
      (name) => CODING_PRIMITIVE_EFFECTS[name] === 'file-mutation',
    );

    expect(directFileMutations).toEqual(['coding_apply_patch']);
    expect(CODING_PRIMITIVE_NAMES).not.toContain('coding_file_write');
    expect(CODING_PRIMITIVE_NAMES).not.toContain('coding_file_replace');
    expect(CODING_PRIMITIVE_NAMES).not.toContain('coding_file_delete');
    expect(CODING_PRIMITIVE_EFFECTS.coding_git_status).toBe('read-only');
    expect(CODING_PRIMITIVE_EFFECTS.coding_git_diff).toBe('read-only');
    expect(CODING_PRIMITIVE_EFFECTS.coding_git_log).toBe('read-only');
  });

  it('accepts only workspace-relative path intent and normalizes harmless dot segments', () => {
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
    expect(validateWorkspaceRelativePath('../outside.txt')).toMatchObject({
      ok: false,
      error: { code: 'P2_PATH_ESCAPE_FORBIDDEN' },
    });
  });

  it('fails closed on a model-supplied workspace root', () => {
    expect(validateCodingPrimitiveInput('coding_workspace_info', {
      version: CODING_CONTRACT_VERSION,
      workspaceRoot: '/model/claimed/root',
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_MODEL_WORKSPACE_ROOT_FORBIDDEN' },
    });

    expect(validateCodingPrimitiveInput('coding_process_exec', {
      version: CODING_CONTRACT_VERSION,
      requestId: 'req-1',
      executable: 'git',
      projectRoot: 'C:\\model\\claimed\\root',
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_MODEL_WORKSPACE_ROOT_FORBIDDEN' },
    });
  });

  it('applies the path rule inside the sole structured patch mutation surface', () => {
    expect(validateCodingPrimitiveInput('coding_apply_patch', {
      version: CODING_CONTRACT_VERSION,
      files: [{ path: 'core/types.ts', patch: '@@ example @@' }],
    })).toMatchObject({ ok: true });

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

  it('freezes process request/run identity and lifecycle/retention semantics explicitly', () => {
    expect(Object.keys(CODING_PRIMITIVE_SCHEMAS.coding_process_exec.input.fields)).toEqual([
      'version',
      'requestId',
      'executable',
      'args',
      'cwd',
      'timeoutMs',
    ]);
    expect(Object.keys(CODING_PRIMITIVE_SCHEMAS.coding_process_exec.output.fields)).toEqual([
      'version',
      'requestId',
      'runId',
      'lifecycle',
      'stdout',
      'stderr',
    ]);
    expect(Object.keys(CODING_PRIMITIVE_SCHEMAS.coding_process_read.input.fields)).toEqual([
      'version',
      'requestId',
      'runId',
      'stdoutOffset',
      'stderrOffset',
      'maxBytes',
    ]);
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
    ]);
  });

  it('validates a process snapshot with requestId distinct from runId and explicit teardown state', () => {
    const output = validateCodingPrimitiveOutput('coding_process_exec', {
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
      },
      stderr: {
        data: '',
        bytesSeen: 0,
        bytesRetained: 0,
        moreAvailable: false,
      },
    });

    expect(output).toMatchObject({
      ok: true,
      value: {
        requestId: 'request-7',
        runId: 'run-42',
      },
    });
  });

  it('treats a file-search zero match as a valid non-error result shape', () => {
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

  it('fails closed on unknown fields and future contract versions', () => {
    expect(CODING_COMPATIBILITY_POLICY).toMatchObject({
      currentVersion: 1,
      unknownRequestFields: 'reject',
      unknownResponseFields: 'reject',
      unsupportedVersion: 'reject',
    });

    expect(validateCodingPrimitiveInput('coding_file_read', {
      version: 2,
      path: 'README.md',
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_UNSUPPORTED_VERSION' },
    });

    expect(validateCodingPrimitiveInput('coding_file_read', {
      version: CODING_CONTRACT_VERSION,
      path: 'README.md',
      futureOption: true,
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_UNKNOWN_FIELD' },
    });

    expect(validateCodingPrimitiveOutput('coding_git_status', {
      version: CODING_CONTRACT_VERSION,
      content: {},
      futureField: 'not silently accepted',
    })).toMatchObject({
      ok: false,
      error: { code: 'P2_UNKNOWN_FIELD' },
    });
  });

  it('keeps authorization evidence out of every primitive input/output descriptor', () => {
    const forbiddenAuthorityFields = new Set([
      'authorization',
      'authorizationId',
      'grant',
      'grantId',
      'capability',
      'capabilityToken',
      'token',
    ]);

    for (const name of CODING_PRIMITIVE_NAMES) {
      for (const direction of ['input', 'output'] as const) {
        const fields = Object.keys(CODING_PRIMITIVE_SCHEMAS[name][direction].fields);
        expect(fields.filter((field) => forbiddenAuthorityFields.has(field))).toEqual([]);
      }
    }
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
