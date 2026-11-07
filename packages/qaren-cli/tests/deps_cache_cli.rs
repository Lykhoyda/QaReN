mod common;

#[test]
fn cache_cleanup_has_no_run_target_and_never_touches_devices() {
    let root = common::temp_repo();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_qaren"))
        .args(["cleanup", "--deps-cache", "--json"])
        .env("QAREN_HOME", root.join("task-home"))
        .env("HOME", &root)
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["result"], "cleaned");
    assert_eq!(receipt["commands_executed"], 0);
    for args in [
        ["cleanup", "run-id", "--deps-cache"],
        ["check", "--deps-cache", "--json"],
    ] {
        let invalid = std::process::Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(invalid.status.code(), Some(2));
    }
    std::fs::remove_dir_all(root).unwrap();
}
