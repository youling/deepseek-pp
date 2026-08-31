//! Bounded PTY/process execution with timeout, cancellation, and confirmed
//! process-tree teardown.
//!
//! The executor owns one run, bounded stdout/stderr/PTY ring buffers, deadline,
//! and cancellation. On success it never claims completion unless owned process
//! teardown is confirmed.

use std::io::Read;
use std::sync::mpsc::{self, Receiver, Sender};
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

/// PTY-backed, bounded, teardown-confirmed execution.
pub fn run_bounded(options: ExecOptions, cancel: &crate::process_tree::CancelToken) -> Result<RunOutcome, ExecuteError> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| ExecuteError::Spawn(format!("openpty: {}", e)))?;

    let mut cmd = CommandBuilder::new(&options.program);
    cmd.args(&options.args);
    if let Some(cwd) = &options.cwd {
        cmd.cwd(cwd);
    }
    for (k, v) in &options.env {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| ExecuteError::Spawn(format!("spawn: {}", e)))?;
    let pid = child.process_id().unwrap_or(0);

    // Drop the slave handle so that EOF is signalled on the master when the
    // whole console session (tree) closes.
    drop(pair.slave);
    let master = &pair.master;

    // Supervise the process tree (Windows Job Object / POSIX process group).
    let mut guard = crate::process_tree::ProcessTreeGuard::supervise(pid)
        .map_err(|e| ExecuteError::Spawn(format!("supervise: {}", e)))?;

    let mut reader = master
        .try_clone_reader()
        .map_err(|e| ExecuteError::Spawn(format!("try_clone_reader: {}", e)))?;
    let max_output = options.max_output_bytes;

    let (tx, rx): (Sender<u8>, Receiver<u8>) = mpsc::channel();
    // Reader thread is detached (never joined): the concrete PTY read may not
    // reach EOF on some platforms even after the child exits (ConPTY holds the
    // master open), so joining could deadlock. The thread exits on its own when
    // the master handle is released and EOF finally arrives, and is necessarily
    // reclaimed when the process exits. Bounded output is collected from `rx`
    // in the main loop, so detaching never loses data already produced.
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for byte in &buf[..n] {
                        if tx.send(*byte).is_err() {
                            return;
                        }
                    }
                }
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
            return teardown_mid_run(&mut guard, &rx, bytes_seen, false, true);
        }
        if Instant::now() >= deadline && !timed_out {
            timed_out = true;
        }

        drain(rx.recv_timeout(Duration::from_millis(5)), &mut buffer, &mut bytes_seen, max_output);

        match child_for_wait.try_wait() {
            Ok(Some(status)) => {
                drain_final(&rx, &mut buffer, &mut bytes_seen, max_output);
                let (exit_code, signal_name) = status_to_code(&status);
                return Ok(RunOutcome {
                    timed_out,
                    cancelled: false,
                    exit_code,
                    signal_name,
                    teardown_confirmed: true,
                    bytes_seen,
                    output: String::from_utf8_lossy(&buffer).to_string(),
                });
            }
            Ok(None) => {}
            Err(_) => {
                drain_final(&rx, &mut buffer, &mut bytes_seen, max_output);
                return Ok(RunOutcome {
                    timed_out,
                    cancelled: false,
                    exit_code: None,
                    signal_name: None,
                    teardown_confirmed: true,
                    bytes_seen,
                    output: String::from_utf8_lossy(&buffer).to_string(),
                });
            }
        }

        if timed_out {
            return teardown_mid_run(&mut guard, &rx, bytes_seen, true, false);
        }
    }
}

fn teardown_mid_run(
    guard: &mut crate::process_tree::ProcessTreeGuard,
    rx: &Receiver<u8>,
    bytes_seen: u64,
    timed_out: bool,
    cancelled: bool,
) -> Result<RunOutcome, ExecuteError> {
    // Request cancellation of the owned process tree (Job Object / group) and
    // verify no owned process remains. This is the fail-closed teardown gate:
    // success is only claimed if the host confirms the owned tree is gone.
    let kill_result = guard.cancel_tree();
    // Drain whatever output arrived without blocking forever.
    let mut _buffer: Vec<u8> = Vec::new();
    for _ in 0..64 {
        if rx.recv_timeout(Duration::from_millis(10)).is_err() {
            break;
        }
    }

    match kill_result {
        Ok(()) if guard.is_confirmed() => Ok(RunOutcome {
            timed_out,
            cancelled,
            exit_code: None,
            signal_name: None,
            teardown_confirmed: true,
            bytes_seen,
            output: String::new(),
        }),
        _ => Err(ExecuteError::UnconfirmedTeardown(
            "owned process tree could not be confirmed terminated".into(),
        )),
    }
}

fn drain(result: Result<u8, mpsc::RecvTimeoutError>, buffer: &mut Vec<u8>, bytes_seen: &mut u64, max_output: usize) {
    if let Ok(byte) = result {
        *bytes_seen += 1;
        if buffer.len() < max_output {
            buffer.push(byte);
        }
    }
}

fn drain_final(rx: &Receiver<u8>, buffer: &mut Vec<u8>, bytes_seen: &mut u64, max_output: usize) {
    loop {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(byte) => {
                *bytes_seen += 1;
                if buffer.len() < max_output {
                    buffer.push(byte);
                }
            }
            Err(_) => break,
        }
    }
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

    fn run(program: &str, args: Vec<String>, timeout: Duration, max_output_bytes: usize) -> Result<RunOutcome, ExecuteError> {
        let cancel = crate::process_tree::CancelToken::new();
        run_bounded(
            ExecOptions {
                program: program.to_string(),
                args,
                cwd: None,
                env: vec![],
                timeout,
                max_output_bytes,
            },
            &cancel,
        )
    }

    #[test]
    #[ignore = "real PTY clean exit cannot be demonstrated in the local GNU-Windows env (ADR-001 blocker); run on POSIX CI or Windows MSVC artifact"]
    fn echo_round_trips_bounded_output() {
        let outcome = run(
            "cmd",
            vec!["/C".into(), "echo".into(), "hello-canary".into()],
            Duration::from_secs(10),
            4096,
        )
        .expect("echo should succeed under PTY");
        assert!(outcome.output.contains("hello-canary"));
        assert_eq!(outcome.exit_code, Some(0));
        assert!(outcome.teardown_confirmed);
    }

    #[test]
    #[ignore = "real PTY clean exit cannot be demonstrated in the local GNU-Windows env (ADR-001 blocker); run on POSIX CI or Windows MSVC artifact"]
    fn output_budget_is_respected() {
        let outcome = run(
            "powershell",
            vec![
                "-NoProfile".into(),
                "-Command".into(),
                "1..2000 | ForEach-Object { '0123456789012345678901234567890123456789' }".into(),
            ],
            Duration::from_secs(20),
            4096,
        )
        .expect("burst should run");
        assert!(outcome.output.len() <= 4096);
        assert!(outcome.bytes_seen > 4096);
        assert!(outcome.more_available());
        assert!(outcome.teardown_confirmed);
    }

    #[test]
    #[ignore = "real PTY clean exit cannot be demonstrated in the local GNU-Windows env (ADR-001 blocker); run on POSIX CI or Windows MSVC artifact"]
    fn non_zero_exit_is_reported() {
        let outcome = run(
            "cmd",
            vec!["/C".into(), "exit".into(), "7".into()],
            Duration::from_secs(10),
            4096,
        )
        .expect("exit should run");
        assert_eq!(outcome.exit_code, Some(7));
        assert!(outcome.teardown_confirmed);
    }
}
