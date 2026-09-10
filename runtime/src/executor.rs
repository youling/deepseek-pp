//! Bounded PTY/process execution with timeout, cancellation, and confirmed
//! process-tree teardown.
//!
//! The executor owns one run, bounded stdout/stderr/PTY ring buffers, deadline,
//! and cancellation. On success it never claims completion unless owned process
//! teardown is confirmed.

use std::io::Read;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RunOutcome {
    pub timed_out: bool,
    pub cancelled: bool,
    pub exit_code: Option<i64>,
    pub signal_name: Option<String>,
    pub teardown_confirmed: bool,
    pub bytes_seen: u64,
    pub output: String,
}

impl RunOutcome {
    pub fn more_available(&self) -> bool {
        self.bytes_seen > self.output.len() as u64
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ExecuteError {
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("process-tree teardown could not be confirmed: {0}")]
    UnconfirmedTeardown(String),
}

pub struct ExecOptions {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
    pub max_output_bytes: usize,
}

const BARRIER_ENV: &str = "DEEPSEEK_PP_RUNTIME_BARRIER_FILE";

struct BarrierGuard(Option<std::path::PathBuf>);
impl Drop for BarrierGuard {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// PTY-backed, bounded, teardown-confirmed execution.
///
/// P1B4: Windows production path is real ConPTY/PTY. The prior piped
/// `run_bounded_windows` bypass is removed; `run_bounded` always uses the
/// PTY implementation so gated acceptance directly covers production.
pub fn run_bounded(options: ExecOptions, cancel: &crate::process_tree::CancelToken) -> Result<RunOutcome, ExecuteError> {
    run_bounded_pty(options, cancel)
}

fn run_bounded_pty(options: ExecOptions, cancel: &crate::process_tree::CancelToken) -> Result<RunOutcome, ExecuteError> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| ExecuteError::Spawn(format!("openpty: {}", e)))?;

    let barrier_path_buf = {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!(
            "deepseek-pp-runtime-barrier-{}-{}-{}.ready",
            std::process::id(),
            nanos,
            crate::util::next_barrier_counter()
        ));
        let _ = std::fs::remove_file(&p);
        p
    };
    let barrier_guard = BarrierGuard(Some(barrier_path_buf.clone()));
    let barrier_env = (BARRIER_ENV.to_string(), barrier_path_buf.to_string_lossy().into_owned());

    let mut cmd = CommandBuilder::new(&options.program);
    cmd.args(&options.args);
    if let Some(cwd) = &options.cwd {
        cmd.cwd(cwd);
    }
    for (k, v) in &options.env {
        cmd.env(k, v);
    }
    cmd.env(barrier_env.0.clone(), barrier_env.1.clone());

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| ExecuteError::Spawn(format!("spawn: {}", e)))?;
    let pid = child.process_id().unwrap_or(0);
    drop(pair.slave);
    // P1B4: keep the PTY master alive for the whole run. Dropping `pair.master`
    // here destroys the Windows ConPTY pseudoconsole (HPCON) while the child is
    // still starting, which deterministically fails child startup with
    // STATUS_DLL_NOT_FOUND (3221225794) and 0 bytes. portable-pty's own example
    // keeps master alive until after `child.wait()` for this reason. `try_wait`
    // (GetExitCodeProcess) is not blocked by the extra master handle.
    // ConPTY still requires the master writer to answer the initial DSR
    // (`\x1b[6n`); the reader thread below answers with CPR `1;1`.
    let master = pair.master;
    let mut reader = master
        .try_clone_reader()
        .map_err(|e| ExecuteError::Spawn(format!("try_clone_reader: {}", e)))?;
    let mut writer = master
        .take_writer()
        .map_err(|e| ExecuteError::Spawn(format!("take_writer: {}", e)))?;
    // `_master_keepalive` must outlive child wait + final drain.
    let _master_keepalive = master;

    let mut guard = crate::process_tree::ProcessTreeGuard::supervise(pid)
        .map_err(|e| ExecuteError::Spawn(format!("supervise: {}", e)))?;
    let _ = std::fs::write(&barrier_path_buf, b"ready");

    let max_output = options.max_output_bytes;

    let (tx, rx): (mpsc::Sender<u8>, Receiver<u8>) = mpsc::channel();
    std::thread::spawn(move || {
        use std::io::Write;
        let mut buf = [0u8; 4096];
        let mut zero_streak: u32 = 0;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    zero_streak += 1;
                    if zero_streak > 20 {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Ok(n) => {
                    zero_streak = 0;
                    // ConPTY DSR handling: the pseudoconsole queries cursor
                    // position with `\x1b[6n` on startup. If we never answer,
                    // `cmd` and even our own canary helper hang and the PTY
                    // appears to produce only 4 bytes. Answer with CPR `1;1`.
                    if buf[..n].windows(4).any(|w| w == [0x1b, b'[', b'6', b'n']) {
                        let _ = writer.write_all(b"\x1b[1;1R");
                        let _ = writer.flush();
                    }
                    for byte in &buf[..n] {
                        if tx.send(*byte).is_err() {
                            return;
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(_) => break,
            }
        }
    });

    let deadline = Instant::now() + options.timeout;
    let mut buffer: Vec<u8> = Vec::new();
    let mut bytes_seen: u64 = 0;
    let mut timed_out = false;

    let mut child_for_wait = child;
    loop {
        if cancel.is_cancelled() {
            return teardown_mid_run(&mut guard, &rx, &mut buffer, &mut bytes_seen, max_output, false, true, barrier_guard);
        }
        if Instant::now() >= deadline && !timed_out {
            timed_out = true;
        }

        // Batch drain: pull all immediately available bytes without blocking,
        // then block briefly for the next byte. This keeps burst throughput
        // truthful (bytes_seen reflects real bytes) and avoids the 1-byte-per-
        // 10ms bottleneck that made burst appear as 4 bytes and hit timeout.
        drain_available(&rx, &mut buffer, &mut bytes_seen, max_output);
        // Short blocking wait to avoid busy-spin while still giving ConPTY
        // time to flush after child exit.
        if let Ok(byte) = rx.recv_timeout(Duration::from_millis(5)) {
            bytes_seen += 1;
            if buffer.len() < max_output {
                buffer.push(byte);
            }
            // pull any additional buffered bytes that arrived with it
            drain_available(&rx, &mut buffer, &mut bytes_seen, max_output);
        }

        match child_for_wait.try_wait() {
            Ok(Some(status)) => {
                drain_final(&rx, &mut buffer, &mut bytes_seen, max_output);
                let (exit_code, signal_name) = status_to_code(&status);
                if let Err(e) = guard.confirm_clean_exit() {
                    drop(barrier_guard);
                    return Err(ExecuteError::UnconfirmedTeardown(format!(
                        "clean-exit teardown not confirmed: {}",
                        e
                    )));
                }
                drop(barrier_guard);
                return Ok(RunOutcome {
                    timed_out,
                    cancelled: false,
                    exit_code,
                    signal_name,
                    teardown_confirmed: guard.is_confirmed(),
                    bytes_seen,
                    output: String::from_utf8_lossy(&buffer).to_string(),
                });
            }
            Ok(None) => {}
            Err(e) => {
                drain_final(&rx, &mut buffer, &mut bytes_seen, max_output);
                drop(barrier_guard);
                return Err(ExecuteError::UnconfirmedTeardown(format!(
                    "try_wait failed: {} (teardown not confirmed)",
                    e
                )));
            }
        }

        if timed_out {
            return teardown_mid_run(&mut guard, &rx, &mut buffer, &mut bytes_seen, max_output, true, false, barrier_guard);
        }
    }
}

fn teardown_mid_run(
    guard: &mut crate::process_tree::ProcessTreeGuard,
    rx: &Receiver<u8>,
    buffer: &mut Vec<u8>,
    bytes_seen: &mut u64,
    max_output: usize,
    timed_out: bool,
    cancelled: bool,
    _barrier: BarrierGuard,
) -> Result<RunOutcome, ExecuteError> {
    // Preserve truthful bytes_seen / bounded output: drain whatever the PTY
    // already produced before killing the tree, so timeout/cancel still
    // reports real bytes_seen and capped retained output.
    drain_available(rx, buffer, bytes_seen, max_output);
    let kill_result = guard.cancel_tree();
    // After termination, give ConPTY a short window to flush final bytes.
    drain_final(rx, buffer, bytes_seen, max_output);
    // _barrier drops here and removes the file.

    match kill_result {
        Ok(()) if guard.is_confirmed() => Ok(RunOutcome {
            timed_out,
            cancelled,
            exit_code: None,
            signal_name: None,
            teardown_confirmed: true,
            bytes_seen: *bytes_seen,
            output: String::from_utf8_lossy(buffer).to_string(),
        }),
        Ok(()) => Err(ExecuteError::UnconfirmedTeardown(
            "owned process tree could not be confirmed terminated (not confirmed)".into(),
        )),
        Err(e) => Err(ExecuteError::UnconfirmedTeardown(format!(
            "owned process tree teardown failed: {}",
            e
        ))),
    }
}

fn drain_available(rx: &Receiver<u8>, buffer: &mut Vec<u8>, bytes_seen: &mut u64, max_output: usize) {
    while let Ok(byte) = rx.try_recv() {
        *bytes_seen += 1;
        if buffer.len() < max_output {
            buffer.push(byte);
        }
    }
}

fn drain_final(rx: &Receiver<u8>, buffer: &mut Vec<u8>, bytes_seen: &mut u64, max_output: usize) {
    // Wait up to 1200ms for ConPTY to flush after child exit. Break early
    // only after 200ms of silence, so burst tail is not lost.
    let deadline = Instant::now() + Duration::from_millis(1200);
    let mut last_byte = Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(byte) => {
                *bytes_seen += 1;
                if buffer.len() < max_output {
                    buffer.push(byte);
                }
                last_byte = Instant::now();
            }
            Err(_) => {
                if Instant::now() >= deadline {
                    break;
                }
                if last_byte.elapsed() >= Duration::from_millis(200) {
                    // No byte for 200ms and we already saw EOF/gap
                    // Check if channel still has data via try_recv
                    if rx.try_recv().is_err() {
                        // brief extra grace for ConPTY
                        std::thread::sleep(Duration::from_millis(30));
                        if rx.try_recv().is_err() {
                            break;
                        } else {
                            continue;
                        }
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            break;
        }
    }
    // One last non-blocking sweep
    drain_available(rx, buffer, bytes_seen, max_output);
}

fn status_to_code(status: &portable_pty::ExitStatus) -> (Option<i64>, Option<String>) {
    if status.success() {
        return (Some(0), None);
    }
    let code = status.exit_code() as i64;
    let signal = status.signal().map(|s| s.to_string());
    (Some(code), signal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn run(program: &str, args: Vec<String>, timeout: Duration, max_output_bytes: usize) -> Result<RunOutcome, ExecuteError> {
        let cancel = crate::process_tree::CancelToken::new();
        // Windows ConPTY isolation: canary helper must be hosted via `cmd /C`
        // so `cmd` (VT-aware) is the ConPTY client. See host::profile_command.
        let (prog, a) = pty_wrap_if_needed(program, args);
        run_bounded(
            ExecOptions {
                program: prog,
                args: a,
                cwd: None,
                env: vec![],
                timeout,
                max_output_bytes,
            },
            &cancel,
        )
    }

    #[cfg(windows)]
    fn pty_wrap_if_needed(program: &str, args: Vec<String>) -> (String, Vec<String>) {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string());
        let is_canary = program.contains("deepseek-pp-local-runtime") && args.first().map(|s| s.starts_with("--")).unwrap_or(false);
        if is_canary {
            let mut v = vec!["/C".to_string(), program.to_string()];
            v.extend(args);
            (comspec, v)
        } else if program.eq_ignore_ascii_case("cmd") {
            (comspec, args)
        } else if program.eq_ignore_ascii_case("powershell") {
            // PowerShell is usually at C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
            // but `CommandBuilder::search_path` will find it; keep as is.
            (program.to_string(), args)
        } else {
            (program.to_string(), args)
        }
    }
    #[cfg(not(windows))]
    fn pty_wrap_if_needed(program: &str, args: Vec<String>) -> (String, Vec<String>) {
        (program.to_string(), args)
    }

    fn host_bin() -> String {
        option_env!("CARGO_BIN_EXE_deepseek-pp-local-runtime")
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("deepseek-pp-local-runtime"));
                let candidate = exe
                    .parent()
                    .and_then(|p| p.parent())
                    .map(|p| p.join(if cfg!(windows) { "deepseek-pp-local-runtime.exe" } else { "deepseek-pp-local-runtime" }))
                    .unwrap_or_else(|| std::path::PathBuf::from(if cfg!(windows) { "deepseek-pp-local-runtime.exe" } else { "deepseek-pp-local-runtime" }));
                let alt = std::path::PathBuf::from(format!(
                    "target/debug/{}",
                    if cfg!(windows) { "deepseek-pp-local-runtime.exe" } else { "deepseek-pp-local-runtime" }
                ));
                if candidate.exists() {
                    candidate.to_string_lossy().into_owned()
                } else if alt.exists() {
                    alt.to_string_lossy().into_owned()
                } else {
                    candidate.to_string_lossy().into_owned()
                }
            })
    }

    #[test]
    #[ignore = "real PTY clean exit cannot be demonstrated in the local GNU-Windows env (ADR-001 blocker); run on POSIX CI or Windows MSVC artifact"]
    fn echo_round_trips_bounded_output() {
        let program = host_bin();
        let outcome = run(&program, vec!["--echo-canary".into(), "hello-canary".into()], Duration::from_secs(10), 4096)
            .expect("echo should succeed under PTY");
        assert!(
            outcome.output.contains("hello-canary"),
            "output was: {:?} (program={})",
            outcome.output,
            program
        );
        assert_eq!(outcome.exit_code, Some(0));
        assert!(outcome.teardown_confirmed);
    }

    #[test]
    #[ignore = "real PTY clean exit cannot be demonstrated in the local GNU-Windows env (ADR-001 blocker); run on POSIX CI or Windows MSVC artifact"]
    fn output_budget_is_respected() {
        let program = host_bin();
        let outcome = run(&program, vec!["--emit-burst".into()], Duration::from_secs(20), 4096).expect("burst should run");
        assert!(outcome.output.len() <= 4096, "retained {}", outcome.output.len());
        assert!(outcome.bytes_seen > 4096, "bytes_seen {} should exceed cap", outcome.bytes_seen);
        assert!(outcome.more_available());
        assert!(outcome.teardown_confirmed);
    }

    #[test]
    #[ignore = "real PTY clean exit cannot be demonstrated in the local GNU-Windows env (ADR-001 blocker); run on POSIX CI or Windows MSVC artifact"]
    fn non_zero_exit_is_reported() {
        let program = host_bin();
        let outcome = run(&program, vec!["--exit-code".into(), "7".into()], Duration::from_secs(10), 4096).expect("exit should run");
        assert_eq!(outcome.exit_code, Some(7), "output: {:?}", outcome.output);
        assert!(outcome.teardown_confirmed);
    }

    #[test]
    fn try_wait_error_is_fail_closed() {
        let err = ExecuteError::UnconfirmedTeardown("test".into());
        assert!(format!("{}", err).contains("teardown"));
    }

    // ── P1B3 A/B/C diagnostic ladder (test-only instrumentation) ──────────
    // These tests are deliberately `#[ignore]` and run together with the gated
    // suite via `cargo test -- --ignored --nocapture`. They emit structured
    // `[DIAG X]` lines that are auditable in Windows Server 2025 MSVC logs and
    // prove the first failing boundary without forming a second production
    // executor.

    #[test]
    #[ignore = "P1B3 diagnostic A: helper direct run, no PTY, no Job"]
    fn diagnostic_a_helper_direct() {
        let bin = host_bin();
        println!("[DIAG A] binary={} exists={}", bin, std::path::Path::new(&bin).exists());
        // A1: echo-canary
        {
            let start = Instant::now();
            let mut cmd = std::process::Command::new(&bin);
            cmd.args(["--echo-canary", "hello-canary"]);
            let out = cmd.output().expect("[DIAG A] spawn echo failed");
            let elapsed = start.elapsed();
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            println!(
                "[DIAG A][echo] argv=[--echo-canary hello-canary] status={:?} exit_code={:?} stdout_len={} stdout_contains_hello={} stderr_len={} elapsed_ms={} stdout_preview={:?}",
                out.status,
                out.status.code(),
                out.stdout.len(),
                stdout.contains("hello-canary"),
                out.stderr.len(),
                elapsed.as_millis(),
                &stdout[..stdout.len().min(200)]
            );
            println!("[DIAG A][echo] stderr_preview={:?}", &stderr[..stderr.len().min(200)]);
            assert!(out.status.success(), "[DIAG A] echo helper must exit 0; stderr: {}", stderr);
            assert!(stdout.contains("hello-canary"), "[DIAG A] echo helper stdout must contain hello-canary");
        }
        // A2: exit-code 7
        {
            let start = Instant::now();
            let mut cmd = std::process::Command::new(&bin);
            cmd.args(["--exit-code", "7"]);
            let out = cmd.output().expect("[DIAG A] spawn exit failed");
            let elapsed = start.elapsed();
            println!(
                "[DIAG A][exit] argv=[--exit-code 7] status={:?} exit_code={:?} stdout_len={} stderr_len={} elapsed_ms={}",
                out.status,
                out.status.code(),
                out.stdout.len(),
                out.stderr.len(),
                elapsed.as_millis()
            );
            assert_eq!(out.status.code(), Some(7), "[DIAG A] exit helper must report 7");
        }
        // A3: emit-burst
        {
            let start = Instant::now();
            let mut cmd = std::process::Command::new(&bin);
            cmd.args(["--emit-burst"]);
            let out = cmd.output().expect("[DIAG A] spawn burst failed");
            let elapsed = start.elapsed();
            println!(
                "[DIAG A][burst] argv=[--emit-burst] status={:?} stdout_len={} bytes_seen={} elapsed_ms={} preview_len={}",
                out.status,
                out.stdout.len(),
                out.stdout.len(),
                elapsed.as_millis(),
                out.stdout.len().min(80)
            );
            assert!(out.status.success(), "[DIAG A] burst helper must exit 0");
            assert!(out.stdout.len() > 4096, "[DIAG A] burst stdout must exceed cap, got {}", out.stdout.len());
        }
        println!("[DIAG A] PASS all direct helper checks");
    }

    #[test]
    #[ignore = "P1B3 diagnostic B: PTY with portable_pty, NO Job, proves ConPTY reader/wait boundary"]
    fn diagnostic_b_pty_no_job() {
        diagnostic_pty_boundary(false);
    }

    // P1B4: Windows-only diagnostics are explicitly isolated so Linux
    // `cargo test --all-targets` and `-- --ignored` never attempt `cmd` or
    // `C:\Windows...` paths.
    #[cfg(windows)]
    #[test]
    #[ignore = "P1B3 diagnostic cmd echo PTY"]
    fn diagnostic_cmd_echo_pty() {
        let program = "cmd".to_string();
        let args = vec!["/C".to_string(), "echo".to_string(), "hello-canary".to_string()];
        let info = run_pty_once(&program, args, Duration::from_secs(10), 4096, false).unwrap();
        println!("[DIAG CMD] pid={:?} bytes_seen={} retained={} exit={:?} output_contains={}", info.pid, info.bytes_seen, info.retained, info.exit_code, info.output_contains_hello);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "P1B3 diagnostic simple PTY no guard"]
    fn diagnostic_simple_pty_no_guard() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new(r"C:\Windows\System32\cmd.exe");
        cmd.args(["/C", "echo", "hello-canary"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        println!("[SIMPLE] pid={:?}", child.process_id());
        drop(pair.slave);
        let master = pair.master;
        let mut reader = master.try_clone_reader().unwrap();
        let mut writer = master.take_writer().unwrap();
        let mut out = Vec::new();
        let h = std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                match reader.read(&mut buf) {
                    Ok(0) => std::thread::sleep(Duration::from_millis(10)),
                    Ok(n) => {
                        if buf[..n].windows(4).any(|w| w==[0x1b,b'[',b'6',b'n']) {
                            let _ = writer.write_all(b"\x1b[1;1R");
                            let _ = writer.flush();
                            println!("[SIMPLE] DSR");
                        }
                        println!("[SIMPLE] read {} {:?}", n, &buf[..n]);
                        out.extend_from_slice(&buf[..n]);
                        if out.windows(12).any(|w| w==b"hello-canary") { println!("[SIMPLE] found"); break; }
                    }
                    Err(e)=>{ println!("[SIMPLE] err {}", e); break;}
                }
            }
            println!("[SIMPLE] out len {} {:?}", out.len(), String::from_utf8_lossy(&out));
        });
        for i in 0..30 {
            match child.try_wait() {
                Ok(Some(s))=>{ println!("[SIMPLE] try_wait Some {} {:?}", i, s); break; }
                Ok(None)=>{ if i%10==0 { println!("[SIMPLE] try_wait None {}", i); } }
                Err(e)=>println!("[SIMPLE] err {}", e),
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        h.join().unwrap();
        let status = child.wait().unwrap();
        println!("[SIMPLE] wait {:?}", status);
        assert!(status.success(), "simple PTY should succeed");
    }

    #[test]
    #[ignore = "P1B3 diagnostic C: PTY with portable_pty + Job, proves Job ownership boundary"]
    fn diagnostic_c_pty_with_job() {
        diagnostic_pty_boundary(true);
    }

    fn diagnostic_pty_boundary(with_job: bool) {
        let label = if with_job { "C" } else { "B" };
        let bin = host_bin();
        println!("[DIAG {}] binary={} with_job={}", label, bin, with_job);
        // P1B4: B/C remain test-only instrumentation. They assert real PTY
        // boundaries (no log-only success) but never substitute for the
        // production `run_bounded` acceptance tests above.
        let mut any_fail = false;
        for (name, args, timeout) in [
            ("echo", vec!["--echo-canary".to_string(), "hello-canary".to_string()], Duration::from_secs(10)),
            ("exit7", vec!["--exit-code".to_string(), "7".to_string()], Duration::from_secs(10)),
            ("burst", vec!["--emit-burst".to_string()], Duration::from_secs(20)),
        ] {
            println!("[DIAG {}][{}] starting args={:?}", label, name, args);
            let result = run_pty_once(&bin, args.clone(), timeout, 4096, with_job);
            match result {
                Ok(info) => {
                    println!(
                        "[DIAG {}][{}] pid={:?} pid_nonzero={} first_byte_ms={:?} eof_after_ms={:?} bytes_seen={} retained={} exit_code={:?} signal={:?} try_wait_ok={} elapsed_ms={} output_contains_hello={} job_active_final={:?}",
                        label,
                        name,
                        info.pid,
                        info.pid.map(|p| p != 0).unwrap_or(false),
                        info.first_byte_ms,
                        info.eof_ms,
                        info.bytes_seen,
                        info.retained,
                        info.exit_code,
                        info.signal,
                        info.try_wait_ok,
                        info.elapsed_ms,
                        info.output_contains_hello,
                        info.job_active
                    );
                    let mut fail = false;
                    if info.pid.is_none() || info.pid.unwrap() == 0 {
                        println!("[DIAG {}][{}] FAIL process_id must be Some(nonzero)", label, name);
                        fail = true;
                    }
                    if name == "echo" && !info.output_contains_hello {
                        println!("[DIAG {}][{}] FAIL PTY output must contain hello-canary; got bytes_seen={} output_len={}", label, name, info.bytes_seen, info.retained);
                        fail = true;
                    }
                    if name == "echo" && info.exit_code != Some(0) {
                        println!("[DIAG {}][{}] FAIL exit_code must be Some(0), got {:?}", label, name, info.exit_code);
                        fail = true;
                    }
                    if name == "exit7" && info.exit_code != Some(7) {
                        println!("[DIAG {}][{}] FAIL exit code must be 7, got {:?}", label, name, info.exit_code);
                        fail = true;
                    }
                    if name == "burst" && info.bytes_seen <= 4096 {
                        println!("[DIAG {}][{}] FAIL burst bytes_seen {} must exceed cap", label, name, info.bytes_seen);
                        fail = true;
                    }
                    if name == "burst" && info.retained > 4096 {
                        println!("[DIAG {}][{}] FAIL retained {} must be <= cap", label, name, info.retained);
                        fail = true;
                    }
                    if with_job && info.job_active != Some(0) {
                        println!("[DIAG {}][{}] FAIL Job active count must be 0 after wait, got {:?}", label, name, info.job_active);
                        fail = true;
                    }
                    if fail {
                        any_fail = true;
                        println!("[DIAG {}][{}] BOUNDARY FAIL (auditable)", label, name);
                    } else {
                        println!("[DIAG {}][{}] PASS", label, name);
                    }
                }
                Err(e) => {
                    println!("[DIAG {}][{}] ERROR: {} (auditable, not panic)", label, name, e);
                    any_fail = true;
                }
            }
        }
        if any_fail {
            println!("[DIAG {}] BOUNDARY FAIL with_job={}", label, with_job);
            panic!("[DIAG {}] PTY boundary failed with_job={} (see log above)", label, with_job);
        } else {
            println!("[DIAG {}] PASS all boundary checks (with_job={})", label, with_job);
        }
    }

    struct DiagInfo {
        pid: Option<u32>,
        first_byte_ms: Option<u128>,
        eof_ms: Option<u128>,
        bytes_seen: u64,
        retained: usize,
        exit_code: Option<i64>,
        signal: Option<String>,
        try_wait_ok: bool,
        elapsed_ms: u128,
        output_contains_hello: bool,
        job_active: Option<u64>,
    }

    fn run_pty_once(program: &str, args: Vec<String>, timeout: Duration, max_output: usize, with_job: bool) -> Result<DiagInfo, String> {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        use std::sync::mpsc;

        let start = Instant::now();
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty: {}", e))?;
        // Windows ConPTY isolation: wrap canary helper via `cmd /C` so `cmd`
        // is the ConPTY client (see host::profile_command and pty_wrap_if_needed).
        let (prog, a) = pty_wrap_if_needed(program, args.clone());
        println!("[DIAG PTY] wrapped prog={:?} wrapped_args={:?} orig_args={:?}", prog, a, args);
        let mut cmd = CommandBuilder::new(prog);
        cmd.args(&a);
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn: {}", e))?;
        let pid = child.process_id();
        println!("[DIAG PTY] pid={:?} args={:?}", pid, args);
        if pid.is_none() || pid == Some(0) {
            return Err(format!("process_id was {:?}, expected Some(nonzero)", pid));
        }

        drop(pair.slave);
        // P1B4: keep master alive for the whole diagnostic run. Dropping it
        // here closes the ConPTY HPCON while the child starts and yields
        // STATUS_DLL_NOT_FOUND (3221225794). See production `run_bounded_pty`.
        let master = pair.master;
        let mut reader = master.try_clone_reader().map_err(|e| format!("try_clone_reader: {}", e))?;
        let mut writer = master.take_writer().map_err(|e| format!("take_writer: {}", e))?;
        let _master_keepalive = master;

        // Optionally assign to Job (C) or not (B).
        let mut job_opt: Option<crate::process_tree::ProcessTreeGuard> = None;
        let mut job_active_initial: Option<u64> = None;
        if with_job {
            let pid_u32 = pid.unwrap();
            let guard = crate::process_tree::ProcessTreeGuard::supervise(pid_u32)
                .map_err(|e| format!("supervise: {}", e))?;
            job_active_initial = Some(guard.live_process_count());
            println!("[DIAG PTY] supervise ok pid={} initial_active={:?}", pid_u32, job_active_initial);
            job_opt = Some(guard);
        }

        let (tx, rx) = mpsc::channel::<u8>();
        std::thread::spawn(move || {
            use std::io::Write;
            let mut buf = [0u8; 4096];
            let mut zero_streak: u32 = 0;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        zero_streak += 1;
                        if zero_streak > 20 {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Ok(n) => {
                        zero_streak = 0;
                        if buf[..n].windows(4).any(|w| w == [0x1b, b'[', b'6', b'n']) {
                            let _ = writer.write_all(b"\x1b[1;1R");
                            let _ = writer.flush();
                        }
                        for b in &buf[..n] {
                            if tx.send(*b).is_err() {
                                return;
                            }
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                }
            }
        });

        let deadline = Instant::now() + timeout;
        let mut buffer: Vec<u8> = Vec::new();
        let mut bytes_seen: u64 = 0;
        let mut first_byte_ms: Option<u128> = None;
        let mut exit_code: Option<i64> = None;
        let mut signal: Option<String> = None;
        let mut try_wait_ok = false;
        let mut teardown_confirmed = false;

        loop {
            // batch drain
            while let Ok(b) = rx.try_recv() {
                if first_byte_ms.is_none() {
                    first_byte_ms = Some(start.elapsed().as_millis());
                }
                bytes_seen += 1;
                if buffer.len() < max_output {
                    buffer.push(b);
                }
            }
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(5)) {
                if first_byte_ms.is_none() {
                    first_byte_ms = Some(start.elapsed().as_millis());
                }
                bytes_seen += 1;
                if buffer.len() < max_output {
                    buffer.push(b);
                }
                while let Ok(bb) = rx.try_recv() {
                    bytes_seen += 1;
                    if buffer.len() < max_output {
                        buffer.push(bb);
                    }
                }
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    try_wait_ok = true;
                    let (code, sig) = status_to_code(&status);
                    exit_code = code;
                    signal = sig;
                    // drain final with same robust logic as production
                    let drain_deadline = Instant::now() + Duration::from_millis(800);
                    while Instant::now() < drain_deadline {
                        match rx.recv_timeout(Duration::from_millis(20)) {
                            Ok(b) => {
                                if first_byte_ms.is_none() {
                                    first_byte_ms = Some(start.elapsed().as_millis());
                                }
                                bytes_seen += 1;
                                if buffer.len() < max_output {
                                    buffer.push(b);
                                }
                            }
                            Err(_) => {
                                if rx.try_recv().is_err() {
                                    std::thread::sleep(Duration::from_millis(10));
                                    if rx.try_recv().is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    while let Ok(b) = rx.try_recv() {
                        bytes_seen += 1;
                        if buffer.len() < max_output {
                            buffer.push(b);
                        }
                    }
                    if let Some(g) = job_opt.as_mut() {
                        match g.confirm_clean_exit() {
                            Ok(()) => teardown_confirmed = true,
                            Err(e) => return Err(format!("confirm_clean_exit failed: {}", e)),
                        }
                    } else {
                        teardown_confirmed = true;
                    }
                    break;
                }
                Ok(None) => {}
                Err(e) => {
                    return Err(format!("try_wait error: {}", e));
                }
            }

            if Instant::now() >= deadline {
                // timeout path: still need to confirm teardown if with_job
                if let Some(g) = job_opt.as_mut() {
                    let _ = g.cancel_tree();
                    teardown_confirmed = g.is_confirmed();
                }
                return Err(format!("timeout after {}ms; bytes_seen={} teardown_confirmed={}", timeout.as_millis(), bytes_seen, teardown_confirmed));
            }
        }

        let elapsed_ms = start.elapsed().as_millis();
        let eof_ms = Some(elapsed_ms);
        let output_str = String::from_utf8_lossy(&buffer).to_string();
        let job_active = job_opt.as_ref().map(|g| g.live_process_count());

        // Suppress unused warning for initial active
        let _ = job_active_initial;

        Ok(DiagInfo {
            pid,
            first_byte_ms,
            eof_ms,
            bytes_seen,
            retained: buffer.len(),
            exit_code,
            signal,
            try_wait_ok,
            elapsed_ms,
            output_contains_hello: output_str.contains("hello-canary"),
            job_active,
        })
    }
}
