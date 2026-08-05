//! Streaming feed logic: pull interleaved stereo input at a (possibly changing)
//! rate per fixed-size output block. Rate = input frames consumed per output
//! frame (1.0 = no tempo change, 0.8 = slower playback... no: 0.8 means for
//! each output frame we consume 0.8 input frames, i.e. playback is SLOWER
//! (output is longer). "tempo 1.2x" (faster) = rate 1.2.

pub struct Feeder<'a> {
    samples: &'a [f32], // interleaved stereo
    cursor_frames: usize,
    acc: f64,
}

impl<'a> Feeder<'a> {
    pub fn new(samples: &'a [f32]) -> Self {
        assert_eq!(samples.len() % 2, 0);
        Self { samples, cursor_frames: 0, acc: 0.0 }
    }

    pub fn total_frames(&self) -> usize {
        self.samples.len() / 2
    }

    /// Input slice for `out_frames` output frames at `rate`; advances cursor.
    /// May return fewer frames than requested near the end of input.
    pub fn take(&mut self, out_frames: usize, rate: f64) -> &'a [f32] {
        self.acc += out_frames as f64 * rate;
        let n = self.acc.floor().max(0.0) as usize;
        self.acc -= n as f64;
        let total = self.total_frames();
        let start = self.cursor_frames.min(total);
        let end = (start + n).min(total);
        self.cursor_frames = end;
        &self.samples[start * 2..end * 2]
    }

    pub fn done(&self) -> bool {
        self.cursor_frames >= self.total_frames()
    }
}
