import type { JsonValue, ToolCardResult, ToolExecutionRecord } from '../types';
import {
  TOOL_RESULT_DEFAULT_DETAIL_MAX_LENGTH,
  TOOL_RESULT_DEFAULT_OUTPUT_MAX_LENGTH,
  buildToolResultTruncation,
  clampToolResultText,
  projectToolResultField,
  resolveToolResultTransportTruncated,
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

  const detailProjection = projectToolResultField(result.detail, detailMaxLength);
  const outputProjection = projectToolResultForStorage(result.output, outputMaxLength);

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
): { value: JsonValue | undefined; projection: { cut: boolean; originalChars: number; projectedChars: number } | undefined } | undefined {
  if (output === undefined) return undefined;

  const serialized = safeStringify(output);
  if (serialized.length <= maxLength) {
    return { value: output, projection: { cut: false, originalChars: serialized.length, projectedChars: serialized.length } };
  }
  return {
    value: clampToolResultText(serialized, maxLength),
    projection: { cut: true, originalChars: serialized.length, projectedChars: maxLength },
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
