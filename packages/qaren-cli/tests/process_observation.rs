use std::process::Command;

fn probe(args: &[&str]) -> (i32, serde_json::Value) {
    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .arg("--internal-process-observation")
        .args(args)
        .output()
        .unwrap();
    assert!(output.stderr.is_empty());
    let stdout = std::str::from_utf8(&output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1, "exactly one JSON line");
    assert!(stdout.ends_with('\n'));
    (
        output.status.code().unwrap(),
        serde_json::from_str(stdout).unwrap(),
    )
}

#[test]
fn invalid_requests_refuse_without_reflecting_input() {
    for args in [
        vec![],
        vec!["0"],
        vec!["-2"],
        vec!["123secret-invalid"],
        vec!["999999999999999999999999999"],
        vec!["123secret-invalid", "extra"],
        vec!["0", "--inspect-ios-paths"],
        vec!["1", "--argv", "--inspect-ios-paths"],
        vec!["1", "--inspect-ios-paths", "--argv"],
    ] {
        let (exit, value) = probe(&args);
        assert_eq!(exit, 4);
        assert_eq!(value, serde_json::json!({"v":1,"status":"unknown"}));
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .arg("--internal-process-observation")
            .arg(std::ffi::OsString::from_vec(b"secret\xff".to_vec()))
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(4));
        assert_eq!(output.stdout, b"{\"v\":1,\"status\":\"unknown\"}\n");
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn live_self_inspection_is_explicit_and_content_free() {
    let pid = std::process::id().to_string();
    let (exit, value) = probe(&[&pid, "--inspect-ios-paths"]);
    if cfg!(target_os = "macos") {
        assert_eq!(exit, 0);
        assert_eq!(value["pid"], std::process::id());
        assert_eq!(
            value["iosPathInspection"],
            serde_json::json!({"status":"complete","unresolvedPath":"absent"})
        );
        assert_eq!(value.as_object().unwrap().len(), 5);
        assert!(value.get("argv").is_none());
        assert!(value.to_string().len() < 8192);
    } else {
        assert_eq!(exit, 4);
        assert_eq!(value, serde_json::json!({"v":1,"status":"unknown"}));
    }
}

#[cfg(target_os = "macos")]
#[test]
fn oversized_node_arguments_are_inspected_without_exporting_the_program_or_environment() {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    for (mention, expected) in [("ordinary", "absent"), ("/tmp/WebDriverAgent", "present")] {
        let program = format!(
            "/*PRIVATE_PROGRAM_CANARY{} {mention} */process.stdout.write('ready\\n');process.stdin.resume();",
            "x".repeat(35_112)
        );
        let mut child = Command::new("node")
            .args(["-e", &program])
            .env("PRIVATE_ENV_CANARY", "/tmp/XCTRunner")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        let pid = child.id().to_string();
        let exact = probe(&[&pid, "--argv"]);
        let inspected = probe(&[&pid, "--inspect-ios-paths"]);
        drop(child.stdin.take());
        let exit = child.wait().unwrap();
        assert!(exit.success());
        assert_eq!(ready, "ready\n");
        assert_eq!(exact, (4, serde_json::json!({"v":1,"status":"unknown"})));
        assert_eq!(inspected.0, 0);
        assert_eq!(
            inspected.1["iosPathInspection"],
            serde_json::json!({"status":"complete","unresolvedPath":expected})
        );
        assert_eq!(inspected.1.as_object().unwrap().len(), 5);
        let json = inspected.1.to_string();
        assert!(json.len() < 8192);
        assert!(!json.contains("CANARY"));
        assert!(!json.contains(mention));
    }
}

#[test]
fn live_self_process_yields_only_path_and_birth_or_unknown_on_unsupported_hosts() {
    let pid = std::process::id().to_string();
    let (exit, value) = probe(&[&pid]);
    if cfg!(target_os = "macos") {
        assert_eq!(exit, 0, "macOS should observe the current test process");
        assert_eq!(value["v"], 1);
        assert_eq!(value["pid"], std::process::id());
        assert!(value["birth"]["seconds"].as_u64().unwrap() > 0);
        assert!(value["birth"]["micros"].as_u64().unwrap() < 1_000_000);
        assert!(value["executable"].as_str().unwrap().starts_with('/'));
        assert_eq!(value.as_object().unwrap().len(), 4);
    } else {
        assert_eq!(exit, 4);
        assert_eq!(value, serde_json::json!({"v":1,"status":"unknown"}));
    }
}
