import type {
  McpJsonRpcNotification,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpProtocolTransport,
  McpServerConfig,
} from '../types';
import { McpTransportError, normalizeJsonRpcResponse } from './common';
import { MULTIMODAL_MCP_NATIVE_HOST } from '../../multimodal';
import { getMultimodalNativeEnv } from '../../multimodal/settings';
import { SHELL_MCP_NATIVE_HOST } from '../../shell';
import {
  NATIVE_MESSAGE_MAX_BYTES,
  notifyNativeHost,
  requestNativeHost,
  type NativeRequestId,
} from '../../native/request-channel';
import {
  MCP_NATIVE_ENVELOPE_PROTOCOL,
  MCP_NATIVE_ENVELOPE_VERSION,
  type McpNativeEnvelope,
} from '../native-contract';

// Port lifecycle, pending correlation, timeout/abort, disconnect cleanup,
// unmatched-response handling, and the transport ceiling are owned solely by
// `core/native/request-channel.ts`. This module only owns MCP JSON-RPC
// envelope semantics on top of that shared channel.

// local_file_write content cap with headroom for the JSON-RPC envelope. Keep
// models writing in chunks: write the first section, then append the rest
// with append=true (issue #297).
const MAX_LOCAL_FILE_WRITE_BYTES = 900_000;

function createMcpChannelErrors() {
  return {
    unavailable: () => new McpTransportError(
      'mcp_native_messaging_unavailable',
      'Browser native messaging is unavailable.',
      { retryable: false },
    ),
    disconnected: (detail?: string) => new McpTransportError(
      'mcp_native_host_disconnected',
      detail || 'Native host disconnected.',
      { retryable: true },
    ),
    timeout: (timeoutMs: number) => new McpTransportError(
      'mcp_native_timeout',
      `Native MCP request exceeded ${timeoutMs} ms.`,
    ),
    payloadTooLarge: (bytes: number, ceiling: number) => new McpTransportError(
      'mcp_native_payload_too_large',
      `Native MCP request is too large (${formatBytes(bytes)} > ${formatBytes(ceiling)}). Reduce the request size or split the work into smaller tool calls.`,
      { retryable: false },
    ),
    aborted: (signal: AbortSignal) => {
      if (signal.reason instanceof Error) return signal.reason;
      return new DOMException('Native MCP request was aborted.', 'AbortError');
    },
  };
}

function extractMcpResponseId(response: unknown): NativeRequestId | null | undefined {
  const record = response as { id?: unknown; jsonrpc?: unknown; result?: { id?: unknown } } | null;
  if (typeof record !== 'object' || record === null) return undefined;
  const id = record.jsonrpc === '2.0' ? record.id : (record.id ?? record.result?.id);
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

export function createMcpNativeMessagingTransport(server: McpServerConfig): McpProtocolTransport {
  return {
    request(request, options) {
      return sendNativeMessage(server, request, options?.timeoutMs, options?.signal);
    },
    async notify(notification, options) {
      await sendNativeMessage(server, notification, options?.timeoutMs, options?.signal);
    },
  };
}

async function sendNativeMessage<TParams extends Record<string, unknown> | undefined, TResult>(
  server: McpServerConfig,
  message: McpJsonRpcRequest<TParams> | McpJsonRpcNotification,
  timeoutMs: number = server.timeouts.requestMs,
  signal?: AbortSignal,
): Promise<McpJsonRpcResponse<TResult>> {
  throwIfNativeSignalAborted(signal);
  const nativeHost = server.transport.nativeHost;
  if (!nativeHost) {
    throw new McpTransportError('mcp_native_host_missing', 'Native messaging host is not configured.', {
      retryable: false,
    });
  }

  const expectedRequest = 'id' in message ? message as McpJsonRpcRequest<TParams> : undefined;
  const envelope = await createNativeEnvelope(server, message);
  if (expectedRequest) {
    assertNativePayloadSize(nativeHost, envelope);
  }

  let response: unknown;
  if (expectedRequest) {
    throwIfNativeSignalAborted(signal);
    response = await requestNativeHost(nativeHost, envelope, {
      requestId: expectedRequest.id,
      extractResponseId: extractMcpResponseId,
      timeoutMs,
      signal,
      // Shell requests keep the 1 MiB Chrome Port ceiling enforced twice:
      // once with shell-specific guidance above, once here as the shared
      // transport ceiling. Non-shell hosts (e.g. multimodal large images)
      // preserve the released bypass and are not transport-gated here.
      maxMessageBytes: nativeHost === SHELL_MCP_NATIVE_HOST
        ? NATIVE_MESSAGE_MAX_BYTES
        : Number.POSITIVE_INFINITY,
      errors: createMcpChannelErrors(),
    });
    throwIfNativeSignalAborted(signal);
  } else {
    throwIfNativeSignalAborted(signal);
    // Notifications stay fire-and-forget and preserve the released behavior
    // of not being size-gated; the shared channel still owns Port lifecycle.
    notifyNativeHost(nativeHost, envelope, {
      maxMessageBytes: Number.POSITIVE_INFINITY,
      errors: createMcpChannelErrors(),
    });
    return undefined as any;
  }

  return normalizeJsonRpcResponse<TResult>(response, expectedRequest);
}

function throwIfNativeSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Native MCP request was aborted.', 'AbortError');
}

async function createNativeEnvelope(
  server: McpServerConfig,
  message: McpJsonRpcRequest<any> | McpJsonRpcNotification,
): Promise<McpNativeEnvelope> {
  const env = await createNativeEnv(server);
  return {
    protocol: MCP_NATIVE_ENVELOPE_PROTOCOL,
    version: MCP_NATIVE_ENVELOPE_VERSION,
    server: {
      id: server.id,
      command: server.transport.command,
      args: server.transport.args,
      cwd: server.transport.cwd,
      env,
    },
    message,
  };
}

function assertNativePayloadSize(nativeHost: string, envelope: McpNativeEnvelope): void {
  if (nativeHost !== SHELL_MCP_NATIVE_HOST) return;
  const writeContent = getLocalFileWriteContent(envelope.message);
  if (writeContent !== null) {
    const contentBytes = new Blob([writeContent]).size;
    if (contentBytes > MAX_LOCAL_FILE_WRITE_BYTES) {
      throw new McpTransportError(
        'mcp_native_payload_too_large',
        `local_file_write content is too large (${formatBytes(contentBytes)} > ${formatBytes(MAX_LOCAL_FILE_WRITE_BYTES)}). Write the file in chunks: send the first section now, then call local_file_write again with append=true for each remaining section.`,
        { retryable: false },
      );
    }
    if (contentBytes <= MAX_LOCAL_FILE_WRITE_BYTES && contentBytes > NATIVE_MESSAGE_MAX_BYTES / 2) {
      return;
    }
  }

  const envelopeBytes = new Blob([JSON.stringify(envelope)]).size;
  if (envelopeBytes > NATIVE_MESSAGE_MAX_BYTES) {
    throw new McpTransportError(
      'mcp_native_payload_too_large',
      `Native MCP request is too large (${formatBytes(envelopeBytes)} > ${formatBytes(NATIVE_MESSAGE_MAX_BYTES)}). Reduce the request size or split the work into smaller tool calls.`,
      { retryable: false },
    );
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} bytes`;
}

function getLocalFileWriteContent(message: McpJsonRpcRequest<any> | McpJsonRpcNotification): string | null {
  if (message.method !== 'tools/call') return null;
  const params = message.params as { name?: unknown; arguments?: { content?: unknown } } | undefined;
  if (params?.name !== 'local_file_write') return null;
  const content = params.arguments?.content;
  return typeof content === 'string' ? content : null;
}

async function createNativeEnv(server: McpServerConfig): Promise<Record<string, string> | undefined> {
  if (server.transport.nativeHost === MULTIMODAL_MCP_NATIVE_HOST) {
    const env = await getMultimodalNativeEnv();
    return Object.keys(env).length > 0 ? env : undefined;
  }

  const env: Record<string, string> = { ...(server.transport.env ?? {}) };
  return Object.keys(env).length > 0 ? env : undefined;
}
