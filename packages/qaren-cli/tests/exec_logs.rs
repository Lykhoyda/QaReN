mod common;

use qaren::exec::{CmdOutput, CmdSpec, RealRunner, Runner};
use qaren::failure::{Failure, FailureCode};
use qaren::redact::PRIVATE_KEY_WITHHELD;
use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const KEY: &str = "synthetic-phase3-typesafe-key";

#[test]
fn command_summary_withholds_output_naming_a_private_key() {
    let body = (0..7)
        .map(|line| format!("private-body-{line}\n"))
        .collect::<String>();
    let pem = format!("-----BEGIN PRIVATE KEY-----\n{body}");
    for output in [
        CmdOutput {
            stdout: pem.clone(),
            ..CmdOutput::failed(1, "install failed")
        },
        CmdOutput::failed(1, &pem),
    ] {
        let summary = output.summary();
        assert!(!summary.contains("private-body"), "{summary}");
        assert_eq!(summary, format!("exit=1 {PRIVATE_KEY_WITHHELD}"));
    }
    assert_eq!(
        CmdOutput {
            stdout: "one\ntwo\nthree\nfour\nfive\nsix\nseven\n".into(),
            ..CmdOutput::failed(1, "stderr")
        }
        .summary(),
        "exit=1 two | three | four | five | six | seven"
    );
}

const FAKE_BODY: &str = "FAKEKEYBODY";

#[test]
fn real_capture_preserves_protocol_bytes_and_withholds_summaries() {
    let mut runner = RealRunner::new();
    for (script, stdout, stderr) in [
        (
            "printf '%s\\n' '-----BEGIN PRIVATE KEY-----' >&2; printf 'FAKEKEYBODY\\n'; exit 1",
            "FAKEKEYBODY\n",
            "-----BEGIN PRIVATE KEY-----\n",
        ),
        (
            "printf 'FAKEKEYBODY\\n' >&2; printf 'quoting a private key\\n'; exit 1",
            "quoting a private key\n",
            "FAKEKEYBODY\n",
        ),
    ] {
        let output = runner.run(&CmdSpec::new(
            "private-key-summary",
            "sh",
            &["-c", script],
            5,
        ));
        assert_eq!(output.exit_code, Some(1));
        assert_eq!(output.stdout, stdout);
        assert_eq!(output.stderr, stderr);
        assert_eq!(output.summary(), format!("exit=1 {PRIVATE_KEY_WITHHELD}"));
    }
    for marker in ["private key", "PrIvAtE KeY", "<redacted private key>"] {
        for stderr in [false, true] {
            let output = CmdOutput {
                stdout: if stderr { FAKE_BODY } else { marker }.into(),
                stderr: if stderr { marker } else { FAKE_BODY }.into(),
                ..CmdOutput::failed(1, "")
            };
            assert_eq!(output.summary(), format!("exit=1 {PRIVATE_KEY_WITHHELD}"));
        }
    }
}

#[test]
fn a_marker_mention_cannot_blind_a_truncated_key_in_a_summary() {
    let failure = CmdOutput::failed(
        255,
        &format!(
            "error: unterminated -----BEGIN marker\n-----BEGIN PRIVATE KEY-----\n{FAKE_BODY}1\n{FAKE_BODY}2\n{FAKE_BODY}3\n"
        ),
    );
    assert_eq!(
        failure.summary(),
        format!("exit=255 {PRIVATE_KEY_WITHHELD}")
    );
}

// Earlier log content belongs to other commands and survives; this command's output does not.
fn spawned_log(script: &str) -> String {
    let dir = common::temp_repo();
    let log = dir.join("child.log");
    std::fs::write(&log, "earlier command\n").unwrap();
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    runner
        .spawn_group(&shell(&format!("{script}\n: > done"), &dir), &log)
        .unwrap();
    until(|| dir.join("done").exists());
    until(|| {
        runner.flush_logs().unwrap();
        let stored = std::fs::read_to_string(&log).unwrap_or_default();
        stored.contains("tail line") || stored.contains(PRIVATE_KEY_WITHHELD)
    });
    std::thread::sleep(Duration::from_millis(100));
    runner.flush_logs().unwrap();
    let stored = std::fs::read_to_string(&log).unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    stored
}

fn withheld_log() -> String {
    format!("earlier command\n{PRIVATE_KEY_WITHHELD}\n")
}

#[test]
fn a_private_key_on_either_stream_withholds_the_whole_command_log_in_any_arrival_order() {
    let body = format!(
        r#"n=0; while [ "$n" -lt 26 ]; do printf '{FAKE_BODY}%s\n' "$n"; n=$((n+1)); done"#
    );
    for script in [
        format!("printf 'starting\\n'\nprintf '%s\\n' '-----BEGIN PRIVATE KEY-----' >&2\n{body}\nprintf 'tail line\\n'"),
        format!("printf '%s\\n' '-----BEGIN PRIVATE KEY-----'\n{body} >&2\nprintf '%s\\n' '-----END PRIVATE KEY-----'\nprintf 'tail line\\n'"),
        format!("{body}\nprintf '%s\\n' '-----end private key-----' >&2\nprintf 'tail line\\n'"),
        format!("{body} >&2\nprintf '<redacted private key>\\n'\nprintf 'tail line\\n'"),
        format!("printf -- '-----BEGIN PRIVATE' >&2\n{body}\nprintf ' KEY-----\\n' >&2\nprintf 'tail line\\n'"),
    ] {
        let stored = spawned_log(&script);
        assert_eq!(stored, withheld_log(), "{script}");
    }
}

#[test]
fn a_log_without_a_private_key_keeps_every_line() {
    let stored = spawned_log("printf 'starting\\n'\nprintf 'warn\\n' >&2\nprintf 'tail line\\n'");
    assert!(stored.starts_with("earlier command\n"), "{stored}");
    for line in ["starting\n", "warn\n", "tail line\n"] {
        assert!(stored.contains(line), "{stored}");
    }
}

fn drained_bundle_requests(lines: &[&str], counted: bool) -> (Option<String>, String) {
    let dir = common::temp_repo();
    let log = dir.join("metro.log");
    let script: String = lines
        .iter()
        .map(|line| format!("printf '%s\\n' '{line}' >&2\n"))
        .collect();
    let mut spec = shell(&format!("{script}printf 'tail line\\n'\n: > done"), &dir);
    if counted {
        spec = spec.env("DEBUG", qaren::exec::log::METRO_REQUEST_LOG);
    }
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    runner.spawn_group(&spec, &log).unwrap();
    until(|| dir.join("done").exists());
    until(|| {
        runner.flush_logs().unwrap();
        let stored = std::fs::read_to_string(&log).unwrap_or_default();
        stored.contains("tail line") || stored.contains(PRIVATE_KEY_WITHHELD)
    });
    std::thread::sleep(Duration::from_millis(100));
    runner.flush_logs().unwrap();
    let count = std::fs::read_to_string(qaren::exec::log::bundle_requests_path(&log)).ok();
    let stored = std::fs::read_to_string(&log).unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    (count, stored)
}

const PROBE: &str = "2026-10-22T08:46:08.100Z Metro:Server Handling request: /qaren-request-probe";
const BUNDLE: &str =
    "2026-10-22T08:46:09.200Z Metro:Server Handling request: /index.bundle?platform=ios&dev=true";
const JSC_SAFE_BUNDLE: &str =
    "2026-10-22T08:46:10.300Z Metro:Server Handling request: /index.bundle//&platform=ios&dev=true";
const SOURCE_MAP: &str =
    "2026-10-22T08:46:11.400Z Metro:Server Handling request: /index.map?platform=ios&dev=true";

#[test]
fn a_bundle_request_counts_on_receipt_before_any_build_starts() {
    let (count, _) = drained_bundle_requests(&[PROBE, BUNDLE], true);
    assert_eq!(count.as_deref(), Some("1\n"));
}

#[test]
fn bundle_suffixes_in_directories_and_queries_do_not_change_the_request_path() {
    for suffix in [
        "",
        "?platform=ios&entry=other.bundle",
        "//&platform=ios&entry=other.bundle",
    ] {
        for (path, expected) in [
            ("/apps/app.bundle/index.bundle", "1\n"),
            ("/apps/app.bundle/index.map", "0\n"),
            ("/apps/app.bundle/index.assets", "0\n"),
            ("/qaren-request-probe", "0\n"),
        ] {
            let line = format!(
                "2026-10-22T08:46:09.200Z Metro:Server Handling request: {path}{suffix}"
            );
            let (count, _) = drained_bundle_requests(&[&line], true);
            assert_eq!(count.as_deref(), Some(expected), "{path}{suffix}");
        }
    }
}

#[test]
fn only_bundle_paths_count_including_metros_jsc_safe_form() {
    let (count, _) = drained_bundle_requests(&[PROBE, JSC_SAFE_BUNDLE, SOURCE_MAP, PROBE], true);
    assert_eq!(count.as_deref(), Some("1\n"));
    let (count, _) = drained_bundle_requests(&[PROBE, SOURCE_MAP], true);
    assert_eq!(
        count.as_deref(),
        Some("0\n"),
        "a logged request arms the count"
    );
}

#[test]
fn the_metro_drain_counts_bundle_requests_value_free_even_when_its_log_is_withheld() {
    let (count, stored) = drained_bundle_requests(
        &[
            PROBE,
            BUNDLE,
            "quoting a private key",
            "iOS Bundled 5ms index.ts (10 modules)",
            JSC_SAFE_BUNDLE,
        ],
        true,
    );
    assert_eq!(count.as_deref(), Some("2\n"));
    assert_eq!(stored, format!("{PRIVATE_KEY_WITHHELD}\n"));
}

#[test]
fn the_bundle_request_count_exists_only_once_metro_logs_a_request() {
    let (count, _) = drained_bundle_requests(&["iOS Bundled 5ms index.ts (10 modules)"], true);
    assert_eq!(
        count, None,
        "a Metro that never logged a request leaves the signal unknown"
    );
    let (count, _) = drained_bundle_requests(&[PROBE, BUNDLE], false);
    assert_eq!(
        count, None,
        "only a command that enabled the request log is counted"
    );
}

#[test]
fn an_evidence_tail_naming_a_private_key_never_reaches_run_json() {
    let dir = common::temp_repo();
    let log = dir.join("tunnel.log");
    for mention in [
        "<redacted private key>",
        "-----end private key-----",
        "-----END PRIVATE KEY-----",
    ] {
        let lines: String = (0..8).map(|n| format!("{FAKE_BODY}{n}\n")).collect();
        std::fs::write(&log, format!("{lines}{mention}\nexit\n")).unwrap();
        let failure = Failure::new(
            "allocate",
            FailureCode::TunnelFailed,
            "ssh tunnel died".to_string(),
            "inspect the tunnel log",
        )
        .with_evidence(vec![qaren::commands::log_tail(&log, 25)]);
        persist_failure(&dir, "tailrun", failure.clone());
        let recorded =
            std::fs::read_to_string(qaren::runrecord::RunRecord::path(&dir, "tailrun")).unwrap();
        assert!(!recorded.contains(FAKE_BODY), "{recorded}");
        assert_eq!(failure.evidence, vec![PRIVATE_KEY_WITHHELD.to_string()]);
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn private_capture_passes_bounded_stdin_without_inventory_in_diagnostics_or_command_logs() {
    let dir = common::temp_repo();
    let inventory = include_str!("fixtures/installed-apps.plist");
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    let spec = CmdSpec::new("private-fixture", "/bin/cat", &[], 5).cwd(&dir);
    let output = runner.run_private(&spec, inventory.as_bytes());
    assert!(output.clean());
    assert_eq!(output.stdout(), inventory);
    for diagnostic in [
        format!("{output:?}"),
        output.summary(),
        spec.rendered(),
        serde_json::to_string(&spec).unwrap(),
    ] {
        assert!(!diagnostic.contains("com.private.unrelated"));
        assert!(!diagnostic.contains("/private/fixture"));
    }
    assert!(!dir.join("installed-apps.plist").exists());
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    let oversized = runner.run_private(&spec, &vec![b'x'; 16 * 1024 * 1024 + 1]);
    assert!(!oversized.clean());
    let failed = runner.run_private(&shell("cat >&2; exit 1", &dir), inventory.as_bytes());
    assert!(!failed.clean());
    assert!(!format!("{failed:?} {}", failed.summary()).contains("com.private.unrelated"));
    let mut blocked = shell("sleep 5", &dir);
    blocked.timeout_seconds = 1;
    let started = Instant::now();
    let timed_out = runner.run_private(&blocked, &vec![b'x'; 1024 * 1024]);
    assert!(!timed_out.clean());
    assert!(started.elapsed() < Duration::from_secs(4));
}

fn shell(script: &str, dir: &Path) -> CmdSpec {
    CmdSpec::new("fixture", "/bin/sh", &["-c", script], 5).cwd(dir)
}

fn until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(Instant::now() < deadline, "fixture did not finish");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn persist_failure(dir: &Path, run_id: &str, failure: Failure) {
    let mut record = common::base_record(
        dir,
        &common::ios_scenario_yaml(8791),
        run_id,
        qaren::runrecord::Phase::Failed,
    );
    record.failure = Some(failure);
    record.save(dir).unwrap();
}

struct HelperGuard(Child);

impl Drop for HelperGuard {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn helper_log(chunks: &[Vec<u8>]) -> String {
    let dir = common::temp_repo();
    let path = dir.join("helper.log");
    std::fs::write(&path, "earlier command\n").unwrap();
    let log = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    let (input, mut output) = UnixStream::pair().unwrap();
    let (control, helper_control) = UnixStream::pair().unwrap();
    let mut helper = HelperGuard(
        Command::new(env!("CARGO_BIN_EXE_qaren"))
            .arg(qaren::exec::log::HELPER_ARG)
            .env_clear()
            .stdin(Stdio::from(OwnedFd::from(input)))
            .stdout(Stdio::from(OwnedFd::from(helper_control)))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap(),
    );
    for chunk in chunks {
        output.write_all(chunk).unwrap();
        std::thread::sleep(Duration::from_millis(5));
    }
    drop(output);
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = helper.0.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "log helper did not exit at EOF");
        std::thread::sleep(Duration::from_millis(20));
    };
    drop(control);
    assert!(status.success());
    let stored = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    stored
}

#[test]
fn the_log_helper_withholds_a_mention_split_across_writes_or_oversized_lines() {
    let body = format!("{FAKE_BODY}\n").into_bytes();
    let mut cases = vec![vec![
        b"ssh: -----BEGIN PRIV".to_vec(),
        b"ATE KEY-----\n".to_vec(),
        body.clone(),
    ]];
    for boundary in [64 * 1024, 128 * 1024] {
        for split in [1, 5, 10, 11, 12] {
            cases.push(vec![
                body.clone(),
                format!(
                    "{}-----BEGIN PRIVATE KEY-----{}\n",
                    "x".repeat(boundary - split),
                    "x".repeat(70 * 1024)
                )
                .into_bytes(),
                body.clone(),
            ]);
        }
    }
    for chunks in cases {
        assert_eq!(
            helper_log(&chunks),
            format!("earlier command\n{PRIVATE_KEY_WITHHELD}\n")
        );
    }
    let plain = helper_log(&[
        format!("{}\n", "x".repeat(130 * 1024)).into_bytes(),
        b"after oversized\n".to_vec(),
    ]);
    assert_eq!(
        plain,
        "earlier command\n[oversized log line withheld]\nafter oversized\n"
    );
}

#[test]
fn a_checkpoint_completes_while_four_writers_keep_the_helper_busy() {
    let deadline = Instant::now() + Duration::from_secs(30);
    let (input, output) = UnixStream::pair().unwrap();
    let (mut control, helper_control) = UnixStream::pair().unwrap();
    control
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    control
        .set_write_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut helper = HelperGuard(
        Command::new(env!("CARGO_BIN_EXE_qaren"))
            .arg(qaren::exec::log::HELPER_ARG)
            .env_clear()
            .env("TYPESAFE_API_KEY", KEY)
            .stdin(Stdio::from(OwnedFd::from(input)))
            .stdout(Stdio::from(OwnedFd::from(helper_control)))
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let stop = Arc::new(AtomicBool::new(false));
    let written: Vec<_> = (0..4).map(|_| Arc::new(AtomicU64::new(0))).collect();
    let writers: Vec<_> = written
        .iter()
        .map(|written| {
            let written = Arc::clone(written);
            let stop = Arc::clone(&stop);
            let mut output = output.try_clone().unwrap();
            std::thread::spawn(move || {
                let mut bytes = [b'x'; 64 * 1024];
                for byte in bytes.iter_mut().skip(1).step_by(2) {
                    *byte = b' ';
                }
                for line in bytes.chunks_mut(128) {
                    line[127] = b'\n';
                }
                while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
                    match output.write(&bytes) {
                        Ok(n) => {
                            written.fetch_add(n as u64, Ordering::Relaxed);
                        }
                        Err(_) if stop.load(Ordering::Relaxed) => break,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(error) => return Err(error),
                    }
                }
                Ok(())
            })
        })
        .collect();
    // A loaded host only lengthens warm-up; every writer must still push 256 KiB first.
    let warmup = Instant::now() + Duration::from_secs(15);
    while written
        .iter()
        .any(|bytes| bytes.load(Ordering::Relaxed) < 256 * 1024)
        && Instant::now() < warmup
    {
        std::thread::sleep(Duration::from_millis(1));
    }
    let active = written
        .iter()
        .all(|bytes| bytes.load(Ordering::Relaxed) >= 256 * 1024);
    let mut ack = [0];
    let checkpoint = control
        .write_all(&[1])
        .and_then(|()| control.read_exact(&mut ack));
    let still_running = matches!(helper.0.try_wait(), Ok(None));
    let writers_running = writers.iter().all(|writer| !writer.is_finished());

    stop.store(true, Ordering::Relaxed);
    output.shutdown(std::net::Shutdown::Write).unwrap();
    drop(output);
    let writer_results: Vec<_> = writers.into_iter().map(|writer| writer.join()).collect();
    let exit = loop {
        if let Some(status) = helper.0.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
        active,
        "all four writers must be producing before the checkpoint"
    );
    assert!(
        still_running && writers_running,
        "the checkpoint must not rely on writer or helper exit"
    );
    assert!(writer_results
        .into_iter()
        .all(|result| matches!(result, Ok(Ok(())))));
    assert!(
        exit.is_some_and(|status| status.success()),
        "the helper must drain EOF and be reaped after the writers stop: {exit:?}"
    );
    assert!(
        checkpoint.is_ok(),
        "a healthy busy helper starved its checkpoint: {checkpoint:?}"
    );
    assert_eq!(ack, [1]);
}

#[test]
fn subprocess_logs_are_redacted_before_persistence() {
    let dir = common::temp_repo();
    std::fs::write(dir.join(".env"), format!("TYPESAFE_API_KEY={KEY}\n")).unwrap();
    let result = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "subprocess_fixture_worker", "--nocapture"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("TYPESAFE_API_KEY", KEY)
        .env("QAREN_TEST_LOG_DIR", &dir)
        .env("QAREN_INPUT_INHERITED", "synthetic-inherited-slot")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!String::from_utf8_lossy(&result.stdout).contains(KEY));
    assert!(!String::from_utf8_lossy(&result.stderr).contains(KEY));

    // The legacy prepare owner can exit while its managed Metro is still logging.
    std::fs::write(dir.join("detached-release"), "").unwrap();
    until(|| {
        std::fs::read_to_string(dir.join("detached.log"))
            .unwrap_or_default()
            .contains("detached done")
    });
    for name in [
        "build.log",
        "core.log",
        "killed.log",
        "detached.log",
        "build-failure/run.json",
        "capture-failure/run.json",
    ] {
        let stored = std::fs::read_to_string(dir.join(name)).unwrap();
        assert!(!stored.contains(KEY), "{name} leaked the synthetic key");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn subprocess_fixture_worker() {
    let Some(dir) = std::env::var_os("QAREN_TEST_LOG_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    let log = dir.join("build.log");
    runner
        .spawn_group(
            &shell(
                r#"
        test "${TYPESAFE_API_KEY+x}" != x || exit 10
        . ./.env
        printf 'build ready\n'
        printf 'compiling 42%%\r'
        printf 'split synthetic-phase3-'
        printf 'stderr progress\n' >&2
        : > partial
        n=0; while [ ! -f release ] && [ "$n" -lt 500 ]; do n=$((n+1)); sleep 0.01; done
        printf 'typesafe-key\n'
        printf 'stderr %s\n' "$TYPESAFE_API_KEY" >&2
        printf 'TYPESAFE_API_KEY=%s\n' "$TYPESAFE_API_KEY"
        n=0; while [ "$n" -lt 8192 ]; do printf 'abcdefgh'; n=$((n+1)); done
        printf '%s\n' "$TYPESAFE_API_KEY"
        printf 'stdout done'
        printf 'final diagnostic %s' "$TYPESAFE_API_KEY" >&2
    "#,
                dir,
            ),
            &log,
        )
        .unwrap();
    until(|| dir.join("partial").exists());
    runner.flush_logs().unwrap();
    let partial = std::fs::read_to_string(&log).unwrap();
    assert!(partial.contains("build ready"));
    assert!(partial.contains("compiling 42%\r"));
    assert!(partial.contains("stderr progress"));
    assert!(
        !partial.contains("synthetic"),
        "unfinished lines must not reach disk"
    );
    std::fs::write(dir.join("release"), "").unwrap();
    until(|| {
        runner.flush_logs().unwrap();
        let stored = std::fs::read_to_string(&log).unwrap();
        stored.contains("final diagnostic") && stored.contains("stdout done")
    });
    let stored = std::fs::read_to_string(&log).unwrap();
    assert!(!stored.contains(KEY));
    assert!(stored.contains("split [REDACTED_SECRET]"));
    assert!(stored.contains("stderr [REDACTED_SECRET]"));
    assert!(stored.contains("[oversized log line withheld]"));
    let failure = Failure::new(
        "build",
        FailureCode::BuildFailed,
        "fixture failed",
        "inspect log",
    )
    .with_evidence(vec![
        qaren::commands::log_tail(&log, 25),
        format!(".env echo {KEY}"),
    ]);
    persist_failure(dir, "build-failure", failure);

    let output = runner.run(&shell(
        r#"
        test "${TYPESAFE_API_KEY+x}" != x || exit 10
        . ./.env
        printf 'captured stdout %s\n' "$TYPESAFE_API_KEY"
        printf 'captured stderr %s\n' "$TYPESAFE_API_KEY" >&2
        exit 2
    "#,
        dir,
    ));
    assert_eq!(output.exit_code, Some(2));
    assert_eq!(output.stdout, format!("captured stdout {KEY}\n"));
    assert_eq!(output.stderr, format!("captured stderr {KEY}\n"));
    assert!(!output.summary().contains(KEY));
    let failure = Failure::new(
        "deps",
        FailureCode::DepsInstallFailed,
        output.stdout.clone(),
        "retry",
    )
    .with_evidence(vec![output.stdout]);
    assert!(!serde_json::to_string(&failure).unwrap().contains(KEY));
    persist_failure(dir, "capture-failure", failure);

    let mut preflight = shell(
        r#"printf '{"prepared":{"text":"Bearer ordinary text","token":"%s"}}' "$TYPESAFE_API_KEY""#,
        dir,
    );
    preflight.label = "plan-preflight".into();
    let output = runner.run(&preflight);
    assert!(output.ok());
    let prepared: serde_json::Value = serde_json::from_str(&output.stdout).unwrap();
    assert_eq!(
        prepared["prepared"]["token"], KEY,
        "protocol stdout stays memory-only and intact"
    );
    assert_eq!(prepared["prepared"]["text"], "Bearer ordinary text");

    let mut timeout = shell(
        ". ./.env; printf '%s' \"$TYPESAFE_API_KEY\" >&2; sleep 5",
        dir,
    );
    timeout.timeout_seconds = 1;
    let output = runner.run(&timeout);
    assert!(output.timed_out);
    assert_eq!(output.stderr, KEY);
    assert!(!output.summary().contains(KEY));
    let mut overflowing = shell("head -c 17825792 /dev/zero", dir);
    overflowing.timeout_seconds = 30;
    let output = runner.run(&overflowing);
    assert!(!output.ok());
    assert!(output.stderr.contains("command output exceeded 16 MiB"));

    let tool = shell(
        r#"test "${TYPESAFE_API_KEY+x}" != x && test "${QAREN_INPUT_SLOT+x}" != x && test "${QAREN_INPUT_INHERITED+x}" != x && printf 'scrubbed\n'"#,
        dir,
    )
    .env("TYPESAFE_API_KEY", KEY)
    .env("QAREN_INPUT_SLOT", "synthetic-slot-value");
    let mut tool_child = runner.spawn_piped(&tool, &dir.join("tool.log")).unwrap();
    let mut tool_wire = String::new();
    tool_child.stdout.read_line(&mut tool_wire).unwrap();
    assert_eq!(tool_wire, "scrubbed\n");
    until(|| tool_child.handle.try_wait().unwrap().is_some());

    let mut core = shell(
        r#"test "${QAREN_INPUT_INHERITED+x}" != x || exit 10; printf '{"token":"%s"}\n' "$TYPESAFE_API_KEY"; printf 'core diagnostic %s' "$TYPESAFE_API_KEY" >&2"#,
        dir,
    );
    core.label = "core-walk".into();
    let mut child = runner.spawn_piped(&core, &dir.join("core.log")).unwrap();
    let mut wire = String::new();
    child.stdout.read_line(&mut wire).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&wire).unwrap()["token"],
        KEY
    );
    until(|| child.handle.try_wait().unwrap().is_some());
    assert_eq!(
        std::fs::read_to_string(dir.join("core.log")).unwrap(),
        "core diagnostic [REDACTED_SECRET]"
    );

    let mut killed = runner
        .spawn_piped(
            &shell(
                r#". ./.env; printf 'kill tail %s' "$TYPESAFE_API_KEY" >&2; : > kill-ready; sleep 5"#,
                dir,
            ),
            &dir.join("killed.log"),
        )
        .unwrap();
    until(|| dir.join("kill-ready").exists());
    killed.handle.kill_group();
    assert_eq!(
        std::fs::read_to_string(dir.join("killed.log")).unwrap(),
        "kill tail [REDACTED_SECRET]"
    );

    runner
        .spawn_group(
            &shell(
                r#"
        . ./.env
        n=0; while [ ! -f detached-release ] && [ "$n" -lt 500 ]; do n=$((n+1)); sleep 0.01; done
        printf 'detached done %s\n' "$TYPESAFE_API_KEY"
    "#,
                dir,
            ),
            &dir.join("detached.log"),
        )
        .unwrap();
}

#[test]
fn a_live_tail_never_copies_a_body_whose_mention_awaits_its_newline() {
    let dir = common::temp_repo();
    let log = dir.join("live.log");
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    let script = format!(
        "printf -- '-----BEGIN PRIVATE KEY-----' >&2\nprintf '{FAKE_BODY}1\\n{FAKE_BODY}2\\n'\n: > done\nsleep 30"
    );
    let spawned = runner.spawn_group(&shell(&script, &dir), &log).unwrap();
    until(|| dir.join("done").exists());
    runner.flush_logs().unwrap();
    let failure = Failure::new(
        "metro",
        FailureCode::TunnelFailed,
        "not ready".to_string(),
        "inspect the log",
    )
    .with_evidence(vec![qaren::commands::log_tail(&log, 25)]);
    persist_failure(&dir, "liverun", failure);
    unsafe { libc::kill(-spawned.pgid, libc::SIGKILL) };
    let recorded =
        std::fs::read_to_string(qaren::runrecord::RunRecord::path(&dir, "liverun")).unwrap();
    assert!(!recorded.contains(FAKE_BODY), "{recorded}");
    assert!(recorded.contains(PRIVATE_KEY_WITHHELD), "{recorded}");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_command_log_that_cannot_be_truncated_is_refused() {
    let dir = common::temp_repo();
    let fifo = dir.join("collector.fifo");
    assert!(Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    let reader = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&fifo)
        .unwrap();
    assert!(runner.spawn_group(&shell("true", &dir), &fifo).is_err());
    drop(reader);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn declared_registry_auth_output_is_withheld() {
    let dir = common::temp_repo();
    let result = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "registry_output_fixture_worker", "--nocapture"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("QAREN_REGISTRY_OUTPUT_FIXTURE_DIR", &dir)
        .env("NPM_TOKEN", "bare-synthetic-canary-6d7e\n\"slash\\tail")
        .env(
            "PRIVATE_REGISTRY_TOKEN",
            "bare-synthetic-canary-6d7e\n\"slash\\tail",
        )
        .output()
        .unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn registry_output_emitter() {
    let Ok(name) = std::env::var("QAREN_EMITTER_NAME") else {
        return;
    };
    let value = std::env::var(name).unwrap();
    let encoded = serde_json::to_string(&value).unwrap();
    for bytes in [value.as_bytes(), encoded.as_bytes()] {
        for byte in bytes {
            std::io::stdout().write_all(&[*byte]).unwrap();
            std::io::stderr().write_all(&[*byte]).unwrap();
        }
    }
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let dir = std::env::var_os("QAREN_REGISTRY_OUTPUT_FIXTURE_DIR").unwrap();
    std::fs::write(
        Path::new(&dir).join("handshake"),
        if input == "start\n" { "yes" } else { "no" },
    )
    .unwrap();
    if std::env::var("QAREN_EMITTER_STATUS").unwrap() == "timeout" {
        std::thread::sleep(Duration::from_secs(5));
    }
    std::process::exit(
        std::env::var("QAREN_EMITTER_STATUS")
            .unwrap()
            .parse()
            .unwrap_or(0),
    );
}

#[test]
fn registry_output_fixture_worker() {
    let Some(dir) = std::env::var_os("QAREN_REGISTRY_OUTPUT_FIXTURE_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    let canary = std::env::var("NPM_TOKEN").unwrap();
    let encoded = serde_json::to_string(&canary).unwrap();
    let no_canary = |text: &str| {
        assert!(!text.contains("bare-synthetic-canary"));
        assert!(!text.contains(&encoded));
        assert!(!text.contains(&canary));
    };
    for label in ["pnpm-install", "expo-prebuild"] {
        for name in ["NPM_TOKEN", "PRIVATE_REGISTRY_TOKEN"] {
            for status in ["0", "7", "timeout"] {
                for route in ["captured", "private", "piped", "group"] {
                    if status == "timeout" && !matches!(route, "captured" | "private") {
                        continue;
                    }
                    let spec = CmdSpec::new(
                        label,
                        std::env::current_exe().unwrap().to_str().unwrap(),
                        &["--exact", "registry_output_emitter", "--nocapture"],
                        1,
                    )
                    .registry_auth_env(&[name.to_string()])
                    .env("QAREN_EMITTER_NAME", name)
                    .env("QAREN_EMITTER_STATUS", status);
                    no_canary(&format!(
                        "{spec:?} {} {}",
                        spec.rendered(),
                        serde_json::to_string(&spec).unwrap()
                    ));
                    let log = dir.join("child.log");
                    std::fs::write(&log, "earlier command\n").unwrap();
                    qaren::events::init();
                    qaren::events::attach(&dir.join("events.jsonl"));
                    let mut runner =
                        RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
                    let retained = match route {
                        "captured" => {
                            let output = runner.run(&spec);
                            assert_eq!(output.timed_out, status == "timeout");
                            assert_eq!(
                                output.exit_code,
                                if status == "timeout" {
                                    None
                                } else {
                                    Some(status.parse().unwrap())
                                }
                            );
                            assert!(output.stdout.is_empty());
                            assert_eq!(output.stderr, "[private output withheld]");
                            format!("{} {} {}", output.stdout, output.stderr, output.summary())
                        }
                        "private" => {
                            let output = runner.run_private(&spec, b"start\n");
                            assert_eq!(output.timed_out(), status == "timeout");
                            assert_eq!(
                                output.exit_code(),
                                if status == "timeout" {
                                    None
                                } else {
                                    Some(status.parse().unwrap())
                                }
                            );
                            assert!(output.stdout().is_empty());
                            output.summary()
                        }
                        "piped" => {
                            let mut child = runner.spawn_piped(&spec, &log).unwrap();
                            child.stdin.write_all(b"start\n").unwrap();
                            drop(child.stdin);
                            let mut stdout = String::new();
                            child.stdout.read_to_string(&mut stdout).unwrap();
                            assert!(stdout.is_empty());
                            let mut exit = None;
                            until(|| {
                                exit = child.handle.try_wait().unwrap();
                                exit.is_some()
                            });
                            assert_eq!(exit, Some(status.parse().unwrap()));
                            assert_eq!(
                                std::fs::read_to_string(dir.join("handshake")).unwrap(),
                                "yes"
                            );
                            std::fs::read_to_string(&log).unwrap()
                        }
                        _ => {
                            let child = runner.spawn_group(&spec, &log).unwrap();
                            until(|| runner.try_reap(child.pid));
                            runner.flush_logs().unwrap();
                            std::fs::read_to_string(&log).unwrap()
                        }
                    };
                    no_canary(&retained);
                    assert!(retained.contains("[private output withheld]"));
                    if matches!(route, "group" | "piped") {
                        assert!(retained.starts_with("earlier command\n"));
                    }
                    let failure = Failure::new(
                        "deps",
                        FailureCode::DepsInstallFailed,
                        &retained,
                        "check registry setup",
                    )
                    .with_evidence(vec![retained.clone()]);
                    persist_failure(dir, "registryrun", failure.clone());
                    no_canary(
                        &std::fs::read_to_string(qaren::runrecord::RunRecord::path(
                            dir,
                            "registryrun",
                        ))
                        .unwrap(),
                    );
                    let mut receipt = qaren::receipt::Receipt::new(
                        "check",
                        "registryrun",
                        qaren::receipt::ReceiptResult::Failed,
                        "deps",
                        "fixture".into(),
                    );
                    receipt.failure = Some(failure);
                    no_canary(&receipt.to_json());
                    qaren::events::end(&receipt, 1);
                    qaren::events::finish();
                    no_canary(&std::fs::read_to_string(dir.join("events.jsonl")).unwrap());
                }
            }
        }
    }
}

#[test]
fn registry_output_policy_preserves_unconfigured_protocols_and_withholds_missing_names() {
    let dir = common::temp_repo();
    let result = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "registry_output_policy_fixture_worker",
            "--nocapture",
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("QAREN_PROTOCOL_FIXTURE_DIR", &dir)
        .output()
        .unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn registry_output_policy_fixture_worker() {
    let Some(dir) = std::env::var_os("QAREN_PROTOCOL_FIXTURE_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    for (label, names, withhold) in [
        ("core-walk", vec!["ABSENT_SECRET".into()], false),
        ("tool", vec!["ABSENT_SECRET".into()], false),
        ("pnpm-install", vec![], false),
        ("expo-prebuild", vec![], false),
        ("pnpm-install", vec!["ABSENT_SECRET".into()], true),
        ("expo-prebuild", vec!["ABSENT_SECRET".into()], true),
    ] {
        for route in ["captured", "piped", "group"] {
            let spec = CmdSpec::new(
                label,
                "/bin/sh",
                &["-c", "printf 'protocol\\n'; printf 'diagnostic\\n' >&2"],
                5,
            )
            .registry_auth_env(&names);
            let log = dir.join("protocol.log");
            std::fs::write(&log, "earlier command\n").unwrap();
            let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
            let retained = match route {
                "captured" => {
                    let output = runner.run(&spec);
                    assert!(output.ok());
                    if !withhold {
                        assert_eq!(output.stdout, "protocol\n");
                        assert_eq!(output.stderr, "diagnostic\n");
                    }
                    format!("{}{}", output.stdout, output.stderr)
                }
                "piped" => {
                    let mut child = runner.spawn_piped(&spec, &log).unwrap();
                    let mut output = String::new();
                    child.stdout.read_to_string(&mut output).unwrap();
                    until(|| child.handle.try_wait().unwrap().is_some());
                    if !withhold {
                        assert_eq!(output, "protocol\n");
                    }
                    format!("{output}{}", std::fs::read_to_string(&log).unwrap())
                }
                _ => {
                    let child = runner.spawn_group(&spec, &log).unwrap();
                    until(|| runner.try_reap(child.pid));
                    runner.flush_logs().unwrap();
                    std::fs::read_to_string(&log).unwrap()
                }
            };
            assert_eq!(retained.contains("protocol"), !withhold, "{label} {route}");
            assert_eq!(retained.contains("diagnostic"), !withhold);
            assert_eq!(retained.contains("[private output withheld]"), withhold);
        }
    }
}

#[test]
fn a_test_pii_only_run_keeps_subprocess_logs_redacted_by_value_instead_of_withheld() {
    const EMAIL: &str = "qa.tester+run7@staging.example.test";
    const PASSWORD: &str = "fake-pass-0000";
    let dir = common::temp_repo();
    let script = format!(
        "printf 'typed {EMAIL} as %s and %s with %s and qa.tester%%2Brun7%%40staging.example.test\\n' qa.tester staging.example.test {PASSWORD} >&2"
    );
    let drained = |name: &str, test_pii: &[&str], unused_secret: bool| {
        let mut entries = vec![("QAREN_INPUT_EMAIL".into(), EMAIL.into())];
        if unused_secret {
            entries.push(("QAREN_INPUT_PASSWORD".into(), PASSWORD.into()));
        }
        let inputs = Arc::new(qaren::redact::InputValues::from_entries(entries));
        qaren::redact::with_input_scope(inputs.clone(), || {
            let resolved = inputs.admit(&["EMAIL".to_string()]).unwrap();
            resolved.declare_test_pii(&test_pii.iter().map(|n| n.to_string()).collect::<Vec<_>>());
            let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
            let log = dir.join(name);
            let mut child = runner.spawn_piped(&shell(&script, &dir), &log).unwrap();
            let mut wire = String::new();
            child.stdout.read_to_string(&mut wire).unwrap();
            until(|| child.handle.try_wait().unwrap().is_some());
            drop(child);
            runner.flush_logs().unwrap();
            std::fs::read_to_string(&log).unwrap()
        })
    };
    let strict = drained("strict.log", &[], false);
    assert_eq!(strict, "[private output withheld]\n");
    let unused_secret = drained("unused-secret.log", &["EMAIL"], true);
    assert_eq!(unused_secret, "[private output withheld]\n");
    let test_pii = drained("test-pii.log", &["EMAIL"], false);
    assert!(
        test_pii.starts_with("typed [REDACTED_INPUT] as"),
        "{test_pii}"
    );
    for leaked in [
        EMAIL,
        "qa.tester",
        "staging.example.test",
        "%40staging",
    ] {
        assert!(!test_pii.contains(leaked), "{leaked} in {test_pii}");
    }
    std::fs::remove_dir_all(dir).unwrap();
}
