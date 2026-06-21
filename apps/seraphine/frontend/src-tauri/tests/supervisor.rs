use std::io::{BufRead, BufReader};
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
