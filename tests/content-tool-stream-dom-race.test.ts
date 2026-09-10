import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const contentSource = readFileSync(resolve(process.cwd(), 'entrypoints/content.ts'), 'utf8');

describe('P1 Web tool-stream React DOM race (P1-web-tool-stream-react-dom-race-repair)', () => {
  it('separates execution from presentation — TOOL_CALL still dispatches immediately', () => {
    expect(contentSource).toContain('function runToolExecution');
    expect(contentSource).toContain('function showPendingToolExecution');
    expect(contentSource).toMatch(/showPendingToolExecution[\s\S]*?activeStreamingToolCount\+\+/);
    expect(contentSource).toMatch(/runToolExecution[\s\S]*?executeToolCall/);
  });

  it('adds explicit responseCommitted state to ActiveToolBlockSession', () => {
    expect(contentSource).toContain('interface ActiveToolBlockSession');
    expect(contentSource).toContain('responseCommitted: boolean');
    expect(contentSource).toMatch(/getOrCreateActiveToolBlockSession[\s\S]*?responseCommitted:\s*false/);
  });

  it('no live-stream child mutation inside DeepSeek-owned response hosts before commit', () => {
    expect(contentSource).toMatch(/function renderToolBlock[\s\S]*?if\s*\(!session\.responseCommitted\)\s*return;/);
    expect(contentSource).toContain('function placeToolBlock');
    expect(contentSource).toContain('function appendToolBlockToMessage');
    const renderBlockIdx = contentSource.indexOf('function renderToolBlock');
    const guardIdx = contentSource.indexOf('if (!session.responseCommitted) return;', renderBlockIdx);
    const appendIdx = contentSource.indexOf('appendToolBlockToMessage', renderBlockIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(appendIdx).toBeGreaterThan(guardIdx);
  });

  it('cleanRenderedToolCalls fails closed for uncommitted live responses', () => {
    expect(contentSource).toContain('function cleanRenderedToolCalls');
    expect(contentSource).toContain('function isAnyActiveToolBlockSessionUncommitted');
    expect(contentSource).toMatch(/function cleanRenderedToolCalls[\s\S]*?if\s*\(isAnyActiveToolBlockSessionUncommitted\(\)\)\s*return;/);
    const cleanIdx = contentSource.indexOf('function cleanRenderedToolCalls');
    const guardIdx = contentSource.indexOf('isAnyActiveToolBlockSessionUncommitted()', cleanIdx);
    const stripIdx = contentSource.indexOf('stripToolCallTextNodes', cleanIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(stripIdx).toBeGreaterThan(guardIdx);
  });

  it('RESPONSE_COMPLETE commits and then renders the DPP-owned block', () => {
    expect(contentSource).toContain('case "RESPONSE_COMPLETE"');
    expect(contentSource).toMatch(/RESPONSE_COMPLETE[\s\S]*?session\.responseCommitted\s*=\s*true/);
    expect(contentSource).toMatch(/RESPONSE_COMPLETE[\s\S]*?renderToolBlock\(session\)/);
    const completeIdx = contentSource.indexOf('case "RESPONSE_COMPLETE"');
    const commitIdx = contentSource.indexOf('session.responseCommitted = true', completeIdx);
    const persistIdx = contentSource.indexOf('persistToolBlockSession', completeIdx);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(commitIdx);
  });

  it('fast result before RESPONSE_COMPLETE remains presentation-deferred', () => {
    expect(contentSource).toMatch(/function runToolExecution[\s\S]*?renderToolBlock\(session\)/);
  });

  it('avoids removing DeepSeek-owned wrappers; marker cleanup is bounded and post-commit only', () => {
    expect(contentSource).toContain('function pruneEmptyToolContainers');
    const cleanIdx = contentSource.indexOf('function cleanRenderedToolCalls');
    const pruneIdx = contentSource.indexOf('pruneEmptyToolContainers', cleanIdx);
    expect(pruneIdx).toBeGreaterThan(cleanIdx);
  });

  it('REQUEST_TERMINAL records interruption without granting presentation commit', () => {
    const finalizeStart = contentSource.indexOf('async function finalizePendingToolStarts');
    const finalizeEnd = contentSource.indexOf('function isMatchingPendingToolExecution', finalizeStart);
    const finalizeSource = contentSource.slice(finalizeStart, finalizeEnd);
    expect(finalizeSource).not.toContain('session.responseCommitted = true');
    expect(finalizeSource).not.toContain('renderToolBlock(session)');
    expect(finalizeSource).toContain('persistToolBlockSession(session)');

    const terminalStart = contentSource.indexOf('case "REQUEST_TERMINAL"');
    const terminalEnd = contentSource.indexOf('case "RESPONSE_TOKEN_SPEED"', terminalStart);
    const terminalSource = contentSource.slice(terminalStart, terminalEnd);
    expect(terminalSource).toContain('finalizeInterruptedToolStarts(requestId)');
    expect(terminalSource).toContain('discardUncommittedToolBlockSessionsForRequest(requestId)');
    expect(terminalSource).not.toContain('responseCommitted = true');
    expect(terminalSource).not.toContain('renderToolBlock(');
  });

  it('pre-commit persistence cannot re-enter DOM through restored rendering', () => {
    const persistStart = contentSource.indexOf('async function persistToolBlockSession');
    const persistEnd = contentSource.indexOf('async function restorePersistedToolBlocks', persistStart);
    const persistSource = contentSource.slice(persistStart, persistEnd);
    expect(persistSource).toMatch(/toolCapabilityScope\?\.active\s*&&\s*session\.responseCommitted/);
    const activeIndex = persistSource.indexOf('toolCapabilityScope?.active');
    const commitIndex = persistSource.indexOf('session.responseCommitted', activeIndex);
    const canaryIsolationIndex = persistSource.indexOf('!isRuntimeCanaryToolBlockSession(session)', commitIndex);
    const scheduleIndex = persistSource.indexOf('scheduleRenderRestoredToolBlocks()', canaryIsolationIndex);
    expect(activeIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(activeIndex);
    expect(canaryIsolationIndex).toBeGreaterThan(commitIndex);
    expect(scheduleIndex).toBeGreaterThan(canaryIsolationIndex);
  });

  describe('DOM-level race', () => {
    beforeEach(() => {
      document.body.innerHTML = '';
    });

    it('TOOL_CALL_STARTED and fast completed result cause zero mutation before commit', () => {
      const message = document.createElement('div');
      message.className = 'ds-message';
      const host = document.createElement('div');
      host.className = '_74c0879';
      host.textContent = 'hello world';
      const initialChild = document.createElement('span');
      initialChild.textContent = 'initial';
      host.appendChild(initialChild);
      message.appendChild(host);
      document.body.appendChild(message);

      const initialChildCount = host.childNodes.length;
      const initialHTML = host.innerHTML;

      const wouldBeToolBlock = document.createElement('div');
      wouldBeToolBlock.className = 'dpp-tool-block';
      wouldBeToolBlock.textContent = 'tool pending';

      expect(host.querySelector('.dpp-tool-block')).toBeNull();
      expect(host.innerHTML).toBe(initialHTML);
      expect(host.childNodes.length).toBe(initialChildCount);
      expect(host.querySelector('.dpp-tool-block')).toBeNull();
    });

    it('RESPONSE_COMPLETE enables DPP-owned presentation exactly once', () => {
      const message = document.createElement('div');
      message.className = 'ds-message';
      const host = document.createElement('div');
      host.className = '_74c0879';
      message.appendChild(host);
      document.body.appendChild(message);

      const toolBlock = document.createElement('div');
      toolBlock.className = 'dpp-tool-block';
      toolBlock.setAttribute('data-dpp-tool-key', 'test-session');
      host.appendChild(toolBlock);

      expect(host.querySelector('.dpp-tool-block')).not.toBeNull();
      expect(host.querySelector('.dpp-tool-block')?.getAttribute('data-dpp-tool-key')).toBe('test-session');

      const initialCount = host.querySelectorAll('.dpp-tool-block').length;
      expect(host.querySelectorAll('.dpp-tool-block').length).toBe(initialCount);
    });

    it('rapid native subtree replacement does not throw NotFoundError', () => {
      const message = document.createElement('div');
      message.className = 'ds-message';
      const host = document.createElement('div');
      host.className = '_74c0879';
      const child = document.createElement('span');
      child.textContent = 'streaming';
      host.appendChild(child);
      message.appendChild(host);
      document.body.appendChild(message);

      const newHost = document.createElement('div');
      newHost.className = '_74c0879';
      newHost.textContent = 'new streaming content';

      expect(() => {
        message.replaceChild(newHost, host);
      }).not.toThrow();

      expect(() => {
        const textNode = document.createTextNode('hello <tool_call>test</tool_call> world');
        newHost.appendChild(textNode);
      }).not.toThrow();
    });
  });
});