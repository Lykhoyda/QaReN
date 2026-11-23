// Synthetic private values an app may print to its console; never real data.
pub const VALUES: [&str; 2] = ["qa79.canary@example.test", "+12025550179"];

pub fn line() -> String {
    format!(
        "[Diagnostics] profile loaded (synthetic): {} {}",
        VALUES[0], VALUES[1]
    )
}

pub fn assert_absent(label: &str, text: &str) {
    for value in VALUES {
        assert!(!text.contains(value), "{label} holds {value}: {text}");
    }
}

// A failure that names a kept log carries a pointer to it, never its lines.
pub fn assert_log_pointer(
    receipt_json: &str,
    run_json: &[u8],
    log: &std::path::Path,
    log_words: &[&str],
) {
    let run_json = String::from_utf8_lossy(run_json);
    for (label, output) in [("receipt", receipt_json), ("run.json", run_json.as_ref())] {
        assert_absent(label, output);
        for words in log_words {
            assert!(!output.contains(words), "{label} holds {words:?}: {output}");
        }
        let value: serde_json::Value = serde_json::from_str(output).unwrap();
        assert!(
            value["failure"].get("evidence").is_none(),
            "{label}: {output}"
        );
        assert_eq!(
            value["failure"]["log"]["file"],
            log.display().to_string(),
            "{label}"
        );
    }
    let kept = std::fs::read_to_string(log).unwrap();
    for words in VALUES.iter().chain(log_words) {
        assert!(
            kept.contains(*words),
            "the kept log lacks {words:?}: {kept}"
        );
    }
}

pub fn assert_pointer_not_evidence(failure: serde_json::Value) {
    assert!(failure.get("evidence").is_none(), "{failure}");
    assert!(failure["log"]["file"].is_string(), "{failure}");
}
