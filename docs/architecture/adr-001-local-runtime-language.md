# ADR-001: Local Runtime Language and Packaging

- Status: Proposed for Architect Review
- Date: 2026-08-31
- Scope: DeepSeek++ Local Coding Runtime only
- Baseline: `main@0a02c72b135bf2936e11aa78fd6136931ed65908`

## Decision

Implement the DeepSeek++-owned Local Coding Runtime as a Rust native binary, eventually distributed with a self-contained, signed installer/update bundle. Keep the browser extension, DeepSeek Web session, existing authorization path, Native Messaging transport infrastructure, and model-facing tool semantics in the existing TypeScript spine. P1 uses a development registration and does not require production signing or update infrastructure.

The binary is an execution subordinate. It never selects a model, calls a paid API, owns an agent loop, or becomes a second authorization/router authority. The official DeepSeek Web session remains the only model/reasoning path. Local Runtime availability is an optional capability: if the host is absent, incompatible, or upgrading, the web session remains usable and reports a bounded local-capability error.

The first implementation should use `portable-pty` for the PTY abstraction (version 0.9.0 was the current documented release during this research), Tokio for async I/O, and explicit platform process-supervision code: Windows Job Objects plus ConPTY; POSIX process groups plus Unix PTY. `tokio::process::Child::kill_on_drop` is useful but is not, by itself, a process-tree guarantee.

## Why this product needs a native substrate

The current repository already has a public `deepseek-pp-shell-host` package (`node >=18.17`) and a Native Messaging implementation. The host uses a dependency-free `.mjs` payload, `child_process`, sentinel-delimited persistent sessions, and bounded retained output. That is a useful compatibility and fallback reference, but it deliberately does not provide a real PTY or a complete process-tree containment model. The extension-side native transport already owns the `deepseek-pp-mcp-native` v1 envelope, request correlation, timeout/abort behavior, and the approximately 1 MiB Native Messaging limit.

The decision therefore targets the missing execution substrate, not a browser-stack rewrite. The Rust binary will initially reuse the existing Native Messaging framing, browser transport, request correlation, and size limits, but it will speak a dedicated, discriminated `deepseek-pp-local-runtime` v1 contract. P1 uses an isolated canary host identity (`com.deepseek_pp.runtime.canary`). The released `com.deepseek_pp.shell` host and its catalog remain unchanged; any later migration is a separate compatibility decision.

## Alternatives considered

### A. Self-contained Node/TypeScript runtime

This is the lowest-friction option for this repository. It reuses the current host code, TypeScript-adjacent JSON contracts, `child_process`, and npm developer workflow. It is credible for one-shot process execution, bounded stdout/stderr, Native Messaging framing, and installer orchestration.

It is not selected as the primary runtime because:

1. A real PTY requires a native dependency such as `node-pty`, which means per-platform prebuilt artifacts, ABI/toolchain maintenance, and a larger installer surface. The current host intentionally avoids this dependency.
2. Node's built-in single-executable application feature is active development. The current local canary is Node v24.15.0, where `node --build-sea` is unavailable; current Node documentation describes built-in `--build-sea` beginning in v25.5.0 and says the feature is tested regularly only on Windows, macOS arm64, and Linux subject to documented limitations.
3. `child_process` plus `SIGTERM`/`SIGKILL` is not a Windows process-tree containment design. A future implementation would still need native Job Object and ConPTY bindings, at which point the runtime has acquired a native subsystem while retaining Node packaging/runtime overhead.
4. Shipping a self-contained Node executable can work, but the packaging contract and native-addon story would be coupled to a fast-moving Node SEA surface. This is a poor foundation for an installer that must be independently upgradeable from the extension.

Node remains a valid development/reference implementation and a possible rollback artifact while the Rust host is canaried. It is not a second active authority: only one host artifact is registered for the host name at a time.

### B. Rust native binary — selected

Rust produces a native executable without a user-installed Node/Python/uv/pipx prerequisite and has direct, mature access to OS process, handle, filesystem, and signal APIs. `portable-pty` exposes a cross-platform PTY interface and has Windows and Unix implementations; Tokio provides async pipes, cancellation plumbing, and bounded streaming building blocks; the remaining process-tree guarantees can be made explicit in small Windows/Unix adapters rather than hidden in a general-purpose agent framework.

The costs are real: a second language/toolchain, cross-compilation and signing CI, platform-specific filesystem/process code, and a slower initial implementation curve for the TypeScript-first repository. Those costs buy the two requirements that are hardest to fake safely: interactive terminal semantics and reliable cleanup of descendants.

No third candidate is included. Python would not materially dominate either candidate for this Windows-first, self-contained, PTY/process-supervision contract: it adds a runtime-distribution problem and would still require native PTY/process adapters. A generic language survey would not improve this decision.

## Contract comparison

| Criterion | TypeScript/Node packaged | Rust native binary | Decision implication |
| --- | --- | --- | --- |
| Chrome/Edge/Firefox Native Messaging | Straightforward stdio framing; already implemented | Same 4-byte native-endian length + UTF-8 JSON; no browser change | Tie; reuse framing/transport, not semantic authority |
| Windows-first canary / macOS / Linux | Easy host bootstrap; native features need per-platform addons | Cross-compile explicit targets; native OS APIs are first-class | Rust wins for long-term parity |
| ConPTY and POSIX PTY | Requires native addon and ABI packaging | `portable-pty` abstraction plus platform adapters | Rust wins |
| Cancellation and process trees | Child cancellation is easy; descendant cleanup is not | Job Objects/process groups can be owned and tested directly | Rust wins |
| Filesystem confinement and atomic replacement | Node fs APIs are usable, but secure handle-level behavior needs native code | `canonicalize`/handle APIs and atomic rename can be isolated in one crate/module | Rust wins, with explicit TOCTOU limits |
| Self-contained install/update | SEA is promising but active-development; native addons complicate it | Signed per-platform binary plus installer bundle | Rust wins |
| Footprint/startup | Larger runtime, convenient JS startup | Small native process, no embedded JS runtime | Rust likely wins; measure in P1 |
| Typed/versioned JSON with TypeScript | Best local ergonomics | Requires schema/code generation and boundary validation | Node wins locally; Rust cost is bounded by schema-first contract |
| Testability/crash isolation | Familiar tests; process-tree cases need native coverage | Unit tests plus OS integration tests; crash is process-isolated | Rust wins for failure containment |
| Reuse of listed projects | Easy to copy JS/Python patterns; risks dependency chains | Port narrow ideas without importing an agent/router | Rust better matches ownership boundary |
| License/NOTICE | Existing Apache-2.0 product; npm graph must be audited | Cargo graph must be audited; selected PTY dependency is MIT | Both acceptable with inventory; no opaque source copy |
| Developer velocity / maintenance | Fast first patch, lower local language cost | Slower first slice, clearer long-term OS boundary | Rust wins for the stated contract |
| Independence of DeepSeek Web inference | Possible in either design | Explicit separate process and protocol | Tie; mandatory invariant |

## Evidence and reproducible spikes

### Canonical protocol and repository evidence

- Chrome documents Native Messaging as a separate host process over stdin/stdout, with UTF-8 JSON preceded by a 32-bit native-endian length; the documented host-to-browser message ceiling is 1 MiB and the browser-to-host ceiling is 64 MiB: <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>.
- Mozilla documents the host manifest, extension permission, browser-specific registration, and the fact that the browser does not install/manage the native application: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging>.
- The baseline repository's `core/mcp/native-contract.ts` defines `deepseek-pp-mcp-native` version 1. That contract carries caller-selected `server.command`, `args`, `cwd`, and `env` for generic MCP stdio launching; it is not the semantic authority for the new Coding Runtime. `core/mcp/transports/native.ts` and `packages/shell-host/native/framing.mjs` provide reusable browser transport, request correlation, abort, size-limit, and 4-byte framing compatibility points only.
- The baseline `packages/shell-host/native/contracts.mjs` documents `MAX_OUTPUT_BYTES = 128000`, a 1 MiB native-message limit, and the deliberate no-native-dependency persistent-session design. The baseline `package.json` pins `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` at 0.83.0; this ADR does not upgrade them.

### Local Windows spike

Files are kept in the research workspace under `work/spikes/` and are not production runtime code.

1. Native framing, bounded output, and junction confinement:

   ```powershell
   node work/spikes/native-echo.mjs
   ```

   Observed on 2026-08-31 with Node `v24.15.0`:

   ```text
   echoed.protocol = deepseek-pp-spike
   bounded.code = 0
   bounded.bytesSeen = 10000
   bounded.retainedBytes = 4096
   confinement.symlinkSupported = true
   confinement.escaped = true
   ```

   The result proves the framing and bounded-buffer mechanics, and proves that a lexical/ordinary path check must not be treated as sufficient: resolving a junction can escape the workspace. It does not claim a production-safe confinement implementation.

2. Rust source/type-check and packaging attempt:

   ```powershell
   rustc work/spikes/native-echo.rs --emit=metadata,obj -C opt-level=3 -o work/spikes/native-echo-rs.o
   rustc work/spikes/native-echo.rs -C opt-level=3 -o work/spikes/native-echo-rs.exe
   node --build-sea --help
   ```

   The Rust metadata/object compilation succeeded and produced a Windows object artifact. Linking an executable was blocked by the environment because the installed MSVC toolchain has no `link.exe`; Node SEA was blocked because the installed Node is v24.15.0 and reports `bad option: --build-sea`. No executable or runtime result is claimed from those failed commands. A CI job with Visual Studio Build Tools and a current Node release must provide the release-size/startup comparison before P1 completion.

### Source-backed OS/runtime evidence

- Windows ConPTY is an OS pseudoconsole for hosting character-mode applications and exposes UTF-8 over the pseudoconsole channel: <https://learn.microsoft.com/en-us/windows/console/pseudoconsoles>.
- Rust's `portable-pty` 0.9.0 describes a cross-platform PTY interface, with Unix and Windows implementations and a `PtySystem` abstraction: <https://docs.rs/portable-pty/0.9.0/portable_pty/>.
- Tokio's process API supports async child I/O, `kill_on_drop`, and Unix process groups, but its docs explicitly describe `kill_on_drop` as killing the child handle; the runtime must add a Windows Job Object and verify descendants: <https://docs.rs/tokio/1.53.1/tokio/process/struct.Command.html>.
- Rust `Path::canonicalize` resolves symbolic links using `realpath` on Unix and `CreateFile`/`GetFinalPathNameByHandle` on Windows: <https://doc.rust-lang.org/std/fs/fn.canonicalize.html>. Windows handle-derived final paths are documented here: <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlea>.
- Rust `fs::rename` maps to Unix `rename` and Windows `MoveFileExW`/`SetFileInformationByHandle`, with platform differences that must be covered by integration tests: <https://doc.rust-lang.org/std/fs/fn.rename.html>.
- Node's current single-executable documentation says SEA is active development, supports an embedded script, and lists the tested platform matrix and native-addon caveats: <https://nodejs.org/api/single-executable-applications.html>.

## Proposed architecture and packaging

### Authority and process boundary

1. DeepSeek Web remains the model/reasoning authority.
2. The extension's existing background-owned grant and tool router remain the only authorization/execution entry point. Content scripts and model-declared metadata cannot authorize a native call.
3. The existing TypeScript Native Messaging transport sends the dedicated runtime contract to `com.deepseek_pp.runtime.canary` for P1; the Rust host validates protocol/version/request shape again at its trust boundary. The released `com.deepseek_pp.shell` host is not replaced or registered over.
4. The new runtime contract is not a generic MCP launcher contract. It is a discriminated, versioned operation set. P1 command execution uses host-owned canary command profiles plus the background authorization grant; browser-supplied `server.command`, `args`, `cwd`, and `env` fields do not grant launch authority. General arbitrary-command profiles require a later explicit contract/authorization decision.
5. The Rust host owns only local execution: PTY/process lifecycle, workspace filesystem operations, bounded result collection, structured diagnostics, and host health.
6. Responses carry stable request IDs, exit/cancellation status, byte counts, retained output, and an explicit `overflowed`/`more_available` indicator. The host must never silently discard data or imply that a bounded result is complete.

### Schema sharing

Reuse the existing Native Messaging framing, browser transport, request correlation, size limits, and compatibility fixtures, but do not reuse `deepseek-pp-mcp-native` v1 as the new runtime's semantic authority. Before P1 implementation, introduce one language-neutral, versioned JSON Schema source for `deepseek-pp-local-runtime` v1. The schema is a discriminated operation contract (initially `runtime.status` and a host-owned canary `runtime.exec` profile), not a generic `server.command/args/cwd/env` launcher shape. Generate TypeScript types/validators and Rust serde types/validators from that schema in CI; generated code is not hand-edited. Keep the existing TypeScript contract constants as the transport compatibility facade and add golden JSON fixtures consumed by both sides.

The initial schema must include `protocol`, `version`, `request_id`, `operation`, an authorization/grant reference, a logical workspace identifier, a host-owned command-profile identifier, `timeout_ms`, `max_output_bytes`, and result provenance. It must not expose the generic MCP launch fields as authority. Unknown future versions fail closed; unknown fields follow the existing compatibility policy and are tested explicitly. If a later contract carries command arguments, they are payload bound to a background-issued grant and an allowlisted profile, never authorization evidence by themselves.

### Installer/update model

- Production model: build signed per-platform bundles containing the Rust executable, browser host manifest, and installer metadata. Windows uses the existing per-browser HKCU Native Messaging registration model; macOS/Linux use their documented per-browser manifest locations.
- Install to a versioned application-data directory, stage the new bundle, verify signature/hash and manifest paths, then atomically switch a small current-version pointer. Retain one last-known-good version for rollback. Do not overwrite a running host in place.
- The installer must not require Node, Python, uv, pipx, Git, or an npm global install. External coding tools remain user-selected capabilities, not hidden runtime prerequisites.
- Use compatibility negotiation in the host health response. Extension updates and host updates can roll independently while the official Web session continues if local capability negotiation fails.
- Production release gates: Windows artifacts must be Authenticode-signed; macOS artifacts must be codesigned/notarized. Linux packaging can begin with a signed tar/AppImage-style bundle and an explicit distro support matrix, then add native package formats only when update ownership is clear. These are not P1 blockers unless credentials are already available under current authority.

### Security-critical filesystem policy

For every operation, canonicalize the workspace root once and reject roots that cannot be resolved. Resolve existing target paths and verify containment after symlink/junction/reparse resolution. For writes, do not rely on a check-then-open sequence: use handle-relative or reparse-aware APIs where available, create temporary files in the destination directory, flush as required by the durability policy, and replace via same-volume atomic rename. Document remaining TOCTOU and network-share limitations instead of claiming that `canonicalize` alone is a sandbox.

### Process/PTY policy

The supervisor owns one run ID, deadline, abort signal, and bounded stdout/stderr/PTY ring buffers. On Windows, every process tree is assigned to a Job Object as part of the spawn path and teardown is verified. On POSIX, the leader owns a process group and cancellation signals the group before escalation. Detached descendants are an explicit error/unsupported case, not a silent success. Every timeout/cancel path waits for confirmed cleanup or returns a distinct teardown failure.

## Source reuse and license/NOTICE policy

Prefer designs and behavior contracts over copying implementation. Third-party projects are reference material only; no project becomes a required runtime chain or second router.

- DeepSeek++ is Apache-2.0.
- `xyTom/coding-tools-mcp` is Apache-2.0 and is useful evidence for bounded, workspace-scoped coding tools and explicit paging/permission concerns.
- `deepseek-ai/deepseek-harness` is MIT; `@deepseek-ai/dsh-mcp-client` is evidence for server-qualified MCP naming and stdio configuration, not a dependency for the Local Runtime.
- `oraios/serena` is MIT and is evidence for semantic/LSP-oriented tool boundaries, not a runtime dependency.
- `scmypapa/mcp-bridge` is reference-only until a license file and exact commit are verified; no source will be copied from it before that review.
- `portable-pty`, Tokio, and all Cargo dependencies require a generated license/SBOM inventory. Substantive source reuse requires preserving copyright/license notices and adding relevant text to `NOTICE`/third-party attribution material. Dependency linkage is preferred over copied source.

Record exact commit SHAs for any dependency or copied excerpt in the implementation PR. Run the repository's license/audit checks plus a Cargo license/SBOM check before release.

## Migration and reversal cost

The stable Native Messaging framing, TypeScript transport infrastructure, and existing authorization path keep reversal bounded; the new runtime semantic contract is intentionally separate from the generic MCP v1 contract. If the Rust canary fails, disable only `com.deepseek_pp.runtime.canary` and leave the released `com.deepseek_pp.shell` host untouched; no model/session data migration is needed and DeepSeek Web inference is unaffected. A later migration to the released host name requires a separately scoped full backward-compatibility decision. The main irrecoverable cost is Rust CI/signing/toolchain investment and any Rust-specific implementation. Keeping the runtime schema language-neutral avoids coupling user data or browser code to either implementation.

Do not run both implementations concurrently for one host name. A staged installer may retain a rollback artifact, but the registry/pointer must select exactly one active host.

## Exact P1 minimum build slice

P1 is the smallest end-to-end proof, not the full runtime:

1. A reproducible Windows x64 Rust host artifact with SHA-256 and build provenance, speaking the existing Native Messaging framing but a dedicated `deepseek-pp-local-runtime` v1 contract. Production signing is not required for this slice.
2. An isolated development registration for `com.deepseek_pp.runtime.canary`; the released `com.deepseek_pp.shell` registration and behavior remain unchanged.
3. A two-operation catalog: `runtime.status` and a host-owned canary `runtime.exec` profile. The operation accepts only the background authorization/grant reference, logical workspace identity, profile ID, timeout, and output budget; it streams bounded stdout/stderr and returns truthful exit, timeout, cancellation, and overflow metadata.
3. A PTY-backed canary command on Windows (ConPTY) and the closest available POSIX CI target, plus process-tree teardown tests using a child that spawns a descendant.
4. Workspace read/write canaries: reject a path escaping through a junction/symlink/reparse point, and replace a file atomically within the workspace.
5. The existing TypeScript transport and background authorization path call the host; a real DeepSeek Web dogfood turn observes the authorized result and continues the same session. No direct content-script-to-host path is permitted.
6. A development install/register/status/unregister path can install the canary without a separately installed Node/Python runtime. Produce a hash-stamped, reproducible Windows artifact in CI. Production signing, update, rollback, and cross-platform installer UX remain P4/productization/release gates.

P1 acceptance criteria:

- Native framing and dedicated runtime-schema golden tests pass for valid, malformed, oversized, future-version, timeout, cancellation, and overflow responses; generic `deepseek-pp-mcp-native` v1 launcher fields cannot authorize the new runtime.
- The canary host is registered under `com.deepseek_pp.runtime.canary`; released `com.deepseek_pp.shell` behavior and catalog tests remain unchanged.
- A command cannot run outside the authorized workspace after canonical/reparse resolution; the junction escape test fails closed.
- Cancellation and timeout leave no owned descendant process, or return an explicit teardown failure that blocks success.
- Retained output never exceeds the requested budget; `more_available=true` and byte counts are truthful when data was dropped.
- The TypeScript extension sees the same request ID and continuation semantics through the existing grant/router; no provider, prompt, model, WXT, or `pi-agent-core` contract changes are made.
- `npm run compile`, `npm run prompt:freeze`, affected browser builds, manifest/UTF-8 checks, the focused native-host suite, and `npm run ci:quality` (with unrelated/pre-existing failures separated) are recorded before Architect Review. P1 does not require production signing credentials.

## Unresolved risks and follow-ups

- Current research could not link a Rust executable or run a real ConPTY session because the Windows environment lacks `link.exe`; CI must supply this evidence.
- `portable-pty` provides the PTY abstraction, not the complete DeepSeek++ security policy. Job Object assignment, reparse-point handling, output limits, and teardown verification remain product-owned code.
- Windows network shares, mount points, junctions, POSIX bind mounts, and malicious concurrent renames need an explicit supported/unsupported matrix.
- Binary signing, notarization, Linux distribution format, update channel, and rollback retention policy are later P4/productization/release gates and need release-owner decisions after P1 artifact measurements.
- The existing Node host can remain a rollback artifact only while its limitations are visible; it must not be advertised as equivalent to the Rust PTY/process-tree implementation.

## References

- DeepSeek++ baseline PR: <https://github.com/youling/deepseek-pp/pull/2>
- `coding-tools-mcp`: <https://github.com/xyTom/coding-tools-mcp>
- DeepSeek Harness MCP client: <https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp/mcp-client>
- MCP Bridge reference: <https://github.com/scmypapa/mcp-bridge>
- Serena reference: <https://github.com/oraios/serena>

