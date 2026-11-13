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
            if self.fault == Some("spawn-release") {
                std::fs::write(
                    log.parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .join("locks/native-build-slot/holder.json"),
                    "{",
                )
                .unwrap();
            }
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
        f.runner.inner.expect_run(
            &format!("ps -p {} -o lstart=", std::process::id()),
            CmdOutput::success(""),
        );
        let receipt = crate::commands::cleanup::cleanup(&mut f.runner, &f.root, "check-slot");
        assert_eq!(slot.exists(), pending);
        assert!(receipt.cleanup.contains_key("build_slot"));
        if pending {
            assert!(receipt.cleanup["build_slot"].contains("unproven"));
        }
    }
}

fn expo_script(f: &mut Fixture, log: &str, ready: bool) {
    expo_script_with_identity(f, log, ready, true);
}

fn expo_script_with_identity(f: &mut Fixture, log: &str, ready: bool, identity: bool) {
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
    f.runner.inner.expect_run(
        "ps -p 6000 -o lstart=",
        if identity {
            CmdOutput::success(BIRTH)
        } else {
            CmdOutput::failed(1, "")
        },
    );
    f.runner.inner.expect_run(
        "ps -p 6000 -o command=",
        CmdOutput::success("expo run:android"),
    );
    if !identity {
        return;
    }
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
        f.runner.inner.expect_run(
            &format!("ps -p {} -o lstart=", std::process::id()),
            CmdOutput::success(""),
        );
        if retired {
            f.runner
                .inner
                .expect_run("ps -p 6000 -o lstart=", CmdOutput::failed(1, ""));
        }
        f.runner.inner.expect_run("lsof", CmdOutput::failed(1, ""));
        f.runner.inner.expect_run(
            "ps -A",
            CmdOutput::success(if retired { "1 1 S\n" } else { "6000 6000 S\n" }),
        );
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

#[test]
fn s14_cleanup_can_retry_slot_release_after_the_metro_record_is_retired() {
    for (name, inventory, released) in [
        ("absent", CmdOutput::success("1 1 S\n"), true),
        ("present", CmdOutput::success("6000 6000 S\n"), false),
        ("unknown", CmdOutput::failed(1, ""), false),
    ] {
        let mut f = fixture(&format!("release-retry-{name}"), Platform::Android);
        expo_script(&mut f, "compiling\n", true);
        f.runner
            .inner
            .expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        let mut ctx = f.ctx();
        build_and_ready(&mut ctx).unwrap();
        let slot = ctx
            .record
            .resources
            .build_slot
            .as_ref()
            .unwrap()
            .lock
            .clone();
        let original = std::fs::read(slot.lock_dir.join("holder.json")).unwrap();
        std::fs::write(slot.lock_dir.join("holder.json"), "{").unwrap();
        let first =
            crate::commands::cleanup::cleanup_build_slot(ctx.runner, &mut ctx.record).unwrap();
        assert!(!first.clean());
        ctx.record.resources.metro = None;
        ctx.record.resources.adb_server = None;
        ctx.record.resources.adb_local_serial = None;
        ctx.record.resources.adb_path = None;
        ctx.save().unwrap();
        std::fs::write(slot.lock_dir.join("holder.json"), original).unwrap();
        f.runner.inner.expect_run(
            &format!("ps -p {} -o lstart=", std::process::id()),
            CmdOutput::success(""),
        );
        f.runner.inner.expect_run("ps -A", inventory);
        let receipt = crate::commands::cleanup::cleanup(&mut f.runner, &f.root, "check-slot");
        assert_eq!(slot.lock_dir.exists(), !released);
        assert_eq!(
            receipt.cleanup["build_slot"].contains("retained"),
            !released
        );
    }
}

#[test]
fn s14_a_foreign_slot_is_never_reported_as_this_runs_retained_slot() {
    let mut f = fixture("foreign-after-completion", Platform::Android);
    expo_script(&mut f, "compiling\n", true);
    let mut ctx = f.ctx();
    build_and_ready(&mut ctx).unwrap();
    let slot = ctx
        .record
        .resources
        .build_slot
        .as_ref()
        .unwrap()
        .lock
        .clone();
    let mut next = buildplan::read_holder(&slot.lock_dir).unwrap();
    next.run_id = "check-next".into();
    next.holder = "next-holder".into();
    buildplan::save_json(&slot.lock_dir.join("holder.json"), &next).unwrap();
    ctx.record.resources.metro = None;
    let outcome =
        crate::commands::cleanup::cleanup_build_slot(ctx.runner, &mut ctx.record).unwrap();
    assert!(outcome.clean());
    assert_eq!(
        buildplan::read_holder(&slot.lock_dir).unwrap().run_id,
        "check-next"
    );
    assert!(ctx.record.resources.build_slot.is_none());
}

#[test]
fn s9_repeated_release_errors_add_only_one_readiness_note() {
    let mut f = fixture("release-notes", Platform::Android);
    expo_script(&mut f, "compiling\n", true);
    let mut ctx = f.ctx();
    build_and_ready(&mut ctx).unwrap();
    let slot = ctx
        .record
        .resources
        .build_slot
        .as_ref()
        .unwrap()
        .lock
        .clone();
    let log = ctx.record.resources.metro.as_ref().unwrap().log.clone();
    std::fs::write(slot.lock_dir.join("holder.json"), "{").unwrap();
    std::fs::write(log, "BUILD SUCCESSFUL in 12s\n").unwrap();
    f.record = ctx.record.clone();
    for _ in 0..2 {
        f.runner
            .inner
            .expect_run("ps -p 6000 -o lstart=", CmdOutput::success(BIRTH));
        f.runner
            .inner
            .expect_run("ps -p 6000 -o stat=", CmdOutput::success("S"));
        f.runner.inner.expect_run("lsof", CmdOutput::failed(1, ""));
    }
    let mut ctx = f.ctx();
    assert!(wait_ready(&mut ctx).is_err());
    assert_eq!(
        ctx.notes
            .iter()
            .filter(|(key, _)| key == "build_slot")
            .count(),
        1
    );
}

#[test]
fn s12_a_failed_slot_release_does_not_hide_the_expo_spawn_failure() {
    let mut f = fixture("spawn-and-release", Platform::Android);
    expo_script(&mut f, "", true);
    f.runner.spawn_error = true;
    f.runner.fault = Some("spawn-release");
    let mut ctx = f.ctx();
    let failure = build_and_ready(&mut ctx).unwrap_err();
    assert_eq!(failure.code, FailureCode::BuildFailed);
    assert!(failure.detail.contains("injected spawn failure"));
    assert!(ctx.notes.iter().any(|(key, _)| key == "build_slot_release"));
}

fn colliding_foreign_slot(f: &mut Fixture) -> PathBuf {
    let dir = f.foreign_slot();
    let mut held = buildplan::read_holder(&dir).unwrap();
    held.run_id = f.record.run_id.clone();
    held.holder = android::holder(&held.run_id);
    buildplan::save_json(&dir.join("holder.json"), &held).unwrap();
    dir
}

#[test]
fn a_waiter_never_releases_another_homes_slot_with_the_same_run_id() {
    for cancelled in [false, true] {
        let mut f = fixture(&format!("same-run-id-{cancelled}"), Platform::Android);
        let dir = colliding_foreign_slot(&mut f);
        for _ in 0..3 {
            f.live_poll();
        }
        if cancelled {
            f.runner.inner.cancel_after = Some(("ps -A".into(), "cancelled".into()));
        }
        let mut ctx = f.ctx();
        let failure = claim_build_slot(&mut ctx).unwrap_err();
        assert_eq!(
            failure.code,
            if cancelled {
                FailureCode::RunCancelled
            } else {
                FailureCode::BuildContended
            }
        );
        let outcome =
            crate::commands::cleanup::cleanup_build_slot(ctx.runner, &mut ctx.record).unwrap();
        assert!(
            dir.exists(),
            "a waiting run released the foreign build slot: {}",
            outcome.render()
        );
        assert_eq!(
            buildplan::read_holder(&dir).unwrap().identity.unwrap().pid,
            4242
        );
        ctx.save().unwrap();
        let root = ctx.runs_root.clone();
        let _receipt = crate::commands::cleanup::cleanup(ctx.runner, &root, "check-slot");
        assert!(dir.exists());
    }
}

#[test]
fn c3_a_waiter_cannot_record_a_group_in_a_foreign_slot() {
    let mut f = fixture("foreign-group", Platform::Android);
    let dir = colliding_foreign_slot(&mut f);
    f.runner.inner.cancel_at_ms = Some((0, "cancel before claim".into()));
    let mut ctx = f.ctx();
    assert!(claim_build_slot(&mut ctx).is_err());
    let slot = ctx.record.resources.build_slot.as_ref().unwrap();
    assert!(
        buildplan::record_holder_group(&dir, &slot.lock.holder, &ctx.record.run_id, 999).is_err()
    );
    assert_eq!(buildplan::read_holder(&dir).unwrap().group, Some(777));
}

#[test]
fn c4_orphan_recovery_uses_the_holders_home_with_a_colliding_run_id() {
    for records in [false, true] {
        let mut f = fixture(&format!("orphan-collision-{records}"), Platform::Android);
        let dir = colliding_foreign_slot(&mut f);
        if records {
            let path = f.root.join("foreign/runs/check-slot");
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("run.json"), "{}").unwrap();
        }
        for _ in 0..if records { 3 } else { 1 } {
            f.runner
                .inner
                .expect_run("ps -p 4242 -o lstart=", CmdOutput::failed(1, ""));
            f.runner
                .inner
                .expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        }
        let mut ctx = f.ctx();
        assert_eq!(claim_build_slot(&mut ctx).is_ok(), !records);
        let held = buildplan::read_holder(&dir).unwrap();
        assert_eq!(held.identity.unwrap().pid == 4242, records);
    }
}

#[test]
fn c5_the_real_claim_saves_one_private_token_and_reuses_it_after_interruption() {
    let mut f = fixture("persisted-token", Platform::Android);
    f.runner.inner.cancel_at_ms = Some((0, "interrupted before claim".into()));
    let mut ctx = f.ctx();
    assert!(claim_build_slot(&mut ctx).is_err());
    let stored = RunRecord::load(&ctx.runs_root, &ctx.record.run_id).unwrap();
    let lock = stored.resources.build_slot.as_ref().unwrap().lock.clone();
    assert!(!lock.lock_dir.exists());
    assert!(
        lock.holder.starts_with("qaren-check-slot-"),
        "{}",
        lock.holder
    );
    f.record = stored;
    f.runner.inner.cancel_at_ms = None;
    let mut ctx = f.ctx();
    claim_build_slot(&mut ctx).unwrap();
    assert_eq!(
        ctx.record
            .resources
            .build_slot
            .as_ref()
            .unwrap()
            .lock
            .holder,
        lock.holder
    );
    assert_eq!(
        buildplan::read_holder(&lock.lock_dir).unwrap().holder,
        lock.holder
    );
    release_build_slot(&mut ctx).unwrap();
    assert!(!lock.lock_dir.exists());
}

#[test]
fn c6_same_run_ids_in_two_homes_get_different_tokens() {
    for no_entropy in [false, true] {
        crate::lease::TOKEN_ENTROPY_UNAVAILABLE.with(|failed| failed.set(no_entropy));
        let mut a = fixture(&format!("identity-home-a-{no_entropy}"), Platform::Android);
        let mut b = fixture(&format!("identity-home-b-{no_entropy}"), Platform::Android);
        let mut ca = a.ctx();
        let mut cb = b.ctx();
        claim_build_slot(&mut ca).unwrap();
        claim_build_slot(&mut cb).unwrap();
        crate::lease::TOKEN_ENTROPY_UNAVAILABLE.with(|failed| failed.set(false));
        assert_ne!(
            ca.record.resources.build_slot.unwrap().lock.holder,
            cb.record.resources.build_slot.unwrap().lock.holder
        );
    }
}

#[test]
fn c8_unresolved_release_never_exposes_either_private_token() {
    let mut f = fixture("release-race", Platform::Android);
    let mut ctx = f.ctx();
    claim_build_slot(&mut ctx).unwrap();
    let slot = ctx.record.resources.build_slot.as_ref().unwrap().clone();
    let own = slot.lock.holder.clone();
    let foreign = "private-foreign-token-that-must-not-escape";
    crate::buildplan::RELEASE_RECHECK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move |isolated, leaf| {
            let mut held = buildplan::read_holder(isolated).unwrap();
            held.holder = foreign.into();
            buildplan::save_json(&isolated.join("holder.json"), &held).unwrap();
            std::fs::create_dir(leaf).unwrap();
        }))
    });
    let failure = release_build_slot(&mut ctx).unwrap_err();
    let notes = format!("{:?}", ctx.notes);
    ctx.save().unwrap();
    let root = ctx.runs_root.clone();
    let receipt = finish_receipt(ctx, crate::receipt::ReceiptResult::Refused, Some(failure));
    f.runner.inner.expect_run(
        &format!("ps -p {} -o lstart=", std::process::id()),
        CmdOutput::success(""),
    );
    let cleanup = crate::commands::cleanup::cleanup(&mut f.runner, &root, "check-slot");
    let public = format!(
        "{}\n{notes}\n{}",
        serde_json::to_string(&receipt).unwrap(),
        serde_json::to_string(&cleanup).unwrap()
    );
    for token in [own.as_str(), foreign] {
        assert!(!public.contains(token), "token escaped: {public}");
    }
    assert!(public.contains("native-build-slot"));
}

#[test]
fn c2_cleanup_releases_the_owners_private_claim() {
    let mut f = fixture("private-owner-cleanup", Platform::Android);
    let mut ctx = f.ctx();
    claim_build_slot(&mut ctx).unwrap();
    let dir = ctx
        .record
        .resources
        .build_slot
        .as_ref()
        .unwrap()
        .lock
        .lock_dir
        .clone();
    ctx.save().unwrap();
    let root = ctx.runs_root.clone();
    drop(ctx);
    f.runner.inner.expect_run(
        &format!("ps -p {} -o lstart=", std::process::id()),
        CmdOutput::success(""),
    );
    let receipt = crate::commands::cleanup::cleanup(&mut f.runner, &root, "check-slot");
    assert_eq!(receipt.cleanup["build_slot"], "removed");
    assert!(!dir.exists());
}

#[test]
fn c7_wait_timeout_foreign_release_and_cleanup_keep_tokens_private() {
    let mut f = fixture("privacy-wait", Platform::Android);
    let dir = colliding_foreign_slot(&mut f);
    let foreign = buildplan::read_holder(&dir).unwrap().holder;
    for _ in 0..3 {
        f.live_poll();
    }
    let path = f.root.join("events.jsonl");
    crate::events::init();
    crate::events::attach(&path);
    let mut ctx = f.ctx();
    let failure = claim_build_slot(&mut ctx).unwrap_err();
    let lock = ctx
        .record
        .resources
        .build_slot
        .as_ref()
        .unwrap()
        .lock
        .clone();
    let release = crate::native_build_slot::release(&lock, &ctx.record.run_id);
    assert!(matches!(release, buildplan::ReleaseOutcome::Foreign(_)));
    let root = ctx.runs_root.clone();
    let receipt = ctx.fail(failure);
    f.runner.inner.expect_run(
        &format!("ps -p {} -o lstart=", std::process::id()),
        CmdOutput::success(""),
    );
    let cleanup = crate::commands::cleanup::cleanup(&mut f.runner, &root, "check-slot");
    crate::events::finish();
    let events = std::fs::read_to_string(path).unwrap();
    let watch = crate::watch::test_public_outputs(&events);
    let public = format!(
        "{events}\n{watch}\n{:?}\n{}\n{}",
        release,
        serde_json::to_string(&receipt).unwrap(),
        serde_json::to_string(&cleanup).unwrap()
    );
    for token in [lock.holder.as_str(), foreign.as_str()] {
        assert!(!public.contains(token), "private token in output: {public}");
        for log in &f.runner.inner.spawned_logs {
            assert!(!std::fs::read_to_string(log)
                .unwrap_or_default()
                .contains(token));
        }
    }
    assert!(dir.exists());
}

#[test]
fn review_s1_identity_capture_failure_can_release_only_a_proven_absent_group() {
    for (name, inventory, released) in [
        ("absent", CmdOutput::success("1 1 S\n"), true),
        ("present", CmdOutput::success("6000 6000 S\n"), false),
        ("unknown", CmdOutput::failed(1, ""), false),
    ] {
        let mut f = fixture(&format!("identity-lost-{name}"), Platform::Android);
        expo_script_with_identity(&mut f, "compiling\n", false, false);
        let mut ctx = f.ctx();
        let failure = build_and_ready(&mut ctx).unwrap_err();
        assert_eq!(failure.code, FailureCode::BuildFailed);
        assert!(failure.detail.contains("exited immediately"));
        assert!(ctx
            .record
            .resources
            .metro
            .as_ref()
            .unwrap()
            .identity
            .is_none());
        ctx.record.resources.adb_server = None;
        ctx.record.resources.adb_local_serial = None;
        ctx.record.resources.adb_path = None;
        ctx.save().unwrap();
        f.runner.inner.expect_run(
            &format!("ps -p {} -o lstart=", std::process::id()),
            CmdOutput::success(""),
        );
        f.runner.inner.expect_run("lsof", CmdOutput::failed(1, ""));
        f.runner.inner.expect_run("ps -A", inventory);
        let receipt = crate::commands::cleanup::cleanup(&mut f.runner, &f.root, "check-slot");
        assert_eq!(f.root.join("locks/native-build-slot").exists(), !released);
        assert_eq!(
            receipt.cleanup["build_slot"].contains("retained"),
            !released
        );
        assert_eq!(f.runner.inner.remaining(), 0);
    }
}

#[test]
fn review_s2_core_wait_releases_a_late_gradle_completion_before_teardown() {
    let mut f = fixture("core-slot-poller", Platform::Android);
    expo_script(&mut f, "compiling\n", true);
    let mut ctx = f.ctx();
    build_and_ready(&mut ctx).unwrap();
    let slot = ctx
        .record
        .resources
        .build_slot
        .as_ref()
        .unwrap()
        .lock
        .lock_dir
        .clone();
    let log = ctx.record.resources.metro.as_ref().unwrap().log.clone();
    let run_dir = RunRecord::run_dir(&ctx.runs_root, &ctx.record.run_id);
    let request = crate::core::CoreRequest {
        run_id: ctx.record.run_id.clone(),
        t0: ctx.runner.now_epoch_ms(),
        walk_budget_ms: 60_000,
        attach_budget_ms: 10_000,
        plan: "1. Check app\n".into(),
        prepared: json!({"hash":"fixture","blocks":[]}),
        preflight_calls: vec![],
        platform: "android".into(),
        app_id: "com.example.app".into(),
        app_root: ctx.runs_root.join("app"),
        run_dir: run_dir.clone(),
        lease: "fixture".into(),
        login_block: None,
        login_marker: None,
        video_policy: Default::default(),
        target: crate::core::CoreTarget {
            device_id: "fixture-device".into(),
            device_name: "fixture".into(),
            metro_port: 8791,
            metro_url_for_device: "http://127.0.0.1:8791".into(),
            worktree: ctx.runs_root.join("app"),
            metro_bundle_requests: None,
            manifest_warm: None,
            warm_lane: false,
        },
    };
    let record = ctx.record.clone();
    let stdout = format!(
        "{}\n{}\n",
        json!({"v":1,"runId":"check-slot","seq":2,"type":"resource","payload":{"kind":"runner_driver","pid":9001}}),
        json!({"v":1,"runId":"check-slot","seq":3,"type":"result","payload":{"verdict":"PASS","path":"walk","blocks":[],"steps":[],"jev":{"calls":0,"medianMs":0},"llmTurns":0,"escapes":0,"recoveries":0}})
    );
    f.runner
        .inner
        .expect_spawn_piped("core-fixture", 9000, &stdout, Some(0));
    let mut child = crate::core::spawn(
        &mut f.runner,
        &CmdSpec::new("core", "core-fixture", &[], 60),
        &run_dir.join("logs/core.log"),
        &request,
    )
    .unwrap();
    child.watch_build_slot(&record);
    let mut appended = false;
    let outcome = crate::core::wait(
        &mut f.runner,
        child,
        crate::core::Budgets {
            walk_seconds: 60,
            step_seconds: 10,
        },
        &mut |runner, _| {
            assert!(slot.exists());
            std::fs::write(&log, "compiling\nBUILD SUCCESSFUL in 3s\n").unwrap();
            appended = true;
            runner.sleep(Duration::from_millis(1000));
        },
    );
    assert!(appended);
    assert!(matches!(outcome.verdict, crate::core::Verdict::Pass));
    assert!(
        !slot.exists(),
        "core wait must release the slot before any teardown"
    );
    assert!(record.resources.metro.is_some());
}

#[test]
fn cleanup_retains_expo_slot_until_all_descendants_are_absent() {
    for (name, metro_inventory, inventory, released) in [
        (
            "absent",
            CmdOutput::success("1 1 S\n"),
            CmdOutput::success("1 1 S\n"),
            true,
        ),
        (
            "descendant",
            CmdOutput::success("6001 6000 S\n"),
            CmdOutput::success("6001 6000 S\n"),
            false,
        ),
        (
            "unknown",
            CmdOutput::failed(1, ""),
            CmdOutput::failed(1, ""),
            false,
        ),
        (
            "changed",
            CmdOutput::success("1 1 S\n"),
            CmdOutput::success("6001 6000 S\n"),
            false,
        ),
    ] {
        let mut f = fixture(&format!("dead-expo-leader-{name}"), Platform::Android);
        expo_script(&mut f, "compiling\n", true);
        let mut ctx = f.ctx();
        build_and_ready(&mut ctx).unwrap();
        ctx.record.resources.adb_server = None;
        ctx.record.resources.adb_local_serial = None;
        ctx.record.resources.adb_path = None;
        ctx.save().unwrap();
        f.runner.inner.expect_run(
            &format!("ps -p {} -o lstart=", std::process::id()),
            CmdOutput::success(""),
        );
        f.runner
            .inner
            .expect_run("ps -p 6000 -o lstart=", CmdOutput::failed(1, ""));
        f.runner.inner.expect_run("lsof", CmdOutput::failed(1, ""));
        f.runner.inner.expect_run("ps -A", metro_inventory);
        f.runner.inner.expect_run("ps -A", inventory);
        let receipt = crate::commands::cleanup::cleanup(&mut f.runner, &f.root, "check-slot");
        assert_eq!(
            receipt.cleanup["metro"] == "absent",
            matches!(name, "absent" | "changed")
        );
        assert_eq!(f.root.join("locks/native-build-slot").exists(), !released);
        let stored = RunRecord::load(&f.root, "check-slot").unwrap();
        assert_eq!(stored.resources.build_slot.is_some(), !released);
        assert_eq!(
            receipt.cleanup["build_slot"].contains("retained"),
            !released
        );
        assert_eq!(f.runner.inner.remaining(), 0);
    }
}

#[test]
fn external_cleanup_requires_build_slot_owner_death_before_touching_resources() {
    for platform in [Platform::Ios, Platform::Android] {
        for work in ["finite", "pending", "metro"] {
            for owner in ["alive", "unknown", "missing", "dead", "reused"] {
                let mut f = fixture(
                    &format!("cleanup-owner-{}-{work}-{owner}", platform_dir(platform)),
                    platform,
                );
                let mut ctx = f.ctx();
                claim_build_slot(&mut ctx).unwrap();
                ctx.record.resources.build_slot.as_mut().unwrap().work = match work {
                    "pending" => BuildSlotWork::MetroSpawnPending,
                    "metro" => BuildSlotWork::Metro { pgid: 6000 },
                    _ => BuildSlotWork::Finite,
                };
                if owner == "missing" {
                    ctx.record.prepare = None;
                }
                ctx.save().unwrap();
                let path = RunRecord::path(&ctx.runs_root, "check-slot");
                let before = std::fs::read(&path).unwrap();
                let slot = ctx
                    .record
                    .resources
                    .build_slot
                    .as_ref()
                    .unwrap()
                    .lock
                    .lock_dir
                    .clone();
                let holder = std::fs::read(slot.join("holder.json")).unwrap();
                drop(ctx);
                if owner != "missing" {
                    f.runner.inner.expect_run(
                        &format!("ps -p {} -o lstart=", std::process::id()),
                        match owner {
                            "alive" => CmdOutput::success(BIRTH),
                            "unknown" => CmdOutput::failed(1, "ps denied"),
                            "reused" => CmdOutput::success("another birth"),
                            _ => CmdOutput::success(""),
                        },
                    );
                    if owner == "alive" {
                        f.runner.inner.expect_run("stat=", CmdOutput::success("S"));
                    }
                }
                let gone = matches!(owner, "dead" | "reused");
                if gone && work == "metro" {
                    f.runner
                        .inner
                        .expect_run("ps -A", CmdOutput::success("1 1 S\n"));
                }
                let receipt =
                    crate::commands::cleanup::cleanup(&mut f.runner, &f.root, "check-slot");
                if gone {
                    assert_eq!(slot.exists(), work == "pending");
                    assert_ne!(receipt.result, crate::receipt::ReceiptResult::Refused);
                } else {
                    assert_eq!(receipt.result, crate::receipt::ReceiptResult::Refused);
                    assert_eq!(std::fs::read(&path).unwrap(), before);
                    assert_eq!(std::fs::read(slot.join("holder.json")).unwrap(), holder);
                    assert!(receipt.cleanup["build_slot"].starts_with("refused"));
                    assert!(f
                        .runner
                        .inner
                        .calls
                        .iter()
                        .all(|call| call.label.starts_with("ps-")));
                }
                assert_eq!(f.runner.inner.remaining(), 0);
            }
        }
    }
}
