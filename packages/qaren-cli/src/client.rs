use crate::exec::Runner;

pub struct Client {
    pub harness: &'static str,
    pub markers: Vec<&'static str>,
    pub model: Option<String>,
}

pub fn detect(runner: &dyn Runner) -> Client {
    let is = |key, value| runner.env_var(key).as_deref() == Some(value);
    let claims = [
        (
            "cursor",
            is("CURSOR_AGENT", "1") || is("CURSOR_INVOKED_AS", "cursor-agent"),
        ),
        ("gemini", is("GEMINI_CLI", "1")),
        (
            "rovo",
            is("ATLASSIAN_AGENT_TYPE", "rovo") || is("ROVODEV_CLI", "1"),
        ),
        ("claude", is("CLAUDECODE", "1")),
        ("pi", is("PI_CODING_AGENT", "true")),
        ("grok", is("GROK_AGENT", "1")),
        ("codex", runner.env_var("CODEX_THREAD_ID").is_some()),
    ];
    let markers: Vec<_> = claims
        .into_iter()
        .filter_map(|(name, present)| present.then_some(name))
        .collect();
    let harness = markers.first().copied().unwrap_or("unknown");
    let model = (harness == "pi")
        .then(|| runner.env_var("PI_MODEL"))
        .flatten();
    Client {
        harness,
        markers,
        model,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::MockRunner;

    #[test]
    fn own_markers_choose_the_first_harness_and_keep_all_claims() {
        for (environment, harness, markers, model) in [
            (
                vec![
                    ("CLAUDECODE", "1"),
                    ("CLAUDE_CODE_SESSION_ID", "private/session key"),
                ],
                "claude",
                vec!["claude"],
                None,
            ),
            (
                vec![("CURSOR_AGENT", "1"), ("CLAUDECODE", "1")],
                "cursor",
                vec!["cursor", "claude"],
                None,
            ),
            (
                vec![("CURSOR_INVOKED_AS", "cursor-agent")],
                "cursor",
                vec!["cursor"],
                None,
            ),
            (vec![("GEMINI_CLI", "1")], "gemini", vec!["gemini"], None),
            (
                vec![("ATLASSIAN_AGENT_TYPE", "rovo")],
                "rovo",
                vec!["rovo"],
                None,
            ),
            (vec![("ROVODEV_CLI", "1")], "rovo", vec!["rovo"], None),
            (
                vec![("PI_CODING_AGENT", "true"), ("PI_MODEL", "m")],
                "pi",
                vec!["pi"],
                Some("m"),
            ),
            (vec![("GROK_AGENT", "1")], "grok", vec!["grok"], None),
            (
                vec![("CODEX_THREAD_ID", "private/session key")],
                "codex",
                vec!["codex"],
                None,
            ),
            (
                vec![("AI_AGENT", "claude"), ("PI_MODEL", "unclaimed")],
                "unknown",
                vec![],
                None,
            ),
            (
                vec![("CLAUDECODE", "true"), ("PI_CODING_AGENT", "1")],
                "unknown",
                vec![],
                None,
            ),
        ] {
            let mut runner = MockRunner::new();
            runner.environment = environment
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect();
            let client = detect(&runner);
            assert_eq!(client.harness, harness);
            assert_eq!(client.markers, markers);
            assert_eq!(client.model.as_deref(), model);
        }
    }
}
