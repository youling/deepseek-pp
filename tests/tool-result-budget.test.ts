import { describe, expect, it } from 'vitest';
import type { ToolCardResult } from '../core/types';
import {
  TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH,
  TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH,
  TOOL_RESULT_TRUNCATION_SUFFIX,
  clampToolResultText,
  projectToolResultForInjection,
  type ToolResultBudget,
} from '../core/tool/result-budget';

const NARROW_BUDGET: ToolResultBudget = {
  detailMaxLength: 100,
  outputMaxLength: 200,
};

function bigCodingResult(over: Partial<ToolCardResult> = {}): ToolCardResult {
  return {
    ok: true,
    summary: 'Read file',
    detail: 'd'.repeat(2_000),
    output: {
      path: '/repo/src/main.ts',
      lines: Array.from({ length: 1_500 }, (_, i) => `line ${i}`),
    },
    truncated: false,
    ...over,
  };
}

describe('tool-result injection budget and truncation provenance', () => {
  it('passes small default-size results through byte-identical and untruncated', () => {
    const result: ToolCardResult = {
      ok: true,
      summary: 'Captured page',
      detail: 'Compatibility Contract',
      output: { title: 'Compatibility Contract', url: 'https://example.test' },
      truncated: false,
    };
    const projected = projectToolResultForInjection({
      detail: result.detail,
      output: result.output === undefined ? undefined : JSON.stringify(result.output),
      truncated: result.truncated,
      truncation: result.truncation,
    });

    expect(projected.detail).toBe(result.detail);
    expect(projected.output).toBe(JSON.stringify(result.output));
    expect(projected.truncated).toBe(false);
    expect(projected.truncation).toEqual({ transport: false, fields: [], overflow: {} });
  });

  it('bounded-histogram: clamps a large coding/MCP-style structured result locally with truthful provenance', () => {
    const result = bigCodingResult();
    const outputRaw = JSON.stringify(result.output);
    const projected = projectToolResultForInjection({
      detail: result.detail,
      output: outputRaw,
      truncated: result.truncated,
      truncation: result.truncation,
    }, NARROW_BUDGET);

    // output > NARROW_BUDGET.outputMaxLength => locally bounded.
    expect(projected.output).toBe(
      `${outputRaw.slice(0, NARROW_BUDGET.outputMaxLength)}${TOOL_RESULT_TRUNCATION_SUFFIX}`,
    );
    expect(projected.detail).toBe(
      `${result.detail!.slice(0, NARROW_BUDGET.detailMaxLength!)}${TOOL_RESULT_TRUNCATION_SUFFIX}`,
    );
    // Truthful boolean: local shortening after transport can never report false.
    expect(projected.truncated).toBe(true);
    // Named provenance: transport did NOT truncate here; only injection did.
    expect(projected.truncation.transport).toBe(false);
    expect(projected.truncation.fields).toEqual(['detail', 'output']);
    expect(projected.truncation.overflow.output).toEqual({
      originalChars: outputRaw.length,
      projectedChars: NARROW_BUDGET.outputMaxLength,
    });
    expect(projected.truncation.overflow.detail).toEqual({
      originalChars: result.detail!.length,
      projectedChars: NARROW_BUDGET.detailMaxLength!,
    });
  });

  it('false-negative regression: a result locally shortened after transport reports truncated:true', () => {
    // Source is large but NOT transport-truncated (truncated:false). The local
    // context-injection clamp is the only truncation, so it must still bump the
    // boolean and label the cause as injection — never `truncated:false`.
    const result = bigCodingResult({ truncated: false });
    const projected = projectToolResultForInjection({
      detail: result.detail,
      output: result.output === undefined ? undefined : JSON.stringify(result.output),
      truncated: result.truncated,
      truncation: result.truncation,
    });

    expect(projected.truncated).toBe(true);
    expect(projected.truncation.transport).toBe(false);
    expect(projected.truncation.fields).toContain('output');
  });

  it('distinguishes transport-origin truncation from extension/injection truncation', () => {
    // Transport-origin: incoming result flagged truncated:true (no provenance).
    const transport = projectToolResultForInjection({
      detail: 'small detail',
      output: 'small',
      truncated: true,
      truncation: undefined,
    });
    expect(transport.truncated).toBe(true);
    expect(transport.truncation.transport).toBe(true);
    expect(transport.truncation.fields).toEqual([]);

    // Injection-origin only: transport false, local fields bounded.
    const injection = projectToolResultForInjection({
      detail: 'd'.repeat(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10),
      output: 'o'.repeat(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10),
      truncated: false,
      truncation: undefined,
    });
    expect(injection.truncated).toBe(true);
    expect(injection.truncation.transport).toBe(false);
    expect(injection.truncation.fields).toEqual(['detail', 'output']);
  });

  it('keeps transport provenance when re-projecting an already-bounded record (idempotent)', () => {
    const first = projectToolResultForInjection({
      detail: 'd'.repeat(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10),
      output: 'o'.repeat(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10),
      truncated: false,
      truncation: undefined,
    });
    const second = projectToolResultForInjection({
      detail: first.detail,
      output: first.output,
      truncated: first.truncated,
      truncation: first.truncation,
    });
    // transport stays false (the source never truncated); local cut remains.
    expect(second.truncated).toBe(true);
    expect(second.truncation.transport).toBe(false);
    expect(second.truncation.fields).toContain('output');
    // The clamp primitive is idempotent on text length.
    expect(second.output).toBeDefined();
    expect(clampToolResultText(second.output, TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH)!.length)
      .toBeLessThanOrEqual(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + TOOL_RESULT_TRUNCATION_SUFFIX.length);
  });

  it('only bounds the field that exceeds its budget', () => {
    const projected = projectToolResultForInjection({
      detail: 'd'.repeat(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10),
      output: 'short',
      truncated: false,
      truncation: undefined,
    });
    expect(projected.truncated).toBe(true);
    expect(projected.truncation.fields).toEqual(['detail']);
    expect(projected.output).toBe('short');
    expect(projected.truncation.overflow.output).toBeUndefined();
  });
});
