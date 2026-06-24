//! Telemetry — Apple-Silicon power sampler (Task 4).
//!
//! Exposes a single `read_power()` command that, on macOS, shells out to
//! `powermetrics` to read instantaneous CPU / GPU / package power draw in
//! milliwatts. `powermetrics` REQUIRES root, so we invoke it via
//! `sudo -n` (non-interactive): if there's no passwordless sudoers entry
//! it fails immediately instead of hanging on a password prompt.
//!
//! The contract is deliberately soft: every failure path (non-mac, no
//! sudo, spawn error, parse miss) degrades to `{ "supported": false }`
//! (optionally with a short `"error"`). The frontend treats ANY
//! error/unsupported as `{ supported: false }`, so this never breaks the
//! UI and never panics.

use serde_json::{json, Value};

/// Sample instantaneous power draw on Apple Silicon via `powermetrics`.
/// Returns `{supported, cpu_mw?, gpu_mw?, package_mw?, error?}`. Never
/// errors hard: any failure (non-mac, no sudo, parse miss) yields
/// `{supported:false,...}`.
#[tauri::command]
pub fn read_power() -> Value {
    #[cfg(target_os = "macos")]
    {
        sample_macos()
    }
    #[cfg(not(target_os = "macos"))]
    {
        json!({ "supported": false })
    }
}

/// macOS implementation: run `powermetrics` (via passwordless sudo) for a
/// single ~200ms sample of cpu/gpu power and parse the result. Any failure
/// to spawn, a non-zero exit, or empty stdout degrades to unsupported.
#[cfg(target_os = "macos")]
fn sample_macos() -> Value {
    use std::process::Command;

    // `-n 1`  → exactly one sample, then exit (bounds runtime).
    // `-i 200` → 200ms sampling interval.
    // `sudo -n` → non-interactive: fail fast if no passwordless sudoers
    //             entry instead of blocking on a password prompt.
    let output = Command::new("sudo")
        .arg("-n")
        .arg("powermetrics")
        .arg("-n")
        .arg("1")
        .arg("-i")
        .arg("200")
        .arg("--samplers")
        .arg("cpu_power,gpu_power")
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            return json!({
                "supported": false,
                "error": format!("failed to spawn powermetrics: {}", e),
            });
        }
    };

    if !output.status.success() {
        // Most commonly: `sudo -n` could not authenticate without a
        // password (no passwordless sudoers entry for powermetrics).
        return json!({
            "supported": false,
            "error": "powermetrics requires passwordless sudo",
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return json!({
            "supported": false,
            "error": "powermetrics produced no output",
        });
    }

    parse_power(&stdout)
}

/// Pure parser over `powermetrics` stdout. Scans each line for the three
/// power readings and returns the JSON contract. Factored out so it can be
/// unit-tested without root / a live `powermetrics` call.
///
/// powermetrics emits lines such as:
///   `CPU Power: 1234 mW`
///   `GPU Power: 567 mW`
///   `Combined Power (CPU + GPU + ANE): 1801 mW`   (or `Package Power: …`)
///
/// Missing readings serialize as JSON `null`. If NONE of the three parse,
/// the output is treated as unsupported.
fn parse_power(stdout: &str) -> Value {
    let mut cpu: Option<u64> = None;
    let mut gpu: Option<u64> = None;
    let mut package: Option<u64> = None;

    for line in stdout.lines() {
        // Order matters: check "CPU Power:" / "GPU Power:" before the
        // generic "Power" combined/package lines. The combined line label
        // does not contain "CPU Power:" / "GPU Power:" substrings, so the
        // checks are mutually exclusive in practice.
        if line.contains("CPU Power:") {
            if let Some(v) = extract_mw(line) {
                cpu = Some(v);
            }
        } else if line.contains("GPU Power:") {
            if let Some(v) = extract_mw(line) {
                gpu = Some(v);
            }
        } else if line.contains("Combined Power") || line.contains("Package Power") {
            if let Some(v) = extract_mw(line) {
                package = Some(v);
            }
        }
    }

    if cpu.is_none() && gpu.is_none() && package.is_none() {
        return json!({
            "supported": false,
            "error": "could not parse powermetrics output",
        });
    }

    json!({
        "supported": true,
        "cpu_mw": cpu,
        "gpu_mw": gpu,
        "package_mw": package,
    })
}

/// Extract the milliwatt integer from a power line: take the substring
/// after the first ':', then find the first integer token (digits only,
/// ignoring a trailing "mW" unit). Returns `None` if no integer is found.
fn extract_mw(line: &str) -> Option<u64> {
    let after_colon = line.split_once(':').map(|(_, rest)| rest).unwrap_or(line);
    for token in after_colon.split_whitespace() {
        // Strip a trailing unit if it's glued to the number (defensive);
        // typically the unit is whitespace-separated ("1234 mW").
        let digits: String = token.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            if let Ok(v) = digits.parse::<u64>() {
                return Some(v);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "*** Sampled system activity ***\n\
CPU Power: 1234 mW\n\
GPU Power: 567 mW\n\
Combined Power (CPU + GPU + ANE): 1801 mW\n";

    #[test]
    fn parses_full_sample() {
        let v = parse_power(SAMPLE);
        assert_eq!(v["supported"], json!(true));
        assert_eq!(v["cpu_mw"], json!(1234));
        assert_eq!(v["gpu_mw"], json!(567));
        assert_eq!(v["package_mw"], json!(1801));
    }

    #[test]
    fn parses_package_power_label() {
        let s = "CPU Power: 100 mW\nGPU Power: 50 mW\nPackage Power: 175 mW\n";
        let v = parse_power(s);
        assert_eq!(v["supported"], json!(true));
        assert_eq!(v["package_mw"], json!(175));
    }

    #[test]
    fn missing_fields_serialize_as_null() {
        // Only CPU present — gpu/package should be JSON null but still
        // supported because at least one reading parsed.
        let v = parse_power("CPU Power: 999 mW\n");
        assert_eq!(v["supported"], json!(true));
        assert_eq!(v["cpu_mw"], json!(999));
        assert!(v["gpu_mw"].is_null());
        assert!(v["package_mw"].is_null());
    }

    #[test]
    fn combined_line_not_misclassified_as_cpu_or_gpu() {
        // The combined label contains "CPU + GPU" but NOT "CPU Power:" /
        // "GPU Power:", so it must only populate package — verify a sample
        // with ONLY the combined line leaves cpu/gpu null.
        let v = parse_power("Combined Power (CPU + GPU + ANE): 1801 mW\n");
        assert_eq!(v["supported"], json!(true));
        assert!(v["cpu_mw"].is_null());
        assert!(v["gpu_mw"].is_null());
        assert_eq!(v["package_mw"], json!(1801));
    }

    #[test]
    fn garbage_is_unsupported() {
        let v = parse_power("this is not powermetrics output\nnothing to see here\n");
        assert_eq!(v["supported"], json!(false));
        assert!(v.get("error").is_some());
    }

    #[test]
    fn empty_is_unsupported() {
        let v = parse_power("");
        assert_eq!(v["supported"], json!(false));
    }

    #[test]
    fn extract_mw_basics() {
        assert_eq!(extract_mw("CPU Power: 1234 mW"), Some(1234));
        assert_eq!(extract_mw("Combined Power (CPU + GPU + ANE): 1801 mW"), Some(1801));
        assert_eq!(extract_mw("CPU Power: mW"), None);
        assert_eq!(extract_mw("no colon here"), None);
    }
}
