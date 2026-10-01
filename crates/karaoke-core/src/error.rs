//! Error type shared across pipeline stages.

use std::fmt;

#[derive(Debug)]
pub enum Error {
    /// I/O failure (file open/read/write).
    Io(std::io::Error),
    /// Input audio could not be decoded.
    Decode(String),
    /// Model file missing / unloadable / wrong shape.
    Model(String),
    /// ONNX Runtime inference failure.
    Inference(String),
    /// Output encoding (wav/flac) failure.
    Encode(String),
    /// Caller error (bad arguments, unsupported input).
    InvalidInput(String),
    /// Library database (SQLite) failure.
    Db(String),
    /// Audio output device / stream failure (playback engine).
    Device(String),
    /// A web request failed (LRCLIB lyrics lookup, cover art).
    Network(String),
    /// yt-dlp couldn't fetch a link (Add from URL).
    Fetch(String),
    /// Stopped on request (a cancelled download).
    Cancelled,
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(e) => write!(f, "i/o error: {e}"),
            Error::Decode(m) => write!(f, "decode error: {m}"),
            Error::Model(m) => write!(f, "model error: {m}"),
            Error::Inference(m) => write!(f, "inference error: {m}"),
            Error::Encode(m) => write!(f, "encode error: {m}"),
            Error::InvalidInput(m) => write!(f, "invalid input: {m}"),
            Error::Db(m) => write!(f, "library db error: {m}"),
            Error::Device(m) => write!(f, "audio device error: {m}"),
            Error::Network(m) => write!(f, "network error: {m}"),
            Error::Fetch(m) => write!(f, "{m}"),
            Error::Cancelled => write!(f, "cancelled"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

impl<T> From<ort::Error<T>> for Error {
    fn from(e: ort::Error<T>) -> Self {
        Error::Inference(e.to_string())
    }
}

impl From<hound::Error> for Error {
    fn from(e: hound::Error) -> Self {
        Error::Encode(e.to_string())
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Db(e.to_string())
    }
}
