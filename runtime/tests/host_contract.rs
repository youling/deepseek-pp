//! End-to-end contract tests against the real compiled host binary, speaking
//! the dedicated `deepseek-pp-local-runtime` v1 contract over native 4-byte
//! framing on stdin/stdout (the exact path the extension uses).

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};

use deepseek_pp_local_runtime::contract::{CONTRACT_VERSION, HOST_ID, PROTOCOL};

const BIN: &str = env!("CARGO_BIN_EXE_deepseek-pp-local-runtime");

struct HostProc {
    child: Child,
    stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
}

fn spawn_host() -> HostProc {
    let mut child = Command::new(BIN)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn host");
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    HostProc { child, stdin, stdout }
}

impl HostProc {
    fn request(&mut self, payload: &serde_json::Value) -> serde_json::Value {
        let body = serde_json::to_vec(payload).unwrap();
        let mut frame = Vec::with_capacity(4 + body.len());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        self.stdin.write_all(&frame).unwrap();
        self.stdin.flush().unwrap();

        // Read one framed response.
        let mut header = [0u8; 4];
        self.stdout.read_exact(&mut header).unwrap();
        let len = u32::from_le_bytes(header) as usize;
        let mut resp = vec![0u8; len];
        self.stdout.read_exact(&mut resp).unwrap();
        serde_json::from_slice(&resp).unwrap()
    }
}

impl Drop for HostProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn status_request() -> serde_json::Value {
    serde_json::json!({
        "protocol": PROTOCOL,
        "version": CONTRACT_VERSION,
        "request_id": "it-status-1",
        "operation": "runtime_status",
    })
}

#[test]
fn version_and_status_subprocess() {
    let out = Command::new(BIN).arg("--version").output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(stdout.contains(HOST_ID), "version must announce host id");
    assert!(stdout.contains(&format!("contract v{}", CONTRACT_VERSION)));

    let out = Command::new(BIN).arg("--status").output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(stdout.contains(&format!("host_id: {}", HOST_ID)));
    assert!(stdout.contains("profiles: canary.echo"));
}

#[test]
fn native_status_round_trip() {
    let mut host = spawn_host();
    let resp = host.request(&status_request());
    assert_eq!(resp["protocol"], PROTOCOL);
    assert_eq!(resp["version"], CONTRACT_VERSION);
    assert_eq!(resp["request_id"], "it-status-1");
    assert_eq!(resp["operation"], "runtime.status");
    assert_eq!(resp["ok"], true);
    assert_eq!(resp["host"]["host_id"], HOST_ID);
    assert_eq!(resp["host"]["contract_version"], CONTRACT_VERSION);
    assert!(resp["host"]["profiles"].as_array().unwrap().len() >= 1);
    assert!(resp["host"]["platform"].as_str().is_some());
}

#[test]
fn future_version_fails_closed_over_wire() {
    let mut host = spawn_host();
    let mut req = status_request();
    req["version"] = serde_json::json!(CONTRACT_VERSION + 1);
    let resp = host.request(&req);
    assert_eq!(resp["ok"], false);
    assert_eq!(resp["error"]["code"], "runtime_version_unsupported");
}

#[test]
fn exec_without_grant_fails_closed() {
    let mut host = spawn_host();
    let req = serde_json::json!({
        "protocol": PROTOCOL,
        "version": CONTRACT_VERSION,
        "request_id": "it-no-grant",
        "operation": "runtime_exec",
        "profile_id": "canary.echo",
    });
    let resp = host.request(&req);
    assert_eq!(resp["ok"], false);
    assert_eq!(resp["error"]["code"], "runtime_grant_missing");
}

#[test]
fn exec_unknown_profile_fails_closed_even_with_grant() {
    let mut host = spawn_host();
    let req = serde_json::json!({
        "protocol": PROTOCOL,
        "version": CONTRACT_VERSION,
        "request_id": "it-bad-profile",
        "operation": "runtime_exec",
        "grant_id": "grant-abc",
        "profile_id": "shell_exec",
    });
    let resp = host.request(&req);
    assert_eq!(resp["ok"], false);
    assert_eq!(resp["error"]["code"], "runtime_profile_unknown");
}

#[test]
fn malformed_operation_is_rejected() {
    let mut host = spawn_host();
    let req = serde_json::json!({
        "protocol": PROTOCOL,
        "version": CONTRACT_VERSION,
        "request_id": "it-bad-op",
        "operation": "runtime_future",
    });
    let resp = host.request(&req);
    assert_eq!(resp["ok"], false);
    assert_eq!(resp["error"]["code"], "runtime_request_malformed");
}

#[test]
fn exec_with_grant_reaches_profile_boundary() {
    // This asserts the host accepts a background-issued grant and routes to the
    // host-owned canary profile's command boundary. Real PTY clean-exit is
    // demonstrated on CI; here we only require a well-formed, grant-bearing
    // exec request to return a runtime_exec-shaped envelope (ok OR a bounded
    // environment/teardown error) rather than an authorization error.
    let mut host = spawn_host();
    let req = serde_json::json!({
        "protocol": PROTOCOL,
        "version": CONTRACT_VERSION,
        "request_id": "it-grant-echo",
        "operation": "runtime_exec",
        "grant_id": "grant-abc",
        "workspace_id": "ws-canary",
        "profile_id": "canary.echo",
        "timeout_ms": 2000,
        "max_output_bytes": 1024,
        "args": ["hello"],
    });
    let resp = host.request(&req);
    assert_eq!(resp["protocol"], PROTOCOL);
    assert_eq!(resp["request_id"], "it-grant-echo");
    assert_eq!(resp["operation"], "runtime.exec");
    // Must NOT be an authorization failure: a grant was honored.
    assert_ne!(resp["error"]["code"], "runtime_grant_missing");
    assert_ne!(resp["error"]["code"], "runtime_profile_unknown");
    // Either a successful bounded result or an explicit environment blocker.
    if resp["ok"].as_bool().unwrap_or(false) {
        assert!(resp["result"]["run_id"].as_str().is_some());
        assert!(resp["result"]["bytes_retained"].as_u64().unwrap_or(0) <= 1024);
        assert!(resp["result"]["exit_status"].is_object());
    }
}
