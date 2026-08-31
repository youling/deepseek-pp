# Changelog — DeepSeek++ Local Coding Runtime (canary)

All notable changes to the Rust local runtime module (and its TS mirror) are
recorded here following `MAJOR.MINOR.PATCH`.

## [1.0.0] — 2026-08-31

Initial P1 canary proving the end-to-end path
`DeepSeek Web → authorized tool call → Native Messaging → isolated Rust host →
bounded local execution → result → same session continues`.

### Added

- Dedicated `deepseek-pp-local-runtime` v1 operation contract (`contract.rs`),
  mirrored on the TS side (`core/local-runtime/contract.ts`) and in
  `runtime/schema/*.schema.json`, with fail-closed validation at the trust
  boundary.
- Native 4-byte LE framing (`framing.rs`).
- Workspace-root safety (`workspace.rs`): canonicalization, junction/symlink/
  reparse escape detection, atomic same-directory writes.
- Process-tree supervision (`process_tree.rs`): Windows Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and active-process-count verification;
  POSIX process group.
- Bounded PTY execution (`executor.rs`): output budget, timeout, cancel, and a
  fail-closed teardown gate that only claims success when the owned tree is
  confirmed gone.
- Host dispatch (`host.rs`): `runtime.status` + `runtime.exec` with a
  background-grant requirement and host-owned `canary.echo` profile (the
  browser can never supply an arbitrary command).
- Native CLI (`main.rs`): `--version`, `--status`, `--echo-canary`,
  `--spawn-sleeper`.
- TS native-messaging client (`core/local-runtime/native-client.ts`) and the
  `local-runtime` tool provider registration in the production registry
  (`runtime.status` low-risk, `runtime.exec` high-risk) reaching the standard
  runtime authorization path.
- Dev installer (`packages/local-runtime/installer.mjs`) for
  `com.deepseek_pp.runtime.canary`.
- CI jobs `local-runtime-linux` (POSIX PTY) and `local-runtime-windows-msvc`
  (MSVC target artifact, native ConPTY + Job Object teardown evidence).

### Notes

- Local GNU-Windows builds cannot demonstrate clean ConPTY process exit (the
  ADR-001 environment blocker, no `link.exe`/full ConPTY). The gated PTY tests
  therefore run in CI on Linux POSIX and Windows MSVC where real execution is
  demonstrable.
- Grant identity binding during execution is honored at the host boundary
  (non-empty grant marker + host-owned profile); deeper grant→call binding is a
  documented follow-up.
