import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "entrypoints/content.ts"), "utf8");

describe("P1 runtime canary React DOM isolation", () => {
  it("identifies only runtime canary executions for inline presentation isolation", () => {
    expect(source).toContain('execution.name === "runtime.exec" || execution.name === "runtime.status"');
  });

  it("never mounts a runtime canary session into the DeepSeek assistant subtree", () => {
    const start = source.indexOf("function renderToolBlock");
    const end = source.indexOf("function collapseToolBlock", start);
    const body = source.slice(start, end);
    const guard = body.indexOf("if (isRuntimeCanaryToolBlockSession(session)) return;");
    const place = body.indexOf("placeToolBlock(");
    expect(guard).toBeGreaterThan(-1);
    expect(place).toBeGreaterThan(guard);
  });

  it("does not re-enter DOM via restored rendering for runtime canary records", () => {
    const persistStart = source.indexOf("async function persistToolBlockSession");
    const persistEnd = source.indexOf("async function restorePersistedToolBlocks", persistStart);
    const persist = source.slice(persistStart, persistEnd);
    expect(persist).toContain("!isRuntimeCanaryToolBlockSession(session)");

    const restoreStart = source.indexOf("async function restorePersistedToolBlocks");
    const restoreEnd = source.indexOf("function isToolEpochActive", restoreStart);
    const restore = source.slice(restoreStart, restoreEnd);
    expect(restore).toContain("!isRuntimeCanaryPersistedToolBlock(block)");
  });

  it("keeps execution semantics independent from presentation", () => {
    expect(source).toMatch(/function runToolExecution[\s\S]*?executeToolCall/);
    expect(source).toMatch(/case "TOOL_CALL"[\s\S]*?runToolExecution/);
  });
});
