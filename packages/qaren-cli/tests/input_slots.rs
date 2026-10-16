mod common;
use qaren::core::Budgets;
use qaren::exec::{CmdOutput, CmdSpec, MockRunner, RealRunner, Runner};
use qaren::failure::FailureCode;
use qaren::receipt::ReceiptResult;
use qaren::redact::{with_input_scope, InputValues};
use qaren::run::{PrTarget, RunRequest};
use qaren::scenario::Platform;
use std::ffi::OsString;
use std::sync::Arc;

fn owner(entries: &[(&str, &str)]) -> Arc<InputValues> {
    Arc::new(InputValues::from_entries(entries.iter().map(
        |(key, value)| (OsString::from(key), OsString::from(value)),
    )))
}

#[test]
fn admission_preserves_exact_values_and_refuses_missing_before_invalid() {
    let inputs = owner(&[
        ("QAREN_INPUT_PASSWORD", "  exact whitespace  "),
        ("QAREN_INPUT_UNUSED", "op://not-resolved"),
    ]);
    let admitted = inputs.admit(&["PASSWORD".into()]).unwrap();
    let mut bytes = Vec::new();
    admitted
        .write_private(
            &mut bytes,
            &serde_json::json!({"phase":"plan-preflight"}),
            None,
        )
        .unwrap();
    let wire: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        wire["inputs"],
        serde_json::json!({"PASSWORD":"  exact whitespace  "})
    );
    assert_eq!(wire["inputProtocol"], 1);
    for value in [
        "op://secret",
        "vault:item",
        "${REF}",
        "$(cmd)",
        "{{REF}}",
        "\n",
        "\t",
        "\u{7f}",
    ] {
        let input = owner(&[("QAREN_INPUT_PASSWORD", value)]);
        assert_eq!(
            input.admit(&["PASSWORD".into()]).err().unwrap().code,
            FailureCode::CoreRefused
        );
        let error = input
            .admit(&["PASSWORD".into(), "USERNAME".into()])
            .err()
            .unwrap();
        assert_eq!(error.code, FailureCode::PlanInputMissing);
        assert!(!error.detail.contains(value));
    }
    use std::os::unix::ffi::OsStringExt;
    let inputs = InputValues::from_entries([(
        OsString::from("QAREN_INPUT_PASSWORD"),
        OsString::from_vec(vec![0xff]),
    )]);
    assert_eq!(
        inputs.admit(&["PASSWORD".into()]).err().unwrap().code,
        FailureCode::CoreRefused
    );
}

#[test]
fn missing_check_and_pr_inputs_refuse_before_device_run_claim_or_worktree_allocation() {
    for pr in [false, true] {
        let repo = common::temp_repo();
        let app = repo.join("test-app");
        std::fs::create_dir_all(app.join(".qaren")).unwrap();
        std::fs::write(
            app.join(".qaren/config.yaml"),
            "appId: com.test\nmetroPort: 8791\ndevClientScheme: test\n",
        )
        .unwrap();
        std::fs::write(
            app.join("plan.md"),
            "1. Fill \"password\" with input PASSWORD\n",
        )
        .unwrap();
        let mut runner = MockRunner::new();
        runner.expect_run("node --version", CmdOutput::success("v24.14.0\n"));
        if pr {
            runner.expect_run(
                "rev-parse --show-toplevel",
                CmdOutput::success(repo.to_str().unwrap()),
            );
            runner.expect_run("gh pr view", CmdOutput::success(&serde_json::json!({"number":12,"url":"https://github.com/o/r/pull/12","headRefOid":"b".repeat(40),"headRefName":"feature","isCrossRepository":false}).to_string()));
            runner.expect_run("fetch origin", CmdOutput::success(""));
            runner.expect_run(
                "rev-parse refs/qaren/pr/",
                CmdOutput::success(&"b".repeat(40)),
            );
            runner.expect_run("update-ref -d", CmdOutput::success(""));
        }
        runner.expect_run(
            "--preflight-stdin",
            CmdOutput::success(
                r#"{"ok":true,"inputProtocol":1,"requiredInputs":["PASSWORD","USERNAME"]}"#,
            ),
        );
        let req = RunRequest {
            project_root: app.clone(),
            config_path: app.join(".qaren/config.yaml"),
            plan_file: app.join("plan.md"),
            platform: Platform::Ios,
            device: None,
            boot_device: false,
            fresh_install: false,
            runtime_dir: "/runtime".into(),
            node: Some("node".into()),
            lock_root: repo.join("locks"),
            runs_root: repo.join("runs"),
            native_cache_root: repo.join("native"),
            android_home: None,
            budgets: Budgets {
                walk_seconds: 30,
                step_seconds: 30,
            },
            pr: pr.then(|| PrTarget {
                target: "12".into(),
            }),
        };
        let receipt = with_input_scope(owner(&[]), || qaren::run::run(&mut runner, &req));
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(receipt.run_id, "none");
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::PlanInputMissing
        );
        assert!(receipt
            .failure
            .as_ref()
            .unwrap()
            .detail
            .contains("PASSWORD, USERNAME"));
        assert!(!req.runs_root.exists());
        assert!(!req.lock_root.exists());
        assert_eq!(runner.remaining(), 0);
        assert!(!runner
            .calls
            .iter()
            .any(|spec| spec.label.contains("device") || spec.label == "git-worktree-add"));
    }
}

#[test]
fn durable_json_redacts_input_keys_and_nested_values_under_protocol_keys() {
    let secret = "synthetic-credential";
    with_input_scope(owner(&[("QAREN_INPUT_PASSWORD", secret)]), || {
        for key in [
            "verdict",
            "result",
            "code",
            "schema",
            "phase",
            "kind",
            "source",
            "path",
            "resolvedBy",
            "outcome",
            "videoPublication",
            "method",
        ] {
            let value = serde_json::json!({
                key: {secret: secret},
                "array": {key: [secret, {secret: secret}]},
                "scalar": {key: secret},
            });
            let text = qaren::redact::durable_json(&value).unwrap();
            let actual: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(actual[key]["[REDACTED_INPUT]"], "[REDACTED_INPUT]", "{key}");
            assert_eq!(actual["array"][key][0], "[REDACTED_INPUT]", "{key}");
            assert_eq!(
                actual["array"][key][1]["[REDACTED_INPUT]"],
                "[REDACTED_INPUT]",
                "{key}"
            );
            assert_eq!(actual["scalar"][key], secret, "{key}");
        }
    });
}

#[test]
fn input_scope_redacts_scalars_and_restores_the_previous_owner() {
    let secret = "quote\"back\\sentinel";
    let inputs = owner(&[("QAREN_INPUT_PASSWORD", secret)]);
    with_input_scope(inputs.clone(), || {
        assert!(!qaren::redact::redact_secrets(secret).contains(secret));
        let escaped = serde_json::to_string(secret).unwrap();
        assert!(!qaren::redact::redact_secrets(&escaped).contains(&escaped[1..escaped.len() - 1]));
        let value = serde_json::json!({"verdict":"PASS","message":secret});
        let text = qaren::redact::durable_json(&value).unwrap();
        assert!(!text.contains("sentinel"));
        with_input_scope(owner(&[]), || {
            assert_eq!(qaren::redact::redact_secrets(secret), secret)
        });
        assert!(!qaren::redact::redact_secrets(secret).contains(secret));
        let captured = qaren::redact::capture_input_scope().unwrap();
        std::thread::spawn(move || {
            with_input_scope(captured, || {
                assert!(!qaren::redact::redact_secrets(secret).contains(secret))
            })
        })
        .join()
        .unwrap();
    });
    assert!(qaren::redact::capture_input_scope().is_none());
}

#[test]
fn real_children_cannot_receive_reinserted_input_env_and_private_logs_never_retain_output() {
    let repo = common::temp_repo();
    let inputs = owner(&[("QAREN_INPUT_UNUSED", "private-synthetic")]);
    with_input_scope(inputs, || {
        let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
        let spec = CmdSpec::new("fixture", "/bin/sh", &["-c", "env | LC_ALL=C sort"], 5)
            .env("QAREN_INPUT_PASSWORD", "reinserted")
            .env("QAREN_INPUT_bad", "invalid-name");
        let output = runner.run_private(&spec, b"");
        assert!(output.clean());
        assert!(!output.stdout().contains("QAREN_INPUT_"));
        assert_eq!(
            format!("{}", output.summary()),
            "exit=Some(0) timed_out=false [private output withheld]"
        );
        let log = repo.join("private.log");
        let mut child = runner
            .spawn_piped(
                &CmdSpec::new(
                    "fixture",
                    "/bin/sh",
                    &[
                        "-c",
                        "printf prefix >&2; printf 'split-synthetic\\n' >&2; printf end >&2",
                    ],
                    5,
                ),
                &log,
            )
            .unwrap();
        for _ in 0..100 {
            if child.handle.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        drop(child);
        assert_eq!(
            std::fs::read_to_string(log).unwrap(),
            "[private output withheld]\n"
        );
    });
}

#[test]
fn a_pr_head_login_block_cannot_request_inputs_the_owner_never_declared() {
    for (head_names, refused) in [
        (r#"["EXFIL","PASSWORD"]"#, true),
        (r#"["PASSWORD"]"#, false),
    ] {
        let repo = common::temp_repo();
        let app = repo.join("test-app");
        std::fs::create_dir_all(app.join(".qaren")).unwrap();
        std::fs::write(
            app.join(".qaren/config.yaml"),
            "appId: com.test\nmetroPort: 8791\ndevClientScheme: test\nloginBlock: sign-in\nloginMarker:\n  id: login-screen\n",
        )
        .unwrap();
        std::fs::write(
            app.join("plan.md"),
            "1. Fill \"password\" with input PASSWORD\n",
        )
        .unwrap();
        let head = "b".repeat(40);
        let mut runner = MockRunner::new();
        runner.expect_run("node --version", CmdOutput::success("v24.14.0\n"));
        runner.expect_run(
            "rev-parse --show-toplevel",
            CmdOutput::success(repo.to_str().unwrap()),
        );
        runner.expect_run("gh pr view", CmdOutput::success(&serde_json::json!({"number":12,"url":"https://github.com/o/r/pull/12","headRefOid":head,"headRefName":"feature","isCrossRepository":true}).to_string()));
        runner.expect_run("fetch origin", CmdOutput::success(""));
        runner.expect_run("rev-parse refs/qaren/pr/", CmdOutput::success(&head));
        runner.expect_run("update-ref -d", CmdOutput::success(""));
        for path in ["test-app", "test-app/.qaren", "test-app/.qaren/actions"] {
            runner.expect_run(
                &format!("ls-tree -z {head} -- {path}"),
                CmdOutput::success(&format!("040000 tree {head}\t{path}\0")),
            );
        }
        runner.expect_run(
            "sign-in.yaml",
            CmdOutput::success(&format!(
                "100644 blob {head}\ttest-app/.qaren/actions/sign-in.yaml\0"
            )),
        );
        runner.expect_run("sign-in.yml", CmdOutput::success(""));
        runner.expect_run("git show", CmdOutput::success("head login block bytes"));
        runner.expect_run(
            "--preflight-stdin",
            CmdOutput::success(&format!(
                r#"{{"ok":true,"inputProtocol":1,"requiredInputs":{head_names},"loginSnapshot":{{"slug":"sign-in","content":"head login block bytes"}}}}"#
            )),
        );
        runner.expect_run(
            "--preflight-stdin",
            CmdOutput::success(
                r#"{"ok":true,"inputProtocol":1,"requiredInputs":["PASSWORD"],"loginSnapshot":{"slug":"sign-in","content":null}}"#,
            ),
        );
        if !refused {
            runner.expect_run("--preflight-stdin", CmdOutput::success("not json"));
        }
        let req = RunRequest {
            project_root: app.clone(),
            config_path: app.join(".qaren/config.yaml"),
            plan_file: app.join("plan.md"),
            platform: Platform::Ios,
            device: None,
            boot_device: false,
            fresh_install: false,
            runtime_dir: "/runtime".into(),
            node: Some("node".into()),
            lock_root: repo.join("locks"),
            runs_root: repo.join("runs"),
            native_cache_root: repo.join("native"),
            android_home: None,
            budgets: Budgets {
                walk_seconds: 30,
                step_seconds: 30,
            },
            pr: Some(PrTarget {
                target: "12".into(),
            }),
        };
        let inputs = owner(&[
            ("QAREN_INPUT_PASSWORD", "declared-synthetic"),
            ("QAREN_INPUT_EXFIL", "undeclared-synthetic"),
        ]);
        let receipt = with_input_scope(inputs, || qaren::run::run(&mut runner, &req));
        let failure = receipt.failure.as_ref().unwrap();
        assert_eq!(receipt.run_id, "none");
        assert_eq!(runner.remaining(), 0);
        assert!(!req.runs_root.exists());
        assert!(!req.lock_root.exists());
        if refused {
            assert_eq!(receipt.result, ReceiptResult::Refused);
            assert_eq!(failure.code, FailureCode::PlanInputMissing);
            assert!(failure.detail.contains("EXFIL"));
            assert!(!failure.detail.contains("PASSWORD"));
            assert!(runner
                .private_inputs
                .iter()
                .all(|bytes| !String::from_utf8_lossy(bytes).contains("synthetic")));
        } else {
            assert_eq!(failure.code, FailureCode::JevUnreachable);
            let preflight =
                String::from_utf8_lossy(runner.private_inputs.last().unwrap()).into_owned();
            assert!(preflight.contains("declared-synthetic"));
            assert!(!preflight.contains("undeclared-synthetic"));
        }
    }
}
