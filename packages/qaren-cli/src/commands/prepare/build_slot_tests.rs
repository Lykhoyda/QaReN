use super::*;
use crate::exec::{CmdOutput, MockRunner, PipedChild, Spawned};
use serde_json::json;

const BIRTH: &str = "Wed Aug 12 10:00:00 2026";

struct TestRunner {
    inner: MockRunner,
    release_on_sleep: Option<PathBuf>,
    saw_slot: bool,
    spawn_error: bool,
    fault: Option<&'static str>,
}

impl Runner for TestRunner {
    fn env_var(&self, name: &str) -> Option<String> {
        self.inner.env_var(name)
    }
    fn env_names(&self) -> Vec<String> {
        self.inner.env_names()
    }
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        self.inner.execute(spec, interruptible)
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        let record = RunRecord::load(
            log.parent().unwrap().parent().unwrap().parent().unwrap(),
            "check-slot",
        )
        .unwrap();
        let dir = record
            .resources
            .build_lock
            .as_ref()
            .unwrap()
            .lock_dir
            .parent()
            .unwrap()
            .join("native-build-slot");
        self.saw_slot = buildplan::read_holder(&dir).is_some_and(|h| h.run_id == "check-slot");
        if self.spawn_error {
            return Err(std::io::Error::other("injected spawn failure"));
        }
        match self.fault {
            Some("save") => {
                std::fs::create_dir(
                    log.parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .join(format!(".run.json.tmp.{}", std::process::id())),
                )
                .unwrap();
            }
            Some("group") => {
                if dir.exists() {
                    std::fs::write(dir.join("holder.json"), "unreadable").unwrap();
                }
            }
            _ => {}
        }
        self.inner.spawn_piped_unchecked(spec, log)
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.saw_slot = buildplan::read_holder(
            &log.parent()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("locks/native-build-slot"),
        )
        .is_some_and(|h| h.run_id == "check-slot");
        if self.spawn_error {
            return Err(std::io::Error::other("injected spawn failure"));
        }
        match self.fault {
            Some("save") => {
                std::fs::create_dir(
                    log.parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .join(format!(".run.json.tmp.{}", std::process::id())),
                )
                .unwrap();
            }
            Some("group") => {
                std::fs::write(
                    log.parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .join("locks/native-build-slot/holder.json"),
                    "unreadable",
                )
                .unwrap();
            }
            _ => {}
        }
        self.inner.spawn_group_unchecked(spec, log)
    }
    fn sleep(&mut self, duration: Duration) {
        self.inner.sleep(duration);
        if let Some(path) = self.release_on_sleep.take() {
            if self.fault == Some("wait-root") {
                let root = path.parent().unwrap();
                std::fs::rename(root, root.with_extension("retained")).unwrap();
                std::fs::write(root, "unavailable lock root").unwrap();
            } else {
                std::fs::remove_dir_all(path).unwrap();
            }
        }
    }
    fn now_epoch_ms(&self) -> u64 {
        self.inner.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.inner.commands_executed()
    }
    fn cancellation(&self) -> Option<String> {
        self.inner.cancellation()
    }
}

struct Fixture {
    root: PathBuf,
    runner: TestRunner,
    record: RunRecord,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn fixture(name: &str, platform: Platform) -> Fixture {
    let root = std::env::temp_dir().join(format!("qaren-slot-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let scenario: Scenario =
        serde_yaml::from_str(include_str!("../../../scenarios/ios-simulator.yaml")).unwrap();
    let mut record: RunRecord = serde_json::from_value(json!({
        "schema":RUN_SCHEMA,"run_id":"check-slot","created_at":"2026-11-13T00:00:00Z",
        "scenario":scenario,"scenario_path":root.join("scenario.yaml"),"scenario_sha256":"0".repeat(64),
        "candidate":{"repo_root":root,"project_root":root.join("app"),"app_id":"com.example.app","git_sha":"b".repeat(40),"git_dirty":false},
        "phase":"building","resources":{},"history":[]
    })).unwrap();
    record.scenario.platform = platform;
    record.scenario.deadlines.build_seconds = 3;
    let mut runner = MockRunner::new();
    let holder = LockHolder {
        holder: "own-token".into(),
        run_id: record.run_id.clone(),
        identity: Some(crate::runrecord::PidIdentity {
            pid: std::process::id() as i32,
            started_at: BIRTH.into(),
            command: crate::redact::OutputText::from_output("qaren prepare"),
        }),
        at: record.created_at.clone(),
        home: None,
        qaren_home: Some(root.clone()),
        group: None,
    };
    assert!(matches!(
        buildplan::claim_lock(
            &mut runner,
            &root.join("locks"),
            &format!("native-build-{}", platform_dir(platform)),
            &holder,
            LockPolicy::Strict
        ),
        LockOutcome::Claimed { .. }
    ));
    record.prepare = holder.identity.clone();
    record.resources.build_lock = Some(BuildLockResource {
        lock_dir: root
            .join("locks")
            .join(format!("native-build-{}", platform_dir(platform))),
        holder: holder.holder,
    });
    std::fs::create_dir_all(RunRecord::run_dir(&root, &record.run_id).join("logs")).unwrap();
    record.save(&root).unwrap();
    Fixture {
        root,
        runner: TestRunner {
            inner: runner,
            release_on_sleep: None,
            saw_slot: false,
            spawn_error: false,
            fault: None,
        },
        record,
    }
}

fn finite_script(f: &mut Fixture, exit: Option<i32>) {
    f.runner
        .inner
        .expect_spawn_piped("compiler", 5000, "", exit);
    f.runner
        .inner
        .expect_run("ps -p 5000 -o lstart=", CmdOutput::success(BIRTH));
    f.runner
        .inner
        .expect_run("ps -p 5000 -o command=", CmdOutput::success("compiler"));
    f.runner
        .inner
        .expect_run("ps -A", CmdOutput::success("1 1 S\n"));
}

#[test]
fn s1_s2_waiting_build_starts_after_the_foreign_slot_is_released() {
    for platform in [Platform::Ios, Platform::Android] {
        let mut f = fixture(&format!("released-{}", platform_dir(platform)), platform);
        let slot = f.foreign_slot();
        f.live_poll();
        f.runner.release_on_sleep = Some(slot.clone());
        finite_script(&mut f, Some(0));
        assert!(run_finite_build(
            &mut f.ctx(),
            &CmdSpec::new("native-compile", "compiler", &[], 3)
        )
        .is_ok());
        assert!(f.runner.saw_slot);
        assert!(!slot.exists());
    }
}

#[test]
fn s4_proven_orphan_is_reclaimed_and_named() {
    let mut f = fixture("orphan", Platform::Ios);
    let slot = f.foreign_slot();
    f.runner
        .inner
        .expect_run("ps -p 4242 -o lstart=", CmdOutput::failed(1, ""));
    f.runner
        .inner
        .expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    finite_script(&mut f, Some(0));
    let mut ctx = f.ctx();
    run_finite_build(
        &mut ctx,
        &CmdSpec::new("native-compile", "compiler", &[], 3),
    )
    .unwrap();
    assert!(ctx
        .notes
        .iter()
        .any(|(_, note)| note.contains("check-foreign")));
    assert!(!slot.exists());
}

#[test]
fn s8_s13_finished_failed_cancelled_or_expired_build_releases_only_its_slot() {
    for (name, exit, cancel) in [
        ("pass", Some(0), false),
        ("fail", Some(1), false),
        ("expired", None, false),
        ("cancel", None, true),
    ] {
        let mut f = fixture(name, Platform::Ios);
        finite_script(&mut f, exit);
        if cancel {
            f.runner.inner.cancel_at_ms = Some((1_770_000_000_100, "received SIGINT".into()));
        }
        let mut ctx = f.ctx();
        ctx.build_deadline_ms = Some(ctx.runner.monotonic_ms() + 1000);
        let result = run_finite_build(
            &mut ctx,
            &CmdSpec::new("native-compile", "compiler", &[], 3),
        );
        assert_eq!(result.is_ok(), name == "pass");
        assert!(f.runner.saw_slot);
        assert!(!f.root.join("locks/native-build-slot").exists());
        assert!(f.root.join("locks/native-build-ios").exists());
    }
}

#[test]
fn s12_a_build_that_cannot_spawn_releases_the_slot() {
    let mut f = fixture("spawn-error", Platform::Ios);
    f.runner.spawn_error = true;
    assert!(run_finite_build(
        &mut f.ctx(),
        &CmdSpec::new("native-compile", "compiler", &[], 3)
    )
    .is_err());
    assert!(f.runner.saw_slot);
    assert!(!f.root.join("locks/native-build-slot").exists());
}

#[test]
fn s12_save_and_group_record_faults_never_open_the_build_gate() {
    for fault in ["save", "group"] {
        let mut f = fixture(&format!("fault-{fault}"), Platform::Ios);
        finite_script(&mut f, Some(0));
        f.runner.fault = Some(fault);
        assert!(run_finite_build(
            &mut f.ctx(),
            &CmdSpec::new("native-compile", "compiler", &[], 3)
        )
        .is_err());
        assert!(f.runner.saw_slot);
        assert_eq!(f.runner.inner.piped_stdin_text(0), "");
        assert!(f.root.join("locks/native-build-slot").exists());
    }
}

#[test]
fn w5_lock_wait_producer_emits_safe_holder_facts() {
    let mut f = fixture("producer", Platform::Ios);
    f.foreign_slot();
    for _ in 0..3 {
        f.live_poll();
    }
    let path = f.root.join("events.jsonl");
    crate::events::init();
    crate::events::attach(&path);
    let mut ctx = f.ctx();
    let root = ctx.runs_root.join("locks");
    let holder = lock_holder_for(&mut ctx);
    assert!(claim_ios_build_lock(&mut ctx, &root, "native-build-slot", holder).is_err());
    crate::events::finish();
    let events = std::fs::read_to_string(path).unwrap();
    let stage: serde_json::Value = events
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|e| e["event"] == "stage" && e["payload"]["state"] == "running")
        .unwrap();
    assert_eq!(stage["payload"]["lock"], "native-build-slot");
    assert_eq!(stage["payload"]["holder"], "check-foreign");
    assert_eq!(stage["payload"]["holdMs"], 540000);
    assert!(!events.contains("foreign-token"));
}

#[test]
fn w5_unreadable_holder_stays_absent_from_queue_events() {
    let mut f = fixture("producer-unreadable", Platform::Ios);
    let slot = f.foreign_slot();
    std::fs::write(slot.join("holder.json"), "{").unwrap();
    let path = f.root.join("events.jsonl");
    crate::events::init();
    crate::events::attach(&path);
    let mut ctx = f.ctx();
    let root = ctx.runs_root.join("locks");
    let holder = lock_holder_for(&mut ctx);
    assert!(claim_ios_build_lock(&mut ctx, &root, "native-build-slot", holder).is_err());
    crate::events::finish();
    let stages: Vec<serde_json::Value> = std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|event| event["event"] == "stage")
        .collect();
    assert!(!stages.is_empty());
    assert!(stages
        .iter()
        .all(|event| event["payload"].get("holder").is_none()));
    assert_eq!(stages.last().unwrap()["payload"]["code"], "BUILD_CONTENDED");
}

#[test]
fn w6_producer_keeps_cancellation_and_lock_errors_distinct() {
    for (fault, expected) in [
        ("cancel", "RUN_CANCELLED"),
        ("wait-root", "RUN_RECORD_UPDATE_FAILED"),
    ] {
        let mut f = fixture(&format!("producer-{fault}"), Platform::Ios);
        let slot = f.foreign_slot();
        f.live_poll();
        if fault == "cancel" {
            f.runner.inner.cancel_at_ms = Some((1_770_000_001_000, "received SIGINT".into()));
        } else {
            f.runner.fault = Some(fault);
            f.runner.release_on_sleep = Some(slot);
        }
        let path = f.root.join("events.jsonl");
        crate::events::init();
        crate::events::attach(&path);
        let mut ctx = f.ctx();
        let root = ctx.runs_root.join("locks");
        let holder = lock_holder_for(&mut ctx);
        assert!(claim_ios_build_lock(&mut ctx, &root, "native-build-slot", holder).is_err());
        crate::events::finish();
        let failed: serde_json::Value = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .find(|event| event["event"] == "stage" && event["payload"]["state"] == "failed")
            .unwrap();
        assert_eq!(failed["payload"]["code"], expected);
    }
}

#[test]
fn s7_cleanup_releases_a_retired_build_and_retains_unproven_spawn() {
    for pending in [false, true] {
        let mut f = fixture(&format!("cleanup-{pending}"), Platform::Ios);
        let slot = f.foreign_slot();
        let mut held = buildplan::read_holder(&slot).unwrap();
        held.run_id = "check-slot".into();
        held.holder = "own-token".into();
        buildplan::save_json(&slot.join("holder.json"), &held).unwrap();
        let mut stored = serde_json::to_value(&f.record).unwrap();
        stored["resources"]["build_slot"] =
            json!({"lock_dir":slot,"holder":"own-token","work":"finite"});
        f.record = serde_json::from_value(stored).unwrap();
        if pending {
            f.record.resources.begin_build().unwrap();
        }
        f.record.save(&f.root).unwrap();
        let receipt = crate::commands::cleanup::cleanup(&mut f.runner, &f.root, "check-slot");
        assert_eq!(slot.exists(), pending);
        assert!(receipt.cleanup.contains_key("build_slot"));
        if pending {
            assert!(receipt.cleanup["build_slot"].contains("unproven"));
        }
    }
}

fn expo_script(f: &mut Fixture, log: &str, ready: bool) {
    f.record.resources.adb_server = Some(crate::runrecord::AdbServerResource {
        spawned: Spawned {
            pid: 7100,
            pgid: 7100,
        },
        identity: None,
        server_port: 15037,
        log: f.root.join("adb.log"),
    });
    f.record.resources.adb_local_serial = Some("127.0.0.1:5555".into());
    f.record.resources.adb_path = Some(PathBuf::from("/fake/adb"));
    f.runner.inner.expect_spawn_with_log(
        "expo run:android",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
        log,
    );
    f.runner
        .inner
        .expect_run("ps -p 6000 -o lstart=", CmdOutput::success(BIRTH));
    f.runner.inner.expect_run(
        "ps -p 6000 -o command=",
        CmdOutput::success("expo run:android"),
    );
    for _ in 0..if ready { 1 } else { 2 } {
        f.runner
            .inner
            .expect_run("ps -p 6000 -o lstart=", CmdOutput::success(BIRTH));
        f.runner
            .inner
            .expect_run("ps -p 6000 -o stat=", CmdOutput::success("S"));
        f.runner.inner.expect_run(
            "lsof",
            if ready {
                CmdOutput::success("6001\n")
            } else {
                CmdOutput::failed(1, "")
            },
        );
        if ready {
            f.runner
                .inner
                .expect_run("ps", CmdOutput::success("6000\n"));
            f.runner
                .inner
                .expect_run("curl", CmdOutput::success("packager-status:running"));
            f.runner.inner.expect_run(
                "shell pm path",
                CmdOutput::success("package:/data/app/base.apk\n"),
            );
            f.runner
                .inner
                .expect_run("shell pidof", CmdOutput::success("12345\n"));
        }
    }
}

#[test]
fn s9_gradle_end_releases_the_slot_while_readiness_alone_does_not() {
    for (index, log, complete) in [
        (0, "task output\nBUILD SUCCESSFUL in 12s\n", true),
        (1, "BUILD FAILED in 12s\n", true),
        (2, "task output\n", false),
        (3, "prefix BUILD SUCCESSFUL in 12s\n", false),
        (4, "BUILD SUCCESSFUL in 12s", false),
    ] {
        let mut f = fixture(&format!("expo-{index}"), Platform::Android);
        expo_script(&mut f, log, true);
        let mut ctx = f.ctx();
        build_and_ready(&mut ctx).unwrap();
        assert!(ctx.record.resources.metro.is_some());
        assert_eq!(f.root.join("locks/native-build-slot").exists(), !complete);
        assert!(f.runner.saw_slot);
        assert_eq!(f.runner.inner.remaining(), 0);
    }
}

#[test]
fn s10_s14_readiness_timeout_retains_slot_until_metro_retirement_is_proven() {
    for retired in [false, true] {
        let mut f = fixture(&format!("expo-timeout-{retired}"), Platform::Android);
        expo_script(&mut f, "compiling\n", false);
        let mut ctx = f.ctx();
        assert_eq!(
            build_and_ready(&mut ctx).unwrap_err().code,
            FailureCode::ReadyDeadlineExceeded
        );
        assert!(ctx.record.resources.metro.is_some());
        ctx.record.resources.adb_server = None;
        ctx.record.resources.adb_local_serial = None;
        ctx.record.resources.adb_path = None;
        if !retired {
            ctx.record.resources.metro.as_mut().unwrap().identity = None;
        }
        ctx.save().unwrap();
        assert!(f.root.join("locks/native-build-slot").exists());
        if retired {
            f.runner
                .inner
                .expect_run("ps -p 6000 -o lstart=", CmdOutput::failed(1, ""));
        }
        f.runner.inner.expect_run("lsof", CmdOutput::failed(1, ""));
        if retired {
            f.runner
                .inner
                .expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        }
        let receipt = crate::commands::cleanup::cleanup(&mut f.runner, &f.root, "check-slot");
        assert_eq!(f.root.join("locks/native-build-slot").exists(), !retired);
        if !retired {
            assert!(receipt.cleanup["build_slot"].contains("retained"));
        }
    }
}

impl Fixture {
    fn ctx(&mut self) -> Ctx<'_> {
        Ctx {
            runner: &mut self.runner,
            runs_root: self.root.clone(),
            native_cache_root: self.root.join("cache"),
            native_store_entry: None,
            plan_fingerprint: None,
            ios_observation: None,
            linkage_before_build: None,
            ios_generated_native: false,
            record: self.record.clone(),
            started_ms: 0,
            timings: Vec::new(),
            notes: Vec::new(),
            verb: "prepare",
            bundle_requests_at_launch: None,
            manifest_warm: None,
            lane_owned: false,
            build_deadline_ms: None,
        }
    }
    fn foreign_slot(&mut self) -> PathBuf {
        let holder = LockHolder {
            holder: "foreign-token".into(),
            run_id: "check-foreign".into(),
            identity: Some(crate::runrecord::PidIdentity {
                pid: 4242,
                started_at: BIRTH.into(),
                command: crate::redact::OutputText::from_output("qaren check"),
            }),
            at: timefmt::iso8601_utc(self.runner.now_epoch_ms() - 540_000),
            home: None,
            qaren_home: Some(self.root.join("foreign")),
            group: Some(777),
        };
        assert!(matches!(
            buildplan::claim_lock(
                &mut self.runner,
                &self.root.join("locks"),
                "native-build-slot",
                &holder,
                LockPolicy::Strict
            ),
            LockOutcome::Claimed { .. }
        ));
        self.root.join("locks/native-build-slot")
    }
    fn live_poll(&mut self) {
        self.runner
            .inner
            .expect_run("ps -p 4242 -o lstart=", CmdOutput::success(BIRTH));
        self.runner
            .inner
            .expect_run("ps -p 4242 -o stat=", CmdOutput::success("S"));
        self.runner
            .inner
            .expect_run("ps -A", CmdOutput::success("777 777 S\n"));
    }
}

#[test]
fn s1_s2_s3_both_platforms_wait_and_refuse_without_starting_a_build() {
    for platform in [Platform::Ios, Platform::Android] {
        let mut f = fixture(&format!("budget-{}", platform_dir(platform)), platform);
        let slot = f.foreign_slot();
        for _ in 0..3 {
            f.live_poll();
        }
        let failure = run_finite_build(
            &mut f.ctx(),
            &CmdSpec::new("native-compile", "compiler", &[], 3),
        )
        .unwrap_err();
        assert_eq!(failure.code, FailureCode::BuildContended);
        for expected in [
            "native-build-slot",
            "check-foreign",
            "alive: yes",
            "waited 3 s",
        ] {
            assert!(failure.detail.contains(expected), "{:?}", failure);
        }
        assert!(f.runner.inner.spawned_logs.is_empty());
        assert_eq!(f.runner.inner.remaining(), 0);
        assert_eq!(
            buildplan::read_holder(&slot).unwrap().run_id,
            "check-foreign"
        );
    }
}

#[test]
fn s11_slot_does_not_restart_the_ios_build_window() {
    let mut f = fixture("shared-budget", Platform::Ios);
    f.foreign_slot();
    f.live_poll();
    let mut ctx = f.ctx();
    ctx.build_deadline_ms = Some(ctx.runner.monotonic_ms() + 1000);
    let failure = run_finite_build(
        &mut ctx,
        &CmdSpec::new("native-compile", "compiler", &[], 3),
    )
    .unwrap_err();
    assert_eq!(failure.code, FailureCode::BuildContended);
    assert!(failure.detail.contains("waited 1 s"));
}

#[test]
fn s11_two_lock_waits_share_one_budget_and_both_reach_the_receipt() {
    let mut f = fixture("two-waits", Platform::Ios);
    let slot = f.foreign_slot();
    let platform = f.root.join("locks/native-build-ios");
    let held = buildplan::read_holder(&slot).unwrap();
    buildplan::save_json(&platform.join("holder.json"), &held).unwrap();
    for _ in 0..3 {
        f.live_poll();
    }
    f.runner.release_on_sleep = Some(platform);
    let mut ctx = f.ctx();
    let root = ctx.runs_root.join("locks");
    let start = ctx.runner.monotonic_ms();
    claim_build_lock(&mut ctx, &root).unwrap();
    let failure = run_finite_build(
        &mut ctx,
        &CmdSpec::new("native-compile", "compiler", &[], 3),
    )
    .unwrap_err();
    assert_eq!(failure.code, FailureCode::BuildContended);
    assert_eq!(ctx.runner.monotonic_ms() - start, 3000);
    let receipt = finish_receipt(ctx, crate::receipt::ReceiptResult::Refused, Some(failure));
    assert_eq!(receipt.build_lock_waits.len(), 2);
    assert_eq!(
        receipt.build_lock_waits[0].lock.as_deref(),
        Some("native-build-ios")
    );
    assert_eq!(receipt.build_lock_waits[0].waited_s, 1);
    assert_eq!(
        receipt.build_lock_waits[1].lock.as_deref(),
        Some("native-build-slot")
    );
    assert_eq!(receipt.build_lock_waits[1].waited_s, 2);
    assert!(f.runner.inner.spawned_logs.is_empty());
}

#[test]
fn s9_a_late_complete_line_releases_the_slot_while_metro_keeps_running() {
    let mut f = fixture("expo-late", Platform::Android);
    expo_script(&mut f, "BUILD SUCCESSFUL in 12s", true);
    let mut ctx = f.ctx();
    build_and_ready(&mut ctx).unwrap();
    let mut completion = crate::native_build_slot::GradleCompletion::for_run(&ctx.record).unwrap();
    assert!(!completion.poll().unwrap());
    let log = ctx.record.resources.metro.as_ref().unwrap().log.clone();
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(log)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    assert!(completion.poll().unwrap());
    assert!(!ctx.runs_root.join("locks/native-build-slot").exists());
    assert!(ctx.record.resources.metro.is_some());
}

#[test]
fn s9_a_large_build_log_does_not_hide_its_complete_end_line() {
    let mut f = fixture("expo-large-log", Platform::Android);
    let log = format!("{}\nBUILD SUCCESSFUL in 12s\n", "x".repeat(1_100_000));
    expo_script(&mut f, &log, true);
    let mut ctx = f.ctx();
    build_and_ready(&mut ctx).unwrap();
    assert!(!ctx.runs_root.join("locks/native-build-slot").exists());
    assert!(ctx.record.resources.metro.is_some());
}

#[test]
fn s5_slot_never_reclaims_dead_holder_with_a_live_group_or_records() {
    for records in [false, true] {
        let mut f = fixture(&format!("dead-{records}"), Platform::Ios);
        let slot = f.foreign_slot();
        if records {
            std::fs::create_dir_all(f.root.join("foreign/runs/check-foreign")).unwrap();
            std::fs::write(f.root.join("foreign/runs/check-foreign/run.json"), "{}").unwrap();
        }
        for _ in 0..3 {
            f.runner
                .inner
                .expect_run("ps -p 4242 -o lstart=", CmdOutput::failed(1, ""));
            f.runner.inner.expect_run(
                "ps -A",
                CmdOutput::success(if records { "1 1 S\n" } else { "777 777 S\n" }),
            );
            if !records {
                f.runner
                    .inner
                    .expect_run("ps -A", CmdOutput::success("777 777 S\n"));
            }
        }
        let failure = run_finite_build(
            &mut f.ctx(),
            &CmdSpec::new("native-compile", "compiler", &[], 3),
        )
        .unwrap_err();
        assert_eq!(failure.code, FailureCode::BuildContended);
        assert!(slot.exists());
    }
}

#[test]
fn s12_expo_spawn_save_and_group_faults_keep_only_unproven_ownership() {
    for fault in ["spawn", "save", "group"] {
        let mut f = fixture(&format!("expo-fault-{fault}"), Platform::Android);
        expo_script(&mut f, "compiling\n", true);
        f.runner.fault = Some(fault);
        f.runner.spawn_error = fault == "spawn";
        let mut ctx = f.ctx();
        assert!(build_and_ready(&mut ctx).is_err());
        assert_eq!(
            ctx.runs_root.join("locks/native-build-slot").exists(),
            fault != "spawn"
        );
        assert!(f.runner.saw_slot);
        if fault == "save" {
            let stored = RunRecord::load(&f.root, "check-slot").unwrap();
            assert!(matches!(
                stored.resources.build_slot.unwrap().work,
                BuildSlotWork::MetroSpawnPending
            ));
        }
    }
}
