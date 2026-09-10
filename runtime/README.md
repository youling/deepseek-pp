# DeepSeek++ Local Coding Runtime (canary)

Execution-only native host (`com.deepseek_pp.runtime.canary`) proving the P1 path:
DeepSeek Web → authorized tool call → Native Messaging channel → isolated Rust
host → bounded local execution → result → the same DeepSeek Web session continues.

## Architectural boundary

The official DeepSeek Web session remains the **only** model/reasoning authority.
This binary is an execution subordinate only: it never selects a model, calls a
paid API, owns an agent loop, or becomes a second authorization/router
authority. The host only runs **host-owned** canary profiles (`canary.echo`),
and refuses to execute without a non-empty, background-issued grant reference.

## Layout

- `src/contract.rs` — dedicated `deepseek-pp-local-runtime` v1 operation contract
  (globally versioned, language-neutral). Mirrored by
  `core/local-runtime/contract.ts` and `runtime/schema/*.schema.json`.
- `src/framing.rs` — native 4-byte little-endian framing used by the
  native-messaging channel.
- `src/workspace.rs` — workspace-root safety: canonicalize root, detect
  junction/symlink/reparse escapes after resolution, atomic same-directory
  writes (temp + rename).
- `src/process_tree.rs` — process-tree supervision: Windows Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and active-process-count verification
  before claiming teardown; POSIX process group on supported targets.
- `src/executor.rs` — bounded PTY execution (portable-pty / ConPTY) with output
  budget, timeout, and cancel → teardown gate.
- `src/host.rs` — `runtime.status` / `runtime.exec` dispatch and the grant +
  host-owned-profile authorization gate.
- `src/main.rs` — CLI (`--version`, `--status`, `--echo-canary`,
  `--spawn-sleeper`) and the native loop (read frame → validate → dispatch →
  write frame).
- `schema/` — JSON Schema mirror of the v1 contract.

## Build

The P1 target artifact is built with the MSVC toolchain (CI job
`local-runtime-windows-msvc`):

```sh
cargo build --release --manifest-path runtime/Cargo.toml
```

Local Windows machines without `link.exe` (the ADR-001 blocker) must use the GNU
toolchain:

```sh
cargo +stable-x86_64-pc-windows-gnu build --manifest-path runtime/Cargo.toml
```

## Test

Unit + integration tests run on Linux (POSIX PTY) and Windows MSVC in CI. The
gated `#[ignore]` PTY / Job-Object clean-exit tests run only on platforms where
real PTY execution is demonstrable (`cargo test -- --ignored`); a local
GNU-Windows build cannot demonstrate clean ConPTY process exit (ADR-001
environment blocker), so those tests are skipped by default there.

```sh
cargo test --manifest-path runtime/Cargo.toml
cargo test --manifest-path runtime/Cargo.toml -- --ignored
```

## Install (dev)

Build first, then register the native host:

```sh
node packages/local-runtime/installer.mjs install --browser chrome --extension-id <id>
node packages/local-runtime/installer.mjs status
node packages/local-runtime/installer.mjs uninstall
```

## Versioning

`1.0.0` — initial P1 canary. Contract version is `1` (`deepseek-pp-local-runtime`
v1). See `CHANGELOG.md` for PATCH records.
