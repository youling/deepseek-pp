import { describe, expect, it } from 'vitest';
import type { ToolCardResult } from '../core/types';
import {
  TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH,
  TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH,
  TOOL_RESULT_TRUNCATION_SUFFIX,
  projectToolResultForInjection,
  type ToolResultBudget,
  type ToolResultTruncationProvenance,
} from '../core/tool/result-budget';
import { sanitizeToolExecutionForRestoreStorage } from '../core/tool/execution-restore';
import type { ToolExecutionRecord } from '../core/types';

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

  it('same-budget re-projection preserves overflow provenance exactly (idempotent)', () => {
    const first = projectToolResultForInjection({
      detail: 'd'.repeat(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10),
      output: 'o'.repeat(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10),
      truncated: false,
      truncation: undefined,
    });

    // First projection records the true original lengths.
    const expectedDetail: ToolResultTruncationProvenance['overflow']['detail'] = {
      originalChars: TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10,
      projectedChars: TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH,
    };
    const expectedOutput: ToolResultTruncationProvenance['overflow']['output'] = {
      originalChars: TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10,
      projectedChars: TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH,
    };
    expect(first.truncation.overflow.detail).toEqual(expectedDetail);
    expect(first.truncation.overflow.output).toEqual(expectedOutput);

    // Re-project the already-bounded strings at the SAME budget. The
    // provenance must survive byte-for-byte: originalChars is the true source
    // length, never the length of the bounded string + suffix.
    const second = projectToolResultForInjection({
      detail: first.detail,
      output: first.output,
      truncated: first.truncated,
      truncation: first.truncation,
    });

    expect(second.truncated).toBe(true);
    expect(second.truncation.transport).toBe(false);
    expect(second.truncation.fields).toEqual(['detail', 'output']);
    expect(second.truncation.overflow.detail).toEqual(expectedDetail);
    expect(second.truncation.overflow.output).toEqual(expectedOutput);
    // Text is unchanged (idempotent clamp, no double suffix).
    expect(second.detail).toBe(first.detail);
    expect(second.output).toBe(first.output);
    expect(second.detail!.length)
      .toBeLessThanOrEqual(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + TOOL_RESULT_TRUNCATION_SUFFIX.length);
    // The provenance must NOT derive from the bounded string: the true source
    // (4010) exceeds the budget (4000), while the bounded string + suffix
    // (4015) is what the defect would have wrongly recorded as originalChars.
    expect(second.truncation.overflow.detail!.originalChars)
      .toBe(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10);
    expect(second.truncation.overflow.detail!.originalChars)
      .toBeGreaterThan(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH);
  });

  it('stricter later budget composes provenance: original length kept, projected tightened', () => {
    const first = projectToolResultForInjection({
      detail: 'd'.repeat(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10),
      output: 'o'.repeat(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10),
      truncated: false,
      truncation: undefined,
    });

    // Re-project the already-bounded record under a stricter budget.
    const stricter = projectToolResultForInjection({
      detail: first.detail,
      output: first.output,
      truncated: first.truncated,
      truncation: first.truncation,
    }, {
      detailMaxLength: NARROW_BUDGET.detailMaxLength!,
      outputMaxLength: NARROW_BUDGET.outputMaxLength!,
    });

    // original source length is preserved from the first projection.
    expect(stricter.truncation.overflow.detail!.originalChars)
      .toBe(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10);
    expect(stricter.truncation.overflow.output!.originalChars)
      .toBe(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10);
    // retained/projected length reflects the stricter bound.
    expect(stricter.truncation.overflow.detail!.projectedChars).toBe(NARROW_BUDGET.detailMaxLength);
    expect(stricter.truncation.overflow.output!.projectedChars).toBe(NARROW_BUDGET.outputMaxLength);
    // text is tightened accordingly.
    expect(stricter.detail).toBe(
      first.detail!.slice(0, NARROW_BUDGET.detailMaxLength!) + TOOL_RESULT_TRUNCATION_SUFFIX,
    );
    expect(stricter.truncated).toBe(true);
  });

  it('composes transport-origin and local truncation together without losing either', () => {
    // Incoming record: provider flagged transport truncation AND detail is large
    // enough that injection must also bound it locally.
    const first = projectToolResultForInjection({
      detail: 'd'.repeat(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10),
      output: 'small',
      truncated: true, // transport-origin truncation
      truncation: undefined,
    });
    expect(first.truncation.transport).toBe(true);
    expect(first.truncation.fields).toEqual(['detail']);

    // Re-project at the same budget: both transport provenance and the local
    // overflow must remain.
    const second = projectToolResultForInjection({
      detail: first.detail,
      output: first.output,
      truncated: first.truncated,
      truncation: first.truncation,
    });
    expect(second.truncation.transport).toBe(true);
    expect(second.truncated).toBe(true);
    expect(second.truncation.fields).toEqual(['detail']);
    expect(second.truncation.overflow.detail).toEqual({
      originalChars: TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10,
      projectedChars: TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH,
    });
  });

  it('restore/storage projection does not downgrade existing provenance (round trip)', () => {
    const detailSource = 'd'.repeat(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10);
    const outputSource = 'o'.repeat(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10);
    // The storage path serializes the output field (JSON-quoting a string), so
    // the true serialized source length differs from the raw string length.
    const outputSerializedLength = JSON.stringify(outputSource).length;

    const execution: ToolExecutionRecord = {
      name: 'artifact_create',
      result: {
        ok: true,
        summary: 'Read file',
        detail: detailSource,
        output: outputSource,
        truncated: false,
      },
    };

    // First storage sanitization bounds and records provenance.
    const stored1 = sanitizeToolExecutionForRestoreStorage(execution);
    expect(stored1.result.truncated).toBe(true);
    expect(stored1.result.truncation!.overflow.detail!.originalChars).toBe(detailSource.length);
    expect(stored1.result.truncation!.overflow.output!.originalChars).toBe(outputSerializedLength);

    // Re-sanitizing the already-sanitized (bounded) record must preserve the
    // original overflow counts exactly — never downgrade to the bounded length.
    const stored2 = sanitizeToolExecutionForRestoreStorage(stored1);
    expect(stored2.result.truncated).toBe(true);
    expect(stored2.result.truncation).toEqual(stored1.result.truncation);
    expect(stored2.result.truncation!.overflow.detail!.originalChars).toBe(detailSource.length);
    expect(stored2.result.truncation!.overflow.output!.originalChars).toBe(outputSerializedLength);
    expect(stored2.result.truncation!.overflow.output!.projectedChars)
      .toBe(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH);
  });

  it('wider budget after narrow projection keeps projectedChars capped at prior retained ceiling', () => {
    // First: narrow budget clips both fields.
    const narrow = projectToolResultForInjection({
      detail: 'd'.repeat(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10),
      output: 'o'.repeat(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10),
      truncated: false,
      truncation: undefined,
    }, NARROW_BUDGET);
    expect(narrow.truncation.overflow.detail!.projectedChars).toBe(NARROW_BUDGET.detailMaxLength);
    expect(narrow.truncation.overflow.output!.projectedChars).toBe(NARROW_BUDGET.outputMaxLength);

    // Second: wider budget (but still below original source). The retained
    // ceiling must NOT increase — the data beyond the narrow bound is gone.
    const wider = projectToolResultForInjection({
      detail: narrow.detail,
      output: narrow.output,
      truncated: narrow.truncated,
      truncation: narrow.truncation,
    }, {
      detailMaxLength: TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH,
      outputMaxLength: TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH,
    });
    // originalChars preserved as true source.
    expect(wider.truncation.overflow.detail!.originalChars)
      .toBe(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10);
    expect(wider.truncation.overflow.output!.originalChars)
      .toBe(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10);
    // projectedChars capped at the narrow ceiling — not expanded to the wider budget.
    expect(wider.truncation.overflow.detail!.projectedChars).toBe(NARROW_BUDGET.detailMaxLength);
    expect(wider.truncation.overflow.output!.projectedChars).toBe(NARROW_BUDGET.outputMaxLength);
    // text unchanged — the lost bytes cannot be recovered.
    expect(wider.detail).toBe(narrow.detail);
    expect(wider.output).toBe(narrow.output);
    expect(wider.truncated).toBe(true);
  });

  it('storage second-save is idempotent: output text and provenance both stable', () => {
    const outputSource = 'o'.repeat(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10);
    const execution: ToolExecutionRecord = {
      name: 'web_fetch',
      result: {
        ok: true,
        summary: 'Fetched',
        detail: 'detail',
        output: outputSource,
        truncated: false,
      },
    };

    const stored1 = sanitizeToolExecutionForRestoreStorage(execution);
    const stored2 = sanitizeToolExecutionForRestoreStorage(stored1);

    // Output text is byte-identical across two sanitize rounds.
    expect(stored2.result.output).toBe(stored1.result.output);
    // Provenance is byte-identical.
    expect(stored2.result.truncation).toEqual(stored1.result.truncation);
    // stored1.output is a clamped string (not double-encoded).
    expect(typeof stored1.result.output).toBe('string');
    expect((stored1.result.output as string).endsWith(TOOL_RESULT_TRUNCATION_SUFFIX)).toBe(true);
  });

  it('narrow then budget >= originalChars: provenance and truncated unchanged, text not restored', () => {
    // First: narrow budget clips detail (4010 → 100) and output (8010 → 200).
    const narrow = projectToolResultForInjection({
      detail: 'd'.repeat(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10),
      output: 'o'.repeat(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10),
      truncated: false,
      truncation: undefined,
    }, NARROW_BUDGET);

    // Second: budget larger than original source. The local truncation must NOT
    // be cleared — the data was already lost by the narrow projection.
    const wider = projectToolResultForInjection({
      detail: narrow.detail,
      output: narrow.output,
      truncated: narrow.truncated,
      truncation: narrow.truncation,
    }, {
      detailMaxLength: TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 100,
      outputMaxLength: TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 100,
    });

    // cut stays true because originalChars > min(prev.projectedChars, newBudget).
    expect(wider.truncated).toBe(true);
    expect(wider.truncation.fields).toEqual(['detail', 'output']);
    // projectedChars remains at the narrow ceiling — not restored.
    expect(wider.truncation.overflow.detail!.originalChars)
      .toBe(TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH + 10);
    expect(wider.truncation.overflow.detail!.projectedChars).toBe(NARROW_BUDGET.detailMaxLength);
    expect(wider.truncation.overflow.output!.originalChars)
      .toBe(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10);
    expect(wider.truncation.overflow.output!.projectedChars).toBe(NARROW_BUDGET.outputMaxLength);
    // text byte-identical to narrow — suffix not duplicated, content not restored.
    expect(wider.detail).toBe(narrow.detail);
    expect(wider.output).toBe(narrow.output);
  });

  it('storage already-clamped then budget >= originalChars: text and provenance byte-identical', () => {
    const outputSource = 'o'.repeat(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH + 10);
    const execution: ToolExecutionRecord = {
      name: 'web_fetch',
      result: { ok: true, summary: 'Fetched', detail: 'detail', output: outputSource, truncated: false },
    };

    // First sanitize: output clamped to default budget 8000, provenance recorded.
    const stored1 = sanitizeToolExecutionForRestoreStorage(execution);
    expect(stored1.result.truncated).toBe(true);
    const originalChars = stored1.result.truncation!.overflow.output!.originalChars;

    // Second sanitize with outputMaxLength > originalChars — truly wider than
    // the source length so the already-clamped text must NOT be treated as
    // complete or re-stringified.
    const widerBudget = { outputMaxLength: originalChars + 100 };
    const stored2 = sanitizeToolExecutionForRestoreStorage(
      stored1 as unknown as ToolExecutionRecord,
      widerBudget,
    );

    // truncated stays true — lost data cannot be restored.
    expect(stored2.result.truncated).toBe(true);
    // output text byte-identical — no double-stringify, no suffix change.
    expect(stored2.result.output).toBe(stored1.result.output);
    // provenance byte-identical — originalChars unchanged, projectedChars capped.
    expect(stored2.result.truncation).toEqual(stored1.result.truncation);
    expect(stored2.result.truncation!.overflow.output!.originalChars).toBe(originalChars);
    expect(stored2.result.truncation!.overflow.output!.projectedChars)
      .toBe(TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH);
    // output is still a clamped string, not a restored complete value.
    expect(typeof stored2.result.output).toBe('string');
    expect((stored2.result.output as string).endsWith(TOOL_RESULT_TRUNCATION_SUFFIX)).toBe(true);
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
