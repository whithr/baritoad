//! Keep the computer awake while songs import: an overnight Import Folder
//! batch shouldn't stall because the computer went to sleep halfway through.
//! The screen may still turn off — only idle system sleep is held off.
//! Windows: `SetThreadExecutionState`, held by the pipeline-worker thread
//! that calls it and dropped when that thread lets go or exits. macOS: an
//! IOKit power assertion (shows as "Preventing Sleep" in Activity Monitor),
//! released with the hold or when the app exits. A no-op elsewhere.

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

#[cfg(target_os = "macos")]
fn set(on: bool) {
    use std::ffi::{c_char, c_void};
    use std::sync::atomic::{AtomicU32, Ordering};

    type CFStringRef = *const c_void;
    const CF_UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8
    const LEVEL_ON: u32 = 255; // kIOPMAssertionLevelOn
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(alloc: *const c_void, s: *const c_char, encoding: u32) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(kind: CFStringRef, level: u32, name: CFStringRef, id: *mut u32) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }
    /// The held assertion (0 is kIOPMNullAssertionID: none).
    static HELD: AtomicU32 = AtomicU32::new(0);

    if on {
        if HELD.load(Ordering::Relaxed) != 0 {
            return;
        }
        // SAFETY: NUL-terminated literals in, both CF strings released after;
        // one out-param.
        unsafe {
            let kind = CFStringCreateWithCString(std::ptr::null(), c"PreventUserIdleSystemSleep".as_ptr(), CF_UTF8);
            let name = CFStringCreateWithCString(std::ptr::null(), ASSERTION_NAME.as_ptr(), CF_UTF8);
            let mut id = 0u32;
            if !kind.is_null() && !name.is_null() && IOPMAssertionCreateWithName(kind, LEVEL_ON, name, &mut id) == 0 {
                HELD.store(id, Ordering::Relaxed);
            }
            for s in [kind, name] {
                if !s.is_null() {
                    CFRelease(s);
                }
            }
        }
    } else {
        let id = HELD.swap(0, Ordering::Relaxed);
        if id != 0 {
            // SAFETY: an id IOPMAssertionCreateWithName gave us, released once.
            unsafe {
                IOPMAssertionRelease(id);
            }
        }
    }
}

/// What `pmset -g assertions` and Activity Monitor show for the hold.
#[cfg(target_os = "macos")]
const ASSERTION_NAME: &std::ffi::CStr = c"baritoad is importing songs";

#[cfg(not(any(windows, target_os = "macos")))]
fn set(_on: bool) {}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    fn listed() -> bool {
        let out = std::process::Command::new("pmset").args(["-g", "assertions"]).output().expect("pmset");
        String::from_utf8_lossy(&out.stdout).contains(ASSERTION_NAME.to_str().unwrap())
    }

    #[test]
    fn holds_and_lets_go_of_idle_sleep() {
        let mut awake = KeepAwake::new();
        awake.hold();
        assert!(listed(), "the power assertion should be listed while held");
        awake.release();
        assert!(!listed(), "the power assertion should be gone after release");
    }
}
