//! DeepSeek++ Local Coding Runtime (canary) — execution-only native host.
//!
//! Architecture boundary: the official DeepSeek Web session remains the only
//! model/reasoning authority. This binary is an execution subordinate only; it
//! never selects a model, calls a paid API, owns an agent loop, or becomes a
//! second authorization/router authority.

pub mod contract;
pub mod executor;
pub mod framing;
pub mod host;
pub mod process_tree;
pub mod util;
pub mod workspace;
