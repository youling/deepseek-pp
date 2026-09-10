/**
 * Local Coding Runtime tool provider (`com.deepseek_pp.runtime.canary`).
 *
 * Execution-only canary proving: DeepSeek Web -> authorized tool call ->
 * Native Messaging channel -> isolated Rust host -> bounded local execution ->
 * result returned to the same DeepSeek Web session.
 *
 * This provider is a `local` provider (in-process) whose `execute` is only
 * reached AFTER the runtime authorization path resolved the call. It never
 * authorizes anything itself. The `runtime.exec` tool forwards a
 * background-derived `grant_id` correlation ticket and an optional
 * background-owned `workspace_id` binding hint; both are model-invisible
 * metadata, never authority. The sole execution authority is the background
 * `capabilityScope`; the host only enforces that the requested profile is
 * host-owned production `canary.echo` — the browser can never supply an
 * arbitrary command or authorize execution with a non-empty string.
 */

import type { JsonValue, ToolCall, ToolDescriptor, ToolResult } from '../tool/types';
import type { ToolProviderExecutionContext } from '../tool/provider-registry';
import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import {
  LOCAL_RUNTIME_CANARY_PROFILE,
  LOCAL_RUNTIME_HOST_ID,
} from './contract';
import { localRuntimeExec, localRuntimeStatus } from './native-client';

export const LOCAL_RUNTIME_TOOL_PROVIDER = {
  kind: 'local',
  id: 'local-runtime',
  displayName: 'Local Runtime (canary)',
  transport: 'in_process',
} as const;

export function localRuntimeProviderIdentity() {
  return LOCAL_RUNTIME_TOOL_PROVIDER;
}

export function createLocalRuntimeToolProviderIdentity(
  locale: SupportedLocale = DEFAULT_LOCALE,
) {
  return {
    ...LOCAL_RUNTIME_TOOL_PROVIDER,
    displayName: translate(locale, 'tool.localRuntime.providerName'),
  };
}

export function createLocalRuntimeToolDescriptors(
  locale: SupportedLocale = DEFAULT_LOCALE,
): ToolDescriptor[] {
  const provider = createLocalRuntimeToolProviderIdentity(locale);
  return [
    {
      id: 'local-runtime.status',
      provider: { ...provider },
      name: 'runtime.status',
      invocationName: 'runtime.status',
      title: translate(locale, 'tool.localRuntime.statusTitle'),
      description: translate(locale, 'tool.localRuntime.statusDescription'),
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execution: {
        mode: 'auto',
        enabled: true,
        risk: 'low',
        timeoutMs: 5_000,
        maxResultBytes: 32_000,
      },
    },
    {
      id: 'local-runtime.exec',
      provider: { ...provider },
      name: 'runtime.exec',
      invocationName: 'runtime.exec',
      title: translate(locale, 'tool.localRuntime.execTitle'),
      description: translate(locale, 'tool.localRuntime.execDescription'),
      inputSchema: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: translate(locale, 'tool.localRuntime.argsDescription'),
          },
        },
        additionalProperties: false,
      },
      execution: {
        mode: 'auto',
        enabled: true,
        risk: 'high',
        timeoutMs: 15_000,
        maxResultBytes: 128_000,
      },
    },
  ];
}

export async function executeLocalRuntimeToolCall(
  call: ToolCall,
  descriptor: ToolDescriptor,
  context?: ToolProviderExecutionContext,
): Promise<ToolResult> {
  const locale = context?.locale ?? DEFAULT_LOCALE;
  const provider = createLocalRuntimeToolProviderIdentity(locale);
  const startedAt = Date.now();
  try {
    if (descriptor.id === 'local-runtime.status') {
      const envelope = await localRuntimeStatus();
      return {
        ok: envelope.ok,
        summary: translate(locale, 'tool.localRuntime.statusOk', {
          hostId: envelope.host.host_id,
          platform: envelope.host.platform,
        }),
        descriptorId: descriptor.id,
        provider: { ...provider },
        name: call.name,
        output: {
          host_id: envelope.host.host_id,
          runtime_version: envelope.host.runtime_version,
          contract_version: envelope.host.contract_version,
          platform: envelope.host.platform,
          pty_supported: envelope.host.pty_supported,
          profiles: envelope.host.profiles,
        },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    if (descriptor.id === 'local-runtime.exec') {
      // Authority is background-owned capabilityScope (grant/trusted), never payload.
      // Model/page-injected grant_id/profile_id/workspace_id/path are ignored.
      // Receiver workspace comes only from context.receiverWorkspaceRoot
      // (background authorization/receiver side), never from ToolCall.payload.
      const rawPayload = call.payload as Record<string, unknown> | undefined;
      const args = Array.isArray(rawPayload?.args)
        ? (rawPayload.args as unknown[]).filter((arg): arg is string => typeof arg === 'string')
        : [];

      const capabilityScope = context?.capabilityScope;
      if (!capabilityScope) {
        return {
          ok: false,
          summary: translate(locale, 'tool.localRuntime.authMissing'),
          descriptorId: descriptor.id,
          provider: { ...provider },
          name: call.name,
          error: {
            code: 'runtime_authorization_missing',
            message: 'Local Runtime execution requires a background-owned capabilityScope.',
            retryable: false,
          },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      // Internal correlation ticket derived from receiver-owned scope — not model authority.
      // The Rust host treats grant_id as audit/correlation metadata only and never
      // gates execution on it; the background capabilityScope is the sole authority.
      const internalGrantId = `lr:${capabilityScope.scopeId}`;
      const profileId = LOCAL_RUNTIME_CANARY_PROFILE;
      // Background-owned workspace binding; Rust still canonicalizes and fails closed.
      const receiverWorkspace = context?.receiverWorkspaceRoot?.trim()
        ? context.receiverWorkspaceRoot
        : undefined;

      const envelope = await localRuntimeExec({
        grantId: internalGrantId,
        profileId,
        args,
        workspaceId: receiverWorkspace,
        maxOutputBytes: 128_000,
        timeoutMs: 15_000,
      });

      if (!envelope.ok) {
        return {
          ok: false,
          summary: translate(locale, 'tool.localRuntime.execRejected', {
            code: envelope.error?.code ?? 'unknown',
          }),
          descriptorId: descriptor.id,
          provider: { ...provider },
          name: call.name,
          error: {
            code: envelope.error?.code ?? 'runtime_request_invalid',
            message: envelope.error?.message ?? 'Local Runtime rejected execution.',
            retryable: envelope.error?.retryable ?? false,
          },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      const result = envelope.result;
      if (!result) {
        return {
          ok: false,
          summary: translate(locale, 'tool.localRuntime.missingResult'),
          descriptorId: descriptor.id,
          provider: { ...provider },
          name: call.name,
          error: {
            code: 'local_runtime_unknown_error',
            message: 'Local Runtime returned ok without a result payload.',
            retryable: false,
          },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      return {
        ok: true,
        summary: translate(locale, 'tool.localRuntime.execComplete', {
          bytes: result.bytes_retained,
        }),
        descriptorId: descriptor.id,
        provider: { ...provider },
        name: call.name,
        output: {
          run_id: result.run_id,
          host_id: LOCAL_RUNTIME_HOST_ID,
          profile_id: profileId,
          exit_status: result.exit_status,
          timed_out: result.timed_out,
          cancelled: result.cancelled,
          teardown_confirmed: result.teardown_confirmed,
          bytes_seen: result.bytes_seen,
          bytes_retained: result.bytes_retained,
          more_available: result.more_available,
          output: result.output,
        } as unknown as JsonValue,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      ok: false,
      summary: translate(locale, 'tool.localRuntime.unknownTool'),
      descriptorId: descriptor.id,
      provider: { ...provider },
      name: call.name,
      error: { code: 'tool_unknown', message: 'Unknown Local Runtime tool.', retryable: false },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      summary: translate(locale, 'tool.localRuntime.callFailed'),
      descriptorId: descriptor.id,
      provider: { ...provider },
      name: call.name,
      error: { code: 'local_runtime_unknown_error', message, retryable: true },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  }
}
