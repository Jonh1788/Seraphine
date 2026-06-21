use std::process::Command;
fn run(dir: &str, args: &[&str]) { assert!(Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success()); }

#[test]
fn worktree_create_diff_merge_discard() {
    let tmp = std::env::temp_dir().join(format!("si-test-{}", std::process::id()));
    let root = tmp.to_str().unwrap();
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    run(root, &["init", "-q", "-b", "main"]);
    run(root, &["config", "user.email", "t@t"]); run(root, &["config", "user.name", "t"]);
    std::fs::write(tmp.join("a.txt"), "one\n").unwrap();
    run(root, &["add", "."]); run(root, &["commit", "-q", "-m", "init"]);
    run(root, &["worktree", "add", ".worktrees/selfimprove-x", "-b", "selfimprove/test", "HEAD"]);
    std::fs::write(tmp.join(".worktrees/selfimprove-x/a.txt"), "one\ntwo\n").unwrap();
    run(&format!("{root}/.worktrees/selfimprove-x"), &["commit", "-aqm", "change"]);
    let diff = Command::new("git").arg("-C").arg(root).args(["diff","--stat","main...selfimprove/test"]).output().unwrap();
    assert!(String::from_utf8_lossy(&diff.stdout).contains("a.txt"));
    run(root, &["switch", "main"]);
    run(root, &["merge", "--no-ff", "-m", "m", "selfimprove/test"]);
    assert_eq!(std::fs::read_to_string(tmp.join("a.txt")).unwrap(), "one\ntwo\n");
    std::fs::remove_dir_all(&tmp).ok();
}
