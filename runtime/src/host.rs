//! Host-owned operation handler for `runtime.status` and the canary
//! `runtime.exec` profile (P1C2 final Web-first canary closure).
//!
//! Authorization contract (P1C2): the extension background authorization path
//! is the sole model-tool authorization authority. `grant_id` is a
//! background-owned internal correlation/audit ticket only — model/page
//! invisible — and never grants execution by itself. The host never treats a
//! non-empty string as authorization evidence and does not operate a second
//! permission/grant engine.
//!
//! Only host-owned production profiles listed in `profiles()` are executable
//! (production: `canary.echo` only); a browser cannot supply an arbitrary
//! command. `canary.spawn_sleeper` and the `--exit-code`/`--emit-burst`
//! helpers are test-internal only and never model-selectable production
//! profiles (gated by `DEEPSEEK_PP_RUNTIME_ALLOW_TEST_PROFILES=1`).
//!
//! `workspace_id`, when present, is a background-owned internal binding hint
//! (receiver-owned), never a model authority claim. The host still
//! realpath/canonicalizes it, verifies existence/directory, and fails closed;
//! a browser/model-supplied path is never a trust fact.

use std::time::Duration;

use portable_pty::{native_pty_system, PtySize};

use crate::contract::{
    Envelope, ExecResult, ExitStatusInfo, HostInfo, Operation, RuntimeRequest, CANARY_PROFILE,
    CANARY_SPAWN_SLEEPER_PROFILE,
};

#[derive(Debug, Clone)]
pub struct HostSpec {
    pub platform: String,
    pub pty_supported: bool,
}

pub fn host_spec() -> HostSpec {
    let platform = if cfg!(windows) {
        if cfg!(target_arch = "x86_64") {
            "windows-x64"
        } else {
            "windows"
        }
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "unknown"
    }
    .to_string();

    // Probe PTY support (creates a real pseudo console / PTY pair).
    let pty_supported = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .is_ok();

    HostSpec { platform, pty_supported }
}

/// Production advertisement: only `canary.echo` is model-selectable.
/// `canary.spawn_sleeper` remains a test-internal helper (real PTY/Job Object
/// teardown coverage) and is never advertised to the model surface.
pub fn profiles() -> Vec<String> {
    vec![CANARY_PROFILE.to_string()]
}

/// Test-internal profile gate (P1B real ConPTY/Job Object coverage without
/// widening the production model surface).
fn test_profiles_allowed() -> bool {
    std::env::var("DEEPSEEK_PP_RUNTIME_ALLOW_TEST_PROFILES")
        .map(|v| v == "1")
        .unwrap_or(false)
}

fn is_executable_profile(profile: &str) -> bool {
    if profile == CANARY_PROFILE {
        return true;
    }
    if profile == CANARY_SPAWN_SLEEPER_PROFILE && test_profiles_allowed() {
        return true;
    }
    false
}

/// Returns the host-owned executable + args for a profile. The command is
/// defined by the host, never by the browser.
///
/// Windows ConPTY boundary isolation (P1B3): the canary helper is a plain
/// Rust binary that does not handle ConPTY's initial DSR (`\x1b[6n`) and
/// hangs when spawned directly as a ConPTY client (observed as 4-byte
/// output + timeout, CI 34456939702). Wrapping the helper via `cmd /C`
/// makes `cmd.exe` the ConPTY client (which correctly answers DSR) and the
/// helper runs as a normal child of `cmd`. The helper then inherits the
/// Job Object membership from `cmd`, so real process-tree ownership is
/// retained. We use the absolute `C:\Windows\System32\cmd.exe` path to
/// avoid `CommandBuilder::search_path` issues inside `cargo test` where
/// `PATH` may be polluted.
fn profile_command(profile: &str, args: &[String]) -> Option<(String, Vec<String>)> {
    let me = std::env::current_exe().ok()?;
    let me = me.to_string_lossy().into_owned();
    let cmd = if cfg!(windows) {
        std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string())
    } else {
        "cmd".to_string()
    };
    match profile {
        CANARY_PROFILE => {
            if cfg!(windows) {
                let mut v = vec!["/C".to_string(), me, "--echo-canary".to_string()];
                v.extend_from_slice(args);
                Some((cmd, v))
            } else {
                let mut v = vec!["--echo-canary".to_string()];
                v.extend_from_slice(args);
                Some((me, v))
            }
        }
        CANARY_SPAWN_SLEEPER_PROFILE => {
            if cfg!(windows) {
                let mut v = vec!["/C".to_string(), me, "--spawn-sleeper".to_string()];
                v.extend_from_slice(args);
                Some((cmd, v))
            } else {
                let mut v = vec!["--spawn-sleeper".to_string()];
                v.extend_from_slice(args);
                Some((me, v))
            }
        }
        _ => None,
    }
}

pub fn handle_status(request: RuntimeRequest) -> Envelope {
    let spec = host_spec();
    let host = HostInfo {
        host_id: crate::contract::HOST_ID.to_string(),
        runtime_version: crate::contract::RUNTIME_VERSION.to_string(),
        contract_version: crate::contract::CONTRACT_VERSION,
        platform: spec.platform,
        pty_supported: spec.pty_supported,
        profiles: profiles(),
    };
    Envelope::ok_status(request.request_id, host)
}

pub fn handle_exec(request: RuntimeRequest) -> Envelope {
    let req_id = request.request_id.clone();

    // P1C2: grant_id is correlation/audit metadata only, never authorization
    // evidence. Execution authority lives solely in the extension background
    // authorization path (capabilityScope). The host does not gate on
    // non-empty strings and does not run a second grant engine.
    let grant_correlation = request.grant_id.clone().unwrap_or_default();

    let profile = match &request.profile_id {
        Some(p) if is_executable_profile(p) => p.clone(),
        _ => {
            return Envelope::err(
                req_id,
                "runtime.exec",
                "runtime_profile_unknown",
                "Unknown or un-authorized host execution profile.".into(),
                false,
            );
        }
    };

    // P1C2 receiver-owned workspace binding: the wire's workspace_id, when
    // present, is a background-owned internal hint only. The host still
    // realpath/canonicalizes, verifies existence/directory, and fails closed.
    // Model/page payloads never establish workspace authority.
    let workspace_hint = request.workspace_id.clone();
    let workspace_log = workspace_hint.clone().unwrap_or_else(|| "(none)".into());
    let bound_root = match crate::workspace::resolve_for_exec(workspace_hint.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            return Envelope::err(
                req_id,
                "runtime.exec",
                "runtime_workspace_unavailable",
                format!("host workspace unavailable: {}", e),
                true,
            );
        }
    };
    let cwd_str = bound_root.to_string_lossy().into_owned();
    let timeout = request.timeout_ms.unwrap_or(10_000);
    let budget = request.max_output_bytes.unwrap_or(4096);

    let (program, args) = match profile_command(&profile, &request.args) {
        Some(pair) => pair,
        None => {
            return Envelope::err(
                req_id,
                "runtime.exec",
                "runtime_profile_unknown",
                "Host cannot resolve the requested execution profile.".into(),
                false,
            );
        }
    };

    let cancel = crate::process_tree::CancelToken::new();
    let result = crate::executor::run_bounded(
        crate::executor::ExecOptions {
            program,
            args,
            cwd: Some(cwd_str),
            env: vec![
                (
                    "DEEPSEEK_PP_RUNTIME_GRANT".to_string(),
                    grant_correlation,
                ),
                ("DEEPSEEK_PP_RUNTIME_PROFILE".to_string(), profile),
                ("DEEPSEEK_PP_RUNTIME_WORKSPACE".to_string(), workspace_log),
            ],
            timeout: Duration::from_millis(timeout),
            max_output_bytes: budget,
        },
        &cancel,
    );

    let run_id = crate::util::new_run_id();
    match result {
        Ok(outcome) => {
            let output = outcome.output.clone();
            let bytes_seen = outcome.bytes_seen;
            let bytes_retained = output.len();
            let more_available = outcome.more_available();
            Envelope::ok_exec(
                req_id,
                ExecResult {
                    run_id,
                    exit_status: ExitStatusInfo {
                        code: outcome.exit_code,
                        signal: outcome.signal_name,
                    },
                    timed_out: outcome.timed_out,
                    cancelled: outcome.cancelled,
                    teardown_confirmed: outcome.teardown_confirmed,
                    bytes_seen,
                    bytes_retained,
                    more_available,
                    output,
                },
            )
        }
        Err(e) => Envelope::err(
            req_id,
            "runtime.exec",
            "runtime_exec_teardown_unconfirmed",
            format!("{}", e),
            true,
        ),
    }
}

pub fn dispatch(request: &RuntimeRequest) -> Envelope {
    match request.operation {
        Operation::RuntimeStatus => handle_status(request.clone()),
        Operation::RuntimeExec => handle_exec(request.clone()),
    }
}

/// The canary `--echo-canary`/`--spawn-sleeper` entry used by the host's own
/// process when it runs a profile. These are host-owned commands, not generic
/// launch authority.
pub fn canary_main(args: &[String]) -> i32 {
    if let Some(pos) = args.iter().position(|a| a == "--echo-canary") {
        let rest = &args[pos + 1..];
        println!("deepseek-pp canary echo: {}", rest.join(" "));
        return 0;
    }
    if let Some(pos) = args.iter().position(|a| a == "--exit-code") {
        let code: i32 = args.get(pos + 1).and_then(|v| v.parse().ok()).unwrap_or(1);
        std::process::exit(code);
    }
    if args.iter().any(|a| a == "--emit-burst") {
        for _ in 0..2000 {
            println!("0123456789012345678901234567890123456789");
        }
        return 0;
    }
    if let Some(pos) = args.iter().position(|a| a == "--spawn-sleeper") {
        let sleep_ms: u64 = args.get(pos + 1).and_then(|v| v.parse().ok()).unwrap_or(5000);
        spawn_descendant_sleeper(sleep_ms);
        return 0;
    }
    eprintln!("canary_main: unknown mode");
    1
}

/// Leader (in the PTY) spawns a real descendant process so the Job Object /
/// process-group teardown test has a true process tree. The descendant is
/// created by the leader AFTER the leader is already assigned to the Job
/// Object, so inheritance places it in the same job.
///
/// The executor's per-run barrier (`DEEPSEEK_PP_RUNTIME_BARRIER_FILE`) is used
/// to close the spawn→assign escape race: after `portable-pty` forks the
/// leader and before the descendant is created, the leader waits until the
/// host confirms supervision succeeded and touches the barrier file.
fn spawn_descendant_sleeper(sleep_ms: u64) {
    const BARRIER_ENV: &str = "DEEPSEEK_PP_RUNTIME_BARRIER_FILE";
    if let Ok(barrier) = std::env::var(BARRIER_ENV) {
        let path = std::path::PathBuf::from(barrier);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if path.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    let descriptor = descendant_cmd();
    if let Some(mut cmd) = descriptor {
        let _ = cmd.spawn();
    }
    std::thread::sleep(Duration::from_millis(sleep_ms.max(100)));
}

#[cfg(windows)]
fn descendant_cmd() -> Option<std::process::Command> {
    let mut c = std::process::Command::new("cmd");
    c.args(["/C", "ping", "-n", "30", "127.0.0.1 > nul"]);
    Some(c)
}

// POSIX/other: a long-running descendant (sleep).
#[cfg(not(windows))]
fn descendant_cmd() -> Option<std::process::Command> {
    let mut c = std::process::Command::new("sleep");
    c.arg("30");
    Some(c)
}
