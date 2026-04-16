//! Build script — compiles the Swift HealthKit bridge into a static
//! library, emits linker flags so the Tauri binary picks it up, and
//! runs the standard tauri-build step.

use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    compile_healthkit_bridge();
    tauri_build::build();
}

fn compile_healthkit_bridge() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let swift_src = manifest_dir.join("swift").join("HealthKitBridge.swift");
    if !swift_src.exists() {
        println!(
            "cargo:warning=Swift HealthKit bridge not found at {}",
            swift_src.display()
        );
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let lib_path = out_dir.join("libseraphine_healthkit.a");

    println!("cargo:rerun-if-changed={}", swift_src.display());

    // Resolve the Rust target triple to a Swift target + SDK. On iOS,
    // we also need to pass `-sdk <path>` so swiftc picks up UIKit/
    // HealthKit headers from the correct SDK (iphoneos vs iphonesimulator).
    let target = env::var("TARGET").unwrap_or_default();
    let (swift_target, sdk_name_opt): (&str, Option<&str>) = match target.as_str() {
        "aarch64-apple-darwin" => ("arm64-apple-macos13.0", None),
        "x86_64-apple-darwin" => ("x86_64-apple-macos13.0", None),
        "aarch64-apple-ios" => ("arm64-apple-ios14.0", Some("iphoneos")),
        "aarch64-apple-ios-sim" => ("arm64-apple-ios14.0-simulator", Some("iphonesimulator")),
        "x86_64-apple-ios" => ("x86_64-apple-ios14.0-simulator", Some("iphonesimulator")),
        _ => ("arm64-apple-macos13.0", None),
    };

    let mut cmd = Command::new("swiftc");
    cmd.args([
        "-emit-library",
        "-static",
        "-parse-as-library",
        "-O",
        "-target",
        swift_target,
        "-module-name",
        "SeraphineHealthKit",
    ]);

    // iOS requires explicit SDK path; macOS uses the default one.
    if let Some(sdk) = sdk_name_opt {
        let sdk_path = Command::new("xcrun")
            .args(["--sdk", sdk, "--show-sdk-path"])
            .output()
            .expect("xcrun --show-sdk-path failed");
        let path = String::from_utf8_lossy(&sdk_path.stdout).trim().to_string();
        cmd.args(["-sdk", &path]);
    }

    let status = cmd
        .arg("-o")
        .arg(&lib_path)
        .arg(&swift_src)
        .status()
        .expect("failed to invoke swiftc — ensure Xcode command-line tools are installed");

    if !status.success() {
        panic!("swiftc failed with status {status}");
    }

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=seraphine_healthkit");
    println!("cargo:rustc-link-lib=framework=HealthKit");
    println!("cargo:rustc-link-lib=framework=Foundation");
    // Swift runtime: macOS has it at /usr/lib/swift; iOS bundles it
    // into the app via Xcode. Only need to hint the linker on macOS.
    if sdk_name_opt.is_none() {
        println!("cargo:rustc-link-search=/usr/lib/swift");
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
