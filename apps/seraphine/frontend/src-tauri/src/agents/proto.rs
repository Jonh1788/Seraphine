//! Parsing of claude's --output-format stream-json lines into tagged events.
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEventKind {
    Init { session_id: Option<String> },
    Assistant,
    Result,
    PermissionRequest { request_id: String, tool: String },
    Other,
}

/// Classify a parsed stream-json line. Shapes per tests/fixtures/agent/README.md.
pub fn classify(v: &Value) -> AgentEventKind {
    match v.get("type").and_then(Value::as_str) {
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
            AgentEventKind::Init { session_id: v.get("session_id").and_then(Value::as_str).map(String::from) }
        }
        Some("assistant") => AgentEventKind::Assistant,
        Some("result") => AgentEventKind::Result,
        Some("control_request")
            if v.get("request").and_then(|r| r.get("subtype")).and_then(Value::as_str) == Some("can_use_tool") =>
        {
            let req = v.get("request").unwrap_or(v);
            let request_id = v.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
            let tool = req.get("tool_name").and_then(Value::as_str).unwrap_or("").to_string();
            AgentEventKind::PermissionRequest { request_id, tool }
        }
        _ => AgentEventKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn classifies_real_shapes() {
        assert_eq!(classify(&json!({"type":"system","subtype":"init","session_id":"abc"})),
                   AgentEventKind::Init { session_id: Some("abc".into()) });
        assert_eq!(classify(&json!({"type":"assistant","message":{}})), AgentEventKind::Assistant);
        assert_eq!(classify(&json!({"type":"result","subtype":"success"})), AgentEventKind::Result);
        let perm = classify(&json!({"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Write"}}));
        assert_eq!(perm, AgentEventKind::PermissionRequest { request_id: "r1".into(), tool: "Write".into() });
        // initialize control_request must NOT classify as a permission ask:
        assert_eq!(classify(&json!({"type":"control_request","request_id":"i","request":{"subtype":"initialize"}})), AgentEventKind::Other);
    }
}
