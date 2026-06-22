//! Skills self-authoring v1: distill a successful agent run's trace into a draft
//! SKILL.md, then publish it under `~/.claude/skills/<slug>/SKILL.md`.
//!
//! Three commands:
//!   - `maestro_skill_extract` — one-shot `claude -p` over a run transcript, mirroring
//!     `selfimprove::maestro_si_review`'s spawn mechanics. Returns the model's raw
//!     stdout (a fenced ```json block); the TS layer parses it, Rust does not.
//!   - `maestro_skill_publish` — atomically writes a reviewed SKILL.md under the
//!     skills dir (trusted core; intentionally allowed to write there).
//!   - `maestro_skill_list` — lists published skill slugs.
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// `<home>/.claude/skills`. Resolves home the same way `observer.rs` reaches
/// `~/.claude` — but reads the `HOME` env var FIRST (at call time) so tests can
/// point it at a temp dir via `std::env::set_var("HOME", tmp)`. Falls back to
/// `dirs::home_dir()` (observer's mechanism), then `/` as a last resort.
fn skills_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"));
    home.join(".claude/skills")
}

/// kebab-case ascii slug, max 40 chars, never `..` or `/` — safe as a single path
/// segment under the skills dir. Mirrors `selfimprove::slugify` (reused directly so
/// the rule stays canonical). Exposed for the TS layer / tests to derive a slug
/// from a skill name; not called by the publish path (the client supplies the slug,
/// which `slug_is_safe` re-validates), hence the allow.
#[allow(dead_code)]
fn skill_slug(name: &str) -> String {
    crate::agents::selfimprove::slugify(name)
}

/// True when `slug` is a single, safe kebab path segment: non-empty, ascii
/// lowercase alphanumerics and `-` only, no `..`, no `/`. Rejects anything the
/// trusted publish path would otherwise let escape the skills dir.
fn slug_is_safe(slug: &str) -> bool {
    !slug.is_empty()
        && slug != ".."
        && !slug.contains('/')
        && !slug.contains("..")
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Distill a reusable skill from a successful agent run's transcript. One-shot
/// `claude -p` (print mode), prompt fed via stdin to dodge arg-length limits —
/// identical spawn mechanics to `maestro_si_review`. Read-only: `-p` without a
/// permission-prompt tool auto-denies any tool the model tries, so it works from
/// the transcript text alone. Blocks for the model round-trip.
///
/// Output contract (enforced by the prompt, parsed by the TS layer — NOT here):
/// the model returns EXACTLY ONE fenced ```json block:
///   {"reusable": bool, "confidence": 0.0-1.0, "name": "...", "slug": "...",
///    "skill_md": "<full superpowers SKILL.md>"}
/// with `reusable=false` when the run shows no reusable procedure.
#[tauri::command]
pub fn maestro_skill_extract(transcript: String) -> Result<String, String> {
    let transcript = transcript.trim();
    if transcript.is_empty() {
        return Err("transcript vazio".to_string());
    }
    // Bound the prompt: keep the HEAD of the transcript (where the goal + the early
    // structure of the procedure live). Snap to a char boundary so multibyte text
    // never panics. Same CAP/logic as `maestro_si_review`.
    const CAP: usize = 28000;
    let body = if transcript.len() > CAP {
        let mut end = CAP;
        while !transcript.is_char_boundary(end) {
            end -= 1;
        }
        format!(
            "{}\n\n…(transcript truncado em {CAP} caracteres)…",
            &transcript[..end]
        )
    } else {
        transcript.to_string()
    };
    let prompt = format!(
        "Você está destilando uma skill REUTILIZÁVEL a partir do trace de uma execução de agente que teve sucesso. \
Leia o trace abaixo. Se ele mostra um procedimento de múltiplos passos que valeria a pena reaplicar em execuções futuras, \
produza EXATAMENTE UM bloco cercado ```json e NADA mais (sem prosa antes ou depois):\n\
```json\n\
{{\"reusable\": true|false, \"confidence\": 0.0-1.0, \"name\": \"<nome curto>\", \"slug\": \"<kebab-case>\", \"skill_md\": \"<um SKILL.md completo no estilo superpowers>\"}}\n\
```\n\
O campo `skill_md` deve conter um SKILL.md COMPLETO: frontmatter YAML \
(--- name: / description: / status: draft / source: learned / confidence: <n> ---) \
seguido das seções ## When to Use / ## Procedure / ## Pitfalls / ## Verification.\n\
Se o trace NÃO contém um procedimento reutilizável, devolva o mesmo bloco JSON com \"reusable\": false.\n\
PORTABILIDADE (obrigatório): a skill precisa funcionar em QUALQUER máquina — \
NÃO inclua hostnames, caminhos absolutos, nem session ids fixos no skill_md.\n\n\
--- TRACE DA EXECUÇÃO ---\n{body}"
    );
    let mut child = Command::new(crate::agents::claude_bin())
        .arg("-p")
        .arg("--setting-sources")
        .arg("")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("claude falhou ao iniciar: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("sem stdin")?
        .write_all(prompt.as_bytes())
        .map_err(|e| format!("write prompt: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("claude -p: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude -p erro: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Publish a reviewed SKILL.md to `<skills_dir>/<slug>/SKILL.md`. TRUSTED core:
/// it is intentional that this writes under `~/.claude/skills`. The slug is
/// validated to a single safe path segment first (rejects `..`, `/`, empty) so
/// it can never escape the skills dir. The file is written ATOMICALLY — to a temp
/// file in the same dir, then `rename` over `SKILL.md` — so a reader never sees a
/// half-written skill, and re-publishing is idempotent (overwrites in place).
/// Returns the absolute path of the written SKILL.md.
#[tauri::command]
pub fn maestro_skill_publish(slug: String, skill_md: String) -> Result<String, String> {
    if !slug_is_safe(&slug) {
        return Err(format!("slug inválido: {slug:?} (esperado kebab-case ascii, sem '/' nem '..')"));
    }
    let dir = skills_dir().join(&slug);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all {dir:?}: {e}"))?;
    let final_path = dir.join("SKILL.md");
    // Atomic write: temp file in the SAME dir (so rename stays on one filesystem),
    // then rename over the destination. Temp name is pid-scoped to avoid clashes
    // between concurrent publishes of the same slug.
    let tmp_path = dir.join(format!(".SKILL.md.{}.tmp", std::process::id()));
    std::fs::write(&tmp_path, skill_md.as_bytes())
        .map_err(|e| format!("write {tmp_path:?}: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp_path, &final_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("rename {tmp_path:?} -> {final_path:?}: {e}"));
    }
    Ok(final_path.to_string_lossy().to_string())
}

/// List published skill slugs: immediate subdirs of `skills_dir()` that contain a
/// `SKILL.md`. Returns an empty Vec (NOT an error) when the skills dir doesn't
/// exist yet, so a fresh install lists cleanly.
#[tauri::command]
pub fn maestro_skill_list() -> Result<Vec<String>, String> {
    let base = skills_dir();
    let entries = match std::fs::read_dir(&base) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    let mut slugs = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        if !p.join("SKILL.md").is_file() {
            continue;
        }
        if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
            slugs.push(name.to_string());
        }
    }
    slugs.sort();
    Ok(slugs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // The HOME-mutating tests share one process-global env var (`HOME`), which Rust's
    // default parallel test runner would let them clobber for each other. Serialize
    // them behind this lock so each sets HOME, does its work, and restores it without
    // a sibling test observing a half-changed environment. (Tests that never touch
    // HOME — e.g. `slug_*` — don't take the lock and stay parallel.)
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    /// RAII: point HOME at `tmp`, restore the previous value (or unset) on drop, even
    /// if the test panics — so a failing test can't poison HOME for the next one.
    struct HomeGuard {
        prev: Option<std::ffi::OsString>,
    }
    impl HomeGuard {
        fn set(tmp: &std::path::Path) -> Self {
            let prev = std::env::var_os("HOME");
            std::env::set_var("HOME", tmp);
            HomeGuard { prev }
        }
    }
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    fn unique_tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "skills-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ))
    }

    #[test]
    fn slug_is_kebab_capped_and_ascii() {
        assert_eq!(skill_slug("Deploy to the VPS!"), "deploy-to-the-vps");
        assert_eq!(skill_slug("  a/b  c  "), "a-b-c");
        assert_eq!(skill_slug("你好"), "session");
        assert_eq!(skill_slug(""), "session");
        // Capped at 40 chars.
        let long = "a".repeat(100);
        assert!(skill_slug(&long).len() <= 40);
    }

    #[test]
    fn slug_safety_rejects_traversal_and_separators() {
        assert!(slug_is_safe("my-skill"));
        assert!(slug_is_safe("a1-b2"));
        assert!(!slug_is_safe(""));
        assert!(!slug_is_safe(".."));
        assert!(!slug_is_safe("../evil"));
        assert!(!slug_is_safe("a/b"));
        assert!(!slug_is_safe("a..b"));
        assert!(!slug_is_safe("Has-Caps")); // uppercase not kebab-ascii
    }

    #[test]
    fn publish_writes_skill_md_under_home() {
        let _g = HOME_LOCK.lock().unwrap();
        let tmp = unique_tmp("publish");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let _home = HomeGuard::set(&tmp);

        let md = "---\nname: x\nstatus: draft\n---\n## When to Use\n...\n";
        let path = maestro_skill_publish("my-skill".into(), md.into()).unwrap();
        let expected = tmp.join(".claude/skills/my-skill/SKILL.md");
        assert_eq!(path, expected.to_string_lossy());
        assert!(expected.is_file(), "SKILL.md should exist at {expected:?}");
        assert_eq!(std::fs::read_to_string(&expected).unwrap(), md);

        // Re-publish overwrites in place (idempotent), leaving no temp files behind.
        let md2 = "---\nname: x2\n---\n## When to Use\nupdated\n";
        let path2 = maestro_skill_publish("my-skill".into(), md2.into()).unwrap();
        assert_eq!(path2, path);
        assert_eq!(std::fs::read_to_string(&expected).unwrap(), md2);
        let leftovers: Vec<_> = std::fs::read_dir(tmp.join(".claude/skills/my-skill"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp files should remain after rename");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn list_returns_published_slugs_and_empty_when_absent() {
        let _g = HOME_LOCK.lock().unwrap();
        let tmp = unique_tmp("list");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let _home = HomeGuard::set(&tmp);

        // No skills dir yet → empty Vec, not an error.
        assert_eq!(maestro_skill_list().unwrap(), Vec::<String>::new());

        maestro_skill_publish("alpha".into(), "md".into()).unwrap();
        maestro_skill_publish("beta".into(), "md".into()).unwrap();
        // A bare subdir without SKILL.md must NOT be listed.
        std::fs::create_dir_all(tmp.join(".claude/skills/no-skill-here")).unwrap();

        let list = maestro_skill_list().unwrap();
        assert!(list.contains(&"alpha".to_string()));
        assert!(list.contains(&"beta".to_string()));
        assert!(
            !list.contains(&"no-skill-here".to_string()),
            "dir without SKILL.md is excluded"
        );

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn publish_rejects_bad_slug_and_writes_nothing() {
        let _g = HOME_LOCK.lock().unwrap();
        let tmp = unique_tmp("badslug");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let _home = HomeGuard::set(&tmp);

        for bad in ["../evil", "a/b", "", ".."] {
            let r = maestro_skill_publish(bad.into(), "payload".into());
            assert!(r.is_err(), "slug {bad:?} should be rejected");
        }
        // Nothing was written anywhere under HOME (the skills dir was never created).
        assert!(
            !tmp.join(".claude/skills").exists(),
            "rejected publishes must not create the skills dir or any file"
        );

        std::fs::remove_dir_all(&tmp).ok();
    }
}
