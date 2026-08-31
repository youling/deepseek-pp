/**
 * Local Coding Runtime tool provider (`com.deepseek_pp.runtime.canary`).
 *
 * Execution-only canary proving: DeepSeek Web -> authorized tool call ->
 * Native Messaging channel -> isolated Rust host -> bounded local execution ->
 * result returned to the same DeepSeek Web session.
 *
 * This provider is a `local` provider (in-process) whose `execute` is only
 * reached AFTER the runtime authorization path resolved the call. It never
 * authorizes anything itself. The `runtime.exec` tool forwards a `grant_id`
 * reference to the host; the host independently enforces (fail-closed) that a
 * non-empty background-issued grant reference is present and that the requested
 * profile is host-owned (`canary.echo` only) — the browser can never supply an
 * arbitrary command.
 */

import type { JsonValue, ToolCall, ToolDescriptor, ToolResult } from '../tool/types';
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

export function createLocalRuntimeToolDescriptors(_locale: string): ToolDescriptor[] {
  return [
    {
      id: 'local-runtime.status',
      provider: { ...LOCAL_RUNTIME_TOOL_PROVIDER },
      name: 'runtime.status',
      invocationName: 'runtime.status',
      title: 'Local Runtime 状态',
      description: '报告 Local Runtime 原生宿主（com.deepseek_pp.runtime.canary）的健康状态、平台、契约版本与可用执行画像。不会执行任何命令。',
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
      provider: { ...LOCAL_RUNTIME_TOOL_PROVIDER },
      name: 'runtime.exec',
      invocationName: 'runtime.exec',
      title: '本地受限执行（canary）',
      description: '在隔离的 Rust Local Runtime 宿主中以宿主拥有的 canary.echo 画像执行一次有界命令，返回输出、字节数与退出状态。仅允许宿主定义的非交互 echo 画像，浏览器无法提供任意命令。',
      inputSchema: {
        type: 'object',
        properties: {
          grant_id: {
            type: 'string',
            description: '后台签发的授权引用；宿主要求非空，直接页面调用会被拒绝。',
          },
          profile_id: {
            type: 'string',
            description: '宿主拥有且可执行的画像。缺省为 canary.echo。',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '传给画像的参数（受宿主每请求上限约束）。',
          },
        },
        required: ['grant_id'],
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
): Promise<ToolResult> {
  const startedAt = Date.now();
  try {
    if (descriptor.id === 'local-runtime.status') {
      const envelope = await localRuntimeStatus();
      return {
        ok: envelope.ok,
        summary: `Local Runtime ${envelope.host.host_id} (${envelope.host.platform}) 正常`,
        descriptorId: descriptor.id,
        provider: { ...LOCAL_RUNTIME_TOOL_PROVIDER },
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
      const payload = call.payload as {
        grant_id?: unknown;
        profile_id?: unknown;
        args?: unknown;
      };
      const grantId = typeof payload.grant_id === 'string' && payload.grant_id.length > 0
        ? payload.grant_id
        : undefined;
      if (!grantId) {
        return {
          ok: false,
          summary: '缺少后台授权引用（grant_id），宿主拒绝执行。直接页面调用不可达。',
          descriptorId: descriptor.id,
          provider: { ...LOCAL_RUNTIME_TOOL_PROVIDER },
          name: call.name,
          error: {
            code: 'runtime_grant_missing',
            message: 'A background-issued grant_id is required to execute on the Local Runtime host.',
            retryable: false,
          },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      const profileId = typeof payload.profile_id === 'string' && payload.profile_id.length > 0
        ? payload.profile_id
        : LOCAL_RUNTIME_CANARY_PROFILE;
      const args = Array.isArray(payload.args)
        ? payload.args.filter((arg): arg is string => typeof arg === 'string')
        : [];

      const envelope = await localRuntimeExec({
        grantId,
        profileId,
        args,
        maxOutputBytes: 128_000,
        timeoutMs: 15_000,
      });

      if (!envelope.ok) {
        return {
          ok: false,
          summary: `本地执行被宿主拒绝：${envelope.error?.code ?? 'unknown'}`,
          descriptorId: descriptor.id,
          provider: { ...LOCAL_RUNTIME_TOOL_PROVIDER },
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
          summary: '宿主返回了成功标记但缺少执行结果',
          descriptorId: descriptor.id,
          provider: { ...LOCAL_RUNTIME_TOOL_PROVIDER },
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
        summary: `canary 执行完成，保留 ${result.bytes_retained} 字节`,
        descriptorId: descriptor.id,
        provider: { ...LOCAL_RUNTIME_TOOL_PROVIDER },
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
      summary: '未知的 Local Runtime 工具',
      descriptorId: descriptor.id,
      provider: { ...LOCAL_RUNTIME_TOOL_PROVIDER },
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
      summary: 'Local Runtime 调用失败',
      descriptorId: descriptor.id,
      provider: { ...LOCAL_RUNTIME_TOOL_PROVIDER },
      name: call.name,
      error: { code: 'local_runtime_unknown_error', message, retryable: true },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  }
}
