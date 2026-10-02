//! CPU budget for ONNX Runtime sessions. Song import runs beside the UI, the
//! player and whatever else the user has open, so inference never takes the
//! whole machine: it leaves cores free and its idle pool threads sleep
//! instead of spin-waiting (ORT's default keeps waiting threads busy, which
//! reads as 100% on every core it owns).

use ort::session::{builder::SessionBuilder, Session};

use crate::error::Result;

/// Intra-op threads for background inference: all cores but two on 5+ core
/// machines (the 8-core i7-9700K dev box gets 6), all but one below that.
pub fn inference_threads() -> usize {
    let n = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    match n {
        0..=2 => 1,
        3..=4 => n - 1,
        _ => n - 2,
    }
}

/// The DirectML execution provider, failing loudly so callers can fall back
/// to the CPU. Windows only; elsewhere asking for it is that failure.
#[cfg(windows)]
pub fn directml() -> Result<ort::ep::ExecutionProviderDispatch> {
    Ok(ort::ep::DirectML::default().build().error_on_failure())
}

#[cfg(not(windows))]
pub fn directml() -> Result<ort::ep::ExecutionProviderDispatch> {
    Err(crate::Error::Model("DirectML is Windows-only; using the CPU".into()))
}

/// A session builder with `threads` intra-op threads and spinning off.
pub fn session_builder(threads: usize) -> Result<SessionBuilder> {
    Ok(Session::builder()?
        .with_intra_threads(threads)?
        .with_intra_op_spinning(false)?
        .with_inter_op_spinning(false)?)
}
