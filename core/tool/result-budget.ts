import type {
  ToolResultField,
  ToolResultTruncationProvenance,
} from '../types';

export type { ToolResultField, ToolResultTruncationProvenance };

/**
 * Authoritative tool-result injection/budget policy.
 *
 * Single source of truth for the bounded projection of a tool result into
 * agent context and for the truncation provenance that accompanies that
 * projection. Production consumers must use these constants and helpers
 * instead of restating their own `4000`/`8000`/`...[truncated]` policy, so a
 * tool result that is locally shortened after transport can never report
 * `truncated:false`.
 *
 * Provenance model (see `ToolResultTruncationProvenance`):
 *  - `transport` — the incoming result was already flagged truncated by the
 *    provider/transport (source origin), independent of any local clamp.
 *  - `fields` — which field(s) this projection locally bounded for context
 *    injection.
 *  - `overflow` — deterministic char counts dropped per bounded field, enough
 *    metadata for a later continuation/paging layer to request the remainder.
 */
export const TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH = 4000;
export const TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH = 8000;
export const TOOL_RESULT_TRUNCATION_SUFFIX = '\n...[truncated]';

export interface ToolResultBudget {
  detailMaxLength: number;
  outputMaxLength: number;
}

export const DEFAULT_TOOL_RESULT_BUDGET: ToolResultBudget = {
  detailMaxLength: TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH,
  outputMaxLength: TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH,
};

export function resolveToolResultBudget(
  limits: Partial<ToolResultBudget> | undefined,
): ToolResultBudget {
  return {
    detailMaxLength: limits?.detailMaxLength ?? DEFAULT_TOOL_RESULT_BUDGET.detailMaxLength,
    outputMaxLength: limits?.outputMaxLength ?? DEFAULT_TOOL_RESULT_BUDGET.outputMaxLength,
  };
}

/**
 * Clamp one string to `maxLength` chars. Matches the released byte-for-byte
 * clamp: values within budget pass through untouched; larger values are cut to
 * `maxLength` and joined with the truncation suffix.
 */
export function clampToolResultText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (!value) return value;
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}${TOOL_RESULT_TRUNCATION_SUFFIX}`
    : value;
}

export interface ToolFieldProjection {
  cut: boolean;
  originalChars: number;
  projectedChars: number;
}

/**
 * Decide whether a single already-serialized field must be locally bounded
 * under `maxLength` (matching `clampToolResultText`'s cut condition) and, if
 * so, capture the deterministic overflow counts. `undefined` input means no
 * cut.
 *
 * `prev` is the projection already recorded for this field by an earlier
 * bounded projection (i.e. `truncation.overflow[field]`). When present it is
 * authoritative for the true original source length, so a repeated projection
 * of an already-bounded string never loses the original overflow counts, and
 * a stricter later projection composes provenance instead of replacing it:
 * `originalChars` stays the true source length while `projectedChars` is
 * tightened to the stricter bound.
 */
export function projectToolResultField(
  value: string | undefined,
  maxLength: number,
  prev?: { originalChars: number; projectedChars: number },
): ToolFieldProjection | undefined {
  if (value === undefined) return undefined;
  // When prev exists, the retained ceiling from the earlier projection is
  // authoritative; a wider budget cannot fabricate data that was already
  // lost. Compute the effective ceiling first, then derive cut from it.
  const originalChars = prev ? prev.originalChars : value.length;
  if (prev) {
    const effectiveProjectedChars = Math.min(prev.projectedChars, maxLength);
    return {
      cut: originalChars > effectiveProjectedChars,
      originalChars,
      projectedChars: effectiveProjectedChars,
    };
  }
  const cut = originalChars > maxLength;
  return { cut, originalChars, projectedChars: cut ? maxLength : originalChars };
}

/**
 * Build the aggregate truncation provenance + truthful `truncated` from an
 * incoming transport flag and the per-field local projections. `truncated` is
 * true when the result was truncated at ANY origin (transport or local).
 */
export interface BuildToolResultTruncationInput {
  transport: boolean;
  detail?: ToolFieldProjection;
  output?: ToolFieldProjection;
}

export function buildToolResultTruncation(
  input: BuildToolResultTruncationInput,
): { truncated: boolean; truncation: ToolResultTruncationProvenance } {
  const fields: ToolResultField[] = [];
  const overflow: ToolResultTruncationProvenance['overflow'] = {};
  if (input.detail?.cut) {
    fields.push('detail');
    overflow.detail = {
      originalChars: input.detail.originalChars,
      projectedChars: input.detail.projectedChars,
    };
  }
  if (input.output?.cut) {
    fields.push('output');
    overflow.output = {
      originalChars: input.output.originalChars,
      projectedChars: input.output.projectedChars,
    };
  }
  const truncation: ToolResultTruncationProvenance = {
    transport: input.transport,
    fields,
    overflow,
  };
  return {
    truncated: input.transport || fields.length > 0,
    truncation,
  };
}

/**
 * Reads the transport-origin flag from an incoming record, remaining
 * compatible with legacy records that predate named provenance: without
 * `truncation`, the only released source of `truncated:true` was
 * transport/provider truncation, so that is what `truncated:true` means.
 */
export function resolveToolResultTransportTruncated(
  truncated: boolean | undefined,
  truncation: ToolResultTruncationProvenance | undefined,
): boolean {
  if (truncation) return truncation.transport;
  return truncated === true;
}

export interface ProjectToolResultInjectionInput {
  detail: string | undefined;
  output: string | undefined;
  truncated: boolean | undefined;
  truncation: ToolResultTruncationProvenance | undefined;
}

export interface ProjectToolResultInjectionOutput {
  detail: string | undefined;
  output: string | undefined;
  truncated: boolean;
  truncation: ToolResultTruncationProvenance;
}

/**
 * The authoritative context-injection projection. Bounds detail and output to
 * the budget, serializes the cut, and returns truthful `truncated` plus
 * named provenance. Callers should pass each field already serialized the way
 * they render it (JSON string for output).
 */
export function projectToolResultForInjection(
  input: ProjectToolResultInjectionInput,
  limits?: Partial<ToolResultBudget>,
): ProjectToolResultInjectionOutput {
  const budget = resolveToolResultBudget(limits);
  const transport = resolveToolResultTransportTruncated(input.truncated, input.truncation);
  const prev = input.truncation;

  const detailProjection = projectToolResultField(
    input.detail,
    budget.detailMaxLength,
    prev?.overflow.detail,
  );
  const outputProjection = projectToolResultField(
    input.output,
    budget.outputMaxLength,
    prev?.overflow.output,
  );

  const { truncated, truncation } = buildToolResultTruncation({
    transport,
    detail: detailProjection,
    output: outputProjection,
  });

  return {
    detail: clampToolResultText(input.detail, budget.detailMaxLength),
    output: clampToolResultText(input.output, budget.outputMaxLength),
    truncated,
    truncation,
  };
}
