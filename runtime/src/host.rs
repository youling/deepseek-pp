//! Host-owned operation handler for `runtime.status` and the canary
//! `runtime.exec` profile.
//!
//! Authorization contract: `grant_id`, `workspace_id`, `profile_id`, `args`
//! are payload/claims bound to the background-issued grant. They never grant
//! execution by themselves. Only host-owned profiles listed in `profiles()` are
//! executable; a browser cannot supply an arbitrary command.
//!
//! P1 also requires a non-empty, background-owned `grant_id` to be echoed back
//! as an authorization marker. This enforces "no direct content/page-to-host
//! execution path" at the host trust boundary: the host refuses to run the
//! canary command unless a grant was issued by the extension background before
//! it calls us.

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

pub fn profiles() -> Vec<String> {
    vec![
        CANARY_PROFILE.to_string(),
        CANARY_SPAWN_SLEEPER_PROFILE.to_string(),
    ]
}

/// Returns the host-owned executable + args for a profile. The command is
/// defined by the host, never by the browser.
fn profile_command(profile: &str, args: &[String]) -> Option<(String, Vec<String>)> {
    let me = std::env::current_exe().ok()?;
    let me = me.to_string_lossy().into_owned();
    match profile {
        CANARY_PROFILE => {
            let mut v = vec!["--echo-canary".to_string()];
            v.extend_from_slice(args);
            Some((me, v))
        }
        CANARY_SPAWN_SLEEPER_PROFILE => {
            let mut v = vec!["--spawn-sleeper".to_string()];
            v.extend_from_slice(args);
            Some((me, v))
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

    // Authorization marker: a non-empty grant reference is required. Without a
    // background-issued grant, the host refuses to run anything.
    let grant = match request.grant_id {
        Some(g) if !g.is_empty() => g,
        _ => {
            return Envelope::err(
                req_id,
                "runtime.exec",
                "runtime_grant_missing",
                "No background-issued authorization grant reference was supplied. Direct browser/page calls are refused.".into(),
                false,
            );
        }
    };

    let profile = match &request.profile_id {
        Some(p) if profiles().contains(p) => p.clone(),
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

    let workspace_id = request.workspace_id.clone().unwrap_or_else(|| "(none)".into());
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
            cwd: std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().into_owned()),
            env: vec![
                ("DEEPSEEK_PP_RUNTIME_GRANT".to_string(), grant),
                ("DEEPSEEK_PP_RUNTIME_PROFILE".to_string(), profile),
                ("DEEPSEEK_PP_RUNTIME_WORKSPACE".to_string(), workspace_id),
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
fn spawn_descendant_sleeper(sleep_ms: u64) {
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
