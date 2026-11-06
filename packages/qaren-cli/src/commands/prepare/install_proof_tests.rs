use super::*;
use crate::exec::{CmdOutput, MockRunner, PipedChild, Spawned};

const UDID: &str = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
const DEVICE_TYPE: &str = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
const RUNTIME: &str = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
const REMEDY: &str = "boot it and re-run, or pass --boot-device";

// (command label, nth matching command, effect)
type Hook = (&'static str, usize, Box<dyn FnMut()>);

// Runs a hook after the nth command with a matching label, as if it happened while that command ran.
struct Hooked {
    inner: MockRunner,
    hook: Option<Hook>,
    seen: usize,
}

impl Runner for Hooked {
    fn env_var(&self, name: &str) -> Option<String> {
        self.inner.env_var(name)
    }
    fn env_names(&self) -> Vec<String> {
        self.inner.env_names()
    }
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        let output = self.inner.execute(spec, interruptible);
        if let Some((label, nth, hook)) = self.hook.as_mut() {
            if spec.label == *label {
                self.seen += 1;
                if self.seen == *nth {
                    hook();
                }
            }
        }
        output
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.inner.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.inner.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, duration: Duration) {
        self.inner.sleep(duration)
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

#[derive(Clone, Copy)]
enum Custody {
    // A --device target of check/pr or prepare; `authorised` is --boot-device/--restart-device.
    Borrowed { authorised: bool },
    // A reused pool member: leased and QaReN's to boot.
    PoolMember,
    // A pool member this run created: leased, owned and QaReN's to boot.
    NewPoolMember,
    // A temporary simulator this run created: owned, no lease.
    Temporary,
}

struct Fixture {
    root: PathBuf,
    runner: Hooked,
    record: RunRecord,
    artifact: CachedArtifact,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn inventory(state: &str) -> CmdOutput {
    CmdOutput::success(
        &serde_json::json!({"devices": {RUNTIME: [{
            "udid": UDID, "name": "selected", "state": state,
            "isAvailable": true, "deviceTypeIdentifier": DEVICE_TYPE,
        }]}})
        .to_string(),
    )
}

fn fixture(name: &str, custody: Custody, booted_minutes_ago: Option<u64>) -> Fixture {
    let root =
        std::env::temp_dir().join(format!("qaren-install-proof-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let mut inner = MockRunner::new();
    let now = inner.now_epoch_ms();
    let scenario: Scenario = serde_json::from_value(serde_json::json!({
        "schema": "qaren/1", "name": "install-proof", "platform": "ios",
        "candidate": { "project_root": "/app", "app_id": "com.example.app", "revision": "HEAD" },
        "ios": { "device_type": DEVICE_TYPE, "runtime": RUNTIME }
    }))
    .unwrap();
    let mut resources = crate::runrecord::Resources::default();
    let (leased, borrowed, authorised, owned) = match custody {
        Custody::Borrowed { authorised } => (true, true, authorised, false),
        Custody::PoolMember => (true, true, true, false),
        Custody::NewPoolMember => (true, true, true, true),
        Custody::Temporary => (false, false, true, true),
    };
    let run_id = format!("proof-{name}");
    if leased {
        resources.lease = Some(
            crate::lease::acquire(
                &mut inner,
                &root.join("locks"),
                Platform::Ios,
                UDID,
                &run_id,
                None,
            )
            .unwrap(),
        );
    }
    resources.device_borrowed = borrowed;
    resources.ios_simulator = Some(IosSimResource {
        udid: UDID.into(),
        name: "selected".into(),
        device_type: DEVICE_TYPE.into(),
        runtime: RUNTIME.into(),
        boot_authorized: authorised,
        owned_by_run: owned,
        booted_proven_at: booted_minutes_ago
            .map(|minutes| timefmt::iso8601_utc(now - minutes * 60_000)),
    });
    let record = RunRecord {
        schema: RUN_SCHEMA.to_string(),
        run_id,
        created_at: timefmt::iso8601_utc(now),
        scenario,
        scenario_path: root.join("scenario.yaml"),
        scenario_sha256: "0".repeat(64),
        plan_sha256: None,
        plan_marker_lines: None,
        candidate: crate::candidate::Candidate {
            repo_root: root.clone(),
            project_root: root.join("app"),
            app_id: "com.example.app".into(),
            git_sha: "b".repeat(40),
            git_dirty: false,
            lockfile_sha256: None,
            worktree_fingerprint: None,
        },
        phase: Phase::Building,
        substage: None,
        prepare: None,
        build: None,
        handoff: None,
        resources,
        failure: None,
        history: Vec::new(),
        terminal: None,
        held: None,
        build_lock: None,
        runtime_version: None,
    };
    let artifact = CachedArtifact {
        sha256: "a".repeat(64),
        path: root.join("App.app"),
        kind: ArtifactKind::AppBundle,
    };
    Fixture {
        root,
        runner: Hooked {
            inner,
            hook: None,
            seen: 0,
        },
        record,
        artifact,
    }
}

impl Fixture {
    fn ctx(&mut self, verb: &'static str) -> Ctx<'_> {
        Ctx {
            runner: &mut self.runner,
            runs_root: self.root.join("runs"),
            native_cache_root: self.root.join("native-store"),
            native_store_entry: None,
            ios_observation: None,
            linkage_before_build: None,
            ios_generated_native: false,
            record: self.record.clone(),
            started_ms: 0,
            timings: Vec::new(),
            notes: Vec::new(),
            verb,
            bundle_requests_at_launch: None,
            manifest_warm: None,
            lane_owned: false,
            build_deadline_ms: None,
        }
    }

    fn expect(&mut self, hint: &str, output: CmdOutput) {
        self.runner.inner.expect_run(hint, output);
    }

    // Another run takes the device lease while the nth command with `label` runs.
    fn replace_lease_during(&mut self, label: &'static str, nth: usize) {
        let lock_dir = self
            .record
            .resources
            .lease
            .as_ref()
            .expect("leased fixture")
            .lock_dir
            .clone();
        self.runner.hook = Some((
            label,
            nth,
            Box::new(move || {
                let mut holder = crate::buildplan::read_holder(&lock_dir).unwrap();
                holder.run_id = "replacement-run".into();
                holder.holder = "replacement-holder".into();
                crate::buildplan::save_json(&lock_dir.join("holder.json"), &holder).unwrap();
            }),
        ));
    }

    fn labels(&self) -> Vec<String> {
        self.runner
            .inner
            .calls
            .iter()
            .map(|spec| spec.label.clone())
            .collect()
    }

    fn deadline_in(&self, ms: u64) -> u64 {
        self.runner.inner.monotonic_ms() + ms
    }
}

fn install<'a>(
    fx: &'a mut Fixture,
    verb: &'static str,
    budget_ms: u64,
) -> (Result<(), Failure>, Ctx<'a>) {
    let deadline = fx.deadline_in(budget_ms);
    let artifact = fx.artifact.clone();
    let mut ctx = fx.ctx(verb);
    let result = install_cached_ios_app(&mut ctx, UDID, &artifact, deadline);
    (result, ctx)
}

const BUDGET_MS: u64 = 2_400_000;

#[test]
fn an_authorised_target_shut_down_before_install_is_re_booted_under_custody_then_installed() {
    for (custody, verb) in [
        (Custody::Borrowed { authorised: true }, "check"),
        (Custody::Borrowed { authorised: true }, "pr"),
        (Custody::Borrowed { authorised: true }, "prepare"),
        (Custody::PoolMember, "prepare"),
        (Custody::NewPoolMember, "prepare"),
        (Custody::Temporary, "prepare"),
    ] {
        let mut fx = fixture("reboot", custody, Some(25));
        fx.expect("simctl list", inventory("Shutdown"));
        fx.expect("simctl bootstatus", CmdOutput::success(""));
        fx.expect("simctl list", inventory("Booted"));
        fx.expect("simctl install", CmdOutput::success(""));
        let booted_before = fx
            .record
            .resources
            .ios_simulator
            .clone()
            .unwrap()
            .booted_proven_at
            .unwrap();
        let shutdown_at = timefmt::iso8601_utc(fx.runner.inner.now_epoch_ms());
        let (result, ctx) = install(&mut fx, verb, BUDGET_MS);
        result.unwrap();
        let expected = format!(
            "re-booted under this run's custody: observed Booted at {booted_before}, Shutdown at {shutdown_at}"
        );
        assert!(ctx
            .notes
            .iter()
            .any(|(key, value)| key == "device_reboot" && *value == expected));
        assert_eq!(ctx.record.history.last().unwrap().note.as_str(), expected);
        assert!(ctx
            .record
            .resources
            .ios_simulator
            .as_ref()
            .unwrap()
            .booted_proven_at
            .is_some());
        let saved = RunRecord::load(&ctx.runs_root, &ctx.record.run_id).unwrap();
        assert_eq!(saved.history.last().unwrap().note.as_str(), expected);
        drop(ctx);
        assert_eq!(
            fx.labels(),
            [
                "simctl-list",
                "simctl-bootstatus",
                "simctl-list",
                "simctl-install"
            ]
        );
        assert_eq!(fx.runner.inner.remaining(), 0);
    }
}

#[test]
fn an_unauthorised_target_shut_down_before_install_refuses_device_not_booted_with_both_times() {
    for verb in ["check", "pr"] {
        let mut fx = fixture(
            "unauthorised",
            Custody::Borrowed { authorised: false },
            Some(25),
        );
        fx.expect("simctl list", inventory("Shutdown"));
        let booted_at = fx
            .record
            .resources
            .ios_simulator
            .clone()
            .unwrap()
            .booted_proven_at
            .unwrap();
        let shutdown_at = timefmt::iso8601_utc(fx.runner.inner.now_epoch_ms());
        let (result, ctx) = install(&mut fx, verb, BUDGET_MS);
        let failure = result.unwrap_err();
        assert_eq!(failure.code, FailureCode::DeviceNotBooted);
        assert!(failure.code.is_refusal());
        assert_eq!(failure.phase, "install");
        assert_eq!(
            failure.detail.as_str(),
            format!("the simulator was observed Booted at {booted_at} and Shutdown at {shutdown_at}, 25 min later, before install; booting it was not authorised for this run; {REMEDY}")
        );
        assert_eq!(failure.next_action.as_str(), REMEDY);
        // Failure handling keeps the remedy: cleanup guidance is prepended, never substituted.
        let receipt = ctx.fail(failure);
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt.next_action,
            format!("qaren cleanup proof-unauthorised --json; then {REMEDY}")
        );
        assert_eq!(fx.labels(), ["simctl-list"]);
    }
}

#[test]
fn a_missing_booted_proof_is_named_as_unknown() {
    let mut fx = fixture("unknown", Custody::Borrowed { authorised: false }, None);
    fx.expect("simctl list", inventory("Shutdown"));
    let shutdown_at = timefmt::iso8601_utc(fx.runner.inner.now_epoch_ms());
    let (result, _) = install(&mut fx, "check", BUDGET_MS);
    let failure = result.unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceNotBooted);
    assert_eq!(
        failure.detail.as_str(),
        format!("the simulator was observed Shutdown at {shutdown_at} before install (proof time unknown); booting it was not authorised for this run; {REMEDY}")
    );
}

#[test]
fn an_authorised_target_without_budget_for_a_boot_and_one_read_refuses_without_booting() {
    // 420 s boot + 10 s read is needed; 429 s is not enough.
    let mut fx = fixture("budget", Custody::Borrowed { authorised: true }, Some(3));
    fx.expect("simctl list", inventory("Shutdown"));
    let (result, _) = install(&mut fx, "check", 429_000);
    let failure = result.unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceNotBooted);
    assert!(
        failure
            .detail
            .contains("insufficient remaining budget to re-boot (429 s left, 430 s needed)"),
        "{failure:?}"
    );
    assert!(failure.detail.contains(", 3 min later, before install"));
    assert_eq!(fx.labels(), ["simctl-list"]);
}

#[test]
fn a_target_still_booted_installs_as_before_and_stamps_the_proof() {
    for custody in [
        Custody::Borrowed { authorised: false },
        Custody::PoolMember,
        Custody::Temporary,
    ] {
        let mut fx = fixture("booted", custody, None);
        fx.expect("simctl list", inventory("Booted"));
        fx.expect("simctl install", CmdOutput::success(""));
        let now = timefmt::iso8601_utc(fx.runner.inner.now_epoch_ms());
        let (result, ctx) = install(&mut fx, "check", BUDGET_MS);
        result.unwrap();
        assert_eq!(
            ctx.record
                .resources
                .ios_simulator
                .as_ref()
                .unwrap()
                .booted_proven_at
                .as_deref(),
            Some(now.as_str())
        );
        assert!(ctx.notes.iter().all(|(key, _)| key != "device_reboot"));
        drop(ctx);
        assert_eq!(fx.labels(), ["simctl-list", "simctl-install"]);
    }
}

#[test]
fn a_real_install_failure_on_a_booted_target_stays_artifact_install_failed() {
    let mut fx = fixture(
        "install-failed",
        Custody::Borrowed { authorised: true },
        Some(1),
    );
    fx.expect("simctl list", inventory("Booted"));
    fx.expect(
        "simctl install",
        CmdOutput::failed(1, "bundle is malformed"),
    );
    let (result, _) = install(&mut fx, "check", BUDGET_MS);
    let failure = result.unwrap_err();
    assert_eq!(failure.code, FailureCode::ArtifactInstallFailed);
    assert!(failure.detail.contains("(install-failed)"), "{failure:?}");
}

#[test]
fn a_replaced_lease_stops_every_further_device_effect() {
    let lease_lost = |fx: &Fixture, result: Result<(), Failure>, calls: &[&str]| {
        let failure = result.unwrap_err();
        assert_eq!(failure.code, FailureCode::DeviceUnavailable);
        assert_eq!(
            failure.detail.as_str(),
            "the device lease is no longer held by this run"
        );
        assert_eq!(fx.labels(), calls);
    };
    // During an inventory read that returns Booted.
    let mut fx = fixture(
        "lease-booted",
        Custody::Borrowed { authorised: true },
        Some(1),
    );
    fx.expect("simctl list", inventory("Booted"));
    fx.replace_lease_during("simctl-list", 1);
    let (result, _) = install(&mut fx, "check", BUDGET_MS);
    lease_lost(&fx, result, &["simctl-list"]);
    // During one that returns Shutdown.
    let mut fx = fixture("lease-shutdown", Custody::PoolMember, Some(1));
    fx.expect("simctl list", inventory("Shutdown"));
    fx.replace_lease_during("simctl-list", 1);
    let (result, _) = install(&mut fx, "prepare", BUDGET_MS);
    lease_lost(&fx, result, &["simctl-list"]);
    // During the boot itself, so the readback is never trusted.
    let mut fx = fixture("lease-boot", Custody::NewPoolMember, Some(1));
    fx.expect("simctl list", inventory("Shutdown"));
    fx.expect("simctl bootstatus", CmdOutput::success(""));
    fx.expect("simctl list", inventory("Booted"));
    fx.replace_lease_during("simctl-bootstatus", 1);
    let (result, _) = install(&mut fx, "prepare", BUDGET_MS);
    lease_lost(
        &fx,
        result,
        &["simctl-list", "simctl-bootstatus", "simctl-list"],
    );
    // During the re-boot readback.
    let mut fx = fixture(
        "lease-readback",
        Custody::Borrowed { authorised: true },
        Some(1),
    );
    fx.expect("simctl list", inventory("Shutdown"));
    fx.expect("simctl bootstatus", CmdOutput::success(""));
    fx.expect("simctl list", inventory("Booted"));
    fx.replace_lease_during("simctl-list", 2);
    let (result, _) = install(&mut fx, "check", BUDGET_MS);
    lease_lost(
        &fx,
        result,
        &["simctl-list", "simctl-bootstatus", "simctl-list"],
    );
    // Between install retries.
    let mut fx = fixture(
        "lease-retry",
        Custody::Borrowed { authorised: false },
        Some(1),
    );
    fx.expect("simctl list", inventory("Booted"));
    fx.expect(
        "simctl install",
        CmdOutput::failed(2, "domain=IXErrorDomain, code=2 Failed to create promise."),
    );
    fx.replace_lease_during("simctl-install", 1);
    let (result, _) = install(&mut fx, "check", BUDGET_MS);
    lease_lost(&fx, result, &["simctl-list", "simctl-install"]);
    assert_eq!(fx.runner.inner.remaining(), 0);
}

#[test]
fn a_spent_budget_reports_the_install_timeout_without_touching_the_device() {
    for budget_ms in [0, 999] {
        let mut fx = fixture("spent", Custody::Borrowed { authorised: true }, Some(1));
        let (result, ctx) = install(&mut fx, "check", budget_ms);
        let failure = result.unwrap_err();
        assert_eq!(failure.code, FailureCode::ArtifactInstallFailed);
        assert!(
            failure
                .detail
                .contains("(install-timeout): preparation budget spent before install"),
            "{failure:?}"
        );
        assert!(ctx
            .notes
            .iter()
            .any(|(key, value)| key == "launch_ready_budget" && value == "spent"));
        drop(ctx);
        assert!(fx.labels().is_empty());
    }
    // A retry that leaves under a second dispatches nothing further.
    let mut fx = fixture("spent-retry", Custody::Temporary, Some(1));
    fx.expect("simctl list", inventory("Booted"));
    fx.expect(
        "simctl install",
        CmdOutput::failed(2, "domain=IXErrorDomain, code=2 Failed to create promise."),
    );
    fx.runner.inner.advance_on = Some(("simctl install".into(), 59_500));
    let (result, _) = install(&mut fx, "check", 60_000);
    let failure = result.unwrap_err();
    assert_eq!(failure.code, FailureCode::ArtifactInstallFailed);
    assert!(
        failure
            .detail
            .contains("(install-timeout): last of 1 attempts"),
        "{failure:?}"
    );
    assert_eq!(fx.labels(), ["simctl-list", "simctl-install"]);
}

#[test]
fn custody_follows_the_allocation() {
    // A created temporary simulator has no lease and is in custody.
    let mut fx = fixture("temporary", Custody::Temporary, None);
    fx.expect("simctl list", inventory("Booted"));
    fx.expect("simctl install", CmdOutput::success(""));
    install(&mut fx, "prepare", BUDGET_MS).0.unwrap();
    // A newly created pool member is owned and still needs its enrolled lease.
    let mut fx = fixture("new-member", Custody::NewPoolMember, None);
    fx.replace_lease_during("simctl-list", 1);
    fx.expect("simctl list", inventory("Booted"));
    let failure = install(&mut fx, "prepare", BUDGET_MS).0.unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceUnavailable);
    // A record with neither a lease nor run ownership is never in custody.
    let mut fx = fixture("no-custody", Custody::Temporary, None);
    fx.record
        .resources
        .ios_simulator
        .as_mut()
        .unwrap()
        .owned_by_run = false;
    let failure = install(&mut fx, "check", BUDGET_MS).0.unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceUnavailable);
    assert!(fx.labels().is_empty());
}

#[test]
fn a_created_simulator_recorded_with_short_identifiers_is_proven_by_its_uuid() {
    let mut fx = fixture("short-ids", Custody::Temporary, None);
    let sim = fx.record.resources.ios_simulator.as_mut().unwrap();
    sim.device_type = "iPhone-17".into();
    sim.runtime = "iOS-26-5".into();
    fx.expect("simctl list", inventory("Shutdown"));
    fx.expect("simctl bootstatus", CmdOutput::success(""));
    fx.expect("simctl list", inventory("Booted"));
    fx.expect("simctl install", CmdOutput::success(""));
    install(&mut fx, "prepare", BUDGET_MS).0.unwrap();
    // A borrowed target whose identity changed is today's failure.
    let mut fx = fixture("changed", Custody::Borrowed { authorised: true }, None);
    fx.record
        .resources
        .ios_simulator
        .as_mut()
        .unwrap()
        .device_type = "com.apple.CoreSimulator.SimDeviceType.iPhone-16".into();
    fx.expect("simctl list", inventory("Booted"));
    let failure = install(&mut fx, "check", BUDGET_MS).0.unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceUnavailable);
    assert_eq!(fx.labels(), ["simctl-list"]);
}

#[test]
fn unusable_inventories_keep_their_own_refusals() {
    // Before any mutation: the shared reader's refusal.
    let mut fx = fixture("unusable", Custody::Borrowed { authorised: true }, Some(1));
    for _ in 0..3 {
        fx.expect(
            "simctl list",
            CmdOutput::failed(1, "CoreSimulator is wedged"),
        );
    }
    let failure = install(&mut fx, "check", BUDGET_MS).0.unwrap_err();
    assert_eq!(failure.code, FailureCode::SimulatorInventoryUnavailable);
    assert!(failure.code.is_refusal());
    assert_eq!(fx.labels(), ["simctl-list"; 3]);
    // After the re-boot: boot_borrowed_ios's own failure.
    let mut fx = fixture("readback", Custody::Borrowed { authorised: true }, Some(1));
    fx.expect("simctl list", inventory("Shutdown"));
    fx.expect("simctl bootstatus", CmdOutput::success(""));
    for _ in 0..3 {
        fx.expect(
            "simctl list",
            CmdOutput::failed(1, "CoreSimulator is wedged"),
        );
    }
    let failure = install(&mut fx, "check", BUDGET_MS).0.unwrap_err();
    assert_eq!(failure.code, FailureCode::SimulatorBootFailed);
    assert!(!fx.labels().contains(&"simctl-install".to_string()));
}

#[test]
fn prepare_keeps_device_unavailable_unauthorised_and_never_re_boots_at_launch_or_ready() {
    let mut fx = fixture(
        "prepare-borrowed",
        Custody::Borrowed { authorised: false },
        Some(1),
    );
    fx.expect("simctl list", inventory("Shutdown"));
    let failure = install(&mut fx, "prepare", BUDGET_MS).0.unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceUnavailable);
    assert_eq!(
        failure.detail.as_str(),
        "selected simulator is Shutdown and booting it was not authorized"
    );
    assert_eq!(fx.labels(), ["simctl-list"]);
    // The launch and Ready re-proofs refuse a Shutdown target even when booting is authorised.
    for custody in [Custody::Borrowed { authorised: true }, Custody::PoolMember] {
        let mut fx = fixture("prepare-launch", custody, Some(1));
        fx.expect("simctl list", inventory("Shutdown"));
        let mut ctx = fx.ctx("prepare");
        let failure = reprove_borrowed_prepare(&mut ctx, None).unwrap_err();
        drop(ctx);
        assert_eq!(failure.code, FailureCode::DeviceUnavailable);
        assert_eq!(fx.labels(), ["simctl-list"]);
    }
}

#[test]
fn an_old_record_without_the_new_fields_loads_for_cleanup_and_runs() {
    let mut fx = fixture(
        "old-record",
        Custody::Borrowed { authorised: true },
        Some(1),
    );
    let ctx = fx.ctx("check");
    ctx.record.save(&ctx.runs_root).unwrap();
    let path = RunRecord::path(&ctx.runs_root, &ctx.record.run_id);
    let mut raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let sim = raw["resources"]["ios_simulator"].as_object_mut().unwrap();
    for key in ["boot_authorized", "owned_by_run", "booted_proven_at"] {
        assert!(sim.remove(key).is_some(), "{key} is persisted");
    }
    std::fs::write(&path, serde_json::to_string(&raw).unwrap()).unwrap();
    let loaded = RunRecord::load(&ctx.runs_root, &ctx.record.run_id).unwrap();
    let sim = loaded.resources.ios_simulator.unwrap();
    assert_eq!(sim.udid, UDID);
    assert!(!sim.boot_authorized && !sim.owned_by_run && sim.booted_proven_at.is_none());
}

#[test]
fn refusal_details_survive_private_output_mode_and_carry_no_inputs() {
    let inputs = std::sync::Arc::new(crate::redact::InputValues::from_entries([(
        "QAREN_INPUT_PASSWORD".into(),
        "sentinel-value-123".into(),
    )]));
    crate::redact::with_input_scope(inputs, || {
        assert!(crate::redact::private_output_mode());
        let mut fx = fixture("private", Custody::Borrowed { authorised: false }, Some(25));
        fx.expect("simctl list", inventory("Shutdown"));
        let (result, ctx) = install(&mut fx, "check", BUDGET_MS);
        let failure = result.unwrap_err();
        let receipt = ctx.fail(failure.clone()).to_json();
        assert!(failure.detail.ends_with(&format!(
            "25 min later, before install; booting it was not authorised for this run; {REMEDY}"
        )));
        assert!(receipt.contains("DEVICE_NOT_BOOTED"));
        assert!(receipt.contains(REMEDY));
        assert!(!receipt.contains("sentinel-value-123"));
        assert!(!receipt.contains("withheld"));
    });
}
