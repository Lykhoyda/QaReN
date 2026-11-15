use super::*;
use common::host::HostRunner;

// (macOS pressure level, free KiB); the fixture reports no inactive or speculative pages.
const OK: (u8, u64) = (1, 8 * 1024 * 1024);
// Under 4 GiB available at normal pressure.
const LOW: (u8, u64) = (1, 2 * 1024 * 1024);
// Pressure alone, with plenty available.
const WARNING: (u8, u64) = (2, 8 * 1024 * 1024);
const CRITICAL: (u8, u64) = (4, 8 * 1024 * 1024);

fn host(mock: MockRunner, memory: &[(u8, u64)], req: &RunRequest) -> HostRunner {
    let mut runner = HostRunner::new(mock);
    runner.os = Some("macos");
    runner.memory = memory.to_vec();
    runner.runs_root = Some(req.runs_root.clone());
    runner
}

// A first iOS check that builds, launches and walks.
fn building(memory: &[(u8, u64)]) -> (HostRunner, RunRequest) {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_provision(&mut mock);
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    script_teardown(&mut mock);
    let req = request(&repo, &app, 30);
    (host(mock, memory, &req), req)
}

// The same check scripted only up to its build plan: nothing may run after the wait.
fn stopping_before_the_build(memory: &[(u8, u64)]) -> (HostRunner, RunRequest) {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_clean_build_plan(&mut mock);
    let req = request(&repo, &app, 30);
    (host(mock, memory, &req), req)
}

fn waits(events: &[serde_json::Value]) -> Vec<String> {
    stage_trail(events)
        .into_iter()
        .filter(|s| s.starts_with("host_wait "))
        .collect()
}

fn assert_no_build_lock(runner: &HostRunner, req: &RunRequest) {
    assert!(!runner.calls.iter().any(|c| c.label == "expo-run-ios"));
    let locks: Vec<_> = std::fs::read_dir(&req.lock_root)
        .map(|dir| {
            dir.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with("native-build"))
                .collect()
        })
        .unwrap_or_default();
    assert!(locks.is_empty(), "{locks:?}");
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert!(record.resources.build_lock.is_none());
}

fn report(receipt: &qaren::receipt::Receipt) -> String {
    std::fs::read_to_string(&receipt.artifacts["report"]).unwrap()
}

#[test]
fn d1_low_memory_that_recovers_after_three_polls_waits_then_builds() {
    let (mut runner, req) = building(&[LOW, LOW, LOW, OK]);
    let (receipt, events) = run_with_events(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    let trail = stage_trail(&events);
    let wait = trail.iter().position(|s| s == "host_wait running memory_low");
    let passed = trail.iter().position(|s| s == "host_wait passed");
    let build = trail.iter().position(|s| s == "native_build running");
    assert!(
        wait.is_some() && wait < passed && passed < build,
        "{trail:?}"
    );
    // Start, the first look and three polls, end.
    assert_eq!(runner.samples(), 6);
    let note = &receipt.outcomes["host_wait"];
    assert!(note.contains("waited 15 s"), "{note}");
    assert!(note.contains("recovered"), "{note}");
    assert!(note.contains("8.0 GiB available"), "{note}");
    assert!(report(&receipt).contains(note.as_str()));
    assert_eq!(runner.inner.remaining(), 0);
}

#[test]
fn d2_critical_pressure_for_the_whole_window_refuses_with_the_numbers_and_no_build() {
    let (mut runner, req) = stopping_before_the_build(&[CRITICAL]);
    let (receipt, events) = run_with_events(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Refused, "{:?}", receipt.failure);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::HostUnderPressure);
    assert_eq!(failure.phase, "host_wait");
    let detail = failure.detail.to_string();
    for part in [
        "load 12.0 on 8 cores",
        "8.0 GiB available",
        "pressure critical",
        "swap 1.0 GiB",
        "waited 600 s",
    ] {
        assert!(detail.contains(part), "{part}: {detail}");
    }
    assert_eq!(
        waits(&events).first().map(String::as_str),
        Some("host_wait running memory_critical")
    );
    assert_eq!(
        waits(&events).last().map(String::as_str),
        Some("host_wait failed HOST_UNDER_PRESSURE")
    );
    // Start, the first look, one poll every 5 s for 600 s, end.
    assert_eq!(runner.samples(), 123);
    assert_no_build_lock(&runner, &req);
    assert!(report(&receipt).contains("HOST_UNDER_PRESSURE"));
    assert_eq!(runner.inner.remaining(), 0);
}

#[test]
fn d3_constrained_but_not_critical_builds_after_the_window_with_a_note() {
    let (mut runner, req) = building(&[WARNING]);
    let (receipt, events) = run_with_events(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(
        waits(&events).last().map(String::as_str),
        Some("host_wait passed memory_low")
    );
    let note = &receipt.outcomes["host_wait"];
    for part in [
        "waited 600 s",
        "still constrained",
        "full build budget",
        "pressure warning",
        "8.0 GiB available",
    ] {
        assert!(note.contains(part), "{part}: {note}");
    }
    assert!(report(&receipt).contains(note.as_str()));
    assert_eq!(runner.inner.remaining(), 0);
}

#[test]
fn d8_a_ten_minute_wait_leaves_the_whole_build_budget() {
    let mut timeouts = Vec::new();
    for memory in [OK, WARNING] {
        let (mut runner, req) = building(&[memory]);
        // A 30 s budget would be gone twenty times over if the wait ran inside it.
        let config = std::fs::read_to_string(&req.config_path).unwrap();
        std::fs::write(
            &req.config_path,
            format!("{config}\ndeadlines:\n  build_seconds: 30\n"),
        )
        .unwrap();
        let receipt = run(&mut runner, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(receipt.outcomes.contains_key("host_wait"), memory == WARNING);
        let build = runner
            .calls
            .iter()
            .find(|c| c.label == "expo-run-ios")
            .unwrap();
        timeouts.push(build.timeout_seconds);
    }
    assert_eq!(timeouts, [30, 30]);
}

#[test]
fn d9_a_cancelled_run_leaves_the_wait_at_once_without_a_lock() {
    let (mut runner, req) = stopping_before_the_build(&[CRITICAL]);
    let started = runner.now_epoch_ms();
    // Between two 5 s polls, so a whole poll interval would show.
    runner.inner.cancel_at_ms = Some((started + 302_500, "SIGTERM".into()));
    let (receipt, events) = run_with_events(&mut runner, &req);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::RunCancelled, "{failure:?}");
    assert_eq!(failure.phase, "host_wait");
    assert!(
        receipt.timings_ms["total"] <= 303_500,
        "{}",
        receipt.timings_ms["total"]
    );
    assert_eq!(
        waits(&events).last().map(String::as_str),
        Some("host_wait failed RUN_CANCELLED")
    );
    assert_no_build_lock(&runner, &req);
}

#[test]
fn d9_a_cancellation_during_the_last_sleep_wins_over_recovered_memory() {
    // An uncancelled run with the same steps up to the wait gives the poll's time.
    let (mut probe, req) = building(&[LOW, OK]);
    let _ = run(&mut probe, &req);
    // The first look, then the poll that would show memory recovered.
    let (first_look, poll) = (probe.sampled_at[1], probe.sampled_at[2]);
    assert_eq!(poll - first_look, 5_000);
    let (mut runner, req) = stopping_before_the_build(&[LOW, OK]);
    runner.inner.cancel_at_ms = Some((poll - 500, "SIGTERM".into()));
    let (receipt, events) = run_with_events(&mut runner, &req);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::RunCancelled, "{failure:?}");
    assert_eq!(failure.phase, "host_wait");
    assert_eq!(
        waits(&events).last().map(String::as_str),
        Some("host_wait failed RUN_CANCELLED")
    );
    assert_no_build_lock(&runner, &req);
}

#[test]
fn d4_high_load_with_normal_memory_never_waits() {
    let (mut runner, req) = building(&[OK]);
    runner.end_load = 50.0;
    let (receipt, events) = run_with_events(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert!(waits(&events).is_empty());
    assert!(!receipt.outcomes.contains_key("host_wait"));
    assert_eq!(runner.samples(), 3);
}

#[test]
fn d5_a_healthy_host_takes_one_sample_no_stage_and_no_time() {
    let (mut runner, req) = building(&[]);
    let (receipt, events) = run_with_events(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert!(waits(&events).is_empty());
    assert!(!receipt.outcomes.contains_key("host_wait"));
    assert_eq!(runner.samples(), 3);
    let (mut bare, req) = building(&[]);
    bare.timeout = true;
    let unprobed = run(&mut bare, &req);
    assert_eq!(receipt.timings_ms["total"], unprobed.timings_ms["total"]);
}

#[test]
fn d6_an_unreadable_host_never_waits_or_refuses_and_says_so() {
    for timeout in [false, true] {
        let (mut runner, req) = building(&[CRITICAL]);
        runner.malformed = !timeout;
        runner.timeout = timeout;
        let (receipt, events) = run_with_events(&mut runner, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert!(waits(&events).is_empty());
        assert_eq!(runner.samples(), 3);
        let note = &receipt.outcomes["host_wait"];
        assert!(note.contains("unavailable"), "{note}");
        assert!(!note.contains("canary"), "{note}");
    }
}

const UNREAD: (u8, u64) = (0, 0);
// One of the two probes fails: no pressure level, or no available memory.
const NO_PRESSURE: (u8, u64) = (0, 8 * 1024 * 1024);
const NO_AVAILABLE: (u8, u64) = (1, 0);

#[test]
fn d6_a_poll_without_the_pressure_reading_keeps_waiting() {
    // Critical pressure with plenty available: without the pressure level a poll would look recovered.
    let (mut runner, req) = building(&[CRITICAL, NO_PRESSURE, NO_PRESSURE, OK]);
    let receipt = run(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    let note = &receipt.outcomes["host_wait"];
    assert!(note.contains("waited 15 s"), "{note}");
    assert!(note.contains("recovered"), "{note}");
    assert!(note.contains("pressure normal"), "{note}");
}

#[test]
fn d6_a_poll_without_the_available_memory_keeps_waiting() {
    // Low memory at normal pressure: without available memory a poll would look recovered.
    let (mut runner, req) = building(&[LOW, NO_AVAILABLE, NO_AVAILABLE, OK]);
    let receipt = run(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    let note = &receipt.outcomes["host_wait"];
    assert!(note.contains("waited 15 s"), "{note}");
    assert!(note.contains("8.0 GiB available"), "{note}");
}

#[test]
fn d6_an_incomplete_final_poll_builds_instead_of_refusing() {
    let (mut runner, req) = building(&[CRITICAL, NO_PRESSURE]);
    let receipt = run(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    let note = &receipt.outcomes["host_wait"];
    assert!(note.contains("waited 600 s"), "{note}");
    assert!(note.contains("last reading unavailable"), "{note}");
}

#[test]
fn d6_a_critical_reading_never_refuses_once_the_probes_fail() {
    let (mut runner, req) = building(&[CRITICAL, UNREAD]);
    let receipt = run(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    let note = &receipt.outcomes["host_wait"];
    assert!(note.contains("waited 600 s"), "{note}");
    assert!(note.contains("still constrained"), "{note}");
    assert!(note.contains("last reading unavailable"), "{note}");
}

#[test]
fn d6_a_reading_that_fails_during_the_wait_keeps_waiting() {
    // An overloaded host can time out a probe; that is no evidence memory came back.
    let (mut runner, req) = building(&[CRITICAL, UNREAD, UNREAD, OK]);
    let (receipt, events) = run_with_events(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(runner.samples(), 6);
    assert_eq!(
        waits(&events).last().map(String::as_str),
        Some("host_wait passed")
    );
    let note = &receipt.outcomes["host_wait"];
    assert!(note.contains("waited 15 s"), "{note}");
    assert!(note.contains("recovered"), "{note}");
}

#[test]
fn d7_a_run_that_reuses_its_build_takes_no_preflight() {
    let (repo, app) = app_repo();
    common::write_ios_workspace(&app, "ios/First.xcworkspace");
    configure_workspace(&app, "ios/First.xcworkspace", "Debug");
    std::fs::write(
        app.join("package.json"),
        r#"{"dependencies":{"expo":"56.0.23"}}"#,
    )
    .unwrap();
    let files = format!("{}test-app/package.json\0", common::IOS_NATIVE_FILES);
    let expo = |mock: &mut qaren::exec::MockRunner| {
        common::script_expo_fingerprint(
            mock,
            "abcdef0123456789",
            "Xcode 27.0\nBuild version 27A123\n",
        );
    };
    for reuse in [false, true] {
        let mut req = request(&repo, &app, 30);
        req.runs_root = repo.join(if reuse { "runs-reuse" } else { "runs-seed" });
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        mock.expect_run("ls-files", CmdOutput::success(&files));
        expo(&mut mock);
        for package in ["expo-modules-core", "expo-modules-jsi"] {
            mock.expect_run(package, CmdOutput::success("null"));
        }
        if reuse {
            script_check_install_and_launch(&mut mock);
        } else {
            mock.expect_run("df", df_ok());
            script_check_build_with(&mut mock, "xcodebuild", |m| {
                script_candidate_recheck(m);
                m.expect_run("ls-files", CmdOutput::success(&files));
                expo(m);
            });
        }
        script_ready_recheck_with(&mut mock, &files, expo);
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
        script_core_identity(&mut mock);
        script_teardown(&mut mock);
        // Critical memory throughout: only a build may wait for it.
        let mut runner = host(mock, &[if reuse { CRITICAL } else { OK }], &req);
        let (receipt, events) = run_with_events(&mut runner, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(runner.inner.remaining(), 0);
        if reuse {
            assert_eq!(
                receipt.build.as_ref().unwrap().decision,
                qaren::buildplan::BuildDecision::Reuse
            );
            assert_eq!(runner.samples(), 2);
            assert!(waits(&events).is_empty());
            assert!(!receipt.outcomes.contains_key("host_wait"));
        }
    }
}

#[test]
fn newly_observed_memory_signals_cannot_disappear_to_report_recovery() {
    for memory in [
        vec![(0, LOW.1), CRITICAL, NO_PRESSURE, OK],
        vec![(4, 0), LOW, NO_AVAILABLE, OK],
    ] {
        let (mut runner, req) = building(&memory);
        let receipt = run(&mut runner, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        let note = &receipt.outcomes["host_wait"];
        assert!(note.contains("waited 15 s"), "{note}");
        assert!(note.contains("recovered"), "{note}");
        assert_eq!(runner.inner.remaining(), 0);
    }
}

fn release_contended_lock_on_memory_recheck(runner: &mut HostRunner, req: &RunRequest) {
    let lock = req.lock_root.join("native-build-ios");
    std::fs::create_dir_all(&lock).unwrap();
    let mut samples = 0;
    runner.inner.observe = Some(Box::new(move |spec| {
        if spec.label == "host-sample" && spec.program == "sysctl" {
            samples += 1;
            if samples == 3 {
                std::fs::remove_dir_all(&lock).unwrap();
            }
        }
    }));
}

#[test]
fn critical_memory_after_lock_contention_refuses_without_building() {
    let (mut runner, req) = stopping_before_the_build(&[OK, CRITICAL]);
    release_contended_lock_on_memory_recheck(&mut runner, &req);
    let receipt = run(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Refused, "{:?}", receipt.failure);
    assert_eq!(receipt.failure.unwrap().code, FailureCode::HostUnderPressure);
    assert_no_build_lock(&runner, &req);
    assert_eq!(runner.inner.remaining(), 0);
}

#[test]
fn memory_wait_after_lock_contention_preserves_remaining_build_budget() {
    let (mut runner, req) = building(&[OK, WARNING]);
    let config = std::fs::read_to_string(&req.config_path).unwrap();
    std::fs::write(
        &req.config_path,
        format!("{config}\ndeadlines:\n  build_seconds: 30\n"),
    )
    .unwrap();
    release_contended_lock_on_memory_recheck(&mut runner, &req);
    let receipt = run(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert!(receipt.outcomes["host_wait"].contains("waited 600 s"));
    let build = runner
        .calls
        .iter()
        .find(|c| c.label == "expo-run-ios")
        .unwrap();
    assert_eq!(build.timeout_seconds, 29);
    assert_eq!(runner.inner.remaining(), 0);
}
