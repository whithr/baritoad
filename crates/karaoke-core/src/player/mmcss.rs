//! MMCSS registration for the audio callback thread.
//!
//! Spike finding (spikes/stretch/REPORT.md §4 item 1): cpal does not register
//! its WASAPI callback thread with MMCSS, and without it mid-stream OS
//! preemption stalled the callback for up to 43.5 ms; one
//! `AvSetMmThreadCharacteristicsW("Pro Audio")` call from the first callback
//! collapsed the worst case to 3.0 ms. Direct avrt.dll FFI, exactly as the
//! spike did — no extra dependency.

#[cfg(windows)]
mod imp {
    #[link(name = "avrt")]
    extern "system" {
        fn AvSetMmThreadCharacteristicsW(
            task_name: *const u16,
            task_index: *mut u32,
        ) -> *mut std::ffi::c_void;
    }

    /// Register the *calling* thread (must be invoked from the audio
    /// callback) with the "Pro Audio" MMCSS task. Returns whether it took.
    /// The characteristics handle is deliberately leaked — the registration
    /// should last for the life of the callback thread.
    pub fn register_pro_audio_current_thread() -> bool {
        let name: Vec<u16> = "Pro Audio\0".encode_utf16().collect();
        let mut index = 0u32;
        let h = unsafe { AvSetMmThreadCharacteristicsW(name.as_ptr(), &mut index) };
        !h.is_null()
    }

    pub const SUPPORTED: bool = true;
}

#[cfg(not(windows))]
mod imp {
    /// Documented stub (non-Windows). macOS: CoreAudio already runs the HAL
    /// I/O thread at real-time priority, so no equivalent call is needed.
    /// Linux (ALSA/PulseAudio via cpal): a real-time scheduling request
    /// (pthread_setschedparam / RTKit) is worth evaluating when Linux
    /// playback is profiled — tracked for a later milestone, not silently
    /// faked here.
    pub fn register_pro_audio_current_thread() -> bool {
        false
    }

    pub const SUPPORTED: bool = false;
}

pub use imp::{register_pro_audio_current_thread, SUPPORTED};
