use std::io::{BufRead, BufReader, Write as _};
use std::process::{Command, Stdio};
#[test]
fn fake_agent_streams_result_line() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let mut c = Command::new(format!("{dir}/tests/fixtures/agent/fake_agent.sh"))
        .arg(format!("{dir}/tests/fixtures/agent/basic_run.jsonl"))
        .stdout(Stdio::piped()).spawn().unwrap();
    let out = c.stdout.take().unwrap();
    let lines: Vec<String> = BufReader::new(out).lines().map_while(Result::ok).collect();
    c.wait().unwrap();
    assert!(lines.iter().any(|l| l.contains("\"type\":\"result\"")), "expected a result line");
}

#[test]
fn fake_agent_permission_round_trip() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let mut c = Command::new(format!("{dir}/tests/fixtures/agent/fake_agent.sh"))
        .arg(format!("{dir}/tests/fixtures/agent/permission_request.jsonl"))
        .arg("--wait-stdin-after").arg("6")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    c.stdin.take().unwrap().write_all(b"{\"type\":\"control_response\"}\n").unwrap();
    let out = c.stdout.take().unwrap();
    let n = BufReader::new(out).lines().map_while(Result::ok).count();
    c.wait().unwrap();
    let total = std::fs::read_to_string(format!("{dir}/tests/fixtures/agent/permission_request.jsonl")).unwrap().lines().count();
    assert_eq!(n, total, "all fixture lines should stream (no line swallowed)");
}
