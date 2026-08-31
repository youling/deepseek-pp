import { type JsonValue, type ToolCardResult, type ToolExecutionRecord } from '../types';
import {
  TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH,
  TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH,
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

  const serialized = safeStringify(output);
  // Composition rule: a previously recorded overflow is authoritative for the
  // true original length, so re-projecting an already-bounded storage field
  // never downgrades known provenance.
  const originalChars = prev ? prev.originalChars : serialized.length;
  const cut = originalChars > maxLength;
  return {
    value: cut ? clampToolResultText(serialized, maxLength) : output,
    projection: {
      cut,
      originalChars,
      projectedChars: cut ? maxLength : originalChars,
    },
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
