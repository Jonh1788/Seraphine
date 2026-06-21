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

#[test]
fn merge_conflict_aborts_clean() {
    let tmp = std::env::temp_dir().join(format!("si-conflict-{}", std::process::id()));
    let root = tmp.to_str().unwrap();
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    run(root, &["init", "-q", "-b", "main"]);
    run(root, &["config", "user.email", "t@t"]); run(root, &["config", "user.name", "t"]);
    std::fs::write(tmp.join("a.txt"), "base\n").unwrap();
    run(root, &["add", "."]); run(root, &["commit", "-qm", "init"]);
    // branch edits line; main edits same line differently -> conflict
    run(root, &["worktree", "add", ".worktrees/selfimprove-c", "-b", "selfimprove/conf", "HEAD"]);
    std::fs::write(tmp.join(".worktrees/selfimprove-c/a.txt"), "from-branch\n").unwrap();
    run(&format!("{root}/.worktrees/selfimprove-c"), &["commit", "-aqm", "branch edit"]);
    std::fs::write(tmp.join("a.txt"), "from-main\n").unwrap();
    run(root, &["commit", "-aqm", "main edit"]);
    // production sequence: switch main (already there) + merge --no-ff; expect failure, then abort
    let merge = std::process::Command::new("git").arg("-C").arg(root)
        .args(["merge", "--no-ff", "-m", "m", "selfimprove/conf"]).output().unwrap();
    assert!(!merge.status.success(), "merge should conflict");
    run(root, &["merge", "--abort"]);
    // tree must be clean after abort (ignore the untracked .worktrees/ scaffolding,
    // which is gitignored in the real repo but not in this throwaway one)
    let status = std::process::Command::new("git").arg("-C").arg(root)
        .args(["status", "--porcelain"]).output().unwrap();
    let stdout = String::from_utf8_lossy(&status.stdout);
    let dirty: Vec<&str> = stdout.lines()
        .filter(|l| !l.contains(".worktrees/") && !l.trim().is_empty()).collect();
    assert!(dirty.is_empty(), "tree not clean after abort: {dirty:?}");
    assert!(!tmp.join(".git/MERGE_HEAD").exists(), "MERGE_HEAD left behind");
    std::fs::remove_dir_all(&tmp).ok();
}
