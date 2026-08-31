# Web-first Coding Runtime v0

Status: **Architecture baseline / Human-authorized direction**  
Date: 2026-08-31  
Owner: Project Architect  
Baseline: `main@0a02c72b135bf2936e11aa78fd6136931ed65908`

## 1. Product origin

The primary product goal is **not** to build another standalone coding agent.

DeepSeek++ exists to extend **DeepSeek Web** so the user can keep the official web experience and its web-side free inference/token allowance while gaining agentic capabilities that the stock web product does not provide.

Therefore:

1. `deepseek-web` remains the default and primary reasoning/model backend for Coding Mode.
2. Local runtime components execute tools only. They do not run a model, route paid model traffic, or require an official API key for the core Coding Mode loop.
3. Official API support remains optional and independent. Coding Mode must not silently fall back from DeepSeek Web to a paid API path.
4. The browser/web session remains the model conversation authority for the web backend; the local runtime is an execution subordinate.
5. Product success is measured as: **what additional tasks can the DeepSeek web session reliably complete on the user's computer?**

## 2. Architectural decision: own the runtime

DeepSeek++ will own its Local Coding Runtime architecture and contracts.

External projects such as `xyTom/coding-tools-mcp`, DeepSeek Harness MCP client, Serena, MCP-Gateway, Desktop Commander and similar projects are **reference implementations and source material**, not mandatory runtime dependencies.

Allowed reuse:

- study algorithms, safety rules, lifecycle patterns, schemas and tests;
- transplant narrowly scoped code when its license permits and attribution/NOTICE requirements are preserved;
- port an implementation into DeepSeek++-owned modules when that produces a simpler coherent system.

Disallowed default architecture:

- chaining several third-party plugins/processes as the normal product path;
- duplicating tool routers, permission engines or workspace authorities;
- making Coding Mode depend on Python/uv/pipx/npm packages being independently installed and version-compatible;
- allowing an external runtime to become a second agent/model authority.

Rule: **external source code conforms to DeepSeek++ contracts; DeepSeek++ contracts do not conform to external package boundaries.**

## 3. Top-level runtime model

```text
DeepSeek Web
    |
    v
DeepSeek++ Extension
    - DeepSeek web provider / stream authority
    - pi agent loop
    - memory / Skills / project context
    - one runtime authorization path
    - Coding Mode UI
    |
    | versioned Native Messaging contract
    v
DeepSeek++ Local Runtime
    - workspace authority
    - filesystem/search
    - atomic patch engine
    - process/terminal lifecycle
    - Git/GitHub adapters
    - permission enforcement
    - bounded result/output store
    - optional semantic code services
    |
    v
User workspace / toolchain / git / gh
```

The existing DeepSeek web provider, pi loop and authorization path remain the integration spine. Coding tools must enter the same existing tool execution path; no second model loop or privileged execution bypass is allowed.

## 4. Trust and authority boundaries

### Extension authority

The extension owns:

- whether a model-originated tool call is authorized;
- user-facing permission grants and policy selection;
- which workspace/runtime instance is attached to a chat/session;
- which tool descriptors are exposed to the model;
- continuation/finalization in the DeepSeek web conversation.

### Local Runtime authority

The Local Runtime independently enforces:

- workspace path confinement;
- canonical path/symlink escape checks;
- process working directory and environment policy;
- destructive command/file safety rules;
- process/output resource limits;
- runtime protocol validation.

A browser-side grant is necessary but does not disable Local Runtime safety invariants.

### Model non-authority

Model/page payload fields are never identity or authorization evidence. The model may request an operation; it cannot declare that it has permission.

## 5. v0 tool surface

The first runtime should stay deliberately small. A tool is added only when a real Coding Mode workflow requires it.

### Runtime / workspace

- `coding_runtime_info`
- `coding_workspace_info`

### Files / search

- `coding_read_file`
- `coding_list_dir`
- `coding_search_text`

### Mutation

- `coding_apply_patch`

`coding_apply_patch` is the only direct v0 file-write primitive. It must support baseline validation and all-or-nothing behavior for a multi-file patch before broader edit APIs are considered.

### Process lifecycle

- `coding_exec`
- `coding_process_read`
- `coding_process_write`
- `coding_process_kill`

Long-running commands are first-class handles; a tool-call timeout must not imply process termination or process success.

### Git

- `coding_git_status`
- `coding_git_diff`
- `coding_git_log`

Git mutations may initially use `coding_exec` behind the same policy. Dedicated structured mutation tools are added only after dogfood demonstrates a model/reliability benefit.

### GitHub

GitHub is not a core runtime dependency. If local `gh` is available and authenticated, a thin structured adapter may later expose a small selected surface (`status`, Issue/PR/checks workflows). Unrestricted `gh api` is never the default model-facing interface.

## 6. Result contract: no blind truncation

Coding Runtime results must separate three concepts:

1. **agent summary** — compact text useful for the immediate model turn;
2. **structured result** — deterministic machine-readable metadata;
3. **retained output reference** — bounded runtime-owned data retrievable in pages/chunks when the full output cannot fit in the model context.

A result must state truncation/omission provenance explicitly. Transport truncation, local-runtime retention limits and model-context injection limits must not collapse into one ambiguous boolean.

The extension must never silently clamp a complete runtime result and then report `truncated: false`.

The model should receive an explicit continuation action when more output exists, e.g. a stable output/process reference plus byte/line cursor.

## 7. Workspace contract

A Local Runtime instance owns exactly one canonical workspace root.

Direct filesystem tools:

- reject paths outside the root;
- reject `..` traversal and NULs;
- resolve and reject symlink/junction/reparse-point escapes;
- never accept an absolute-path argument as a shortcut around the root contract.

The runtime may execute workspace-local tools that themselves access broader system resources only through command policy and explicit user authority; that does not weaken direct file-tool confinement.

## 8. Process contract

Process execution requires:

- explicit `cwd` resolution under the workspace unless a future narrowly scoped capability authorizes otherwise;
- sanitized/controlled environment construction;
- bounded stdout/stderr retention;
- stable process IDs independent of individual model turns;
- deterministic exit/timeout/killed state;
- cleanup of orphan children on runtime shutdown where the OS permits;
- platform-specific terminal implementation hidden behind one process port.

Windows interactive support must be designed around ConPTY or an equivalent real PTY path rather than terminal emulation in the browser. POSIX uses a real PTY where required.

## 9. Permission model

Product-level modes may be presented as `Safe`, `Trusted` and later `Sandbox`, but they are policies over one stable tool catalog, not different hidden catalogs.

Initial intent:

- reads/search/status: normally low risk;
- workspace patch/test/build: policy-configurable;
- network/package installation/git push/GitHub remote mutation: elevated;
- destructive system commands, privilege escalation and workspace-boundary escape: default deny or explicit high-friction grant;
- `Sandbox` is a future isolation backend, not a synonym for disabling permission checks on the host.

Every production tool call still traverses the existing DeepSeek++ runtime authorization path before Local Runtime dispatch.

## 10. Technology-stack boundary

The **extension remains WXT/React/TypeScript**. This architecture work does not authorize a browser-side rewrite.

The Local Runtime implementation language is intentionally not frozen in this document. It must satisfy the product contract first. A narrow ADR/spike will choose the implementation based on:

- self-contained desktop distribution;
- Windows/macOS/Linux process + PTY support;
- Native Messaging integration;
- filesystem/path safety primitives;
- startup/runtime footprint;
- shared-schema ergonomics with TypeScript;
- testability and maintainability;
- ability to absorb/reference existing open-source implementations without keeping their package/runtime dependency graph.

Candidate set for the first ADR: TypeScript/Node-derived single-runtime packaging vs Rust native binary. No broad framework rewrite is authorized by this ADR.

## 11. External source reuse policy

For every transplanted implementation:

- record source repository + source commit;
- record license;
- preserve required copyright/license/NOTICE text;
- document what behavior was retained vs intentionally changed;
- add DeepSeek++-owned tests for the adopted contract;
- do not track upstream structure mechanically after the code becomes DeepSeek++-owned.

Apache-2.0 material such as coding-tools-mcp requires its license/NOTICE obligations to remain visible when substantive code is reused.

## 12. Delivery order

### P0 — unblock model/tool feedback

Repair current tool-result injection budgeting/truncation provenance so Coding Mode evaluation is not invalidated by the existing 4k/8k post-transport clamp.

### P1 — Local Runtime contract + substrate

Implement only runtime lifecycle, Native Messaging protocol, one workspace and the minimal `runtime_info`/read command needed to prove a real DeepSeek Web → authorized tool → native runtime → workspace → continuation round trip.

### P2 — coding primitives

Add search, atomic patch, bounded process lifecycle and Git inspection under the same contract.

### P3 — web-side dogfood closure

Prove from a normal DeepSeek web chat:

`inspect repo -> locate defect -> patch -> run test -> read bounded/continued output -> inspect diff -> iterate`

No paid API may be required for this acceptance path.

### P4 — productization

Workspace picker, runtime install/update/health, permission UX, environment diagnostics, optional `gh` integration, packaging/signing and cross-platform closure.

### P5 — enhancements

Semantic/LSP code intelligence, sandbox/container backend, remote workstation, richer GitHub workflows and other optional capabilities only after the core web-first loop is stable.

## 13. Non-goals for v0

- replacing DeepSeek Web with a local or paid model;
- building a second generic MCP Gateway inside the product;
- reproducing all Serena/Desktop Commander/OpenHands features;
- arbitrary full-computer automation before the coding workflow is reliable;
- Android/mobile scope;
- opportunistic WXT/pi-agent-core upgrades;
- changing released DeepSeek web prompt/tool protocol bytes without explicit scoped authorization.

## 14. First acceptance milestone

The first material milestone is complete only when the user can open DeepSeek Web with DeepSeek++, select a local repository and ask the normal web model to perform a deterministic coding repair that includes a real file read, patch, test command, continued output when needed and Git diff inspection, with every privileged operation visible through the existing authorization system.

The milestone must demonstrate that the reasoning/token path is the **official DeepSeek web session**, not an API-backed substitute.
