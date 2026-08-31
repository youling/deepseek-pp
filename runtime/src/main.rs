//! CLI entry point for the DeepSeek++ Local Runtime canary.

use deepseek_pp_local_runtime::contract::{self, Envelope};
use deepseek_pp_local_runtime::framing;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("--echo-canary") => {
            return ExitCode::from(deepseek_pp_local_runtime::host::canary_main(&args[2..]) as u8);
        }
        Some("--spawn-sleeper") => {
            return ExitCode::from(deepseek_pp_local_runtime::host::canary_main(&args[2..]) as u8);
        }
        Some("--sleep-descendant") => {
            // Legacy descendant mode: sleep only (used by some tests).
            let ms: u64 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(5000);
            std::thread::sleep(std::time::Duration::from_millis(ms));
            return ExitCode::from(0);
        }
        Some("--status") => {
            return print_status();
        }
        Some("--version") => {
            println!("deepseek-pp-local-runtime {}", contract::RUNTIME_VERSION);
            println!("host {}", contract::HOST_ID);
            println!("contract v{}", contract::CONTRACT_VERSION);
            return ExitCode::from(0);
        }
        _ => {
            return run_native_loop();
        }
    }
}

fn print_status() -> ExitCode {
    let spec = deepseek_pp_local_runtime::host::host_spec();
    println!("host_id: {}", contract::HOST_ID);
    println!("runtime_version: {}", contract::RUNTIME_VERSION);
    println!("contract_version: {}", contract::CONTRACT_VERSION);
    println!("platform: {}", spec.platform);
    println!("pty_supported: {}", spec.pty_supported);
    println!("profiles: {}", deepseek_pp_local_runtime::host::profiles().join(","));
    ExitCode::from(0)
}

/// Read one framed request, dispatch, and write one framed response.
fn run_native_loop() -> ExitCode {
    let mut channel = framing::Channel::stdio();
    let body = match channel.read() {
        Ok(body) => body,
        Err(e) => {
            let response = Envelope::err(
                "unknown".into(),
                "runtime.status",
                "runtime_request_malformed",
                format!("native framing error: {}", e),
                false,
            );
            let _ = channel.write(&serde_json::to_string(&response).unwrap_or_default());
            return ExitCode::from(1);
        }
    };

    let json = match String::from_utf8(body) {
        Ok(s) => s,
        Err(_) => {
            let response = Envelope::err(
                "unknown".into(),
                "runtime.status",
                "runtime_request_malformed",
                "request body is not valid UTF-8".into(),
                false,
            );
            let _ = channel.write(&serde_json::to_string(&response).unwrap_or_default());
            return ExitCode::from(1);
        }
    };

    let request = match contract::parse_request(&json) {
        Ok(req) => req,
        Err(e) => {
            let operation = "runtime.status";
            let response = Envelope::err(
                "unknown".into(),
                operation,
                e.code(),
                format!("{}", e),
                false,
            );
            let _ = channel.write(&serde_json::to_string(&response).unwrap_or_default());
            return ExitCode::from(1);
        }
    };

    let response = deepseek_pp_local_runtime::host::dispatch(&request);
    let out = serde_json::to_string(&response).unwrap_or_else(|_| {
        serde_json::json!({
            "protocol": contract::PROTOCOL,
            "version": contract::CONTRACT_VERSION,
            "request_id": request.request_id,
            "operation": "runtime.status",
            "ok": false,
            "error": { "code": "runtime_response_serialization", "message": "internal", "retryable": false }
        })
        .to_string()
    });
    match channel.write(&out) {
        Ok(()) => ExitCode::from(0),
        Err(e) => {
            eprintln!("failed to write response: {}", e);
            ExitCode::from(1)
        }
    }
}
