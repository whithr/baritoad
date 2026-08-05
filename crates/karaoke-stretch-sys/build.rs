//! Compiles the vendored Signalsmith Stretch C wrapper (see vendor/README
//! trail: signalsmith-stretch + signalsmith-linear headers are MIT from
//! Signalsmith Audio; wrapper.{h,cpp} is the MIT C wrapper from
//! colinmarc/signalsmith-stretch-rs v0.1.3, vendored with one patch — see
//! wrapper.cpp `signalsmith_stretch_set_formant_base`).
//!
//! FFI bindings are hand-written in src/lib.rs (the published crate needs
//! bindgen → libclang, absent on the dev box; the ~30-line extern block is
//! smaller than that toolchain — spikes/stretch/REPORT.md §4 item 4).

fn main() {
    println!("cargo:rerun-if-changed=vendor/wrapper.cpp");
    println!("cargo:rerun-if-changed=vendor/wrapper.h");
    println!("cargo:rerun-if-changed=vendor/signalsmith-stretch/signalsmith-stretch.h");
    println!("cargo:rerun-if-changed=vendor/signalsmith-linear/stft.h");
    println!("cargo:rerun-if-changed=vendor/signalsmith-linear/fft.h");

    cc::Build::new()
        .cpp(true)
        .std("c++14")
        .flag_if_supported("/EHsc")
        .file("vendor/wrapper.cpp")
        .include("vendor")
        .include("vendor/signalsmith-stretch")
        .compile("signalsmith_stretch_wrapper");
}
