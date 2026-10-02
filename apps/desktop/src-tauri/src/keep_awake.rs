//! Keep the computer awake while songs import: an overnight Import Folder
//! batch shouldn't stall because Windows went to sleep halfway through. The
//! screen may still turn off — only system sleep is held off. Windows only
//! (`SetThreadExecutionState`, held by the pipeline-worker thread that calls
//! it and dropped when that thread lets go or exits); a no-op elsewhere.

pub struct KeepAwake {
    held: bool,
}

impl KeepAwake {
    pub fn new() -> Self {
        Self { held: false }
    }

    /// A job started (call from the worker thread).
    pub fn hold(&mut self) {
        if !self.held {
            set(true);
            self.held = true;
        }
    }

    /// Nothing left to import.
    pub fn release(&mut self) {
        if self.held {
            set(false);
            self.held = false;
        }
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(windows)]
fn set(on: bool) {
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }
    // SAFETY: plain flags in, previous state out; no pointers involved.
    unsafe {
        SetThreadExecutionState(if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS });
    }
}

#[cfg(not(windows))]
fn set(_on: bool) {}
