//! Gaming mode: notice when the app in front is busy on the graphics card,
//! so song import can keep separation off it.
//!
//! Measured 2026-09-30 (157.6 s song, RTX 2080 Super, RuneLite open at ~19 %
//! of the 3D engine): DirectML separation dropped a 120 fps probe to 57 fps
//! (47 frames over 50 ms) for its 6.3 s; on the CPU the import stayed at
//! 120 fps but took 90.5 s instead of 11.7 s. wav2vec2 alignment on DirectML
//! stayed smooth, so only separation moves.
//!
//! "Busy" means the foreground window's process uses at least
//! [`GPU_3D_THRESHOLD`] of a 3D engine (Windows' "GPU Engine" performance
//! counters, the numbers Task Manager shows), or an exclusive-fullscreen
//! Direct3D app is running. Our own windows never count. A watcher thread
//! samples every [`SAMPLE_EVERY`]; the queue reads the latest verdict when a
//! song is about to separate ([`crate::queue`]).

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Share of a 3D engine the app in front must use to count as a game (an
/// idle browser or the desktop sits well below; RuneLite measured ~19 %).
pub const GPU_3D_THRESHOLD: f64 = 10.0;
const SAMPLE_EVERY: Duration = Duration::from_secs(2);
/// Samples in a row below the threshold before gaming mode lets go (a game
/// loading screen dips briefly).
const RELEASE_AFTER: u8 = 2;

/// What import does while a game is using the graphics card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GamePolicy {
    /// Separate on the processor (slower, the game stays smooth).
    Cpu,
    /// Wait until the game is done before separating.
    Pause,
    /// Keep using the graphics card.
    Gpu,
}

impl GamePolicy {
    fn to_u8(self) -> u8 {
        match self {
            GamePolicy::Cpu => 0,
            GamePolicy::Pause => 1,
            GamePolicy::Gpu => 2,
        }
    }
    fn from_u8(v: u8) -> Self {
        match v {
            1 => GamePolicy::Pause,
            2 => GamePolicy::Gpu,
            _ => GamePolicy::Cpu,
        }
    }
}

/// The watcher's latest verdict.
#[derive(Debug, Clone, Default, Serialize)]
pub struct GameStatus {
    pub gaming: bool,
    /// The app in front ("RuneLite"), when one is detected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// Its share of the 3D engine, percent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_percent: Option<f64>,
    /// False where detection isn't available (not Windows, counters off).
    pub supported: bool,
}

pub struct GameWatch {
    policy: AtomicU8,
    status: Mutex<GameStatus>,
}

impl GameWatch {
    /// Start the watcher thread (Windows; elsewhere the status stays "not
    /// gaming, unsupported").
    pub fn spawn() -> Arc<Self> {
        let watch = Arc::new(Self {
            policy: AtomicU8::new(GamePolicy::Cpu.to_u8()),
            status: Mutex::new(GameStatus::default()),
        });
        #[cfg(windows)]
        {
            let w = watch.clone();
            let _ = std::thread::Builder::new().name("game-watch".into()).spawn(move || w.run());
        }
        watch
    }

    pub fn policy(&self) -> GamePolicy {
        GamePolicy::from_u8(self.policy.load(Ordering::Relaxed))
    }

    pub fn set_policy(&self, p: GamePolicy) {
        self.policy.store(p.to_u8(), Ordering::Relaxed);
    }

    pub fn status(&self) -> GameStatus {
        self.status.lock().unwrap().clone()
    }

    #[cfg(windows)]
    fn run(&self) {
        let Some(mut sampler) = win::Sampler::new() else {
            eprintln!("game watch: GPU counters unavailable — gaming mode is off");
            return;
        };
        let own_pid = std::process::id();
        let mut latch = Latch::default();
        loop {
            std::thread::sleep(SAMPLE_EVERY);
            let reading = sampler.sample();
            let hit = reading.as_ref().is_some_and(|r| is_game(r, own_pid));
            let gaming = latch.update(hit);
            let mut st = self.status.lock().unwrap();
            st.supported = true;
            st.gaming = gaming;
            if hit {
                let r = reading.expect("hit implies a reading");
                st.app = r.name.clone();
                st.gpu_percent = Some((r.gpu_3d * 10.0).round() / 10.0);
            } else if !gaming {
                st.app = None;
                st.gpu_percent = None;
            }
        }
    }
}

/// One look at the app in front.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub pid: u32,
    pub name: Option<String>,
    /// Its share of the 3D engine, percent (summed over adapters).
    pub gpu_3d: f64,
    /// An exclusive-fullscreen Direct3D app is running.
    pub d3d_fullscreen: bool,
}

/// A game, by the rules in the module docs.
pub fn is_game(r: &Reading, own_pid: u32) -> bool {
    if r.d3d_fullscreen {
        return true;
    }
    r.pid != 0 && r.pid != own_pid && r.gpu_3d >= GPU_3D_THRESHOLD
}

/// On at the first hit; off after [`RELEASE_AFTER`] misses in a row.
#[derive(Debug, Default)]
pub struct Latch {
    on: bool,
    misses: u8,
}

impl Latch {
    pub fn update(&mut self, hit: bool) -> bool {
        if hit {
            self.on = true;
            self.misses = 0;
        } else if self.on {
            self.misses += 1;
            if self.misses >= RELEASE_AFTER {
                self.on = false;
                self.misses = 0;
            }
        }
        self.on
    }
}

/// The pid in a "GPU Engine" counter instance name
/// ("pid_18800_luid_0x…_phys_0_eng_0_engtype_3D").
pub fn instance_pid(name: &str) -> Option<u32> {
    name.strip_prefix("pid_")?.split('_').next()?.parse().ok()
}

#[cfg(windows)]
mod win {
    //! Hand-written FFI (the codebase's precedent — see the player's MMCSS
    //! call): user32 for the foreground window, kernel32 for its process
    //! name, shell32 for the fullscreen state, pdh for the GPU counters.

    use std::collections::HashMap;
    use std::ffi::c_void;

    use super::{instance_pid, Reading};

    type PdhHandle = isize;

    const PDH_FMT_DOUBLE: u32 = 0x0000_0200;
    const PDH_MORE_DATA: u32 = 0x8000_07D2;
    const PDH_CSTATUS_VALID_DATA: u32 = 0;
    const PDH_CSTATUS_NEW_DATA: u32 = 1;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const QUNS_RUNNING_D3D_FULL_SCREEN: i32 = 3;

    /// PDH_FMT_COUNTERVALUE: a status, then (8-aligned) the value union.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FmtValue {
        status: u32,
        value: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FmtItem {
        name: *const u16,
        value: FmtValue,
    }

    #[link(name = "pdh")]
    extern "system" {
        fn PdhOpenQueryW(data_source: *const u16, user_data: usize, query: *mut PdhHandle) -> u32;
        fn PdhAddEnglishCounterW(query: PdhHandle, path: *const u16, user_data: usize, counter: *mut PdhHandle) -> u32;
        fn PdhCollectQueryData(query: PdhHandle) -> u32;
        fn PdhGetFormattedCounterArrayW(
            counter: PdhHandle,
            format: u32,
            buffer_size: *mut u32,
            item_count: *mut u32,
            items: *mut FmtItem,
        ) -> u32;
        fn PdhCloseQuery(query: PdhHandle) -> u32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(hwnd: *mut c_void, pid: *mut u32) -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(process: *mut c_void, flags: u32, name: *mut u16, size: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn SHQueryUserNotificationState(state: *mut i32) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn from_wide(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut len = 0;
        while *p.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }

    pub struct Sampler {
        query: PdhHandle,
        counter: PdhHandle,
    }

    // The handles are only ever used from the watcher thread.
    unsafe impl Send for Sampler {}

    impl Sampler {
        pub fn new() -> Option<Self> {
            let mut query: PdhHandle = 0;
            let mut counter: PdhHandle = 0;
            unsafe {
                if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != 0 {
                    return None;
                }
                let path = wide(r"\GPU Engine(*)\Utilization Percentage");
                if PdhAddEnglishCounterW(query, path.as_ptr(), 0, &mut counter) != 0 {
                    PdhCloseQuery(query);
                    return None;
                }
                // Utilization is a rate: the first collection only primes it.
                PdhCollectQueryData(query);
            }
            Some(Self { query, counter })
        }

        /// 3D-engine percent per process since the last sample.
        fn gpu_3d_by_pid(&mut self) -> Option<HashMap<u32, f64>> {
            unsafe {
                if PdhCollectQueryData(self.query) != 0 {
                    return None;
                }
                let mut size: u32 = 0;
                let mut count: u32 = 0;
                let r = PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, std::ptr::null_mut());
                if r != PDH_MORE_DATA || size == 0 {
                    return None;
                }
                // u64 storage keeps the items 8-aligned.
                let mut buf = vec![0u64; (size as usize).div_ceil(8)];
                let items = buf.as_mut_ptr() as *mut FmtItem;
                if PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, items) != 0 {
                    return None;
                }
                let mut by_pid: HashMap<u32, f64> = HashMap::new();
                for i in 0..count as usize {
                    let item = *items.add(i);
                    if !matches!(item.value.status, PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA) {
                        continue;
                    }
                    let name = from_wide(item.name);
                    if !name.ends_with("engtype_3D") {
                        continue;
                    }
                    if let Some(pid) = instance_pid(&name) {
                        *by_pid.entry(pid).or_default() += item.value.value;
                    }
                }
                Some(by_pid)
            }
        }

        pub fn sample(&mut self) -> Option<Reading> {
            let by_pid = self.gpu_3d_by_pid()?;
            let mut pid: u32 = 0;
            unsafe {
                let hwnd = GetForegroundWindow();
                if !hwnd.is_null() {
                    GetWindowThreadProcessId(hwnd, &mut pid);
                }
            }
            let mut state: i32 = 0;
            let d3d_fullscreen =
                unsafe { SHQueryUserNotificationState(&mut state) } == 0 && state == QUNS_RUNNING_D3D_FULL_SCREEN;
            Some(Reading {
                pid,
                name: process_name(pid),
                gpu_3d: by_pid.get(&pid).copied().unwrap_or(0.0),
                d3d_fullscreen,
            })
        }
    }

    impl Drop for Sampler {
        fn drop(&mut self) {
            unsafe {
                PdhCloseQuery(self.query);
            }
        }
    }

    /// "RuneLite" for …\RuneLite.exe.
    fn process_name(pid: u32) -> Option<String> {
        if pid == 0 {
            return None;
        }
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 1024];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size) != 0;
            CloseHandle(h);
            if !ok {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..size as usize]);
            std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(pid: u32, gpu_3d: f64, d3d_fullscreen: bool) -> Reading {
        Reading { pid, name: None, gpu_3d, d3d_fullscreen }
    }

    #[test]
    fn a_busy_app_in_front_is_a_game_but_never_us() {
        assert!(is_game(&reading(18800, 18.7, false), 1));
        assert!(!is_game(&reading(18800, 4.0, false), 1), "an idle browser isn't");
        assert!(!is_game(&reading(1, 60.0, false), 1), "our own stage isn't");
        assert!(!is_game(&reading(0, 0.0, false), 1), "no window in front");
        assert!(is_game(&reading(0, 0.0, true), 1), "exclusive fullscreen D3D counts outright");
    }

    #[test]
    fn the_latch_holds_through_a_brief_dip() {
        let mut l = Latch::default();
        assert!(!l.update(false));
        assert!(l.update(true));
        assert!(l.update(false), "one miss: still gaming");
        assert!(!l.update(false), "two misses: done");
        assert!(l.update(true));
    }

    #[test]
    fn counter_instance_names_give_their_pid() {
        assert_eq!(instance_pid("pid_18800_luid_0x00000000_0x0000D1C4_phys_0_eng_0_engtype_3D"), Some(18800));
        assert_eq!(instance_pid("luid_0x0_phys_0"), None);
    }

    /// `cargo test -p karaoke-desktop gaming -- --ignored --nocapture`:
    /// prints what's in front and its GPU share, plus the busiest 3D users.
    #[cfg(windows)]
    #[test]
    #[ignore = "reads this machine's live GPU counters"]
    fn live_sample() {
        let mut s = win::Sampler::new().expect("GPU Engine counters");
        std::thread::sleep(Duration::from_secs(2));
        let r = s.sample().expect("a reading");
        println!("in front: {:?} (pid {}) at {:.1}% 3D, d3d fullscreen: {}", r.name, r.pid, r.gpu_3d, r.d3d_fullscreen);
        println!("counts as a game: {}", is_game(&r, std::process::id()));
    }

    #[test]
    fn policies_round_trip() {
        for p in [GamePolicy::Cpu, GamePolicy::Pause, GamePolicy::Gpu] {
            assert_eq!(GamePolicy::from_u8(p.to_u8()), p);
        }
        assert_eq!(serde_json::to_string(&GamePolicy::Pause).unwrap(), "\"pause\"");
    }
}
