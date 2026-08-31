import { type JsonValue, type ToolCardResult, type ToolExecutionRecord } from '../types';
import {
  TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH,
  TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH,
  TOOL_RESULT_TRUNCATION_SUFFIX,
  buildToolResultTruncation,
  clampToolResultText,
  projectToolResultField,
  resolveToolResultTransportTruncated,
  type ToolFieldProjection,
} from './result-budget';

export interface ToolExecutionRestoreLimits {
  detailMaxLength?: number;
  outputMaxLength?: number;
}

export function sanitizeToolExecutionForRestoreStorage(
  execution: ToolExecutionRecord,
  limits: ToolExecutionRestoreLimits = {},
): ToolExecutionRecord {
  return {
    name: execution.name,
    provider: execution.provider,
    descriptorId: execution.descriptorId,
    result: sanitizeToolCardResultForRestoreStorage(execution.result, limits),
  };
}

export function normalizeRestoredToolExecution(execution: ToolExecutionRecord): ToolExecutionRecord {
  return {
    name: execution.name,
    provider: execution.provider,
    descriptorId: execution.descriptorId,
    result: normalizeRestoredToolCardResult(execution.result),
  };
}

export function normalizeRestoredToolCardResult(result: ToolCardResult): ToolCardResult {
  return {
    ...result,
    output: normalizeRestoredOutput(result.output),
  };
}

function sanitizeToolCardResultForRestoreStorage(
  result: ToolCardResult,
  limits: ToolExecutionRestoreLimits,
): ToolCardResult {
  const detailMaxLength = limits.detailMaxLength ?? TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH;
  const outputMaxLength = limits.outputMaxLength ?? TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH;

  const detailProjection = projectToolResultField(
    result.detail,
    detailMaxLength,
    result.truncation?.overflow.detail,
  );
  const outputProjection = projectToolResultForStorage(
    result.output,
    outputMaxLength,
    result.truncation?.overflow.output,
  );

  const { truncated, truncation } = buildToolResultTruncation({
    transport: resolveToolResultTransportTruncated(result.truncated, result.truncation),
    detail: detailProjection,
    output: outputProjection?.projection,
  });

  return {
    ...result,
    detail: clampToolResultText(result.detail, detailMaxLength),
    output: outputProjection?.value,
    truncated,
    truncation,
  };
}

function projectToolResultForStorage(
  output: JsonValue | undefined,
  maxLength: number,
  prev?: { originalChars: number; projectedChars: number },
): { value: JsonValue | undefined; projection: ToolFieldProjection | undefined } | undefined {
  if (output === undefined) return undefined;

  // When the incoming output is already a clamped string (from a prior
  // sanitize), re-safeStringify would double-encode it (adding JSON quotes
  // around the suffix) and drift the retained text. Detect this and operate
  // directly on the string length.
  const alreadyClamped =
    typeof output === 'string' &&
    output.endsWith(TOOL_RESULT_TRUNCATION_SUFFIX) &&
    prev !== undefined;

  if (alreadyClamped) {
    // output is the raw retained string from a prior clamp (no safeStringify).
    // The true original length is authoritative from prev.
    const originalChars = prev.originalChars;
    const effectiveProjectedChars = Math.min(prev.projectedChars, maxLength);
    const cut = originalChars > effectiveProjectedChars;
    return {
      value: cut ? clampToolResultText(output, maxLength) : output,
      projection: { cut, originalChars, projectedChars: effectiveProjectedChars },
    };
  }

  // Normal path: serialize the structured JsonValue, then compose.
  const serialized = safeStringify(output);
  if (prev) {
    const originalChars = prev.originalChars;
    const effectiveProjectedChars = Math.min(prev.projectedChars, maxLength);
    const cut = originalChars > effectiveProjectedChars;
    return {
      value: cut ? clampToolResultText(serialized, maxLength) : output,
      projection: { cut, originalChars, projectedChars: effectiveProjectedChars },
    };
  }
  const originalChars = serialized.length;
  const cut = originalChars > maxLength;
  return {
    value: cut ? clampToolResultText(serialized, maxLength) : output,
    projection: { cut, originalChars, projectedChars: cut ? maxLength : originalChars },
  };
}

function normalizeRestoredOutput(output: JsonValue | undefined): JsonValue | undefined {
  if (typeof output !== 'string') return output;

  const trimmed = output.trim();
  if (!trimmed.startsWith('{')) return output;

  try {
    const parsed = JSON.parse(trimmed) as JsonValue;
    return isKnownStructuredToolOutput(parsed) ? parsed : output;
  } catch {
    return output;
  }
}

function isKnownStructuredToolOutput(value: JsonValue): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = value.kind;
  return kind === 'artifact' || kind === 'skill_draft' || kind === 'memory_import_preview';
}

function safeStringify(value: JsonValue): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
