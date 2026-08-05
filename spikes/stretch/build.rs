fn main() {
    println!("cargo:rerun-if-changed=vendor/wrapper.cpp");
    println!("cargo:rerun-if-changed=vendor/wrapper.h");
    println!("cargo:rerun-if-changed=vendor/signalsmith-stretch/signalsmith-stretch.h");

    cc::Build::new()
        .cpp(true)
        .std("c++14")
        .flag_if_supported("/EHsc")
        .file("vendor/wrapper.cpp")
        .include("vendor")
        .include("vendor/signalsmith-stretch")
        .compile("signalsmith_stretch_wrapper");
}
