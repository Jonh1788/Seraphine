//! Permission policy: given a mode and a tool name, decide auto-allow,
//! auto-deny, or escalate-to-user.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Decision { Allow, Deny, Escalate }

#[derive(Clone, Copy)]
pub enum Mode { AskAll, AutoReads, FullAuto }

const READ_TOOLS: &[&str] = &["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "NotebookRead"];

pub fn decide(mode: Mode, tool: &str) -> Decision {
    match mode {
        Mode::FullAuto => Decision::Allow,
        Mode::AskAll => Decision::Escalate,
        Mode::AutoReads => if READ_TOOLS.contains(&tool) { Decision::Allow } else { Decision::Escalate },
    }
}

/// Map the frontend policy string to a Mode (default: AskAll).
pub fn parse_mode(s: &str) -> Mode {
    match s { "full_auto" => Mode::FullAuto, "auto_reads" => Mode::AutoReads, _ => Mode::AskAll }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modes_behave() {
        assert_eq!(decide(Mode::FullAuto, "Bash"), Decision::Allow);
        assert_eq!(decide(Mode::AskAll, "Read"), Decision::Escalate);
        assert_eq!(decide(Mode::AutoReads, "Read"), Decision::Allow);
        assert_eq!(decide(Mode::AutoReads, "Write"), Decision::Escalate);
    }
    #[test]
    fn parse_mode_maps() {
        assert!(matches!(parse_mode("full_auto"), Mode::FullAuto));
        assert!(matches!(parse_mode("auto_reads"), Mode::AutoReads));
        assert!(matches!(parse_mode("anything_else"), Mode::AskAll));
    }
}
