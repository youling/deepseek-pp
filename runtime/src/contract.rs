//! Dedicated `deepseek-pp-local-runtime` v1 contract.
//!
//! This is the language-neutral, versioned operation contract validated at the
//! Rust trust boundary. It is intentionally separate from the generic
//! `deepseek-pp-mcp-native` v1 launcher envelope (`server.command/args/cwd/env`),
//! which is NOT treated as semantic authority here.
//!
//! The Rust types mirror the schema in `runtime/schema/deepseek-pp-local-runtime.schema.json`
//! and the TypeScript contract in `core/local-runtime/contract.ts`.

use serde::{Deserialize, Serialize};

pub const PROTOCOL: &str = "deepseek-pp-local-runtime";
pub const CONTRACT_VERSION: u32 = 1;
pub const HOST_ID: &str = "com.deepseek_pp.runtime.canary";
pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");

pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_ARGS_PER_REQUEST: usize = 8;
pub const MAX_ARG_BYTES: usize = 1024;

pub const CANARY_PROFILE: &str = "canary.echo";
pub const CANARY_SPAWN_SLEEPER_PROFILE: &str = "canary.spawn_sleeper";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    RuntimeStatus,
    RuntimeExec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeRequest {
    pub protocol: String,
    pub version: u32,
    #[serde(rename = "request_id")]
    pub request_id: String,
    pub operation: Operation,
    #[serde(rename = "grant_id")]
    pub grant_id: Option<String>,
    #[serde(rename = "workspace_id")]
    pub workspace_id: Option<String>,
    #[serde(rename = "profile_id")]
    pub profile_id: Option<String>,
    #[serde(rename = "timeout_ms")]
    pub timeout_ms: Option<u64>,
    #[serde(rename = "max_output_bytes")]
    pub max_output_bytes: Option<usize>,
    #[serde(default)]
    pub args: Vec<String>,
}

impl RuntimeRequest {
    /// Fail-closed validation of the request shape at the trust boundary.
    ///
    /// `protocol`, `version`, and `operation` are authoritative. `grant_id`,
    /// `workspace_id`, `profile_id`, `args` are payload/claims bound to the
    /// background-issued grant; they are never authorization evidence by
    /// themselves. The host owner authorizes execution (see `host.rs`), not
    /// the browser-supplied claims.
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.protocol != PROTOCOL {
            return Err(ContractError::ProtocolUnknown(self.protocol.clone()));
        }
        if self.version != CONTRACT_VERSION {
            return Err(ContractError::VersionUnsupported(self.version));
        }
        if self.request_id.is_empty() || self.request_id.len() > 128 {
            return Err(ContractError::Invalid("request_id must be a non-empty string <= 128 bytes".into()));
        }
        if self.args.len() > MAX_ARGS_PER_REQUEST {
            return Err(ContractError::Invalid(format!(
                "args exceed per-request cap {}",
                MAX_ARGS_PER_REQUEST
            )));
        }
        for (index, arg) in self.args.iter().enumerate() {
            if arg.as_bytes().len() > MAX_ARG_BYTES {
                return Err(ContractError::Invalid(format!(
                    "arg[{}] exceeds {} bytes",
                    index, MAX_ARG_BYTES
                )));
            }
        }
        if let Some(timeout) = self.timeout_ms {
            if timeout == 0 || timeout > 3_600_000 {
                return Err(ContractError::Invalid(
                    "timeout_ms must be within (0, 3600000]".into(),
                ));
            }
        }
        if let Some(budget) = self.max_output_bytes {
            if budget == 0 || budget > 1_000_000 {
                return Err(ContractError::Invalid(
                    "max_output_bytes must be within (0, 1000000]".into(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExitStatusInfo {
    pub code: Option<i64>,
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RuntimeResponse {
    Ok,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostInfo {
    #[serde(rename = "host_id")]
    pub host_id: String,
    #[serde(rename = "runtime_version")]
    pub runtime_version: String,
    #[serde(rename = "contract_version")]
    pub contract_version: u32,
    pub platform: String,
    #[serde(rename = "pty_supported")]
    pub pty_supported: bool,
    pub profiles: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExecResult {
    #[serde(rename = "run_id")]
    pub run_id: String,
    #[serde(rename = "exit_status")]
    pub exit_status: ExitStatusInfo,
    #[serde(rename = "timed_out")]
    pub timed_out: bool,
    #[serde(rename = "cancelled")]
    pub cancelled: bool,
    #[serde(rename = "teardown_confirmed")]
    pub teardown_confirmed: bool,
    #[serde(rename = "bytes_seen")]
    pub bytes_seen: u64,
    #[serde(rename = "bytes_retained")]
    pub bytes_retained: usize,
    #[serde(rename = "more_available")]
    pub more_available: bool,
    pub output: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Envelope {
    pub protocol: &'static str,
    pub version: u32,
    #[serde(rename = "request_id")]
    pub request_id: String,
    pub operation: String,
    #[serde(rename = "ok")]
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<HostInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ExecResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RuntimeError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

impl Envelope {
    pub fn ok_status(request_id: String, host: HostInfo) -> Self {
        Self {
            protocol: PROTOCOL,
            version: CONTRACT_VERSION,
            request_id,
            operation: "runtime.status".into(),
            ok: true,
            host: Some(host),
            result: None,
            error: None,
        }
    }

    pub fn ok_exec(request_id: String, result: ExecResult) -> Self {
        Self {
            protocol: PROTOCOL,
            version: CONTRACT_VERSION,
            request_id,
            operation: "runtime.exec".into(),
            ok: true,
            host: None,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(request_id: String, operation: &str, code: &str, message: String, retryable: bool) -> Self {
        Self {
            protocol: PROTOCOL,
            version: CONTRACT_VERSION,
            request_id,
            operation: operation.into(),
            ok: false,
            host: None,
            result: None,
            error: Some(RuntimeError {
                code: code.into(),
                message,
                retryable: Some(retryable),
            }),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ContractError {
    #[error("unsupported protocol: {0}")]
    ProtocolUnknown(String),
    #[error("unsupported contract version: {0}")]
    VersionUnsupported(u32),
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("malformed request JSON: {0}")]
    Malformed(String),
}

impl ContractError {
    pub fn code(&self) -> &'static str {
        match self {
            ContractError::ProtocolUnknown(_) => "runtime_protocol_unknown",
            ContractError::VersionUnsupported(_) => "runtime_version_unsupported",
            ContractError::Invalid(_) => "runtime_request_invalid",
            ContractError::Malformed(_) => "runtime_request_malformed",
        }
    }
}

pub fn parse_request(json: &str) -> Result<RuntimeRequest, ContractError> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| ContractError::Malformed(e.to_string()))?;
    if !value.is_object() {
        return Err(ContractError::Malformed("request must be a JSON object".into()));
    }
    let request: RuntimeRequest = RuntimeRequest::deserialize(value)
        .map_err(|e| ContractError::Malformed(e.to_string()))?;
    request.validate()?;
    Ok(request)
}

pub fn deserialize_request(value: serde_json::Value) -> Result<RuntimeRequest, ContractError> {
    let request = RuntimeRequest::deserialize(value)
        .map_err(|e| ContractError::Malformed(e.to_string()))?;
    request.validate()?;
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> serde_json::Value {
        serde_json::json!({
            "protocol": PROTOCOL,
            "version": CONTRACT_VERSION,
            "request_id": "req-1",
            "operation": "runtime_status",
        })
    }

    #[test]
    fn valid_status_request() {
        let req = parse_request(&base().to_string()).unwrap();
        assert_eq!(req.operation, Operation::RuntimeStatus);
    }

    #[test]
    fn future_version_fails_closed() {
        let mut v = base();
        v["version"] = serde_json::json!(2);
        match parse_request(&v.to_string()) {
            Err(ContractError::VersionUnsupported(2)) => {}
            other => panic!("expected VersionUnsupported, got {:?}", other),
        }
    }

    #[test]
    fn future_protocol_fails_closed() {
        let mut v = base();
        v["protocol"] = serde_json::json!("deepseek-pp-future");
        match parse_request(&v.to_string()) {
            Err(ContractError::ProtocolUnknown(p)) if p == "deepseek-pp-future" => {}
            other => panic!("expected ProtocolUnknown, got {:?}", other),
        }
    }

    #[test]
    fn unknown_operation_is_malformed() {
        let mut v = base();
        v["operation"] = serde_json::json!("runtime_future");
        assert!(matches!(parse_request(&v.to_string()), Err(_)));
    }

    #[test]
    fn too_many_args_fails() {
        let mut v = base();
        v["operation"] = serde_json::json!("runtime_exec");
        v["args"] = (0..MAX_ARGS_PER_REQUEST + 1).map(|i| format!("a{}", i)).collect();
        assert!(matches!(
            parse_request(&v.to_string()),
            Err(ContractError::Invalid(_))
        ));
    }

    #[test]
    fn oversized_single_arg_fails() {
        let mut v = base();
        v["operation"] = serde_json::json!("runtime_exec");
        v["args"] = serde_json::json!(["x".repeat(MAX_ARG_BYTES + 1)]);
        assert!(matches!(
            parse_request(&v.to_string()),
            Err(ContractError::Invalid(_))
        ));
    }

    #[test]
    fn missing_request_id_fails() {
        let mut v = base();
        v["request_id"] = serde_json::json!("");
        assert!(matches!(
            parse_request(&v.to_string()),
            Err(ContractError::Invalid(_))
        ));
    }
}
