import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __unsafeResetNativeChannelForTests,
  notifyNativeHost,
  requestNativeHost,
} from '../core/native/request-channel';

type PortHarness = {
  postMessage: ReturnType<typeof vi.fn>;
  triggerMessage: (msg: unknown) => void;
  triggerDisconnect: () => void;
};

function createChromeHarness() {
  const ports = new Map<string, PortHarness>();
  let lastErrorMessage: string | undefined;

  const connectNative = vi.fn((host: string) => {
    let onMessage: ((msg: unknown) => void) | null = null;
    let onDisconnect: (() => void) | null = null;
    const postMessage = vi.fn((msg: unknown) => {
      void msg;
    });
    const port = {
      postMessage,
      onMessage: { addListener: vi.fn((h: (msg: unknown) => void) => { onMessage = h; }) },
      onDisconnect: { addListener: vi.fn((h: () => void) => { onDisconnect = h; }) },
    };
    ports.set(host, {
      postMessage,
      triggerMessage: (msg: unknown) => onMessage?.(msg),
      triggerDisconnect: () => {
        if (onDisconnect) onDisconnect();
      },
    });
    return port as unknown as chrome.runtime.Port;
  });

  const stub = {
    runtime: {
      connectNative,
      get lastError() {
        return lastErrorMessage ? { message: lastErrorMessage } : undefined;
      },
    },
  } as unknown as typeof chrome;

  function setLastError(msg?: string) {
    lastErrorMessage = msg;
  }

  vi.stubGlobal('chrome', stub);
  return { connectNative, ports, setLastError };
}

function makeErrors() {
  return {
    unavailable: () => new Error('unavailable'),
    disconnected: (detail?: string) => new Error(`disconnected:${detail ?? ''}`),
    timeout: (ms: number) => new Error(`timeout:${ms}`),
    payloadTooLarge: (bytes: number, ceiling: number) => new Error(`too_large:${bytes}>${ceiling}`),
    aborted: (signal: AbortSignal) => {
      if (signal.reason instanceof Error) return signal.reason;
      return new DOMException('aborted', 'AbortError');
    },
  };
}

beforeEach(() => {
  __unsafeResetNativeChannelForTests();
  vi.unstubAllGlobals();
});

afterEach(() => {
  __unsafeResetNativeChannelForTests();
  vi.unstubAllGlobals();
});

describe('native request-channel primitive', () => {
  it('correlates concurrent requests out-of-order without cross-talk', async () => {
    const harness = createChromeHarness();
    const errors = makeErrors();
    const extract = (r: unknown) => (r as { id?: number | string })?.id;

    const p1 = requestNativeHost('host-a', { payload: 1 }, {
      requestId: 1,
      extractResponseId: extract,
      timeoutMs: 1_000,
      errors,
    });
    const p2 = requestNativeHost('host-a', { payload: 2 }, {
      requestId: 2,
      extractResponseId: extract,
      timeoutMs: 1_000,
      errors,
    });

    expect(harness.connectNative).toHaveBeenCalledTimes(1);
    expect(harness.ports.get('host-a')!.postMessage).toHaveBeenCalledTimes(2);

    // Resolve out of order.
    harness.ports.get('host-a')!.triggerMessage({ id: 2, result: 'second' });
    harness.ports.get('host-a')!.triggerMessage({ id: 1, result: 'first' });

    await expect(p2).resolves.toEqual({ id: 2, result: 'second' });
    await expect(p1).resolves.toEqual({ id: 1, result: 'first' });
  });

  it('ignores unmatched/malformed responses without resolving the wrong pending', async () => {
    const harness = createChromeHarness();
    const errors = makeErrors();
    const extract = (r: unknown) => {
      const rec = r as Record<string, unknown> | null;
      if (!rec || typeof rec.id !== 'number') return undefined;
      return rec.id as number;
    };

    const pending = requestNativeHost('host-a', { payload: 'x' }, {
      requestId: 42,
      extractResponseId: extract,
      timeoutMs: 500,
      errors,
    });

    harness.ports.get('host-a')!.triggerMessage({ id: 999, result: 'wrong' });
    harness.ports.get('host-a')!.triggerMessage(null);
    harness.ports.get('host-a')!.triggerMessage({ notId: 42 });
    harness.ports.get('host-a')!.triggerMessage('not an object');

    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    harness.ports.get('host-a')!.triggerMessage({ id: 42, result: 'ok' });
    await expect(pending).resolves.toEqual({ id: 42, result: 'ok' });
  });

  it('timeouts and removes only the timed-out pending', async () => {
    const harness = createChromeHarness();
    const errors = makeErrors();
    const extract = (r: unknown) => (r as { id?: string })?.id;

    const pTimeout = requestNativeHost('host-a', { hello: 1 }, {
      requestId: 't1',
      extractResponseId: extract,
      timeoutMs: 20,
      errors,
    });
    const pKeep = requestNativeHost('host-a', { hello: 2 }, {
      requestId: 't2',
      extractResponseId: extract,
      timeoutMs: 500,
      errors,
    });

    await expect(pTimeout).rejects.toThrow('timeout:20');
    // Other pending still alive.
    harness.ports.get('host-a')!.triggerMessage({ id: 't2', ok: true });
    await expect(pKeep).resolves.toEqual({ id: 't2', ok: true });

    // Late response for timed-out id must be ignored (unmatched).
    harness.ports.get('host-a')!.triggerMessage({ id: 't1', ok: true });
    // No throw, just ignored.
  });

  it('abort rejects pending and is not delivered as a response', async () => {
    const harness = createChromeHarness();
    const errors = makeErrors();
    const extract = (r: unknown) => (r as { id?: string })?.id;
    const controller = new AbortController();
    const reason = new Error('user-cancel');

    const pending = requestNativeHost('host-a', { x: 1 }, {
      requestId: 'a1',
      extractResponseId: extract,
      timeoutMs: 1_000,
      signal: controller.signal,
      errors,
    });

    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    // Late response must be ignored.
    harness.ports.get('host-a')!.triggerMessage({ id: 'a1', ok: true });
  });

  it('aborted before dispatch throws synchronously and never opens the port', () => {
    const harness = createChromeHarness();
    const errors = makeErrors();
    const extract = (r: unknown) => (r as { id?: string })?.id;
    const controller = new AbortController();
    const reason = new Error('pre-aborted');
    controller.abort(reason);

    expect(() => requestNativeHost('host-a', { x: 1 }, {
      requestId: 'pre',
      extractResponseId: extract,
      timeoutMs: 1_000,
      signal: controller.signal,
      errors,
    })).toThrow(reason);
    expect(harness.connectNative).not.toHaveBeenCalled();
  });

  it('disconnect rejects all pending with per-entry disconnected factories', async () => {
    const harness = createChromeHarness();
    const errorsA = makeErrors();
    const errorsB = {
      ...makeErrors(),
      disconnected: (detail?: string) => new Error(`B-disconnected:${detail ?? ''}`),
    };
    // Use same host but different pending; primitive stores per-entry errors so disconnect
    // must reject each with its own factory. We test by using two hosts separately
    // and verifying each host's pending is rejected on its own disconnect.
    const extract = (r: unknown) => (r as { id?: string })?.id;

    const p1 = requestNativeHost('host-a', { v: 1 }, { requestId: 'd1', extractResponseId: extract, timeoutMs: 1_000, errors: errorsA });
    const p2 = requestNativeHost('host-a', { v: 2 }, { requestId: 'd2', extractResponseId: extract, timeoutMs: 1_000, errors: errorsA });
    const pOtherHost = requestNativeHost('host-b', { v: 3 }, { requestId: 'd3', extractResponseId: extract, timeoutMs: 1_000, errors: errorsB });

    harness.setLastError('Native host disconnected.');
    harness.ports.get('host-a')!.triggerDisconnect();

    await expect(p1).rejects.toThrow('disconnected:Native host disconnected.');
    await expect(p2).rejects.toThrow('disconnected:Native host disconnected.');
    // Other host not disconnected yet.
    let otherSettled = false;
    pOtherHost.then(() => { otherSettled = true; }, () => { otherSettled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(otherSettled).toBe(false);

    harness.ports.get('host-b')!.triggerDisconnect();
    await expect(pOtherHost).rejects.toThrow('B-disconnected:Native host disconnected.');
  });

  it('transport ceiling rejects before opening port and keeps the primitive usable', () => {
    const harness = createChromeHarness();
    const errors = makeErrors();
    const extract = (r: unknown) => (r as { id?: string })?.id;
    const big = 'x'.repeat(2_000);

    expect(() => requestNativeHost('host-a', { id: 'small', big }, {
      requestId: 'ceil',
      extractResponseId: extract,
      timeoutMs: 1_000,
      maxMessageBytes: 100,
      errors,
    })).toThrow(/too_large/);
    expect(harness.connectNative).not.toHaveBeenCalled();

    // Next small request still works.
    const p = requestNativeHost('host-a', { tiny: 1 }, {
      requestId: 'ok',
      extractResponseId: extract,
      timeoutMs: 500,
      errors,
    });
    harness.ports.get('host-a')!.triggerMessage({ id: 'ok', ok: true });
    return expect(p).resolves.toEqual({ id: 'ok', ok: true });
  });

  it('notifyNativeHost shares Port lifecycle but does not participate in correlation', async () => {
    const harness = createChromeHarness();
    const errors = makeErrors();
    const extract = (r: unknown) => (r as { id?: string })?.id;

    notifyNativeHost('host-a', { method: 'notifications/initialized' }, {
      errors: { unavailable: errors.unavailable, payloadTooLarge: errors.payloadTooLarge },
    });
    expect(harness.connectNative).toHaveBeenCalledTimes(1);
    expect(harness.ports.get('host-a')!.postMessage).toHaveBeenCalledWith({ method: 'notifications/initialized' });

    const pending = requestNativeHost('host-a', { id: 'n1' }, {
      requestId: 'n1',
      extractResponseId: extract,
      timeoutMs: 500,
      errors,
    });
    // notify already posted; pending reuses same Port
    expect(harness.connectNative).toHaveBeenCalledTimes(1);
    harness.ports.get('host-a')!.triggerMessage({ id: 'n1', ok: true });
    await expect(pending).resolves.toEqual({ id: 'n1', ok: true });
  });

  it('isolates hosts: correlation never crosses hosts', async () => {
    const harness = createChromeHarness();
    const errors = makeErrors();
    const extract = (r: unknown) => (r as { id?: string })?.id;

    const pA = requestNativeHost('host-a', { x: 1 }, { requestId: 'shared', extractResponseId: extract, timeoutMs: 500, errors });
    const pB = requestNativeHost('host-b', { x: 1 }, { requestId: 'shared', extractResponseId: extract, timeoutMs: 500, errors });

    // Response on host-a must not resolve host-b's pending
    harness.ports.get('host-a')!.triggerMessage({ id: 'shared', host: 'a' });
    await expect(pA).resolves.toEqual({ id: 'shared', host: 'a' });
    let bSettled = false;
    pB.then(() => { bSettled = true; }, () => { bSettled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(bSettled).toBe(false);
    harness.ports.get('host-b')!.triggerMessage({ id: 'shared', host: 'b' });
    await expect(pB).resolves.toEqual({ id: 'shared', host: 'b' });
  });

  it('rejects duplicate requestId on same host', async () => {
    const harness = createChromeHarness();
    const errors = makeErrors();
    const extract = (r: unknown) => (r as { id?: string })?.id;
    const p1 = requestNativeHost('host-a', { x: 1 }, { requestId: 'dup', extractResponseId: extract, timeoutMs: 500, errors });
    expect(() => requestNativeHost('host-a', { x: 2 }, { requestId: 'dup', extractResponseId: extract, timeoutMs: 500, errors }))
      .toThrow(/Duplicate native request id/);
    harness.ports.get('host-a')!.triggerMessage({ id: 'dup', ok: true });
    await expect(p1).resolves.toBeTruthy();
  });
});

describe('MCP native transport is a pure consumer of the shared channel', () => {
  it('preserves shell size-gating and multimodal bypass via the shared channel', async () => {
    const { createMcpNativeMessagingTransport } = await import('../core/mcp/transports/native');
    const connectNative = vi.fn(() => ({
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn((h: (msg: unknown) => void) => {
        setTimeout(() => h({ jsonrpc: '2.0', id: 'analyze-big', result: { content: [{ type: 'text', text: 'ok' }] } }), 0);
      }) },
      onDisconnect: { addListener: vi.fn() },
    }));
    vi.stubGlobal('chrome', {
      runtime: { connectNative },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } },
    } as unknown as typeof chrome);
    __unsafeResetNativeChannelForTests();

    const { MULTIMODAL_MCP_NATIVE_HOST } = await import('../core/multimodal/contracts');
    const multimodalServer = {
      version: 1 as const, id: 'multimodal', displayName: 'Multimodal', enabled: true,
      transport: { kind: 'native_messaging' as const, nativeHost: MULTIMODAL_MCP_NATIVE_HOST, env: {} },
      headers: [], secrets: [], timeouts: { connectMs: 1_000, requestMs: 1_000, discoveryMs: 1_000 },
      limits: { maxResultBytes: 1_000_000, maxToolCount: 64 }, allowlist: { mode: 'all' as const, toolNames: [] },
      execution: { enabled: true, mode: 'auto' as const }, status: 'unknown' as const, lastConnectedAt: null, lastError: null, createdAt: 0, updatedAt: 0,
    };
    const largeImage = 'x'.repeat(512 * 1024);
    const result = await createMcpNativeMessagingTransport(multimodalServer).request({
      jsonrpc: '2.0', id: 'analyze-big', method: 'tools/call',
      params: { name: 'analyze_images', arguments: { prompt: 'describe', images: [{ image_url: `data:image/png;base64,${largeImage}` }] } },
    }, { timeoutMs: 1_000 });
    expect(result).toBeDefined();
    expect(connectNative).toHaveBeenCalled();
  });
});
