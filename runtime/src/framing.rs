//! Native Messaging framing: 4-byte little-endian length + UTF-8 JSON.
//! Mirrors the existing browser transport ceiling used by Chrome/Edge/Firefox.

use std::io::{self, Read, Write};
use std::sync::mpsc::{self, Receiver, Sender};

use crate::contract::MAX_REQUEST_BYTES;

#[derive(Debug, thiserror::Error)]
pub enum FramingError {
    #[error("invalid message length {0} (max {MAX_REQUEST_BYTES})")]
    InvalidLength(usize),
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("input ended")]
    Eof,
}

const HEADER_LEN: usize = 4;

/// Read exactly one native message (the JSON body) from `input`.
pub fn read_message(input: &mut dyn Read) -> Result<Vec<u8>, FramingError> {
    let mut header = [0u8; HEADER_LEN];
    read_exact_bounded(input, &mut header)?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_REQUEST_BYTES {
        // The extension should chunk requests; fail closed on malformed frames.
        return Err(FramingError::InvalidLength(length));
    }
    let mut body = vec![0u8; length];
    read_exact_bounded(input, &mut body)?;
    Ok(body)
}

fn read_exact_bounded(input: &mut dyn Read, buf: &mut [u8]) -> Result<(), FramingError> {
    let mut filled = 0usize;
    while filled < buf.len() {
        match input.read(&mut buf[filled..]) {
            Ok(0) => return Err(FramingError::Eof),
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FramingError::Io(e)),
        }
    }
    Ok(())
}

/// Write one native message frame (4-byte BE->LE length + JSON body).
pub fn write_message(output: &mut dyn Write, json: &str) -> Result<(), io::Error> {
    let body = json.as_bytes();
    let mut header = [0u8; HEADER_LEN];
    header.copy_from_slice(&(body.len() as u32).to_le_bytes());
    output.write_all(&header)?;
    output.write_all(body)?;
    output.flush()
}

/// Bi-directional framed channel over stdin/stdout with a bounded request
/// producer. Pull-parsing is kept simple: the host reads one request, handles
/// it, and writes one response. This matches the request/response correlation
/// the browser transport expects.
pub struct Channel {
    input: Box<dyn Read + Send>,
    output: Box<dyn Write + Send>,
}

impl Channel {
    pub fn stdio() -> Self {
        Self {
            input: Box::new(io::stdin()),
            output: Box::new(io::stdout()),
        }
    }

    pub fn from_parts(input: Box<dyn Read + Send>, output: Box<dyn Write + Send>) -> Self {
        Self { input, output }
    }

    pub fn read(&mut self) -> Result<Vec<u8>, FramingError> {
        read_message(&mut self.input)
    }

    pub fn write(&mut self, json: &str) -> Result<(), io::Error> {
        write_message(&mut self.output, json)
    }
}

/// A temporary channel used by tests: exposes the framed reader/writer over
/// in-memory pipes, letting the host run against concrete byte streams.
pub struct PipeChannel {
    tx: Sender<Vec<u8>>,
    rx: Receiver<Vec<u8>>,
}

impl PipeChannel {
    pub fn pair() -> (Self, ChannelEnd) {
        let (a_tx, a_rx) = mpsc::channel::<Vec<u8>>();
        let (b_tx, b_rx) = mpsc::channel::<Vec<u8>>();
        (
            PipeChannel { tx: a_tx, rx: b_rx },
            ChannelEnd { tx: b_tx, rx: a_rx },
        )
    }

    pub fn send_frame(&self, json: &str) {
        let _ = self.tx.send(json.as_bytes().to_vec());
    }

    pub fn recv_json(&self) -> Result<String, ()> {
        match self.rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).to_string()),
            Err(_) => Err(()),
        }
    }
}

pub struct ChannelEnd {
    tx: Sender<Vec<u8>>,
    rx: Receiver<Vec<u8>>,
}

impl ChannelEnd {
    pub fn send_json(&self, json: &str) {
        let _ = self.tx.send(json.as_bytes().to_vec());
    }

    pub fn recv_raw(&self) -> Result<String, ()> {
        match self.rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).to_string()),
            Err(_) => Err(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(msg: &str) -> Vec<u8> {
        let body = msg.as_bytes();
        let mut header = [0u8; HEADER_LEN];
        header.copy_from_slice(&(body.len() as u32).to_le_bytes());
        [&header[..], body].concat()
    }

    #[test]
    fn round_trips_full_frame() {
        let msg = r#"{"protocol":"deepseek-pp-local-runtime"}"#;
        let mut buf = &encode(msg)[..];
        let mut cursor = io::Cursor::new(&mut buf);
        let body = read_message(&mut cursor).unwrap();
        assert_eq!(String::from_utf8(body).unwrap(), msg);
    }

    #[test]
    fn rejects_zero_length() {
        let mut buf = &[0u8; 4][..];
        let mut cursor = io::Cursor::new(&mut buf);
        match read_message(&mut cursor) {
            Err(FramingError::InvalidLength(0)) => {}
            other => panic!("expected InvalidLength(0), got {:?}", other),
        }
    }

    #[test]
    fn rejects_oversized_length() {
        let mut input = vec![0u8; 4];
        input[..4].copy_from_slice(&(MAX_REQUEST_BYTES as u32 + 1).to_le_bytes());
        let mut cursor = io::Cursor::new(input);
        match read_message(&mut cursor) {
            Err(FramingError::InvalidLength(_)) => {}
            other => panic!("expected InvalidLength, got {:?}", other),
        }
    }
}
