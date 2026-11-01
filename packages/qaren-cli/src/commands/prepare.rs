use crate::adapters::{android, devclient, ios, metro};
use crate::buildplan::{
    self, ArtifactKind, ArtifactStatus, BuildDecision, BuildPlan, CachedArtifact, LockHolder,
    LockOutcome, LockPolicy, StateStatus, StoreRecord,
};
use crate::cancel::ensure_running;
use crate::candidate;
use crate::events::StageState;
use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode, RecoveryReason};
use crate::fingerprint::{self, NativeFingerprint};
use crate::handoff::{self, ExpectedReceipt, HandoffDocument, HandoffState, HANDOFF_SCHEMA};
use crate::pool::{self, PoolMember};
use crate::receipt::{Receipt, ReceiptResult};
use crate::redact::redact_secrets;
use crate::runrecord::{
    capture_pid_identity, probe_pid_identity, AppInstallResource, BuildLockObservation,
    BuildLockResource, FarmResource, IosSimResource, LockObservation, MetroResource, Phase,
    PidLiveness, RunRecord, TunnelResource, UsbDeviceResource, RUN_SCHEMA,
};
use crate::scenario::{BuildOwner, BuildStrategy, DepsPolicy, IosSpec, Platform, Scenario};
use crate::timefmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub struct PrepareArgs {
    pub scenario_path: PathBuf,
    pub dry_run: bool,
    pub android_home: Option<String>,
    pub lock_root: PathBuf,
    pub runs_root: PathBuf,
    pub native_cache_root: PathBuf,
    // Exact existing iOS simulator UUID to borrow under the device lease instead of creating one.
    pub device: Option<String>,
    pub boot_device: bool,
    // Per-home records of QaReN-created iOS simulators that default prepare reuses.
    pub pool_root: PathBuf,
    // --new: a fresh temporary simulator deleted at cleanup, outside the pool.
    pub new_device: bool,
}

fn platform_dir(platform: Platform) -> &'static str {
    match platform {
        Platform::Ios => "ios",
        Platform::Android => "android",
    }
}

// Only qaren-owned build paths call this; scenario validation guarantees a
// `metro:` section whenever build.owner is qaren.
fn qaren_metro_port(scenario: &Scenario) -> u16 {
    scenario
        .metro
        .as_ref()
        .expect("validated qaren-owned scenario carries metro")
        .port
}

pub(crate) struct Ctx<'a> {
    pub(crate) runner: &'a mut dyn Runner,
    pub(crate) runs_root: PathBuf,
    pub(crate) native_cache_root: PathBuf,
    pub(crate) native_store_entry: Option<buildplan::NativeStoreEntry>,
    pub(crate) record: RunRecord,
    pub(crate) started_ms: u64,
    pub(crate) timings: Vec<(String, u64)>,
    pub(crate) notes: Vec<(String, String)>,
    pub(crate) verb: &'static str,
    // Metro's drained bundle-request count when the CLI launched the app.
    pub(crate) bundle_requests_at_launch: Option<u64>,
    // The dev client manifest warm-up that cleared the launch.
    pub(crate) manifest_warm: Option<crate::core::ManifestWarm>,
    // The run owns this exact iOS simulator and pins its locale and keyboard before launch.
    pub(crate) lane_owned: bool,
    // Monotonic end of the iOS build window: lock wait, prebuild, build, verification and publication share it.
    pub(crate) build_deadline_ms: Option<u64>,
}

impl<'a> Ctx<'a> {
    pub(crate) fn mark(&mut self, label: &str, phase_start_ms: u64) -> u64 {
        let now = self.runner.now_epoch_ms();
        self.timings
            .push((label.to_string(), now.saturating_sub(phase_start_ms)));
        now
    }

    pub(crate) fn save(&mut self) -> Result<(), Failure> {
        self.record.save(&self.runs_root)
    }

    pub(crate) fn fail(mut self, mut failure: Failure) -> Receipt {
        // An already-cancelled failure keeps its own recovery.
        if failure.code != FailureCode::RunCancelled {
            failure = ensure_running(self.runner, &failure.phase)
                .err()
                .unwrap_or(failure);
        }
        let metro_cleanup =
            if self.verb == "prepare" && self.record.scenario.platform == Platform::Ios {
                self.record.resources.metro.clone().map(|metro| {
                    let outcome = super::cleanup::cleanup_process_group(
                        self.runner,
                        metro.identity.as_ref(),
                        metro.spawned.pgid,
                        Some(metro.port),
                    );
                    if outcome.clean() {
                        self.record.resources.metro = None;
                    }
                    outcome.render()
                })
            } else {
                None
            };
        if self.record.resources.any_owned()
            && !matches!(
                failure.code,
                FailureCode::ArtifactInstallFailed | FailureCode::BuildContended
            )
            && failure.build_recovery().is_none_or(|r| {
                r.reason != RecoveryReason::ForeignAdmissionUnresolved
                    && !(failure.phase == "fresh_install"
                        && r.reason == RecoveryReason::IdentityUnavailable)
            })
        {
            failure.next_action = crate::redact::OutputText::from_output(&format!(
                "qaren cleanup {} --json",
                self.record.run_id
            ));
        }
        if self.record.resources.any_owned() {
            failure.recovery = failure
                .recovery
                .take()
                .map(|r| Box::new(r.with_own_cleanup(&self.record.run_id)));
        }
        // Contention is a refusal even after the run record exists: nothing
        // broke, qaren declined to take a claimed resource.
        let result = if failure.code.is_refusal() {
            ReceiptResult::Refused
        } else {
            ReceiptResult::Failed
        };
        self.record.phase = Phase::Failed;
        self.record.failure = Some(failure.clone());
        let at = timefmt::iso8601_utc(self.runner.now_epoch_ms());
        self.record
            .push_history(at, &format!("failed: {}", failure.code_str()));
        if let Err(save_failure) = self.save() {
            failure.detail = crate::redact::OutputText::from_output(&format!(
                "{} — AND the run record could not be updated ({}); treat recorded ownership as stale",
                failure.detail, save_failure.detail
            ));
            self.record.failure = Some(failure.clone());
        }
        if let Some(substage) = self.record.substage.clone() {
            self.notes.push(("substage".into(), substage));
        }
        let mut receipt = finish_receipt(self, result, Some(failure));
        if let Some(outcome) = metro_cleanup {
            receipt.cleanup.insert("metro".into(), outcome);
        }
        receipt
    }
}

pub(crate) trait FailureCodeStr {
    fn code_str(&self) -> String;
}

impl FailureCodeStr for Failure {
    fn code_str(&self) -> String {
        serde_json::to_string(&self.code)
            .unwrap_or_default()
            .replace('"', "")
    }
}

pub(crate) fn finish_receipt(ctx: Ctx, result: ReceiptResult, failure: Option<Failure>) -> Receipt {
    let now = ctx.runner.now_epoch_ms();
    let phase = ctx.record.phase.as_str().to_string();
    let next_action = match (&result, &failure) {
        (ReceiptResult::Pass | ReceiptResult::Fail, _) => {
            format!("read the report under {}", RunRecord::run_dir(&ctx.runs_root, &ctx.record.run_id).display())
        }
        (ReceiptResult::Ready, _) if ctx.record.phase == Phase::HandedOff => format!(
            "run the qaren managed build/bind chain against the allocated device (docs/qa/cooperative-qa.md), then: qaren complete {} <build-log> --json",
            ctx.record.run_id
        ),
        (ReceiptResult::Ready, _) => format!(
            "agents can attach now; later run: qaren cleanup {} --json",
            ctx.record.run_id
        ),
        (_, Some(f)) => f.next_action.to_string(),
        _ => String::new(),
    };
    let mut receipt = Receipt::new(
        ctx.verb,
        &ctx.record.run_id,
        result,
        &phase,
        timefmt::iso8601_utc(now),
    );
    receipt.scenario = Some(super::scenario_identity(&ctx.record));
    receipt.candidate = Some(ctx.record.candidate.clone());
    receipt.device = Some(super::device_identity(&ctx.record));
    receipt.metro = super::metro_identity(&ctx.record);
    receipt.build = ctx.record.build.clone();
    receipt.core_cleanup = ctx.record.resources.core_cleanup.clone();
    receipt.fresh_install = ctx.record.resources.fresh_install.clone();
    receipt.lane = ctx.record.resources.lane.clone();
    receipt.build_lock = ctx.record.build_lock.clone();
    for (name, value) in &ctx.notes {
        receipt.outcomes.insert(name.clone(), value.clone());
    }
    receipt.recovery = failure.as_ref().and_then(|f| f.build_recovery().cloned());
    receipt.failure = failure;
    receipt.next_action = next_action;
    receipt.commands_executed = ctx.runner.commands_executed();
    for (label, ms) in &ctx.timings {
        receipt.timings_ms.insert(label.clone(), *ms);
    }
    receipt
        .timings_ms
        .insert("total".to_string(), now.saturating_sub(ctx.started_ms));
    super::attach_artifacts(&mut receipt, &ctx.runs_root, &ctx.record);
    receipt
}

pub fn prepare(runner: &mut dyn Runner, args: &PrepareArgs) -> Receipt {
    let started_ms = runner.now_epoch_ms();
    match prepare_validated(runner, args, started_ms) {
        Ok(receipt) => receipt,
        Err(failure) => {
            // Contention and missing-authorization outcomes are refusals, not
            // failures: nothing broke, qaren declined to proceed.
            let result = if failure.code.is_refusal() {
                ReceiptResult::Refused
            } else {
                ReceiptResult::Failed
            };
            let mut receipt = Receipt::new(
                "prepare",
                "none",
                result,
                &failure.phase.clone(),
                timefmt::iso8601_utc(runner.now_epoch_ms()),
            );
            receipt.next_action = failure.next_action.to_string();
            receipt.failure = Some(failure);
            receipt.commands_executed = runner.commands_executed();
            receipt
        }
    }
}

// Failures before a run record exists come back as Err; everything after is
// folded into the record via Ctx::fail so cleanup can find the resources.
fn prepare_validated(
    runner: &mut dyn Runner,
    args: &PrepareArgs,
    started_ms: u64,
) -> Result<Receipt, Failure> {
    let (mut scenario, raw) = Scenario::load(&args.scenario_path)?;
    if scenario.android_emulator.is_some() {
        return Err(Failure::new(
            "validate",
            FailureCode::ScenarioInvalid,
            "android_emulator is set only by qaren check and qaren pr",
            "remove android_emulator from the scenario; prepare allocates through `android:` or `android_usb:`",
        ));
    }
    let borrowed = borrowed_udid(&scenario, args)?;
    let pool_mode = scenario.platform == Platform::Ios
        && scenario.build.owner == BuildOwner::Cli
        && borrowed.is_none()
        && !args.new_device;
    let scenario_sha256 = candidate::sha256_hex(raw.as_bytes());
    let scenario_dir = args
        .scenario_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let cand = candidate::resolve(runner, &scenario, &scenario_dir)?;
    if let Some(workspace) = scenario.build.ios_workspace.as_ref() {
        ios::validate_workspace(&cand.project_root, workspace)?;
    }
    let repo_root = cand.repo_root.clone();

    // The refusal must come before any network-capable install: an
    // unprewarmed run under require-prewarm may not even try.
    if scenario.deps.policy == DepsPolicy::RequirePrewarm {
        let prewarm = buildplan::load_prewarm(&repo_root);
        let valid = prewarm.as_ref().is_some_and(|p| {
            Some(&p.lockfile_sha256) == cand.lockfile_sha256.as_ref()
                && p.project_root == cand.project_root
        });
        if !valid {
            return Err(Failure::new(
                "deps",
                FailureCode::DepsNotPrewarmed,
                match prewarm {
                    Some(p) => format!(
                        "deps.policy=require-prewarm but the recorded prewarm covers lockfile {}, not the candidate's {}",
                        p.lockfile_sha256,
                        cand.lockfile_sha256.as_deref().unwrap_or("<none>")
                    ),
                    None => "deps.policy=require-prewarm but no prewarm record exists for this worktree".to_string(),
                },
                format!(
                    "run `qaren prewarm {}` once with credentials available, then re-run prepare",
                    args.scenario_path.display()
                ),
            ));
        }
    }

    check_prereqs(runner, &scenario, args.android_home.as_deref())?;
    let mut pool_fallback = (pool_mode
        && !resolve_pool_identifiers(
            runner,
            scenario.ios.as_mut().expect("validated ios scenario"),
        ))
    .then(|| POOL_FALLBACK.to_string());
    let pool_mode = pool_mode && pool_fallback.is_none();
    // An observation only: custody comes from the lease, and the target is re-proven under it.
    let selected = match borrowed.as_deref() {
        Some(udid) => {
            let sim = observe_borrowed_ios(runner, &scenario, udid)?;
            require_borrowed_power(&sim, args.boot_device)?;
            Some(sim)
        }
        None => None,
    };
    let mut pool_scan = match pool_mode {
        true => Some(scan_pool(
            runner,
            &args.pool_root,
            scenario.ios.as_ref().expect("validated ios scenario"),
            !args.dry_run,
        )?),
        false => None,
    };
    let pool_cap = scenario.ios.as_ref().map(pool::default_cap).unwrap_or(1);
    if args.dry_run && scenario.platform == Platform::Ios && scenario.build.owner == BuildOwner::Cli
    {
        ios::require_build(
            runner,
            &cand.project_root,
            scenario.build.ios_workspace.as_ref(),
        )?;
    }
    // A borrowed run checks its Metro port under the lease, after a dead holder's own cleanup.
    let port_deferred = selected.is_some() || pool_scan.is_some();
    if let Some(metro) = scenario
        .metro
        .as_ref()
        .filter(|_| !port_deferred || args.dry_run)
    {
        check_port_free(runner, metro.port)?;
    }
    if let Some(android) = &scenario.android {
        check_port_free(runner, android.adb_server_port)?;
    }
    if let Some(port) = scenario
        .android_usb
        .as_ref()
        .and_then(|usb| usb.adb_server_port)
    {
        check_port_free(runner, port)?;
    }

    let run_id = format!("{}-{}", scenario.name, timefmt::compact_utc(started_ms));

    if args.dry_run {
        let mut dry_outcome = pool_fallback.clone();
        let (dry_selected, dry_boot, dry_name) = match &pool_scan {
            Some(scan) => match dry_run_pool_member(runner, scan, &args.lock_root, &args.runs_root)
            {
                Some((sim, reclaimed)) => {
                    if let Some(earlier) = reclaimed {
                        dry_outcome = Some(format!(
                            "would reuse {} after reclaiming run {earlier} through its cleanup",
                            sim.udid
                        ));
                    }
                    (Some(sim), true, ios::sim_name(&run_id))
                }
                None if scan.present.len() as u32 >= pool_cap => {
                    dry_outcome = Some(pool_cap_fallback(scan, pool_cap, &[]));
                    (None, false, ios::sim_name(&run_id))
                }
                None => (None, false, ios::pool_sim_name(&run_id)),
            },
            None => (selected.clone(), args.boot_device, ios::sim_name(&run_id)),
        };
        let mut receipt = dry_run_receipt(
            runner,
            &scenario,
            &cand,
            &args.scenario_path,
            &scenario_sha256,
            &run_id,
            started_ms,
            &args.native_cache_root,
            dry_selected.as_ref(),
            dry_boot,
            &dry_name,
            pool_scan.is_some(),
        )?;
        if let Some(outcome) = dry_outcome {
            receipt.outcomes.insert("device_pool".to_string(), outcome);
        }
        return Ok(receipt);
    }

    let run_dir = RunRecord::run_dir(&args.runs_root, &run_id);
    if let Some(parent) = run_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            Failure::new(
                "allocate",
                FailureCode::RunRecordUpdateFailed,
                format!("cannot create {}: {e}", parent.display()),
                "check .qaren directory permissions",
            )
        })?;
    }
    // mkdir is the atomic claim on the run id: two prepares racing within the
    // same second cannot both own the directory.
    std::fs::create_dir(&run_dir).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            Failure::new(
                "allocate",
                FailureCode::RunAlreadyExists,
                format!("{} already exists", run_dir.display()),
                "re-run prepare; run ids are timestamped per second",
            )
        } else {
            Failure::new(
                "allocate",
                FailureCode::RunRecordUpdateFailed,
                format!("cannot create {}: {e}", run_dir.display()),
                "check .qaren directory permissions",
            )
        }
    })?;
    std::fs::create_dir_all(run_dir.join("logs")).map_err(|e| {
        Failure::new(
            "allocate",
            FailureCode::RunRecordUpdateFailed,
            format!("cannot create {}: {e}", run_dir.display()),
            "check .qaren directory permissions",
        )
    })?;

    let self_pid = std::process::id() as i32;
    let identity = capture_pid_identity(runner, self_pid);
    if pool_scan.is_some() && identity.is_none() {
        pool_scan = None;
        pool_fallback = Some(POOL_IDENTITY_FALLBACK.to_string());
    }
    if selected.is_some() && identity.is_none() {
        // Like check's run-directory claim, an unrecorded claim is dropped on refusal.
        let _ = std::fs::remove_dir_all(&run_dir);
        return Err(Failure::new(
            "lease",
            FailureCode::OwnershipUnproven,
            "this prepare process's birth identity could not be proven, so it cannot hold a device lease",
            "ensure ps can read this process's start time, then re-run",
        ));
    }
    let node = std::env::var_os("QAREN_NODE")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"));
    let runtime_dir = crate::run::default_runtime_dir();
    let mut resources = crate::runrecord::Resources::default();
    let mut recovered = None;
    let mut pool_claimed = false;
    let mut pool_create = false;
    let custody = match (&selected, &pool_scan) {
        (Some(sim), _) => claim_borrowed_lease(
            runner,
            args,
            &sim.udid,
            &run_id,
            identity.clone(),
            (&node, &runtime_dir),
            &mut recovered,
        )
        .map(|lease| Some((lease, sim.clone()))),
        (None, Some(scan)) => match claim_pool_member(
            runner,
            args,
            scan,
            scenario.ios.as_ref().expect("validated ios scenario"),
            &run_id,
            identity.clone(),
            (&node, &runtime_dir),
            &mut recovered,
        ) {
            Ok(PoolClaim::Claimed(lease, sim)) => {
                pool_claimed = true;
                Ok(Some((lease, sim)))
            }
            Ok(PoolClaim::Occupied(occupied)) if scan.present.len() as u32 >= pool_cap => {
                pool_fallback = Some(pool_cap_fallback(scan, pool_cap, &occupied));
                Ok(None)
            }
            Ok(PoolClaim::Occupied(_)) => {
                pool_create = true;
                Ok(None)
            }
            Err(f) => Err(f),
        },
        (None, None) => Ok(None),
    };
    let custody = match custody {
        Ok(custody) => custody,
        Err(f) => {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(f);
        }
    };
    if let (Some(metro), true) = (&scenario.metro, port_deferred) {
        if let Err(f) = check_port_free(runner, metro.port) {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(match &custody {
                Some((lease, _)) => crate::lease::release_or_annotate(lease, f),
                None => f,
            });
        }
    }
    if let Some((lease, sim)) = custody {
        resources.lease = Some(lease);
        resources.device_borrowed = true;
        resources.ios_simulator = Some(IosSimResource {
            udid: sim.udid.clone(),
            name: sim.name.clone(),
            device_type: sim.device_type.clone(),
            runtime: sim.runtime.clone(),
        });
    }
    let record = RunRecord {
        schema: RUN_SCHEMA.to_string(),
        run_id: run_id.clone(),
        created_at: timefmt::iso8601_utc(started_ms),
        scenario: scenario.clone(),
        scenario_path: args.scenario_path.clone(),
        scenario_sha256,
        candidate: cand,
        phase: Phase::Created,
        substage: None,
        prepare: identity,
        build: None,
        handoff: None,
        resources,
        failure: None,
        history: Vec::new(),
        terminal: None,
        build_lock: None,
    };
    if let Err(f) = record.save(&args.runs_root) {
        return Err(match &record.resources.lease {
            Some(lease) => crate::lease::release_or_annotate(lease, f),
            None => f,
        });
    }

    let mut ctx = Ctx {
        runner,
        runs_root: args.runs_root.clone(),
        native_cache_root: args.native_cache_root.clone(),
        native_store_entry: None,
        record,
        started_ms,
        timings: Vec::new(),
        notes: Vec::new(),
        verb: "prepare",
        bundle_requests_at_launch: None,
        manifest_warm: None,
        lane_owned: scenario.platform == Platform::Ios,
        build_deadline_ms: None,
    };
    let t = ctx.mark("validate", started_ms);
    if let Some(earlier) = recovered {
        ctx.notes.push(("recovered_run".to_string(), earlier));
    }
    if let Some(orphan) = ctx.record.resources.lease.as_ref().and_then(|l| {
        l.released_orphan
            .as_deref()
            .map(|run_id| crate::lease::orphan_note(&l.lock_dir, run_id))
    }) {
        ctx.notes.push(("device_lease".to_string(), orphan));
    }
    if args.new_device {
        ctx.notes
            .push(("device_pool".to_string(), "fresh".to_string()));
    } else if let Some(fallback) = pool_fallback {
        ctx.notes.push(("device_pool".to_string(), fallback));
    }
    if pool_claimed {
        let udid = ctx
            .record
            .resources
            .ios_simulator
            .clone()
            .expect("claimed")
            .udid;
        ctx.notes
            .push(("device_pool".to_string(), format!("reused {udid}")));
    }
    let borrowed_admission = |ctx: &mut Ctx, stage: &str| {
        crate::core::fresh_install_admission(
            ctx.runner,
            &node,
            &runtime_dir,
            &ctx.record.candidate.project_root.clone(),
            &ctx.record
                .resources
                .ios_simulator
                .clone()
                .expect("borrowed")
                .udid,
            None,
            None,
        )
        .map(|summary| {
            ctx.notes.push((stage.to_string(), summary.note()));
        })
    };
    // A pool member is QaReN's to boot; a --device target only with --boot-device.
    let may_boot = args.boot_device || pool_claimed;
    if selected.is_some() || pool_claimed {
        // Recovery may have changed the target; the pre-lease observation is not authority.
        if let Err(f) = reprove_borrowed_ios(&mut ctx, may_boot)
            .and_then(|_| borrowed_admission(&mut ctx, "admission_before_deps"))
        {
            return Ok(ctx.fail(f));
        }
    }

    if let Err(f) = install_deps(&mut ctx) {
        return Ok(ctx.fail(f));
    }
    if scenario.platform == Platform::Ios && scenario.build.owner == BuildOwner::Cli {
        if let Err(f) = ios::require_build(
            ctx.runner,
            &ctx.record.candidate.project_root,
            scenario.build.ios_workspace.as_ref(),
        ) {
            return Ok(ctx.fail(f));
        }
    }
    if selected.is_some() || pool_claimed {
        if let Err(f) = borrowed_admission(&mut ctx, "admission_before_mutation") {
            return Ok(ctx.fail(f));
        }
        if pool_claimed {
            if let Err(f) = arm_pool_stop(&mut ctx) {
                return Ok(ctx.fail(f));
            }
        }
        if may_boot {
            if let Err(f) = reprove_borrowed_ios(&mut ctx, true)
                .and_then(|needs_boot| boot_borrowed_ios(&mut ctx, needs_boot))
            {
                return Ok(ctx.fail(f));
            }
        }
        if pool_claimed {
            if let Err(f) = reset_pool_member(&mut ctx) {
                return Ok(ctx.fail(f));
            }
        }
    }
    let t = ctx.mark("deps", t);

    if ctx.record.scenario.build.owner == BuildOwner::Qaren {
        return Ok(prepare_handoff(ctx, args, t));
    }

    let plan = match plan_build(&mut ctx) {
        Ok(plan) => plan,
        Err(f) => return Ok(ctx.fail(f)),
    };
    ctx.record.build = Some(plan.clone());
    if let Err(f) = ctx.save() {
        return Ok(ctx.fail(f));
    }
    let t = ctx.mark("plan", t);

    // iOS claims its build lock after allocation, inside build_ios_locked; Android claims here.
    let ios_build =
        plan.decision != BuildDecision::Reuse && ctx.record.scenario.platform == Platform::Ios;
    if plan.decision != BuildDecision::Reuse && !ios_build {
        if let Err(f) = claim_build_lock(&mut ctx, &args.lock_root) {
            return Ok(ctx.fail(f));
        }
    }

    let allocate_result = match ctx.record.scenario.platform {
        Platform::Ios if ctx.record.resources.device_borrowed => Ok(()),
        Platform::Ios => allocate_ios(
            &mut ctx,
            pool_create.then_some((args.pool_root.as_path(), args.lock_root.as_path())),
        ),
        Platform::Android => {
            if ctx.record.scenario.android_usb.is_some() {
                allocate_usb(&mut ctx, args.android_home.as_deref(), &args.lock_root)
            } else {
                allocate_android(&mut ctx, args.android_home.as_deref())
            }
        }
    };
    if let Err(f) = allocate_result {
        return Ok(ctx.fail(f));
    }
    ctx.record.phase = Phase::ResourcesAllocated;
    if let Err(f) = ctx.save() {
        return Ok(ctx.fail(f));
    }
    let t = ctx.mark("allocate", t);

    if plan.decision == BuildDecision::Reuse {
        if let Err(f) = run_reuse_path(&mut ctx, &plan, t) {
            return Ok(ctx.fail(f));
        }
    } else if ios_build {
        let built = match build_ios_locked(&mut ctx, &plan, &args.lock_root) {
            Ok(built) => built,
            Err(f) => return Ok(ctx.fail(f)),
        };
        let now = ctx.runner.now_epoch_ms();
        if let Err(f) = run_reuse_path(&mut ctx, &built, now) {
            return Ok(ctx.fail(f));
        }
    } else {
        if plan.decision == BuildDecision::Clean {
            if let Err(f) = run_clean_preparation(&mut ctx, &plan) {
                return Ok(ctx.fail(f));
            }
        }
        if let Err(f) = build_and_ready(&mut ctx) {
            return Ok(ctx.fail(f));
        }
    }
    let t = ctx.mark("build_and_ready", t);

    if let Err(f) = recheck_candidate(&mut ctx) {
        return Ok(ctx.fail(f));
    }
    let fp = match recheck_fingerprint(&mut ctx, &plan) {
        Ok(fp) => fp,
        Err(f) => return Ok(ctx.fail(f)),
    };
    let t = ctx.mark("verify", t);

    if plan.decision != BuildDecision::Reuse && !ios_build {
        if let Err(f) = record_build_result(&mut ctx, &fp) {
            return Ok(ctx.fail(f));
        }
        release_build_lock(&mut ctx);
    }
    ctx.mark("cache_record", t);

    if let Err(f) = reprove_borrowed_prepare(&mut ctx) {
        return Ok(ctx.fail(f));
    }
    ctx.record.phase = Phase::Ready;
    let at = timefmt::iso8601_utc(ctx.runner.now_epoch_ms());
    ctx.record.push_history(at, "ready");
    if let Err(f) = ctx.save() {
        return Ok(ctx.fail(f));
    }
    Ok(finish_receipt(ctx, ReceiptResult::Ready, None))
}

// Handoff mode (build.owner: qaren, workspace issue #34): qaren owns
// validation, deps preparation, the native fingerprint, and exclusive device
// allocation, then stops. The qaren session performs the one
// authoritative managed build/install against the exact allocated device and
// owns Metro, install proof, and runtime binding; `qaren complete` later
// binds the session's signed build receipt to this run identity. No Metro,
// adb server, build lock, or native-cache mutation happens here.
fn prepare_handoff(mut ctx: Ctx, args: &PrepareArgs, t: u64) -> Receipt {
    let platform = platform_dir(ctx.record.scenario.platform);
    let repo_root = ctx.record.candidate.repo_root.clone();
    let project_root = ctx.record.candidate.project_root.clone();
    let fp = match fingerprint::compute(ctx.runner, &repo_root, &project_root, platform) {
        Ok(fp) => fp,
        Err(f) => return ctx.fail(f),
    };
    let t = ctx.mark("fingerprint", t);

    let allocate_result = match ctx.record.scenario.platform {
        Platform::Ios => allocate_ios(&mut ctx, None),
        Platform::Android => {
            let usb = ctx
                .record
                .scenario
                .android_usb
                .clone()
                .expect("validated handoff scenario is ios or android_usb");
            // Claim-only: the qaren session owns the adb lifecycle in
            // handoff mode, so qaren never starts an adb server or contacts
            // the device; presence and authorization are proven downstream by
            // rn_session bind_device against the exact serial.
            claim_usb_device(&mut ctx, &args.lock_root, &usb.serial)
        }
    };
    if let Err(f) = allocate_result {
        return ctx.fail(f);
    }
    ctx.record.phase = Phase::ResourcesAllocated;
    if let Err(f) = ctx.save() {
        return ctx.fail(f);
    }
    let t = ctx.mark("allocate", t);

    // The handoff must describe the candidate exactly as it stands at issue
    // time; drift since validation refuses instead of handing over a
    // misattributed identity.
    if let Err(f) = recheck_candidate(&mut ctx) {
        return ctx.fail(f);
    }
    let t = ctx.mark("verify", t);

    let device_id = match ctx.record.scenario.platform {
        Platform::Ios => ctx
            .record
            .resources
            .ios_simulator
            .as_ref()
            .map(|sim| sim.udid.clone()),
        Platform::Android => ctx
            .record
            .resources
            .usb_device
            .as_ref()
            .map(|usb| usb.serial.clone()),
    };
    let cleanup_next = format!(
        "qaren cleanup {} --json, then re-run prepare",
        ctx.record.run_id
    );
    let Some(device_id) = device_id.filter(|id| !id.is_empty()) else {
        return ctx.fail(Failure::new(
            "handoff",
            FailureCode::RunRecordInvalid,
            "the allocated device identity is missing from the run record".to_string(),
            cleanup_next,
        ));
    };
    let Some(app_root_key) = handoff::app_root_key(&repo_root, &project_root) else {
        return ctx.fail(Failure::new(
            "handoff",
            FailureCode::CandidatePathInvalid,
            format!(
                "project root {} is not contained in worktree {}; refusing to derive a handoff identity",
                project_root.display(),
                repo_root.display()
            ),
            cleanup_next,
        ));
    };
    let expected = ExpectedReceipt {
        platform: platform.to_string(),
        device_id,
        app_id: ctx.record.candidate.app_id.clone(),
        worktree_key: handoff::worktree_key(&repo_root),
        app_root_key,
    };
    let issued_at = timefmt::iso8601_utc(ctx.runner.now_epoch_ms());
    let document_path = handoff::document_path(&ctx.runs_root, &ctx.record.run_id);
    let document = HandoffDocument {
        schema: HANDOFF_SCHEMA.to_string(),
        run_id: ctx.record.run_id.clone(),
        issued_at: issued_at.clone(),
        candidate: ctx.record.candidate.clone(),
        platform: platform.to_string(),
        device: super::device_identity(&ctx.record),
        native_fingerprint: fp.value.clone(),
        fingerprint_complete: fp.complete,
        fingerprint_incompleteness: fp
            .incompleteness
            .iter()
            .map(|text| crate::redact::OutputText::from_output(text))
            .collect(),
        expected_receipt: expected.clone(),
    };
    let document_sha256 = match handoff::save_document(&document_path, &document) {
        Ok(sha) => sha,
        Err(e) => {
            let failure = Failure::new(
                "handoff",
                FailureCode::RunRecordUpdateFailed,
                format!("cannot write {}: {e}", document_path.display()),
                format!(
                    "check .qaren directory permissions, then qaren cleanup {} --json",
                    ctx.record.run_id
                ),
            );
            return ctx.fail(failure);
        }
    };
    ctx.record.handoff = Some(HandoffState {
        document_sha256,
        expected,
        accepted: None,
        completed_at: None,
        evidence_sha256: None,
    });
    ctx.record.phase = Phase::HandedOff;
    ctx.record.push_history(issued_at, "handed_off");
    if let Err(f) = ctx.save() {
        return ctx.fail(f);
    }
    ctx.mark("handoff", t);
    ctx.notes
        .push(("handoff".to_string(), "issued".to_string()));
    ctx.notes
        .push(("build_owner".to_string(), "qaren".to_string()));
    if !fp.complete {
        ctx.notes.push((
            "fingerprint".to_string(),
            format!("incomplete: {}", fp.incompleteness.join("; ")),
        ));
    }
    finish_receipt(ctx, ReceiptResult::Ready, None)
}

pub(crate) fn install_deps(ctx: &mut Ctx) -> Result<(), Failure> {
    ensure_running(ctx.runner, "deps")?;
    let offline = ctx.record.scenario.deps.policy == DepsPolicy::RequirePrewarm;
    let mut deps_args = vec!["install", "--frozen-lockfile"];
    if offline {
        // The prewarm record proved the store covers this lockfile; --offline
        // hard-guarantees no network and therefore no credential prompt.
        deps_args.push("--offline");
    }
    let deps = ctx.runner.run(
        &CmdSpec::new(
            "pnpm-install",
            "pnpm",
            &deps_args,
            ctx.record.scenario.deadlines.install_deps_seconds,
        )
        .cwd(&ctx.record.candidate.project_root.clone())
        .registry_auth_env(&ctx.record.scenario.deps.registry_auth_env),
    );
    ensure_running(ctx.runner, "deps")?;
    if !deps.ok() {
        return Err(Failure::new(
            "deps",
            FailureCode::DepsInstallFailed,
            format!(
                "pnpm {}: {}",
                deps_args.join(" "),
                redact_secrets(&deps.summary())
            ),
            if !ctx.record.scenario.deps.registry_auth_env.is_empty() {
                "dependency output was withheld; check the declared registry auth environment names and registry setup, then re-run"
            } else if offline {
                "the pnpm store no longer covers the lockfile; re-run qaren prewarm, then re-run"
            } else {
                "fix the dependency install in the candidate project, then re-run"
            },
        ));
    }
    ctx.record.phase = Phase::DepsInstalled;
    ctx.save()
}

pub(crate) fn check_prereqs(
    runner: &mut dyn Runner,
    scenario: &Scenario,
    android_home: Option<&str>,
) -> Result<(), Failure> {
    let handoff = scenario.build.owner == BuildOwner::Qaren;
    let mut tools: Vec<&str> = vec!["git", "pnpm", "node"];
    if !handoff {
        tools.extend(["lsof", "curl"]);
    }
    tools.push("ps");
    match scenario.platform {
        Platform::Ios => tools.push("xcrun"),
        Platform::Android => {
            // ssh reaches the NUC farm; a USB device needs only local tooling.
            if scenario.android.is_some() {
                tools.push("ssh");
            }
            // The gradle build (java) and adb belong to the build owner; a
            // handoff-mode allocation only claims the device lock.
            if !handoff {
                tools.push("java");
            }
        }
    }
    let mut missing = Vec::new();
    for tool in tools {
        let output = runner.run(&CmdSpec::new("which", "/usr/bin/which", &[tool], 10));
        if !output.ok() {
            missing.push(tool.to_string());
        }
    }
    if scenario.platform == Platform::Android && !handoff {
        missing.extend(missing_android_sdk(android_home));
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(Failure::new(
            "prereqs",
            FailureCode::PrereqMissing,
            format!("missing prerequisites: {}", missing.join(", ")),
            "install the missing tools, then re-run prepare",
        ))
    }
}

pub(crate) fn missing_android_sdk(android_home: Option<&str>) -> Option<String> {
    match android_home {
        Some(home) if android::adb_path(home).is_file() => None,
        Some(home) => Some(format!("adb (not at {}/platform-tools/adb)", home)),
        None => Some("ANDROID_HOME env var".to_string()),
    }
}

pub(crate) fn check_port_free(runner: &mut dyn Runner, port: u16) -> Result<(), Failure> {
    let output = runner.run(&metro::port_owner_spec(port));
    match metro::parse_port_owner(&output) {
        metro::PortOwners::Free => Ok(()),
        metro::PortOwners::Owned(pid) => Err(Failure::new(
            "prereqs",
            FailureCode::MetroPortOccupied,
            format!("metro port {port} is already owned by pid {pid}"),
            "pick a different metro.port in the scenario or stop the foreign listener yourself",
        )),
        metro::PortOwners::Multiple => Err(Failure::new(
            "prereqs",
            FailureCode::MetroPortOccupied,
            format!("metro port {port} has multiple listeners"),
            "pick a different metro.port in the scenario",
        )),
        metro::PortOwners::Unknown => Err(Failure::new(
            "prereqs",
            FailureCode::PrereqMissing,
            format!(
                "cannot determine metro port {port} state: {}",
                output.summary()
            ),
            "ensure lsof works on this host, then re-run prepare",
        )),
    }
}

// `pool` = (pool root, device lock root): create a pool member under the creation lock instead of a temporary.
fn allocate_ios(ctx: &mut Ctx, mut pool: Option<(&Path, &Path)>) -> Result<(), Failure> {
    ensure_running(ctx.runner, "allocate")?;
    let ios = ctx
        .record
        .scenario
        .ios
        .clone()
        .expect("validated ios scenario");
    if let Some((pool_root, _)) = pool {
        claim_pool_create_lock(ctx, pool_root)?;
        let cap = pool::default_cap(&ios);
        match scan_pool(ctx.runner, pool_root, &ios, true) {
            Err(f) => {
                release_pool_create_lock(ctx);
                return Err(f);
            }
            Ok(scan) if scan.present.len() as u32 >= cap => {
                release_pool_create_lock(ctx);
                ctx.notes.push((
                    "device_pool".to_string(),
                    pool_cap_fallback(&scan, cap, &[]),
                ));
                pool = None;
            }
            Ok(_) => {}
        }
    }
    let name = match pool {
        Some(_) => ios::pool_sim_name(&ctx.record.run_id),
        None => ios::sim_name(&ctx.record.run_id),
    };
    // The pending allocation is durable before the external create: a crash
    // mid-create leaves the run-scoped name as cleanup's recovery key.
    ctx.record.resources.ios_simulator = Some(IosSimResource {
        udid: String::new(),
        name: name.clone(),
        device_type: ios.device_type.clone(),
        runtime: ios.runtime.clone(),
    });
    ctx.save()?;
    ensure_running(ctx.runner, "allocate")?;
    let created = ctx
        .runner
        .run(&ios::create_spec(&name, &ios.device_type, &ios.runtime));
    if !created.ok() {
        return Err(Failure::new(
            "allocate",
            FailureCode::SimulatorCreateFailed,
            format!("simctl create {name}: {}", created.summary()),
            "check ios.device_type and ios.runtime against `xcrun simctl list`",
        ));
    }
    let udid = created.stdout.trim().to_string();
    if udid.len() != 36 {
        return Err(Failure::new(
            "allocate",
            FailureCode::SimulatorCreateFailed,
            format!("simctl create returned unexpected output: {udid:?}"),
            "inspect simctl output; the simulator may need manual deletion",
        ));
    }
    if let Some(sim) = &mut ctx.record.resources.ios_simulator {
        sim.udid = udid.clone();
    }
    ctx.save()?;
    if let Some((pool_root, lock_root)) = pool {
        enroll_pool_member(ctx, pool_root, lock_root, &ios)?;
    }

    ensure_running(ctx.runner, "allocate")?;
    let boot = ctx.runner.run(&ios::bootstatus_spec(
        &udid,
        ctx.record.scenario.deadlines.device_boot_seconds,
    ));
    if !boot.ok() {
        return Err(Failure::new(
            "allocate",
            FailureCode::SimulatorBootFailed,
            format!("simctl bootstatus {udid}: {}", boot.summary()),
            "run qaren cleanup for this run, then retry prepare",
        ));
    }
    Ok(())
}

const POOL_FALLBACK: &str = "fresh: ios.device_type or ios.runtime does not name exactly one installed simulator identifier, so this run uses a temporary simulator";
const POOL_IDENTITY_FALLBACK: &str = "fresh: this prepare process's birth identity could not be proven, so it cannot hold a pool device lease and this run uses a temporary simulator";

// A short form becomes the one installed identifier it names; false keeps this run on the temporary path.
fn resolve_pool_identifiers(runner: &mut dyn Runner, spec: &mut IosSpec) -> bool {
    const TYPE: &str = "com.apple.CoreSimulator.SimDeviceType.";
    const RUNTIME: &str = "com.apple.CoreSimulator.SimRuntime.";
    let device_type = match spec.device_type.starts_with(TYPE) {
        true => Some(spec.device_type.clone()),
        false => resolve_identifier(
            runner,
            &spec.device_type,
            TYPE,
            ios::list_devicetypes_spec(),
            ios::parse_devicetypes,
        ),
    };
    let Some(device_type) = device_type else {
        return false;
    };
    let runtime = match spec
        .runtime
        .strip_prefix("com.apple.CoreSimulator.SimRuntime.iOS-")
        .is_some_and(|v| !v.is_empty())
    {
        true => Some(spec.runtime.clone()),
        false => resolve_identifier(
            runner,
            &spec.runtime,
            RUNTIME,
            ios::list_runtimes_spec(),
            ios::parse_available_runtimes,
        ),
    };
    let Some(runtime) = runtime else {
        return false;
    };
    spec.device_type = device_type;
    spec.runtime = runtime;
    true
}

fn resolve_identifier(
    runner: &mut dyn Runner,
    value: &str,
    prefix: &str,
    list: CmdSpec,
    parse: fn(&str) -> Vec<(String, String)>,
) -> Option<String> {
    let output = runner.run(&list);
    if !output.ok() {
        return None;
    }
    let mut found: Vec<String> = parse(&output.stdout)
        .into_iter()
        .filter(|(name, id)| {
            id == value || id.strip_prefix(prefix) == Some(value) || name.replace(' ', "") == value
        })
        .map(|(_, id)| id)
        .collect();
    found.sort();
    found.dedup();
    (found.len() == 1).then(|| found.remove(0))
}

// One strict inventory read: success, clean stderr and a bounded size, or no proof at all.
fn strict_inventory(runner: &mut dyn Runner) -> Result<String, String> {
    let output = runner.run(&ios::list_devices_spec());
    if !output.ok() || !output.stderr.is_empty() || output.stdout.len() >= 1024 * 1024 {
        return Err(format!("simctl list failed: {}", output.summary()));
    }
    Ok(output.stdout)
}

fn pool_inventory_failure(detail: String) -> Failure {
    Failure::new(
        "device",
        FailureCode::DeviceUnavailable,
        format!("the simulator inventory could not prove the QaReN pool: {detail}"),
        "check `xcrun simctl list devices -j`, then re-run prepare",
    )
}

#[derive(Default)]
struct PoolScan {
    // Members whose simulator still exists, of any device type or runtime: the cap's count.
    present: Vec<PoolMember>,
    // Present members proven to match the scenario, in UDID order.
    candidates: Vec<(PoolMember, ios::Simulator)>,
}

fn scan_pool(
    runner: &mut dyn Runner,
    pool_root: &Path,
    spec: &IosSpec,
    prune: bool,
) -> Result<PoolScan, Failure> {
    let members = pool::load_all(pool_root)?;
    if members.is_empty() {
        return Ok(PoolScan::default());
    }
    let inventory = strict_inventory(runner).map_err(pool_inventory_failure)?;
    let present = pool::present(&members, &inventory);
    if prune {
        pool::prune(pool_root, &members, &present)?;
    }
    let candidates = present
        .iter()
        .filter_map(|m| pool::proven(m, &inventory, spec).map(|sim| (m.clone(), sim)))
        .collect();
    Ok(PoolScan {
        present,
        candidates,
    })
}

fn pool_cap_fallback(scan: &PoolScan, cap: u32, occupied: &[String]) -> String {
    let reason = if scan.candidates.is_empty() {
        let members: Vec<String> = scan
            .present
            .iter()
            .map(|m| format!("{} ({}, {}, {})", m.udid, m.name, m.device_type, m.runtime))
            .collect();
        format!(
            "no member matches the scenario's device type and runtime: {}",
            members.join("; ")
        )
    } else if occupied.is_empty() {
        "no matching member is free".to_string()
    } else {
        format!("every matching member is occupied: {}", occupied.join("; "))
    };
    format!("fresh: the QaReN simulator pool is at ios.max_devices {cap} and {reason}, so this run uses a temporary simulator")
}

// Read-only, in the claim's order: a dead holder whose run never reached ready is reclaimed, and its cleanup shuts the member down only if its stop is armed; the member must then be Shutdown.
fn dry_run_pool_member(
    runner: &mut dyn Runner,
    scan: &PoolScan,
    lock_root: &Path,
    runs_root: &Path,
) -> Option<(ios::Simulator, Option<String>)> {
    scan.candidates.iter().find_map(|(member, sim)| {
        let Some(holder) = buildplan::read_holder(&buildplan::lock_dir(
            lock_root,
            &crate::lease::lock_name(Platform::Ios, &member.udid),
        )) else {
            return (sim.state == ios::SimState::Shutdown).then(|| (sim.clone(), None));
        };
        let liveness = holder
            .identity
            .as_ref()
            .map(|i| probe_pid_identity(runner, i));
        if !matches!(
            liveness,
            Some(PidLiveness::Dead | PidLiveness::AliveForeign)
        ) || ready_holder(runs_root, Some(&holder), liveness).is_some()
        {
            return None;
        }
        let record = RunRecord::load(runs_root, &holder.run_id).ok()?;
        let mut sim = sim.clone();
        if record.resources.borrowed_ios_stop() == crate::runrecord::BorrowedIosStop::Pending {
            sim.state = ios::SimState::Shutdown;
        }
        (sim.state == ios::SimState::Shutdown).then(|| (sim, Some(holder.run_id)))
    })
}

enum PoolClaim {
    Claimed(crate::lease::Lease, ios::Simulator),
    Occupied(Vec<String>),
}

// A dead holder's run that reached ready still owns the session its agents attach to.
fn ready_holder(
    runs_root: &Path,
    holder: Option<&buildplan::LockHolder>,
    liveness: Option<PidLiveness>,
) -> Option<String> {
    let holder = holder?;
    if !matches!(
        liveness,
        Some(PidLiveness::Dead | PidLiveness::AliveForeign)
    ) {
        return None;
    }
    let record = RunRecord::load(runs_root, &holder.run_id).ok()?;
    (matches!(
        record.phase,
        Phase::Ready | Phase::Walking | Phase::HandedOff
    ) && record.terminal.is_none())
    .then(|| holder.run_id.clone())
}

#[allow(clippy::too_many_arguments)]
fn claim_pool_member(
    runner: &mut dyn Runner,
    args: &PrepareArgs,
    scan: &PoolScan,
    spec: &IosSpec,
    run_id: &str,
    identity: Option<crate::runrecord::PidIdentity>,
    runtime_context: (&Path, &Path),
    recovered: &mut Option<String>,
) -> Result<PoolClaim, Failure> {
    let mut occupied = Vec::new();
    for (member, _) in &scan.candidates {
        let udid = member.udid.as_str();
        let lease = match crate::lease::try_acquire(
            runner,
            &args.lock_root,
            Platform::Ios,
            udid,
            run_id,
            identity.clone(),
        ) {
            Ok(lease) => lease,
            Err(busy) if busy.failure.code == FailureCode::DeviceBusy => {
                if let Some(holder) =
                    ready_holder(&args.runs_root, busy.holder.as_ref(), busy.liveness)
                {
                    occupied.push(format!(
                        "{udid} is held by run {holder}, which reached ready; release it with `qaren cleanup {holder}`"
                    ));
                    continue;
                }
                let reclaimed = super::cleanup::reclaim_dead_holder_with_runtime(
                    runner,
                    &args.runs_root,
                    &busy,
                    Some(runtime_context),
                )
                .and_then(|earlier| {
                    crate::lease::acquire(
                        runner,
                        &args.lock_root,
                        Platform::Ios,
                        udid,
                        run_id,
                        identity.clone(),
                    )
                    .map(|lease| (earlier, lease))
                });
                match reclaimed {
                    Ok((earlier, lease)) => {
                        *recovered = Some(earlier);
                        lease
                    }
                    Err(f) => {
                        occupied.push(format!("{udid}: {}", f.detail));
                        continue;
                    }
                }
            }
            Err(busy) => return Err(busy.failure),
        };
        let inventory = match strict_inventory(runner) {
            Ok(inventory) => inventory,
            Err(detail) => {
                return Err(crate::lease::release_or_annotate(
                    &lease,
                    pool_inventory_failure(detail),
                ))
            }
        };
        let skipped = match pool::proven(member, &inventory, spec) {
            Some(sim) if sim.state == ios::SimState::Shutdown => {
                return Ok(PoolClaim::Claimed(lease, sim))
            }
            // Up without QaReN custody: a person, another lock root or a run that left it booted.
            Some(_) => format!(
                "{udid} is Booted with no QaReN run holding it; once nothing uses it, shut it down with `xcrun simctl shutdown {udid}`"
            ),
            None => format!("{udid} no longer matches its pool record under the lease"),
        };
        match crate::lease::release(&lease) {
            buildplan::ReleaseOutcome::Removed
            | buildplan::ReleaseOutcome::Absent
            | buildplan::ReleaseOutcome::Foreign(_) => occupied.push(skipped),
            _ => {
                return Err(crate::lease::release_or_annotate(
                    &lease,
                    Failure::new(
                        "lease",
                        FailureCode::DeviceBusy,
                        skipped,
                        "resolve the pool simulator's state, then re-run prepare",
                    ),
                ))
            }
        }
    }
    Ok(PoolClaim::Occupied(occupied))
}

// Power changes need a durable pending stop: cleanup returns the member Shutdown.
fn arm_pool_stop(ctx: &mut Ctx) -> Result<(), Failure> {
    ensure_running(ctx.runner, "deps")?;
    let prev = ctx.record.resources.borrowed_ios_stop();
    ctx.record.resources.arm_borrowed_ios_stop()?;
    if let Err(f) = ctx.save() {
        ctx.record.resources.revert_borrowed_ios_stop(prev);
        return Err(f);
    }
    Ok(())
}

// Uninstall clears the app container and privacy grants; the keychain is device-wide. Erase stays with --new.
fn reset_pool_member(ctx: &mut Ctx) -> Result<(), Failure> {
    let udid = ctx
        .record
        .resources
        .ios_simulator
        .clone()
        .expect("claimed pool member")
        .udid;
    let app_id = ctx.record.candidate.app_id.clone();
    crate::run::reset_app(ctx, &udid, &app_id, None)?;
    let spec = ios::keychain_reset_spec(&udid);
    ensure_running(ctx.runner, "fresh_install")?;
    if !ctx.runner.run(&spec).ok() {
        return Err(Failure::new(
            "fresh_install",
            FailureCode::AppResetFailed,
            format!(
                "{} did not complete successfully on the pool simulator",
                spec.label
            ),
            format!(
                "inspect the simulator's health, run qaren cleanup {} --json, then re-run prepare",
                ctx.record.run_id
            ),
        ));
    }
    ensure_running(ctx.runner, "fresh_install")
}

fn claim_pool_create_lock(ctx: &mut Ctx, pool_root: &Path) -> Result<(), Failure> {
    let name = pool::creation_lock_name();
    let holder = lock_holder_for(ctx);
    ctx.record.resources.pool_create_lock = Some(BuildLockResource {
        lock_dir: buildplan::lock_dir(pool_root, name),
        holder: holder.holder.clone(),
    });
    ctx.save()?;
    ensure_running(ctx.runner, "allocate")?;
    match buildplan::claim_lock(ctx.runner, pool_root, name, &holder, LockPolicy::Strict) {
        LockOutcome::Claimed { .. } => Ok(()),
        LockOutcome::Contended {
            holder: existing,
            detail,
            ..
        } => {
            // Only this run can write its own holder, so contention proves the claim never succeeded.
            ctx.record.resources.pool_create_lock = None;
            ctx.save()?;
            let (held, next) = match existing {
                Some(h) => (
                    format!(
                        " (held for run {}; if it is no longer creating, recover with {})",
                        h.run_id,
                        crate::lease::cleanup_command(&h.run_id, &h)
                    ),
                    format!(
                        "re-run once run {} finishes creating, or clean it up with {}",
                        h.run_id,
                        crate::lease::cleanup_command(&h.run_id, &h)
                    ),
                ),
                None => (
                    String::new(),
                    "re-run once the creating run finishes, or clean it up with `qaren cleanup <its-run-id>`".to_string(),
                ),
            };
            Err(Failure::new(
                "allocate",
                FailureCode::DeviceBusy,
                format!("another prepare is creating a QaReN pool simulator{held}: {detail}"),
                next,
            ))
        }
        LockOutcome::Error(detail) => Err(Failure::new(
            "allocate",
            FailureCode::RunRecordUpdateFailed,
            format!("cannot operate the pool creation lock: {detail}"),
            "fix the ~/.qaren/pool directory permissions, then re-run prepare",
        )),
    }
}

fn release_pool_create_lock(ctx: &mut Ctx) {
    let Some(lock) = ctx.record.resources.pool_create_lock.clone() else {
        return;
    };
    match buildplan::release_lock(&lock.lock_dir, &lock.holder, &ctx.record.run_id) {
        buildplan::ReleaseOutcome::Removed
        | buildplan::ReleaseOutcome::Absent
        | buildplan::ReleaseOutcome::Foreign(_) => {
            ctx.record.resources.pool_create_lock = None;
            let _ = ctx.save();
        }
        buildplan::ReleaseOutcome::Refused(reason)
        | buildplan::ReleaseOutcome::Unresolved(reason) => {
            ctx.notes
                .push(("pool_create_lock_release".to_string(), reason));
        }
    }
}

// Each step is durable before the next: lease, then the pool record, then borrowed custody with an armed stop.
fn enroll_pool_member(
    ctx: &mut Ctx,
    pool_root: &Path,
    lock_root: &Path,
    ios: &IosSpec,
) -> Result<(), Failure> {
    ensure_running(ctx.runner, "allocate")?;
    let sim = ctx
        .record
        .resources
        .ios_simulator
        .clone()
        .expect("created simulator recorded");
    let lease = crate::lease::acquire(
        ctx.runner,
        lock_root,
        Platform::Ios,
        &sim.udid,
        &ctx.record.run_id,
        ctx.record.prepare.clone(),
    )?;
    ctx.record.resources.lease = Some(lease);
    ctx.save()?;
    pool::write(
        pool_root,
        &PoolMember {
            schema: pool::POOL_SCHEMA.to_string(),
            udid: sim.udid.clone(),
            name: sim.name.clone(),
            device_type: ios.device_type.clone(),
            runtime: ios.runtime.clone(),
            created_by_run: ctx.record.run_id.clone(),
            created_at: timefmt::iso8601_utc(ctx.runner.now_epoch_ms()),
        },
    )?;
    let prev = ctx.record.resources.borrowed_ios_stop();
    ctx.record.resources.device_borrowed = true;
    let armed = ctx
        .record
        .resources
        .arm_borrowed_ios_stop()
        .and_then(|_| ctx.save());
    if let Err(f) = armed {
        ctx.record.resources.device_borrowed = false;
        ctx.record.resources.revert_borrowed_ios_stop(prev);
        return Err(f);
    }
    release_pool_create_lock(ctx);
    ctx.notes
        .push(("device_pool".to_string(), format!("created {}", sim.udid)));
    Ok(())
}

fn borrowed_failure(detail: impl Into<String>) -> Failure {
    Failure::new(
        "device",
        FailureCode::DeviceUnavailable,
        detail.into(),
        "check the exact --device UUID, its power state and the scenario's ios.device_type and ios.runtime, then re-run",
    )
}

fn borrowed_udid(scenario: &Scenario, args: &PrepareArgs) -> Result<Option<String>, Failure> {
    if args.new_device {
        if args.device.is_some() || args.boot_device {
            return Err(borrowed_failure(
                "--new creates a fresh simulator and cannot be combined with --device or --boot-device",
            ));
        }
        if scenario.platform != Platform::Ios {
            return Err(Failure::new(
                "validate",
                FailureCode::PlatformUnsupported,
                "--new creates only a fresh iOS simulator for prepare",
                "remove --new, or prepare an iOS scenario",
            ));
        }
    }
    let Some(device) = args.device.as_deref() else {
        return match args.boot_device {
            true => Err(borrowed_failure(
                "--boot-device requires --device with an exact iOS simulator UUID",
            )),
            false => Ok(None),
        };
    };
    if scenario.platform != Platform::Ios {
        return Err(Failure::new(
            "validate",
            FailureCode::PlatformUnsupported,
            "--device selects only an existing iOS simulator for prepare",
            "remove --device, or prepare an iOS scenario",
        ));
    }
    // Cooperative handoff carries no device-lease custody to the session that builds.
    if scenario.build.owner == BuildOwner::Qaren {
        return Err(Failure::new(
            "validate",
            FailureCode::ScenarioInvalid,
            "--device is not supported with build.owner: qaren",
            "remove --device to prepare on a temporary simulator, or use build.owner: cli",
        ));
    }
    ios::canonical_udid(device)
        .map(Some)
        .ok_or_else(|| borrowed_failure("--device must be an exact iOS simulator UUID"))
}

// Strict read-only proof of the exact simulator, matching the scenario's device type and runtime.
fn observe_borrowed_ios(
    runner: &mut dyn Runner,
    scenario: &Scenario,
    udid: &str,
) -> Result<ios::Simulator, Failure> {
    let output = runner.run(&ios::list_devices_spec());
    if !output.ok() || !output.stderr.is_empty() || output.stdout.len() >= 1024 * 1024 {
        return Err(borrowed_failure(format!(
            "simctl list failed: {}",
            output.summary()
        )));
    }
    let spec = scenario.ios.as_ref().expect("validated ios scenario");
    ios::parse_selected_sim(&output.stdout, udid)
        .filter(|sim| sim.device_type == spec.device_type && sim.runtime == spec.runtime)
        .ok_or_else(|| {
            borrowed_failure("selected UUID is not one available iOS simulator with the scenario's device type and runtime")
        })
}

// Returns whether the target needs booting; a Shutdown target without boot permission refuses.
fn require_borrowed_power(sim: &ios::Simulator, boot_device: bool) -> Result<bool, Failure> {
    match sim.state {
        ios::SimState::Booted => Ok(false),
        ios::SimState::Shutdown if boot_device => Ok(true),
        ios::SimState::Shutdown => Err(Failure::new(
            "device",
            FailureCode::DeviceUnavailable,
            "selected simulator is Shutdown and booting it was not authorized",
            "boot it yourself or pass --boot-device, then re-run",
        )),
    }
}

fn claim_borrowed_lease(
    runner: &mut dyn Runner,
    args: &PrepareArgs,
    udid: &str,
    run_id: &str,
    identity: Option<crate::runrecord::PidIdentity>,
    runtime_context: (&Path, &Path),
    recovered: &mut Option<String>,
) -> Result<crate::lease::Lease, Failure> {
    match crate::lease::try_acquire(
        runner,
        &args.lock_root,
        Platform::Ios,
        udid,
        run_id,
        identity.clone(),
    ) {
        Ok(lease) => Ok(lease),
        Err(busy) if busy.failure.code == FailureCode::DeviceBusy => {
            *recovered = Some(super::cleanup::reclaim_dead_holder_with_runtime(
                runner,
                &args.runs_root,
                &busy,
                Some(runtime_context),
            )?);
            crate::lease::acquire(
                runner,
                &args.lock_root,
                Platform::Ios,
                udid,
                run_id,
                identity,
            )
        }
        Err(busy) => Err(busy.failure),
    }
}

// Before each device effect: the lease is still this run's and the recorded target is unchanged.
fn reprove_borrowed_ios(ctx: &mut Ctx, boot_device: bool) -> Result<bool, Failure> {
    ensure_running(ctx.runner, "device")?;
    if !ctx.record.holds_device_lease() {
        return Err(borrowed_failure(
            "the device lease is no longer held by this run",
        ));
    }
    let recorded = ctx
        .record
        .resources
        .ios_simulator
        .clone()
        .expect("borrowed simulator recorded");
    let sim = observe_borrowed_ios(ctx.runner, &ctx.record.scenario, &recorded.udid)?;
    ensure_running(ctx.runner, "device")?;
    require_borrowed_power(&sim, boot_device)
}

// A long build is no continuing authority: never install, launch or report Ready on a borrowed target that changed.
fn reprove_borrowed_prepare(ctx: &mut Ctx) -> Result<(), Failure> {
    if ctx.verb == "prepare" && ctx.record.resources.device_borrowed {
        reprove_borrowed_ios(ctx, false)?;
    }
    Ok(())
}

// Boots (only when asked) and re-proves the recorded borrowed simulator Booted with unchanged identity.
pub(crate) fn boot_borrowed_ios(ctx: &mut Ctx, needs_boot: bool) -> Result<(), Failure> {
    let failed = |detail| {
        Failure::new(
            "boot_device",
            FailureCode::SimulatorBootFailed,
            detail,
            "check the selected simulator's health and inventory, then re-run",
        )
    };
    let Some(sim) = ctx.record.resources.ios_simulator.clone() else {
        return Err(failed(
            "selected simulator lacks recorded runtime and device type",
        ));
    };
    if needs_boot {
        let output = ctx.runner.run(&ios::bootstatus_spec(
            &sim.udid,
            ctx.record.scenario.deadlines.device_boot_seconds,
        ));
        ensure_running(ctx.runner, "boot_device")?;
        if !output.ok() {
            return Err(failed(
                "bootstatus did not complete successfully for the selected simulator",
            ));
        }
    }
    let output = ctx.runner.run(&ios::list_devices_spec());
    ensure_running(ctx.runner, "boot_device")?;
    if output.ok() && output.stderr.is_empty() && output.stdout.len() < 1024 * 1024 {
        if let Some(observed) = ios::parse_selected_sim(&output.stdout, &sim.udid) {
            if observed.state == ios::SimState::Booted
                && observed.device_type == sim.device_type
                && observed.runtime == sim.runtime
            {
                return Ok(());
            }
        }
    }
    Err(failed("inventory did not prove the exact selected simulator Booted with unchanged runtime and device type"))
}

fn allocate_android(ctx: &mut Ctx, android_home: Option<&str>) -> Result<(), Failure> {
    ensure_running(ctx.runner, "allocate")?;
    let android = ctx
        .record
        .scenario
        .android
        .clone()
        .expect("validated android scenario");
    let holder = android::holder(&ctx.record.run_id);

    let status = ctx.runner.run(&android::farm_status_spec(
        &android.ssh_host,
        &android.farm_path,
    ));
    if !status.ok() {
        return Err(Failure::new(
            "allocate",
            FailureCode::FarmUnreachable,
            format!(
                "ssh {} android-farm status: {}",
                android.ssh_host,
                status.summary()
            ),
            "check Tailscale/ssh access to the farm host, then re-run prepare",
        ));
    }
    let slot_status =
        android::parse_slot_status(&status.stdout, android.slot).ok_or_else(|| {
            Failure::new(
                "allocate",
                FailureCode::FarmStartFailed,
                format!(
                    "farm status has no parseable line for slot {}",
                    android.slot
                ),
                "inspect `android-farm status` output on the farm host",
            )
        })?;
    if slot_status.lease != "free" {
        return Err(Failure::new(
            "allocate",
            FailureCode::FarmSlotLeased,
            format!(
                "slot {} is leased by {:?} (state {})",
                android.slot,
                android::lease_holder_token(&slot_status.lease),
                slot_status.state
            ),
            "pick the other slot in the scenario or wait for the lease to clear",
        ));
    }
    if slot_status.state != "down" {
        return Err(Failure::new(
            "allocate",
            FailureCode::FarmSlotLeased,
            format!(
                "slot {} has no lease but its emulator state is {:?}; refusing to adopt a foreign emulator",
                android.slot, slot_status.state
            ),
            "investigate the farm host; the slot emulator is running without a lease",
        ));
    }

    // The tunnel binds the farm-advertised adb port on this host; a listener
    // already there (a local emulator on 5555 in particular) would be adopted
    // as the leased device. Refuse before claiming the lease.
    check_tunnel_port_free(ctx.runner, slot_status.adb_port)?;

    // The pending lease is durable before the remote command runs at all: a
    // crash inside `farm start` must still leave the claim discoverable.
    ctx.record.resources.farm = Some(FarmResource {
        ssh_host: android.ssh_host.clone(),
        farm_path: android.farm_path.clone(),
        slot: android.slot,
        holder: holder.clone(),
        avd: slot_status.avd.clone(),
        remote_serial: slot_status.serial.clone(),
        adb_port: slot_status.adb_port,
    });
    ctx.save()?;
    ensure_running(ctx.runner, "allocate")?;
    let started = ctx.runner.run(&android::farm_start_spec(
        &android.ssh_host,
        &android.farm_path,
        android.slot,
        &holder,
        ctx.record.scenario.deadlines.device_boot_seconds,
    ));
    let started_ok = started.ok()
        && android::parse_started(&started.stdout, android.slot).is_some_and(|s| {
            s.serial == slot_status.serial
                && s.adb_port == slot_status.adb_port
                && s.lease == holder
        });
    if !started_ok {
        return Err(Failure::new(
            "allocate",
            FailureCode::FarmStartFailed,
            format!(
                "android-farm start slot {} did not echo the requested lease/serial/port: {}",
                android.slot,
                started.summary()
            ),
            "run qaren cleanup for this run, then retry prepare",
        ));
    }

    let tunnel_log = RunRecord::run_dir(&ctx.runs_root, &ctx.record.run_id)
        .join("logs")
        .join("tunnel.log");
    let tunnel_spec = android::tunnel_spec(&android.ssh_host, slot_status.adb_port);
    ensure_running(ctx.runner, "allocate")?;
    let spawned = ctx
        .runner
        .spawn_group(&tunnel_spec, &tunnel_log)
        .map_err(|e| {
            Failure::new(
                "allocate",
                FailureCode::TunnelFailed,
                format!("cannot spawn ssh tunnel: {e}"),
                "run qaren cleanup for this run, then retry prepare",
            )
        })?;
    let identity = capture_pid_identity(ctx.runner, spawned.pid);
    ctx.record.resources.tunnel = Some(TunnelResource {
        spawned: spawned.clone(),
        identity: identity.clone(),
        local_port: slot_status.adb_port,
        log: tunnel_log.clone(),
    });
    ctx.save()?;
    let Some(tunnel_identity) = identity else {
        return Err(Failure::new(
            "allocate",
            FailureCode::TunnelFailed,
            "ssh tunnel died before its identity could be captured".to_string(),
            format!(
                "inspect {} and run qaren cleanup for this run",
                tunnel_log.display()
            ),
        )
        .with_evidence(vec![super::log_tail(&tunnel_log, 25)]));
    };
    wait_for_local_listener(
        ctx,
        slot_status.adb_port,
        spawned.pgid,
        &tunnel_identity,
        &tunnel_log,
        30,
        FailureCode::TunnelFailed,
    )?;

    let adb = android::adb_path(android_home.expect("prereqs checked ANDROID_HOME"));
    ctx.record.resources.adb_path = Some(adb.clone());
    ctx.save()?;

    // The emulator guest only trusts the farm host's adb key; a run-scoped adb
    // server authenticates with it and keeps the Mac's global server out of play.
    let run_dir = RunRecord::run_dir(&ctx.runs_root, &ctx.record.run_id);
    let key = ctx
        .runner
        .run_private(&android::fetch_adbkey_spec(&android.ssh_host), &[]);
    if key.timed_out() || key.exit_code() != Some(0) || key.stdout().trim().is_empty() {
        return Err(Failure::new(
            "allocate",
            FailureCode::AdbServerFailed,
            format!("cannot fetch the farm host adb key: {}", key.summary()),
            "check ~/.android/adbkey on the farm host, run qaren cleanup, then retry",
        ));
    }
    let vendor_key = run_dir.join("nuc-adbkey");
    // Record ownership before the write so a partial key is still cleanable.
    ctx.record.resources.adb_vendor_key = Some(vendor_key.clone());
    ctx.save()?;
    ensure_running(ctx.runner, "allocate")?;
    if let Err(e) = write_private_file(&vendor_key, key.stdout()) {
        return Err(Failure::new(
            "allocate",
            FailureCode::AdbServerFailed,
            format!("cannot write {}: {e}", vendor_key.display()),
            "check .qaren permissions, run qaren cleanup, then retry",
        ));
    }

    let server_port = android.adb_server_port;
    let serial = android::local_serial(slot_status.adb_port);
    let server_log = run_dir.join("logs").join("adb-server.log");
    let server_spec = android::adb_server_spec(&adb, server_port, &serial, &vendor_key);
    ensure_running(ctx.runner, "allocate")?;
    let server = ctx
        .runner
        .spawn_group(&server_spec, &server_log)
        .map_err(|e| {
            Failure::new(
                "allocate",
                FailureCode::AdbServerFailed,
                format!("cannot spawn the private adb server: {e}"),
                "run qaren cleanup for this run, then retry prepare",
            )
        })?;
    let server_identity = capture_pid_identity(ctx.runner, server.pid);
    let server_pgid = server.pgid;
    ctx.record.resources.adb_server = Some(crate::runrecord::AdbServerResource {
        spawned: server,
        identity: server_identity.clone(),
        server_port,
        log: server_log.clone(),
    });
    ctx.save()?;
    let Some(server_identity) = server_identity else {
        return Err(Failure::new(
            "allocate",
            FailureCode::AdbServerFailed,
            "the private adb server died before its identity could be captured".to_string(),
            format!(
                "inspect {} and run qaren cleanup for this run",
                server_log.display()
            ),
        )
        .with_evidence(vec![super::log_tail(&server_log, 25)]));
    };
    wait_for_local_listener(
        ctx,
        server_port,
        server_pgid,
        &server_identity,
        &server_log,
        20,
        FailureCode::AdbServerFailed,
    )?;

    ensure_running(ctx.runner, "allocate")?;
    let connect = ctx
        .runner
        .run(&android::adb_connect_spec(&adb, server_port, &serial));
    let connected = connect.ok()
        && (connect.stdout.contains("connected to")
            || connect.stdout.contains("already connected"));
    if !connected {
        return Err(Failure::new(
            "allocate",
            FailureCode::AdbConnectFailed,
            format!("adb connect {serial}: {}", connect.summary()),
            "run qaren cleanup for this run, then retry prepare",
        ));
    }
    let state = ctx
        .runner
        .run(&android::adb_get_state_spec(&adb, server_port, &serial));
    if !state.ok() || state.stdout.trim() != "device" {
        return Err(Failure::new(
            "allocate",
            FailureCode::AdbConnectFailed,
            format!("adb -s {serial} get-state: {}", state.summary()),
            "run qaren cleanup for this run, then retry prepare",
        ));
    }
    ctx.record.resources.adb_local_serial = Some(serial);
    ctx.save()?;
    Ok(())
}

pub(crate) fn plan_build(ctx: &mut Ctx) -> Result<BuildPlan, Failure> {
    let platform = platform_dir(ctx.record.scenario.platform);
    let repo_root = ctx.record.candidate.repo_root.clone();
    let project_root = ctx.record.candidate.project_root.clone();
    let fp = fingerprint::compute(ctx.runner, &repo_root, &project_root, platform)?
        .with_ios_workspace(ctx.record.scenario.build.ios_workspace.as_ref());
    let state = buildplan::load_state(&repo_root, platform, &ctx.record.candidate.app_id);
    let store = cached_artifact(
        &ctx.native_cache_root,
        platform,
        &ctx.record.candidate.app_id,
        &fp,
        &state,
        &mut ctx.notes,
    )?;
    ctx.native_store_entry = if store.is_some() && platform == "ios" {
        let root = buildplan::open_native_store_root(&ctx.native_cache_root, false)
            .map_err(cache_root_failure)?
            .ok_or_else(|| cache_root_failure("native cache root: unavailable".into()))?;
        let dir = buildplan::store_dir(
            &ctx.native_cache_root,
            platform,
            &ctx.record.candidate.app_id,
            &fp.value,
        );
        root.entry(
            dir.strip_prefix(&ctx.native_cache_root)
                .expect("store child"),
            false,
        )
        .map_err(cache_root_failure)?
    } else {
        None
    };
    let scheme = ctx.record.scenario.candidate.dev_client_scheme.clone();
    let native_dir_exists = project_root.join(platform).is_dir();
    let inputs = buildplan::DecisionInputs {
        platform,
        app_id: &ctx.record.candidate.app_id,
        worktree_root: &repo_root,
        candidate_sha: &ctx.record.candidate.git_sha,
        fingerprint: &fp.value,
        fingerprint_parts: &fp.parts,
        fingerprint_complete: fp.complete,
        incompleteness: &fp.incompleteness,
        expo_unavailable: fp.expo_unavailable.as_deref(),
        scheme: scheme.as_deref(),
        force_clean: ctx.record.scenario.build.strategy == BuildStrategy::Clean,
        native_dir_exists,
        native_dir_in_candidate: fp.native_dir_in_candidate,
    };
    ctx.notes.extend(fingerprint_notes(&fp));
    Ok(buildplan::decide(&inputs, &state, store))
}

fn cache_root_failure(reason: String) -> Failure {
    Failure::new(
        "build_decision",
        FailureCode::PrereqMissing,
        reason,
        "set QAREN_NATIVE_CACHE_ROOT to a supported private absolute directory",
    )
}

fn cached_artifact(
    store_root: &Path,
    platform: &str,
    app_id: &str,
    fp: &NativeFingerprint,
    state: &StateStatus,
    notes: &mut Vec<(String, String)>,
) -> Result<Option<(StoreRecord, ArtifactStatus)>, Failure> {
    if platform != "ios" {
        let StateStatus::Loaded(s) = state else {
            return Ok(None);
        };
        let Some(artifact) = s.artifact.clone().filter(|_| s.fingerprint == fp.value) else {
            return Ok(None);
        };
        let status = verify_artifact(&artifact);
        return Ok(Some((
            StoreRecord {
                artifact,
                built_at: s.built_at.clone(),
                candidate_sha: s.candidate_sha.clone(),
            },
            status,
        )));
    }
    let root = buildplan::open_native_store_root(store_root, false).map_err(cache_root_failure)?;
    let Some(root) = root.filter(|_| fp.complete) else {
        return Ok(None);
    };
    let dir = buildplan::store_dir(store_root, platform, app_id, &fp.value);
    let read: Result<Option<(StoreRecord, ArtifactStatus)>, String> = (|| {
        let Some(entry) = root.entry(dir.strip_prefix(store_root).expect("store child"), false)?
        else {
            return Ok(None);
        };
        let Some(record) = buildplan::load_store_record(&entry)? else {
            return Ok(None);
        };
        let status = entry.artifact_status(&record.artifact)?;
        Ok(Some((record, status)))
    })();
    match read {
        Ok(record) => Ok(record),
        Err(reason) => {
            notes.push(("native_store".into(), format!("ignored: {reason}")));
            Ok(None)
        }
    }
}

// Hash-only parts and closed-template Expo outcomes; never raw config or incompleteness reasons.
fn fingerprint_notes(fp: &fingerprint::NativeFingerprint) -> Vec<(String, String)> {
    let parts = fp
        .parts
        .iter()
        .map(|(part, hash)| format!("{part}={hash}"))
        .collect::<Vec<_>>()
        .join(" ");
    let mut notes = vec![
        ("fingerprint_parts".to_string(), parts),
        ("fingerprint_complete".to_string(), fp.complete.to_string()),
    ];
    if let Some(ms) = fp.expo_fingerprint_ms {
        notes.push(("expo_fingerprint_ms".to_string(), ms.to_string()));
    }
    if let Some(reason) = &fp.expo_unavailable {
        notes.push(("expo_fingerprint_unavailable".to_string(), reason.clone()));
    }
    notes
}

fn verify_artifact(artifact: &CachedArtifact) -> ArtifactStatus {
    if !artifact.path.exists() {
        return ArtifactStatus::MissingFile;
    }
    match buildplan::hash_artifact(&artifact.path) {
        Ok(hash) if hash == artifact.sha256 => ArtifactStatus::Verified,
        Ok(_) => ArtifactStatus::Mismatch,
        Err(_) => ArtifactStatus::Mismatch,
    }
}

fn lock_holder_for(ctx: &mut Ctx) -> LockHolder {
    let (home, qaren_home) = crate::lease::holder_homes(ctx.runner);
    LockHolder {
        holder: android::holder(&ctx.record.run_id),
        run_id: ctx.record.run_id.clone(),
        identity: ctx.record.prepare.clone(),
        at: timefmt::iso8601_utc(ctx.runner.now_epoch_ms()),
        home,
        qaren_home,
        group: None,
    }
}

pub(crate) fn claim_build_lock(ctx: &mut Ctx, lock_root: &Path) -> Result<(), Failure> {
    ensure_running(ctx.runner, "build")?;
    let name = format!(
        "native-build-{}",
        platform_dir(ctx.record.scenario.platform)
    );
    let holder = lock_holder_for(ctx);
    if ctx.record.scenario.platform == Platform::Ios {
        return claim_ios_build_lock(ctx, lock_root, &name, holder);
    }
    // Persisted before the claim so an interrupted prepare leaves the intent
    // discoverable; a foreign holder at cleanup time proves the claim never
    // succeeded (only this run can write its own holder).
    ctx.record.resources.build_lock = Some(BuildLockResource {
        lock_dir: buildplan::lock_dir(lock_root, &name),
        holder: holder.holder.clone(),
    });
    ctx.save()?;
    // A dead CLI owner does not prove its finite build group has stopped.
    let policy = if ctx.record.scenario.platform == Platform::Ios {
        LockPolicy::Strict
    } else {
        LockPolicy::AdoptDead
    };
    match crate::lease::claim_reclaiming_orphan(ctx.runner, lock_root, &name, &holder, policy) {
        (LockOutcome::Claimed { adopted_stale }, orphan) => {
            if let Some(run_id) = orphan {
                ctx.notes.push((
                    "build_lock".to_string(),
                    crate::lease::orphan_note(&buildplan::lock_dir(lock_root, &name), &run_id),
                ));
            } else if adopted_stale {
                ctx.notes.push((
                    "build_lock".to_string(),
                    "adopted a stale lock whose recorded holder is dead".to_string(),
                ));
            }
            Ok(())
        }
        (
            LockOutcome::Contended {
                holder: existing,
                detail,
                ..
            },
            _,
        ) => Err(Failure::new(
            "plan",
            FailureCode::BuildContended,
            format!("a concurrent native build holds the serialization lock: {detail}"),
            format!(
                "native builds are serialized; {}",
                crate::lease::contended_advice(
                    &buildplan::lock_dir(lock_root, &name),
                    existing.as_ref()
                )
            ),
        )),
        (LockOutcome::Error(detail), _) => Err(Failure::new(
            "plan",
            FailureCode::RunRecordUpdateFailed,
            format!("cannot operate the build serialization lock: {detail}"),
            buildplan::LOCK_ROOT_ADVICE,
        )),
    }
}

const LOCK_POLL_MS: u64 = 1000;
const LOCK_PROGRESS_MS: u64 = 5000;
const HOLDER_IDLE_ADVISORY_MS: u64 = 120_000;

// Bounded wait for the iOS build lock within the build window. A live or unproven holder is
// never taken; a dead one is reclaimed only through the group-proven orphan rule.
fn claim_ios_build_lock(
    ctx: &mut Ctx,
    lock_root: &Path,
    name: &str,
    mut holder: LockHolder,
) -> Result<(), Failure> {
    if holder.identity.is_none() {
        return Err(Failure::new(
            "build_lock",
            FailureCode::PrereqMissing,
            "this run's process identity could not be observed, so it cannot hold the native-build lock",
            "Restore process identity observation, then re-run prepare.",
        )
        .with_recovery(RecoveryReason::IdentityUnavailable));
    }
    // Persisted before the claim so an interrupted prepare leaves the intent discoverable.
    ctx.record.resources.build_lock = Some(BuildLockResource {
        lock_dir: buildplan::lock_dir(lock_root, name),
        holder: holder.holder.clone(),
    });
    ctx.save()
        .map_err(|f| f.with_recovery(RecoveryReason::PersistenceFailed))?;
    let start = ctx.runner.monotonic_ms();
    let deadline = start.saturating_add(
        ctx.record
            .scenario
            .deadlines
            .build_seconds
            .saturating_mul(1000),
    );
    ctx.build_deadline_ms = Some(deadline);
    let mut wait = LockWait::default();
    loop {
        if let Err(f) = ensure_running(ctx.runner, "build_lock_wait") {
            wait.finish(ctx, start, StageState::Failed);
            return Err(f.with_recovery(RecoveryReason::RunCancelled));
        }
        // Budget expiry before the claim starts no new work.
        if wait.waiting && ctx.runner.monotonic_ms() >= deadline {
            wait.finish(ctx, start, StageState::Failed);
            return Err(wait.refusal(name, ctx.record.scenario.deadlines.build_seconds));
        }
        holder.at = timefmt::iso8601_utc(ctx.runner.now_epoch_ms());
        let (outcome, orphan) = crate::lease::claim_reclaiming_build_orphan(
            ctx.runner,
            lock_root,
            name,
            &holder,
            Some(deadline),
        );
        match outcome {
            LockOutcome::Claimed { .. } => {
                if let Some(run_id) = orphan {
                    ctx.notes.push((
                        "build_lock".to_string(),
                        crate::lease::orphan_note(&buildplan::lock_dir(lock_root, name), &run_id),
                    ));
                }
                wait.finish(ctx, start, StageState::Passed);
                return Ok(());
            }
            LockOutcome::Contended {
                holder: existing,
                liveness,
                ..
            } => {
                wait.observe(ctx, existing.as_ref(), liveness, start);
                let remaining = deadline.saturating_sub(ctx.runner.monotonic_ms());
                ctx.runner
                    .sleep(Duration::from_millis(LOCK_POLL_MS.min(remaining)));
            }
            LockOutcome::Error(detail) => {
                wait.finish(ctx, start, StageState::Failed);
                return Err(Failure::new(
                    "plan",
                    FailureCode::RunRecordUpdateFailed,
                    format!("cannot operate the build serialization lock: {detail}"),
                    buildplan::LOCK_ROOT_ADVICE,
                ));
            }
        }
    }
}

#[derive(Default)]
struct LockWait {
    observed: BuildLockObservation,
    waiting: bool,
    holder_token: Option<String>,
    reported_ms: u64,
    idle_since_ms: Option<u64>,
    advised: bool,
}

impl LockWait {
    fn observe(
        &mut self,
        ctx: &mut Ctx,
        existing: Option<&LockHolder>,
        liveness: Option<PidLiveness>,
        start: u64,
    ) {
        let token = existing.map(|held| held.holder.clone());
        let transition = self.waiting && token != self.holder_token;
        let facts = existing.map(|held| {
            crate::lease::holder_facts_until(ctx.runner, held, liveness, ctx.build_deadline_ms)
        });
        let alive = facts.and_then(|f| f.alive);
        let build_process = facts.and_then(|f| f.build_process);
        let now = ctx.runner.monotonic_ms();
        if transition {
            self.idle_since_ms = None;
            self.advised = false;
        }
        if alive == Some(true) && build_process == Some(false) {
            self.idle_since_ms.get_or_insert(now);
        } else {
            self.idle_since_ms = None;
        }
        self.observed = BuildLockObservation {
            holder: existing
                .map(|held| held.run_id.clone())
                .filter(|run_id| crate::runrecord::validate_run_id(run_id).is_ok()),
            waited_s: now.saturating_sub(start) / 1000,
            holder_alive: alive,
            holder_build_process: build_process,
            hold_s: facts.and_then(|f| f.hold_s),
            no_build_observed_s: self
                .idle_since_ms
                .map_or(0, |since| now.saturating_sub(since) / 1000),
            observation: if existing.is_some() {
                LockObservation::Observed
            } else {
                LockObservation::Unreadable
            },
        };
        let idle = !self.advised
            && self
                .idle_since_ms
                .is_some_and(|since| now.saturating_sub(since) >= HOLDER_IDLE_ADVISORY_MS);
        let code = if idle {
            "holder_idle_after_build"
        } else {
            match alive {
                Some(true) => "holder_alive",
                Some(false) => "holder_dead",
                None => "holder_unknown",
            }
        };
        if !self.waiting {
            self.waiting = true;
            crate::progress::started("build-lock-wait", false);
            crate::events::stage("build_lock_wait", StageState::Running, Some(code), None);
            self.reported_ms = now;
        } else if transition || idle || now.saturating_sub(self.reported_ms) >= LOCK_PROGRESS_MS {
            crate::events::stage(
                "build_lock_wait",
                StageState::Running,
                Some(code),
                Some(now.saturating_sub(start)),
            );
            self.reported_ms = now;
        }
        if idle {
            self.advised = true;
            ctx.notes.push((
                "build_lock".to_string(),
                format!(
                    "holder_idle_after_build: run {} is alive and has shown no build process for {} s; it is never taken while alive",
                    self.observed.holder.as_deref().unwrap_or("unknown"),
                    self.observed.no_build_observed_s
                ),
            ));
        }
        self.holder_token = token;
        ctx.record.build_lock = Some(self.observed.clone());
    }

    fn finish(&mut self, ctx: &mut Ctx, start: u64, state: StageState) {
        let elapsed = ctx.runner.monotonic_ms().saturating_sub(start);
        self.observed.waited_s = elapsed / 1000;
        ctx.record.build_lock = Some(self.observed.clone());
        if self.waiting {
            crate::events::stage("build_lock_wait", state, None, Some(elapsed));
            crate::progress::finished("build-lock-wait", state == StageState::Passed);
        }
    }

    fn refusal(&self, name: &str, budget_s: u64) -> Failure {
        let seen = &self.observed;
        let holder = seen.holder.as_deref().unwrap_or("unknown");
        let alive = crate::lease::yes_no(seen.holder_alive);
        let build = match seen.holder_build_process {
            Some(true) => "build process running".to_string(),
            Some(false) if seen.no_build_observed_s > 0 => format!(
                "no build process for {}",
                crate::lease::rough_duration(seen.no_build_observed_s)
            ),
            Some(false) => "no build process".to_string(),
            None => "build process unknown".to_string(),
        };
        let held = seen
            .hold_s
            .map_or("unknown".to_string(), crate::lease::rough_duration);
        Failure::new(
            "build_lock_wait",
            FailureCode::BuildContended,
            format!(
                "{name} is held by run {holder} (alive: {alive}; {build}; held {held}); waited {} s of the {budget_s} s build budget",
                seen.waited_s
            ),
            format!(
                "BUILD_CONTENDED: {name} is held by run {holder} (alive: {alive}; {build}); waited {} s of the budget. Next: wait for that run or re-run once later; if the holder is dead, run its qaren cleanup from its home (its resources only).",
                seen.waited_s
            ),
        )
        .with_recovery(RecoveryReason::BudgetExhausted)
    }
}

// Releases only once the build group is proven gone; an unresolved release stops the run and is never reported free.
fn release_ios_build_lock(ctx: &mut Ctx) -> Result<(), Failure> {
    let unresolved = |ctx: &Ctx, reason: &str| {
        Failure::new(
            "build_lock",
            FailureCode::RunRecordUpdateFailed,
            format!("the native-build lock could not be released: {reason}"),
            format!(
                "Restore writable run storage and process observation, then run qaren cleanup {} --json and prepare again; keep unproven resources.",
                ctx.record.run_id
            ),
        )
        .with_recovery(RecoveryReason::OwnershipUnresolved)
    };
    let Some(lock) = ctx.record.resources.build_lock.clone() else {
        return Ok(());
    };
    if !ctx.record.resources.can_release_build_ownership() {
        ctx.notes.push((
            "build_lock_release".into(),
            "retained: the build group is not proven gone".into(),
        ));
        return Err(unresolved(ctx, "the build group is not proven gone"));
    }
    match buildplan::release_lock(&lock.lock_dir, &lock.holder, &ctx.record.run_id) {
        buildplan::ReleaseOutcome::Removed
        | buildplan::ReleaseOutcome::Absent
        | buildplan::ReleaseOutcome::Foreign(_) => {
            ctx.record.resources.build_lock = None;
            ctx.build_deadline_ms = None;
            if let Err(f) = ctx.save() {
                ctx.record.resources.build_lock = Some(lock);
                ctx.notes.push((
                    "build_lock_release".into(),
                    "retained: lock release could not be persisted".into(),
                ));
                return Err(f.with_recovery(RecoveryReason::PersistenceFailed));
            }
            Ok(())
        }
        buildplan::ReleaseOutcome::Refused(reason)
        | buildplan::ReleaseOutcome::Unresolved(reason) => {
            ctx.notes.push((
                "build_lock_release".into(),
                "retained: lock release was refused or unresolved".into(),
            ));
            Err(unresolved(ctx, &reason))
        }
    }
}

pub(crate) fn release_build_lock(ctx: &mut Ctx) {
    if !ctx.record.resources.can_release_build_ownership() {
        return;
    }
    let Some(lock) = ctx.record.resources.build_lock.clone() else {
        return;
    };
    let outcome = buildplan::release_lock(&lock.lock_dir, &lock.holder, &ctx.record.run_id);
    match outcome {
        buildplan::ReleaseOutcome::Removed
        | buildplan::ReleaseOutcome::Absent
        | buildplan::ReleaseOutcome::Foreign(_) => {
            ctx.record.resources.build_lock = None;
        }
        buildplan::ReleaseOutcome::Refused(reason)
        | buildplan::ReleaseOutcome::Unresolved(reason) => {
            ctx.notes.push(("build_lock_release".to_string(), reason));
        }
    }
}

fn claim_usb_device(ctx: &mut Ctx, lock_root: &Path, serial: &str) -> Result<(), Failure> {
    let holder = lock_holder_for(ctx);
    let lock_name = android::usb_lock_name(serial);
    let lock_dir = buildplan::lock_dir(lock_root, &lock_name);
    // Persist-before-claim: an interrupted claim stays discoverable, and a
    // foreign holder at cleanup proves this run never owned the device.
    ctx.record.resources.usb_device = Some(UsbDeviceResource {
        serial: serial.to_string(),
        lock_dir: lock_dir.clone(),
        holder: holder.holder.clone(),
    });
    ctx.save()?;
    match crate::lease::claim_reclaiming_orphan(
        ctx.runner,
        lock_root,
        &lock_name,
        &holder,
        LockPolicy::Strict,
    ) {
        (LockOutcome::Claimed { .. }, orphan) => {
            if let Some(run_id) = orphan {
                ctx.notes.push((
                    "usb_device_lock".to_string(),
                    crate::lease::orphan_note(&lock_dir, &run_id),
                ));
            }
            Ok(())
        }
        (
            LockOutcome::Contended {
                holder: existing,
                detail,
                ..
            },
            _,
        ) => {
            let described = existing
                .as_ref()
                .map(|h| format!(" (held for run {})", h.run_id))
                .unwrap_or_default();
            Err(Failure::new(
                "allocate",
                FailureCode::DeviceClaimContended,
                format!(
                    "physical device {serial} is exclusively claimed elsewhere{described}: {detail}"
                ),
                crate::lease::contended_advice(&lock_dir, existing.as_ref()),
            ))
        }
        (LockOutcome::Error(detail), _) => Err(Failure::new(
            "allocate",
            FailureCode::RunRecordUpdateFailed,
            format!("cannot operate the device claim lock: {detail}"),
            buildplan::LOCK_ROOT_ADVICE,
        )),
    }
}

fn allocate_usb(
    ctx: &mut Ctx,
    android_home: Option<&str>,
    lock_root: &Path,
) -> Result<(), Failure> {
    ensure_running(ctx.runner, "allocate")?;
    let usb = ctx
        .record
        .scenario
        .android_usb
        .clone()
        .expect("validated usb scenario");
    claim_usb_device(ctx, lock_root, &usb.serial)?;
    let usb_adb_server_port = usb
        .adb_server_port
        .expect("validated qaren-owned usb scenario");

    let adb = android::adb_path(android_home.expect("prereqs checked ANDROID_HOME"));
    ctx.record.resources.adb_path = Some(adb.clone());
    ctx.save()?;

    let Some(home) = std::env::var_os("HOME") else {
        return Err(Failure::new(
            "allocate",
            FailureCode::PrereqMissing,
            "HOME is not set; the host adb key cannot be located".to_string(),
            "run qaren in a normal user environment, then retry prepare",
        ));
    };
    let host_key = PathBuf::from(home).join(".android").join("adbkey");
    let run_dir = RunRecord::run_dir(&ctx.runs_root, &ctx.record.run_id);
    let server_log = run_dir.join("logs").join("adb-server.log");
    let server_spec =
        android::usb_adb_server_spec(&adb, usb_adb_server_port, &usb.serial, &host_key);
    ensure_running(ctx.runner, "allocate")?;
    let server = ctx
        .runner
        .spawn_group(&server_spec, &server_log)
        .map_err(|e| {
            Failure::new(
                "allocate",
                FailureCode::AdbServerFailed,
                format!("cannot spawn the run-scoped adb server: {e}"),
                "run qaren cleanup for this run, then retry prepare",
            )
        })?;
    let server_identity = capture_pid_identity(ctx.runner, server.pid);
    let server_pgid = server.pgid;
    ctx.record.resources.adb_server = Some(crate::runrecord::AdbServerResource {
        spawned: server,
        identity: server_identity.clone(),
        server_port: usb_adb_server_port,
        log: server_log.clone(),
    });
    ctx.save()?;
    let Some(server_identity) = server_identity else {
        return Err(Failure::new(
            "allocate",
            FailureCode::AdbServerFailed,
            "the run-scoped adb server died before its identity could be captured".to_string(),
            format!(
                "inspect {} and run qaren cleanup for this run",
                server_log.display()
            ),
        )
        .with_evidence(vec![super::log_tail(&server_log, 25)]));
    };
    wait_for_local_listener(
        ctx,
        usb_adb_server_port,
        server_pgid,
        &server_identity,
        &server_log,
        20,
        FailureCode::AdbServerFailed,
    )?;

    let state = ctx.runner.run(&android::adb_get_state_spec(
        &adb,
        usb_adb_server_port,
        &usb.serial,
    ));
    if !state.ok() || state.stdout.trim() != "device" {
        return Err(Failure::new(
            "allocate",
            FailureCode::DeviceUnavailable,
            format!(
                "physical device {} is not online through the run-scoped server: {}",
                usb.serial,
                state.summary()
            ),
            "connect and authorize the device for this host (check `unauthorized`/`offline` on the phone screen), run qaren cleanup for this run, then retry",
        ));
    }
    ctx.record.resources.adb_local_serial = Some(usb.serial.clone());
    ctx.save()?;
    Ok(())
}

fn native_build_output_dirs(platform: &str) -> &'static [&'static str] {
    match platform {
        "ios" => &["ios/build"],
        _ => &["android/build", "android/app/build", "android/.gradle"],
    }
}

fn native_prebuild_spec(
    project_root: &Path,
    platform: &str,
    build_seconds: u64,
    registry_auth_env: &[String],
) -> CmdSpec {
    CmdSpec::new(
        "expo-prebuild",
        "pnpm",
        &[
            "exec",
            "expo",
            "prebuild",
            "--platform",
            platform,
            "--clean",
        ],
        build_seconds,
    )
    .cwd(project_root)
    .env_remove("CI")
    .env("EXPO_NO_TELEMETRY", "1")
    .registry_auth_env(registry_auth_env)
}

pub(crate) fn run_clean_preparation(ctx: &mut Ctx, plan: &BuildPlan) -> Result<(), Failure> {
    ensure_running(ctx.runner, "build")?;
    let platform = platform_dir(ctx.record.scenario.platform);
    let project_root = ctx.record.candidate.project_root.clone();
    if plan.regenerate_native_dir {
        let spec = native_prebuild_spec(
            &project_root,
            platform,
            build_seconds_left(ctx),
            &ctx.record.scenario.deps.registry_auth_env,
        );
        let prebuild = if ctx.record.scenario.platform == Platform::Ios {
            run_finite_build(ctx, &spec)?;
            crate::exec::CmdOutput::success("")
        } else {
            ctx.runner.run(&spec)
        };
        if !prebuild.ok() {
            return Err(Failure::new(
                "build",
                FailureCode::BuildFailed,
                format!("expo prebuild --clean: {}", prebuild.summary()),
                if spec.registry_auth_env.is_empty() {
                    format!(
                        "inspect the prebuild output, then qaren cleanup {} --json",
                        ctx.record.run_id
                    )
                } else {
                    format!("dependency output was withheld; check the declared registry auth environment names and registry setup, then qaren cleanup {} --json", ctx.record.run_id)
                },
            ));
        }
        ctx.notes.push((
            "clean_preparation".to_string(),
            format!("deleted and regenerated the generated {platform}/ dir, including its installed native dependencies and build outputs, via expo prebuild --clean"),
        ));
        return Ok(());
    }
    // A git-visible native dir is candidate input and is never deleted; clean
    // means dropping the derived build outputs inside it.
    let mut removed = Vec::new();
    for rel in native_build_output_dirs(platform) {
        let path = project_root.join(rel);
        if !path.exists() {
            continue;
        }
        ensure_running(ctx.runner, "build")?;
        std::fs::remove_dir_all(&path).map_err(|e| {
            Failure::new(
                "build",
                FailureCode::BuildFailed,
                format!("cannot remove build output {}: {e}", path.display()),
                "fix the build directory permissions, then re-run prepare",
            )
        })?;
        removed.push(rel.to_string());
    }
    ctx.notes.push((
        "clean_preparation".to_string(),
        if removed.is_empty() {
            "no build outputs existed to remove".to_string()
        } else {
            format!("removed build outputs: {}", removed.join(", "))
        },
    ));
    Ok(())
}

fn spawn_metro_only(ctx: &mut Ctx) -> Result<(), Failure> {
    let port = qaren_metro_port(&ctx.record.scenario);
    let project_root = ctx.record.candidate.project_root.clone();
    let spec = metro::start_spec(&project_root, port);
    let metro_log = RunRecord::run_dir(&ctx.runs_root, &ctx.record.run_id)
        .join("logs")
        .join("metro.log");
    ensure_running(ctx.runner, "build")?;
    let spawned = ctx.runner.spawn_group(&spec, &metro_log).map_err(|e| {
        Failure::new(
            "build",
            FailureCode::BuildFailed,
            format!("cannot spawn {}: {e}", spec.rendered()),
            "check pnpm/expo availability, run qaren cleanup, then retry prepare",
        )
    })?;
    let identity = capture_pid_identity(ctx.runner, spawned.pid);
    ctx.record.resources.metro = Some(MetroResource {
        port,
        endpoint: format!("http://127.0.0.1:{port}"),
        spawned,
        identity: identity.clone(),
        log: metro_log.clone(),
    });
    ctx.record.phase = Phase::Building;
    ctx.save()?;
    if identity.is_none() {
        return Err(Failure::new(
            "build",
            FailureCode::BuildFailed,
            format!("metro exited immediately; see {}", metro_log.display()),
            format!(
                "inspect the log, then qaren cleanup {} --json",
                ctx.record.run_id
            ),
        )
        .with_evidence(vec![super::log_tail(&metro_log, 25)]));
    }
    Ok(())
}

fn wait_metro_responding(ctx: &mut Ctx) -> Result<(), Failure> {
    let deadline = ctx.runner.monotonic_ms() + ctx.record.scenario.deadlines.build_seconds * 1000;
    let metro_resource = ctx.record.resources.metro.clone().expect("metro spawned");
    let identity = metro_resource.identity.clone().expect("identity captured");
    loop {
        ensure_running(ctx.runner, "build")?;
        if probe_pid_identity(ctx.runner, &identity) == PidLiveness::Dead {
            return Err(Failure::new(
                "build",
                FailureCode::BuildFailed,
                format!("metro exited; see {}", metro_resource.log.display()),
                format!(
                    "inspect the log, then qaren cleanup {} --json",
                    ctx.record.run_id
                ),
            )
            .with_evidence(vec![super::log_tail(&metro_resource.log, 25)]));
        }
        let port_output = ctx.runner.run(&metro::port_owner_spec(metro_resource.port));
        let port_ours = match metro::parse_port_owner(&port_output) {
            metro::PortOwners::Owned(pid) => {
                metro::pgid_of(ctx.runner, pid) == Some(metro_resource.spawned.pgid)
            }
            _ => false,
        };
        if port_ours && metro::metro_responding(ctx.runner, metro_resource.port) {
            ensure_running(ctx.runner, "build")?;
            return Ok(());
        }
        if ctx.runner.monotonic_ms() >= deadline {
            return Err(Failure::new(
                "build",
                FailureCode::ReadyDeadlineExceeded,
                format!(
                    "metro did not become ready in time; see {}",
                    metro_resource.log.display()
                ),
                format!(
                    "inspect the log, then qaren cleanup {} --json",
                    ctx.record.run_id
                ),
            )
            .with_evidence(vec![super::log_tail(&metro_resource.log, 25)]));
        }
        ctx.runner.sleep(Duration::from_secs(2));
    }
}

const IOS_SUBSTAGES: [&str; 6] = [
    "install_cached",
    "metro_ready",
    "dev_client_manifest",
    "dev_menu_defaults",
    "app_launch",
    "ready_probes",
];

// Saved for a separate `qaren status`, best effort: observation never changes the run's outcome.
fn enter_substage(ctx: &mut Ctx, next: Option<&'static str>) {
    if ctx.record.scenario.platform != Platform::Ios {
        return;
    }
    if let Some(open) = IOS_SUBSTAGES
        .into_iter()
        .find(|s| ctx.record.substage.as_deref() == Some(*s))
    {
        crate::events::stage(open, StageState::Passed, None, None);
    }
    if let Some(next) = next {
        crate::events::stage(next, StageState::Running, None, None);
    }
    ctx.record.substage = next.map(str::to_string);
    let _ = ctx.save();
}

pub(crate) fn run_reuse_path(ctx: &mut Ctx, plan: &BuildPlan, t: u64) -> Result<(), Failure> {
    ensure_running(ctx.runner, "build")?;
    enter_substage(ctx, Some("install_cached"));
    let artifact = plan.artifact.clone().expect("reuse carries an artifact");
    let metro_port = qaren_metro_port(&ctx.record.scenario);
    let deadline = ctx.runner.monotonic_ms() + ctx.record.scenario.deadlines.build_seconds * 1000;
    match ctx.record.scenario.platform {
        Platform::Ios => {
            if plan.decision == buildplan::BuildDecision::Reuse {
                let entry = ctx.native_store_entry.as_ref().ok_or_else(|| {
                    artifact_install_failure(
                        &ctx.record.run_id,
                        &artifact,
                        "native cache entry: unavailable".into(),
                        ArtifactInstallFailure::ArtifactInvalid,
                    )
                })?;
                if !entry.check_artifact(&artifact).map_err(|reason| {
                    artifact_install_failure(
                        &ctx.record.run_id,
                        &artifact,
                        reason,
                        ArtifactInstallFailure::ArtifactInvalid,
                    )
                })? {
                    return Err(artifact_install_failure(
                        &ctx.record.run_id,
                        &artifact,
                        "artifact changed before install".into(),
                        ArtifactInstallFailure::ArtifactInvalid,
                    ));
                }
            }
            let verified = ios::verify_app(
                ctx.runner,
                &artifact.path,
                &ctx.record.candidate.app_id,
                ctx.record
                    .scenario
                    .candidate
                    .dev_client_scheme
                    .as_deref()
                    .expect("scheme validated"),
            )
            .map_err(|reason| {
                artifact_install_failure(
                    &ctx.record.run_id,
                    &artifact,
                    reason,
                    ArtifactInstallFailure::ArtifactInvalid,
                )
            })?;
            if verified.sha256 != artifact.sha256 || verified.kind != artifact.kind {
                return Err(artifact_install_failure(
                    &ctx.record.run_id,
                    &artifact,
                    "artifact changed before install".into(),
                    ArtifactInstallFailure::ArtifactInvalid,
                ));
            }
            if ctx.record.resources.metro.is_none() {
                spawn_metro_only(ctx)?;
            }
            let sim = ctx
                .record
                .resources
                .ios_simulator
                .clone()
                .expect("ios allocated");
            if plan.decision == buildplan::BuildDecision::Reuse {
                ctx.native_store_entry
                    .as_ref()
                    .expect("selected entry")
                    .recheck()
                    .map_err(|reason| {
                        artifact_install_failure(
                            &ctx.record.run_id,
                            &artifact,
                            reason,
                            ArtifactInstallFailure::ArtifactInvalid,
                        )
                    })?;
            }
            install_cached_ios_app(ctx, &sim.udid, &artifact, deadline)?;
        }
        Platform::Android => {
            let (adb, serial, server_port) =
                ctx.record.resources.adb_endpoint().expect("allocated");
            ensure_running(ctx.runner, "build")?;
            let installed = ctx.runner.run(&android::adb_install_spec(
                &adb,
                server_port,
                &serial,
                &artifact.path,
            ));
            if !installed.ok() || !installed.stdout.contains("Success") {
                return Err(artifact_install_failure(
                    &ctx.record.run_id,
                    &artifact,
                    installed.summary(),
                    if installed.timed_out {
                        ArtifactInstallFailure::InstallTimeout
                    } else {
                        ArtifactInstallFailure::InstallFailed
                    },
                ));
            }
            ctx.record.resources.app_install = Some(AppInstallResource {
                app_id: ctx.record.candidate.app_id.clone(),
                serial: serial.clone(),
                server_port,
                artifact: artifact.clone(),
                via: "adb-install".to_string(),
                installed_at: timefmt::iso8601_utc(ctx.runner.now_epoch_ms()),
                removal: None,
            });
            // Recorded before the mutation so cleanup knows a reverse mapping
            // may exist on the device.
            ctx.record.resources.adb_reverse_port = Some(metro_port);
            ctx.save()?;
            let borrowed = ctx.record.resources.android_emulator.is_some();
            let reverse = if borrowed {
                android::adb_reverse_no_rebind_spec(&adb, server_port, &serial, metro_port)
            } else {
                android::adb_reverse_spec(&adb, server_port, &serial, metro_port)
            };
            if !borrowed {
                ensure_running(ctx.runner, "build")?;
            }
            let executed = ctx.runner.commands_executed();
            let reversed = ctx.runner.run(&reverse);
            if borrowed && ctx.runner.commands_executed() == executed {
                // A cancelled run refuses the command unexecuted, so any
                // mapping on the port is not this run's.
                ctx.record.resources.adb_reverse_port = None;
                ctx.save()?;
                ensure_running(ctx.runner, "build")?;
            }
            if borrowed && !reversed.ok() && reverse_already_bound(&reversed) {
                // Not this run's mapping, so cleanup must never remove it.
                ctx.record.resources.adb_reverse_port = None;
                ctx.save()?;
                return Err(Failure::new(
                    "build",
                    FailureCode::DeviceBusy,
                    format!(
                        "tcp:{metro_port} is already reversed on {serial} by something else; qaren does not take it over"
                    ),
                    format!(
                        "remove that mapping (adb -s {serial} reverse --remove tcp:{metro_port}) or choose another Metro port, then re-run"
                    ),
                ));
            }
            if !reversed.ok() {
                return Err(Failure::new(
                    "build",
                    FailureCode::DeviceUnavailable,
                    format!("adb reverse tcp:{metro_port}: {}", reversed.summary()),
                    format!(
                        "run qaren cleanup {} --json, then retry prepare",
                        ctx.record.run_id
                    ),
                ));
            }
        }
    }
    let t = ctx.mark("install_cached", t);

    enter_substage(ctx, Some("metro_ready"));
    if ctx.record.resources.metro.is_none() {
        spawn_metro_only(ctx)?;
    }
    wait_metro_responding(ctx)?;
    let t = ctx.mark("metro_ready", t);

    enter_substage(ctx, Some("dev_client_manifest"));
    if matches!(ctx.record.scenario.platform, Platform::Ios) {
        run_budgeted_attempt(
            ctx,
            &metro::request_probe_spec(metro_port),
            deadline,
            &mut 0,
        )?;
    }
    let manifest = metro::manifest_spec(metro_port, platform_dir(ctx.record.scenario.platform));
    let mut attempts = 0;
    let mut in_margin = 0;
    let mut last = None;
    loop {
        let Some(warmed) = run_budgeted_attempt(ctx, &manifest, deadline, &mut attempts)? else {
            let last = last.ok_or_else(|| launch_deadline_spent(&ctx.record.run_id))?;
            return Err(launch_failure(
                "dev client manifest",
                &last,
                crate::core::host_load_1m(),
                attempts,
                &ctx.record.run_id,
            ));
        };
        let ready = match ctx.record.scenario.platform {
            Platform::Ios => {
                in_margin = manifest_in_margin(in_margin, &warmed);
                in_margin == DEV_CLIENT_MANIFEST_ANSWERS
            }
            Platform::Android => warmed.ok() && warmed.duration_ms < DEV_CLIENT_REQUEST_TIMEOUT_MS,
        };
        if ready {
            ctx.manifest_warm = Some(crate::core::ManifestWarm {
                ms: warmed.duration_ms,
                attempts,
            });
            break;
        }
        if !warmed.ok() && !warmed.timed_out {
            return Err(launch_failure(
                "dev client manifest",
                &warmed,
                None,
                attempts,
                &ctx.record.run_id,
            ));
        }
        last = Some(warmed);
    }
    let launch = match ctx.record.scenario.platform {
        Platform::Ios => {
            reprove_borrowed_prepare(ctx)?;
            let sim = ctx
                .record
                .resources
                .ios_simulator
                .clone()
                .expect("ios allocated");
            if ctx.lane_owned {
                enter_substage(ctx, Some("lane_normalize"));
                normalize_lane(ctx, &sim.udid, deadline)?;
            }
            enter_substage(ctx, Some("dev_menu_defaults"));
            let defaults = ios::devmenu_defaults_specs(&sim.udid, &ctx.record.candidate.app_id);
            let mut failed = 0;
            let mut attempts = 0;
            for spec in &defaults {
                let output =
                    run_launch_command(ctx, spec, deadline, &mut attempts, &mut |_| false)?;
                if output.timed_out {
                    return Err(launch_failure(
                        "dev-menu defaults",
                        &output,
                        crate::core::host_load_1m(),
                        attempts,
                        &ctx.record.run_id,
                    ));
                }
                failed += usize::from(!output.ok());
            }
            if failed > 0 {
                ctx.notes
                    .push(("dev_menu_defaults".to_string(), "unconfirmed".to_string()));
            }
            ios::launch_spec(&sim.udid, &ctx.record.candidate.app_id, metro_port)
        }
        Platform::Android => {
            let scheme = ctx
                .record
                .scenario
                .candidate
                .dev_client_scheme
                .as_deref()
                .expect("reuse was decided with a scheme");
            let url = devclient::launch_url(scheme, metro_port);
            let (adb, serial, server_port) =
                ctx.record.resources.adb_endpoint().expect("allocated");
            android::am_start_deeplink_spec(
                &adb,
                server_port,
                &serial,
                &url,
                &ctx.record.candidate.app_id,
            )
        }
    };
    let mut attempts = 0;
    let mut proven = false;
    let ios_udid = matches!(ctx.record.scenario.platform, Platform::Ios).then(|| {
        ctx.record
            .resources
            .ios_simulator
            .clone()
            .expect("ios allocated")
            .udid
    });
    let app_id = ctx.record.candidate.app_id.clone();
    let watch = AppWatch {
        launched_ms: ctx.runner.monotonic_ms(),
        launched_epoch_ms: ctx.runner.now_epoch_ms(),
        // simctl launch returns only once the process exists; am start returns before it does.
        first_pid_grace_ms: if ios_udid.is_some() {
            0
        } else {
            ANDROID_FIRST_PID_GRACE_MS
        },
        downs: 0,
    };
    enter_substage(ctx, Some("app_launch"));
    if matches!(ctx.record.scenario.platform, Platform::Ios) {
        ctx.bundle_requests_at_launch = ctx
            .record
            .resources
            .metro
            .as_ref()
            .map(|metro| crate::exec::log::read_bundle_requests(&metro.log).unwrap_or(0));
    }
    let launched = run_launch_command(ctx, &launch, deadline, &mut attempts, &mut |ctx| {
        proven = ios_udid
            .as_deref()
            .is_some_and(|udid| ios_app_running(ctx, udid, &app_id));
        proven
    })?;
    let load = launched.timed_out.then(crate::core::host_load_1m).flatten();
    if !launched.ok() && !proven {
        return Err(launch_failure(
            "dev client launch",
            &launched,
            load,
            attempts,
            &ctx.record.run_id,
        ));
    }
    let t = ctx.mark("app_launch", t);

    enter_substage(ctx, Some("ready_probes"));
    wait_ready_until(ctx, deadline, Some(watch))?;
    ctx.mark("ready_probes", t);
    enter_substage(ctx, None);
    Ok(())
}

// Pins the owned simulator's locale and keyboard before launch; the readback, not the write, decides.
fn normalize_lane(ctx: &mut Ctx, udid: &str, deadline: u64) -> Result<(), Failure> {
    let started = ctx.runner.monotonic_ms();
    let unpinned = read_lane(ctx, udid, deadline)?;
    for &entry in &unpinned {
        lane_command(ctx, &ios::lane_write_spec(udid, entry), deadline)?;
    }
    let pinned = ios::lane_defaults();
    let still = if unpinned.is_empty() {
        Vec::new()
    } else {
        read_lane(ctx, udid, deadline)?
    };
    if !still.is_empty() {
        let keys: Vec<&str> = still.iter().map(|&entry| pinned[entry].1).collect();
        return Err(lane_not_warm(
            format!(
                "the simulator did not keep the pinned value for {}",
                keys.join(", ")
            ),
            "check the simulator with `xcrun simctl spawn <udid> defaults read -g`, or erase it, then re-run",
        ));
    }
    let mut normalized: Vec<String> = unpinned
        .iter()
        .map(|&entry| pinned[entry].1.to_string())
        .collect();
    let hardware_keyboard = match ctx.runner.env_var("HOME") {
        Some(home) => {
            let output = lane_command(
                ctx,
                &ios::hardware_keyboard_spec(Path::new(&home), udid),
                deadline,
            )?;
            let initial = ios::parse_hardware_keyboard(&output);
            if initial == Some(false) {
                initial
            } else {
                lane_command(
                    ctx,
                    &ios::simulator_preferences_dir_spec(Path::new(&home)),
                    deadline,
                )?;
                let set = lane_command(
                    ctx,
                    &ios::hardware_keyboard_write_spec(Path::new(&home), udid, false),
                    deadline,
                )?;
                if !set.ok() {
                    lane_command(
                        ctx,
                        &ios::hardware_keyboard_write_spec(Path::new(&home), udid, true),
                        deadline,
                    )?;
                }
                normalized.push("ConnectHardwareKeyboard".to_string());
                let readback = lane_command(
                    ctx,
                    &ios::hardware_keyboard_spec(Path::new(&home), udid),
                    deadline,
                )?;
                ios::parse_hardware_keyboard(&readback)
            }
        }
        None => None,
    };
    if hardware_keyboard != Some(false) {
        return Err(lane_not_warm(
            "could not prove the hardware keyboard disconnected for this simulator after normalization",
            "turn off I/O > Keyboard > Connect Hardware Keyboard in Simulator.app for this simulator, then re-run",
        ));
    }
    ctx.notes.push((
        "lane".to_string(),
        format!(
            "pinned {} keyboard, {} locale; {} value(s) normalized",
            ios::LANE_LAYOUT,
            ios::LANE_LOCALE,
            normalized.len()
        ),
    ));
    ctx.record.resources.lane = Some(crate::runrecord::LaneEvidence {
        device_id: udid.to_string(),
        build: ctx
            .record
            .build
            .as_ref()
            .map(|plan| plan.fingerprint.clone())
            .unwrap_or_default(),
        layout: ios::LANE_LAYOUT.to_string(),
        locale: ios::LANE_LOCALE.to_string(),
        normalized,
        hardware_keyboard,
        pinned_at: timefmt::iso8601_utc(ctx.runner.now_epoch_ms()),
        first_screen: None,
    });
    ctx.timings.push((
        "lane_normalize".to_string(),
        ctx.runner.monotonic_ms().saturating_sub(started),
    ));
    ctx.save()
}

fn read_lane(ctx: &mut Ctx, udid: &str, deadline: u64) -> Result<Vec<usize>, Failure> {
    let mut exports = Vec::new();
    for spec in ios::lane_read_specs(udid) {
        let output = lane_command(ctx, &spec, deadline)?;
        exports.push(output.ok().then_some(output.stdout));
    }
    Ok(ios::lane_unpinned(&exports))
}

// Bounded by the launch budget; unlike run_budgeted_attempt it records no output, which holds device preferences.
fn lane_command(
    ctx: &mut Ctx,
    spec: &CmdSpec,
    deadline: u64,
) -> Result<crate::exec::CmdOutput, Failure> {
    ensure_running(ctx.runner, "build")?;
    let remaining_s = deadline.saturating_sub(ctx.runner.monotonic_ms()) / 1000;
    if remaining_s == 0 {
        return Err(launch_deadline_spent(&ctx.record.run_id));
    }
    let mut bounded = spec.clone();
    bounded.timeout_seconds = bounded.timeout_seconds.min(remaining_s);
    let output = ctx.runner.run(&bounded);
    ensure_running(ctx.runner, "build")?;
    Ok(output)
}

pub(crate) fn lane_not_warm(detail: impl Into<String>, next_action: &str) -> Failure {
    Failure::new("lane", FailureCode::LaneNotWarm, detail, next_action)
}

// Let the owned install use the remaining preparation budget before checking its receipt.
fn install_cached_ios_app(
    ctx: &mut Ctx,
    udid: &str,
    artifact: &CachedArtifact,
    deadline: u64,
) -> Result<(), Failure> {
    let mut spec = ios::install_app_spec(udid, &artifact.path);
    spec.timeout_seconds = deadline.saturating_sub(ctx.runner.monotonic_ms()) / 1000;
    let mut attempts = 0;
    let mut last = None;
    loop {
        reprove_borrowed_prepare(ctx)?;
        let Some(installed) = run_budgeted_attempt(ctx, &spec, deadline, &mut attempts)? else {
            break;
        };
        if !installed.timed_out {
            if installed.ok() {
                return Ok(());
            }
            if !ios::install_refusal_is_transient(&installed.stderr) {
                return Err(artifact_install_failure(
                    &ctx.record.run_id,
                    artifact,
                    installed.summary(),
                    ArtifactInstallFailure::InstallFailed,
                ));
            }
            ctx.runner.sleep(READY_TICK);
            last = Some(installed);
            continue;
        }
        if installed_bundle_matches(ctx, udid, artifact) {
            ctx.notes
                .push(("install_proof".into(), "container-hash".into()));
            return Ok(());
        }
        last = Some(installed);
    }
    let summary = match last {
        Some(output) => format!(
            "last of {attempts} attempts {}; preparation budget of {}s spent",
            output.summary(),
            ctx.record.scenario.deadlines.build_seconds
        ),
        None => "preparation budget spent before install".into(),
    };
    Err(artifact_install_failure(
        &ctx.record.run_id,
        artifact,
        summary,
        ArtifactInstallFailure::InstallTimeout,
    ))
}

fn installed_bundle_matches(ctx: &mut Ctx, udid: &str, artifact: &CachedArtifact) -> bool {
    let container = ctx
        .runner
        .run(&ios::app_container_spec(udid, &ctx.record.candidate.app_id));
    container.ok()
        && crate::buildplan::hash_artifact(Path::new(container.stdout.trim()))
            .is_ok_and(|sha256| sha256 == artifact.sha256)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactInstallFailure {
    ArtifactInvalid,
    InstallTimeout,
    InstallFailed,
}

impl ArtifactInstallFailure {
    fn as_str(self) -> &'static str {
        match self {
            Self::ArtifactInvalid => "artifact-invalid",
            Self::InstallTimeout => "install-timeout",
            Self::InstallFailed => "install-failed",
        }
    }
}

fn artifact_install_failure(
    run_id: &str,
    artifact: &CachedArtifact,
    summary: String,
    cause: ArtifactInstallFailure,
) -> Failure {
    Failure::new(
        "build",
        FailureCode::ArtifactInstallFailed,
        format!(
            "cached dev client {} failed to install ({}): {summary}",
            artifact.path.display(),
            cause.as_str()
        ),
        match (cause, artifact.kind) {
            (ArtifactInstallFailure::ArtifactInvalid, ArtifactKind::AppBundle) => format!(
                "delete the machine store entry {} to force a rebuild, then qaren cleanup {run_id} --json and re-run prepare",
                artifact.path.parent().and_then(Path::parent).unwrap_or(&artifact.path).display()
            ),
            (ArtifactInstallFailure::ArtifactInvalid, ArtifactKind::Apk) => format!(
                "delete the cached artifact to force a rebuild, then qaren cleanup {run_id} --json and re-run prepare"
            ),
            (ArtifactInstallFailure::InstallTimeout, _) => format!(
                "the install timed out; keep the cached artifact, run qaren cleanup {run_id} --json, and inspect the target device, package service, and transport state"
            ),
            (ArtifactInstallFailure::InstallFailed, _) => format!(
                "the install failed after artifact verification; keep the cached artifact, run qaren cleanup {run_id} --json, and inspect the target device, package service, and transport state"
            ),
        },
    )
}

pub(crate) fn recheck_fingerprint(
    ctx: &mut Ctx,
    plan: &BuildPlan,
) -> Result<NativeFingerprint, Failure> {
    let platform = platform_dir(ctx.record.scenario.platform);
    let repo_root = ctx.record.candidate.repo_root.clone();
    let project_root = ctx.record.candidate.project_root.clone();
    let fp = fingerprint::compute(ctx.runner, &repo_root, &project_root, platform)?
        .with_ios_workspace(ctx.record.scenario.build.ios_workspace.as_ref());
    if fp.value != plan.fingerprint {
        return Err(candidate_drift(
            &ctx.record.run_id,
            format!(
                "native inputs changed during preparation: planned fingerprint {}, now {}",
                plan.fingerprint, fp.value
            ),
        ));
    }
    Ok(fp)
}

// adb's own refusal of `reverse --no-rebind` for a port the device already maps.
fn reverse_already_bound(output: &crate::exec::CmdOutput) -> bool {
    output.stdout.contains("cannot rebind") || output.stderr.contains("cannot rebind")
}

fn locate_built_apk(project_root: &Path) -> Result<(PathBuf, ArtifactKind), String> {
    let apk = project_root
        .join("android")
        .join("app")
        .join("build")
        .join("outputs")
        .join("apk")
        .join("debug")
        .join("app-debug.apk");
    if apk.is_file() {
        Ok((apk, ArtifactKind::Apk))
    } else {
        Err(format!("no apk at {}", apk.display()))
    }
}

// Prune only exact app/fingerprint keys, never another app sharing the prefix.
fn prune_stale_artifacts(platform_dir: &Path, app_id: &str, keep_fp_key: &str) -> usize {
    let prefix = format!("{app_id}-");
    let mut pruned = 0;
    let entries = match std::fs::read_dir(platform_dir) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(fp_key) = name.strip_prefix(&prefix) else {
            continue;
        };
        if fp_key == keep_fp_key
            || fp_key.len() != 16
            || !fp_key.chars().all(|c| c.is_ascii_hexdigit())
            || !entry.path().is_dir()
        {
            continue;
        }
        if std::fs::remove_dir_all(entry.path()).is_ok() {
            pruned += 1;
        }
    }
    pruned
}

pub(crate) fn record_build_result(
    ctx: &mut Ctx,
    fp: &NativeFingerprint,
) -> Result<Option<CachedArtifact>, Failure> {
    let platform = platform_dir(ctx.record.scenario.platform);
    let repo_root = ctx.record.candidate.repo_root.clone();
    let project_root = ctx.record.candidate.project_root.clone();
    let app_id = ctx.record.candidate.app_id.clone();
    let verified = ctx.record.build.as_ref().and_then(|p| p.artifact.clone());
    let source = if platform == "ios" {
        verified
            .as_ref()
            .map(|a| (a.path.clone(), a.kind))
            .ok_or("no verified iOS build artifact".to_string())
    } else {
        locate_built_apk(&project_root)
    };
    let (src, kind) = match source {
        Ok(source) => source,
        Err(reason) => {
            ensure_running(ctx.runner, "native_cache")?;
            ctx.notes
                .push(("artifact_cache".into(), format!("skipped: {reason}")));
            return Ok(None);
        }
    };
    let ios = platform == "ios";
    let bucket = if ios {
        buildplan::store_dir(&ctx.native_cache_root, platform, &app_id, &fp.value)
    } else {
        let fp_key: String = fp
            .value
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .take(16)
            .collect();
        buildplan::cache_dir(&repo_root)
            .join("artifacts")
            .join(platform)
            .join(format!("{app_id}-{fp_key}"))
    };
    let staging = bucket.join(format!(
        ".staging-{}-{}",
        ctx.record.run_id,
        std::process::id()
    ));
    let dest_dir = bucket.join(&ctx.record.run_id);
    let staged = staging.join(src.file_name().unwrap_or_default());
    let dest = dest_dir.join(src.file_name().unwrap_or_default());
    let mut private_copy = None;
    let mut private_entry = None;
    let copied = if ios {
        (|| {
            let root = buildplan::open_native_store_root(&ctx.native_cache_root, true)?
                .ok_or("native cache root: unavailable")?;
            let entry = root
                .entry(
                    bucket
                        .strip_prefix(&ctx.native_cache_root)
                        .expect("store child"),
                    true,
                )?
                .ok_or("native cache entry: unavailable")?;
            if let Some(existing) = buildplan::load_store_record(&entry)? {
                entry.check_artifact(&existing.artifact)?;
            }
            let expected = &verified.as_ref().expect("verified iOS artifact").sha256;
            ensure_build_budget(ctx).map_err(|failure| failure.detail.to_string())?;
            let copy = entry.copy_app(
                ctx.runner,
                &src,
                std::ffi::OsStr::new(&ctx.record.run_id),
                expected,
            )?;
            private_copy = Some(copy);
            private_entry = Some(entry);
            Ok(expected.clone())
        })()
    } else {
        buildplan::copy_artifact(ctx.runner, &src, &staged)
            .and_then(|()| buildplan::hash_artifact(&staged))
            .and_then(|hash| {
                if verified.as_ref().is_some_and(|a| a.sha256 != hash) {
                    Err("copied artifact differs from the verified build".into())
                } else {
                    Ok(hash)
                }
            })
    };
    if ios {
        ensure_build_budget(ctx)?;
    }
    let sha256 = match copied {
        Ok(hash) => hash,
        Err(reason) => {
            if !ios {
                let _ = std::fs::remove_dir_all(&staging);
            }
            ensure_running(ctx.runner, "native_cache")?;
            ctx.notes
                .push(("artifact_cache".into(), format!("skipped: {reason}")));
            return Ok(None);
        }
    };
    let artifact = CachedArtifact {
        path: dest,
        sha256,
        kind,
    };
    let built_at = timefmt::iso8601_utc(ctx.runner.now_epoch_ms());
    let generated =
        ctx.record.candidate.project_root.join(platform).is_dir() && !fp.native_dir_in_candidate;
    let state = buildplan::NativeCacheState {
        schema: buildplan::CACHE_SCHEMA.to_string(),
        platform: platform.to_string(),
        app_id: app_id.clone(),
        worktree_root: repo_root.clone(),
        fingerprint: fp.value.clone(),
        built_at: built_at.clone(),
        candidate_sha: ctx.record.candidate.git_sha.clone(),
        lockfile_sha256: ctx
            .record
            .candidate
            .lockfile_sha256
            .clone()
            .unwrap_or_default(),
        generated_native_dirs: if generated {
            vec![platform.to_string()]
        } else {
            Vec::new()
        },
        artifact: (!ios).then(|| artifact.clone()),
        fingerprint_parts: fp.parts.clone(),
    };
    let path = buildplan::state_path(&repo_root, platform, &app_id);
    if let Err(f) = ensure_running(ctx.runner, "native_cache") {
        if !ios {
            let _ = std::fs::remove_dir_all(&staging);
        }
        return Err(f);
    }
    if let Err(e) = if ios {
        Ok(())
    } else {
        std::fs::rename(&staging, &dest_dir)
    } {
        if !ios {
            let _ = std::fs::remove_dir_all(&staging);
        }
        ctx.notes
            .push(("artifact_cache".into(), format!("skipped: {e}")));
        return Ok(None);
    }
    if ios {
        ensure_build_budget(ctx)?;
    }
    if let Err(e) = buildplan::save_json(&path, &state) {
        if !ios {
            let _ = std::fs::remove_dir_all(&dest_dir);
        }
        ctx.notes.push((
            "native_cache_state".to_string(),
            format!("could not persist {}: {e}", path.display()),
        ));
        return Ok(None);
    }
    if let Some(copy) = private_copy.take() {
        copy.retain();
    }
    // A run that installed by serial already recorded that install; only an expo install is recorded here.
    if let (ArtifactKind::Apk, Some((_, serial, server_port)), None) = (
        kind,
        ctx.record.resources.adb_endpoint(),
        &ctx.record.resources.app_install,
    ) {
        ctx.record.resources.app_install = Some(AppInstallResource {
            app_id: app_id.clone(),
            serial,
            server_port,
            artifact: artifact.clone(),
            via: "expo-run-android".into(),
            installed_at: timefmt::iso8601_utc(ctx.runner.now_epoch_ms()),
            removal: None,
        });
    }
    let record = StoreRecord {
        artifact: artifact.clone(),
        built_at,
        candidate_sha: ctx.record.candidate.git_sha.clone(),
    };
    if ios {
        ensure_build_budget(ctx)?;
    }
    let mut publication_failed = false;
    let deadline = ctx.build_deadline_ms;
    let runner: &dyn Runner = &*ctx.runner;
    let in_budget = || deadline.is_none_or(|deadline| runner.monotonic_ms() < deadline);
    let published = match (ios, fp.complete) {
        (false, _) => {
            "cached the built dev client for fingerprint-matched reuse in this worktree".to_string()
        }
        (true, false) => "kept this run's copy; an incomplete fingerprint is never published for reuse".to_string(),
        (true, true) => match buildplan::publish_store_record_within(private_entry.as_ref().expect("private iOS entry"), &record, &in_budget) {
            Ok(true) => format!(
                "published the built dev client to the machine store at {}",
                bucket.display()
            ),
            Ok(false) => format!(
                "kept this run's copy; the machine store already holds a build of this fingerprint at {}",
                bucket.display()
            ),
            Err(e) => {
                publication_failed = true;
                format!("kept this run's copy; could not publish to the machine store: {e}")
            },
        },
    };
    ctx.notes.push(("artifact_cache".into(), published));
    if publication_failed {
        ensure_running(ctx.runner, "native_cache")?;
        return Ok(None);
    }
    if !ios {
        let keep = bucket
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix(&format!("{app_id}-")))
            .unwrap_or_default()
            .to_string();
        let pruned =
            prune_stale_artifacts(bucket.parent().expect("platform cache"), &app_id, &keep);
        if pruned > 0 {
            ctx.notes.push((
                "artifact_cache".into(),
                format!(
                    "pruned {pruned} artifact director{} for older native fingerprints",
                    if pruned == 1 { "y" } else { "ies" }
                ),
            ));
        }
        return Ok(None);
    }
    if !ctx.record.resources.can_release_build_ownership() {
        return Ok(None);
    }
    let (Some(source), cached) = (verified, artifact) else {
        return Ok(None);
    };
    ensure_build_budget(ctx)?;
    ctx.record.build.as_mut().expect("build planned").artifact = Some(cached);
    if let Err(e) = ctx.save() {
        ctx.record.build.as_mut().expect("build planned").artifact = Some(source);
        ctx.notes
            .push(("ios_build_output".into(), format!("retained: {}", e.detail)));
        return Ok(None);
    }
    Ok(Some(source))
}

fn retire_ios_build_output(ctx: &mut Ctx, source: CachedArtifact) -> Result<(), Failure> {
    let run_dir = RunRecord::run_dir(&ctx.runs_root, &ctx.record.run_id);
    let output = run_dir.join("ios-build");
    if source.kind != ArtifactKind::AppBundle
        || source.path.parent() != Some(output.as_path())
        || source.path.extension().is_none_or(|ext| ext != "app")
        || [&run_dir, &output, &source.path]
            .iter()
            .any(|path| !std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()))
    {
        ctx.notes.push((
            "ios_build_output".into(),
            "retained: source is not a run-owned app directory".into(),
        ));
        return Ok(());
    }
    if ctx.record.scenario.build.ios_workspace.is_some() {
        let derived = run_dir.join("ios-derived-data");
        let derived_exists = match std::fs::symlink_metadata(&derived) {
            Ok(meta) if meta.is_dir() => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            _ => {
                ctx.notes.push((
                    "ios_build_output".into(),
                    "retained: derived data is not a plain run-owned directory".into(),
                ));
                return Ok(());
            }
        };
        if std::fs::remove_dir_all(&output)
            .and_then(|()| {
                if derived_exists {
                    std::fs::remove_dir_all(&derived)
                } else {
                    Ok(())
                }
            })
            .is_err()
        {
            ctx.notes.push((
                "ios_build_output".into(),
                "retirement incomplete: could not remove run-owned build products".into(),
            ));
        }
        return Ok(());
    }
    if let Err(e) =
        std::fs::remove_dir_all(&source.path).and_then(|()| std::fs::remove_dir(&output))
    {
        ctx.notes.push((
            "ios_build_output".into(),
            format!("could not retire output: {e}"),
        ));
    }
    Ok(())
}

fn write_private_file(path: &Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(content.as_bytes())
}

// The build can run for many minutes; the receipt's provenance claim is only
// honest if the checkout still matches what was recorded at validation time.
fn recheck_candidate(ctx: &mut Ctx) -> Result<(), Failure> {
    // Handoff baselines are recorded through the integration filter, so the
    // recheck must look through the same filter to compare like with like.
    let tolerate = ctx.record.scenario.build.owner == BuildOwner::Qaren;
    candidate::verify_unchanged_with(ctx.runner, &ctx.record.candidate, tolerate)
        .map_err(|detail| candidate_drift(&ctx.record.run_id, format!("{detail} during the run")))
}

fn candidate_drift(run_id: &str, detail: String) -> Failure {
    Failure::new(
        "verify",
        FailureCode::CandidateDrifted,
        detail,
        format!("qaren cleanup {run_id} --json, then re-run prepare on a stable checkout"),
    )
    .with_recovery(RecoveryReason::CandidateDrifted)
}

fn check_tunnel_port_free(runner: &mut dyn Runner, port: u16) -> Result<(), Failure> {
    let output = runner.run(&metro::port_owner_spec(port));
    match metro::parse_port_owner(&output) {
        metro::PortOwners::Free => Ok(()),
        metro::PortOwners::Owned(pid) => Err(Failure::new(
            "allocate",
            FailureCode::TunnelFailed,
            format!("farm adb port {port} already has a local listener (pid {pid}); refusing to bind the tunnel over it"),
            "stop the local listener yourself (a local emulator commonly owns 5555) or lease a slot with a different adb_port",
        )),
        metro::PortOwners::Multiple => Err(Failure::new(
            "allocate",
            FailureCode::TunnelFailed,
            format!("farm adb port {port} has multiple local listeners; refusing to bind the tunnel over them"),
            "stop the local listeners yourself or lease a slot with a different adb_port",
        )),
        metro::PortOwners::Unknown => Err(Failure::new(
            "allocate",
            FailureCode::TunnelFailed,
            format!(
                "cannot determine local state of farm adb port {port}: {}",
                output.summary()
            ),
            "ensure lsof works on this host, then re-run prepare",
        )),
    }
}

// A listener on the port only counts once it is proven to belong to the group
// we just spawned; adopting a foreign listener would silently swap the device
// identity behind the receipt.
fn wait_for_local_listener(
    ctx: &mut Ctx,
    port: u16,
    expected_pgid: i32,
    leader: &crate::runrecord::PidIdentity,
    log: &Path,
    deadline_seconds: u64,
    failure_code: FailureCode,
) -> Result<(), Failure> {
    let deadline = ctx.runner.monotonic_ms() + deadline_seconds * 1000;
    loop {
        ensure_running(ctx.runner, "allocate")?;
        let output = ctx.runner.run(&metro::port_owner_spec(port));
        match metro::parse_port_owner(&output) {
            metro::PortOwners::Owned(pid) => match metro::pgid_of(ctx.runner, pid) {
                Some(pgid) if pgid == expected_pgid => {
                    ensure_running(ctx.runner, "allocate")?;
                    return Ok(());
                }
                Some(foreign_pgid) => {
                    return Err(Failure::new(
                        "allocate",
                        failure_code,
                        format!(
                            "local port {port} is owned by pid {pid} in foreign process group {foreign_pgid}, not the spawned group {expected_pgid}"
                        ),
                        "run qaren cleanup for this run, resolve the foreign listener yourself, then retry prepare",
                    ));
                }
                // The owner exited between lsof and ps; keep polling.
                None => {}
            },
            metro::PortOwners::Multiple => {
                return Err(Failure::new(
                    "allocate",
                    failure_code,
                    format!("local port {port} has multiple listeners; refusing to adopt any of them"),
                    "run qaren cleanup for this run, resolve the foreign listeners yourself, then retry prepare",
                ));
            }
            _ => {}
        }
        // The listener is the spawned leader itself; once it dies, waiting out
        // the full deadline would only hide the real cause in its log.
        if probe_pid_identity(ctx.runner, leader) == PidLiveness::Dead {
            return Err(Failure::new(
                "allocate",
                failure_code,
                format!(
                    "the process spawned for local port {port} exited before the port started listening; see {}",
                    log.display()
                ),
                "run qaren cleanup for this run, then retry prepare",
            )
            .with_evidence(vec![super::log_tail(log, 25)]));
        }
        if ctx.runner.monotonic_ms() >= deadline {
            return Err(Failure::new(
                "allocate",
                failure_code,
                format!(
                    "local port {port} did not start listening (owned by the spawned group) within {deadline_seconds}s; see {}",
                    log.display()
                ),
                "run qaren cleanup for this run, then retry prepare",
            )
            .with_evidence(vec![super::log_tail(log, 25)]));
        }
        ctx.runner.sleep(Duration::from_millis(500));
    }
}

fn build_failure(ctx: &Ctx, detail: impl Into<String>) -> Failure {
    Failure::new(
        "build",
        FailureCode::BuildFailed,
        detail,
        format!(
            "inspect the build log, then qaren cleanup {} --json",
            ctx.record.run_id
        ),
    )
}

fn run_finite_build(ctx: &mut Ctx, spec: &CmdSpec) -> Result<(), Failure> {
    ensure_running(ctx.runner, "build")?;
    use crate::runrecord::BuildCompletionEvidence;
    use std::io::Write;
    let log = RunRecord::run_dir(&ctx.runs_root, &ctx.record.run_id)
        .join("logs")
        .join(format!("{}.log", spec.label));
    let mut gated = spec.clone();
    gated.program = "/bin/bash".into();
    gated.args = vec![
        "--noprofile".into(),
        "--norc".into(),
        "-c".into(),
        "IFS= read -r start && [ \"$start\" = start ] || exit 4; exec \"$@\" >&2".into(),
        "qaren-build".into(),
        spec.program.clone(),
    ];
    gated.args.extend(spec.args.clone());
    gated = gated
        .env("BASH_ENV", "/dev/null")
        .env("TYPESAFE_API_KEY", "");
    ctx.record.resources.begin_build()?;
    ctx.record.phase = Phase::Building;
    ctx.save()?;
    if let Err(failure) = ensure_running(ctx.runner, "build") {
        ctx.record
            .resources
            .finish_build(BuildCompletionEvidence::NotSpawned)?;
        ctx.save()?;
        return Err(failure);
    }
    let mut child = match ctx.runner.spawn_piped(&gated, &log) {
        Ok(child) => child,
        Err(error) => {
            let mut cancelled = ctx.record.clone();
            cancelled
                .resources
                .finish_build(BuildCompletionEvidence::NotSpawned)?;
            cancelled.save(&ctx.runs_root)?;
            ctx.record = cancelled;
            return Err(build_failure(
                ctx,
                format!("build command did not spawn: {error}"),
            ));
        }
    };
    let identity = capture_pid_identity(ctx.runner, child.pid);
    let known = identity.is_some();
    ctx.record
        .resources
        .record_build_spawned(child.pid, identity)?;
    ctx.save()?;
    let grouped = match ctx.record.resources.build_lock.as_ref() {
        Some(lock) => buildplan::record_holder_group(
            &lock.lock_dir,
            &lock.holder,
            &ctx.record.run_id,
            child.pid,
        ),
        None => Ok(()),
    };
    if let Err(detail) = &grouped {
        ctx.notes
            .push(("build_lock_group".to_string(), detail.clone()));
    }
    let started = known
        && ctx
            .build_deadline_ms
            .is_none_or(|deadline| ctx.runner.monotonic_ms() < deadline)
        && grouped.is_ok()
        && ctx.runner.cancellation().is_none()
        && child
            .stdin
            .write_all(b"start\n")
            .and_then(|_| child.stdin.flush())
            .is_ok();
    drop(child.stdin);
    drop(child.stdout);
    let mut exit = None;
    let mut cancelled = ctx.runner.cancellation();
    if started {
        let deadline = ctx
            .runner
            .monotonic_ms()
            .saturating_add(spec.timeout_seconds.saturating_mul(1000))
            .min(ctx.build_deadline_ms.unwrap_or(u64::MAX));
        loop {
            if let Some(reason) = ctx.runner.cancellation() {
                cancelled = Some(reason);
                break;
            }
            match child.handle.try_wait() {
                Ok(Some(code)) => {
                    exit = Some(code);
                    break;
                }
                Err(_) => break,
                Ok(None) if ctx.runner.monotonic_ms() >= deadline => break,
                Ok(None) => ctx.runner.sleep(Duration::from_millis(100)),
            }
        }
    }
    let mut outcome = super::cleanup::cleanup_build(ctx.runner, &mut ctx.record, &ctx.runs_root)
        .expect("build recorded");
    if !outcome.clean() && exit.is_none() && matches!(child.handle.try_wait(), Ok(Some(_))) {
        outcome = super::cleanup::cleanup_build(ctx.runner, &mut ctx.record, &ctx.runs_root)
            .expect("unresolved build retained");
    }
    let _ = child.handle.try_wait();
    ctx.notes.push((
        spec.label.clone(),
        format!("exit={exit:?}; group={}", outcome.render()),
    ));
    let windowed = ctx.build_deadline_ms.is_some();
    if let Some(reason) = cancelled.or_else(|| ctx.runner.cancellation()) {
        let failure = Failure::cancelled("build", &reason);
        return Err(if windowed {
            failure.with_recovery(RecoveryReason::RunCancelled)
        } else {
            failure
        });
    }
    if !started || exit != Some(0) || !matches!(outcome, super::cleanup::Outcome::Absent) {
        let budget_spent = ctx
            .build_deadline_ms
            .is_some_and(|deadline| ctx.runner.monotonic_ms() >= deadline);
        let mut failure = build_failure(
            ctx,
            format!(
                "{} did not finish cleanly: exit={exit:?}; group={}; see {}",
                spec.label,
                outcome.render(),
                log.display()
            ),
        )
        .with_evidence(vec![super::log_tail(&log, 25)]);
        if crate::redact::is_registry_child(&spec.label) && !spec.registry_auth_env.is_empty() {
            failure.next_action = crate::redact::OutputText::from_output(&format!("dependency output was withheld; check the declared registry auth environment names and registry setup, then qaren cleanup {} --json", ctx.record.run_id));
        }
        if windowed {
            failure = failure.with_recovery(if budget_spent && exit.is_none() {
                RecoveryReason::BuildBudgetExhausted
            } else {
                RecoveryReason::BuildProcessFailed
            });
        }
        return Err(failure);
    }
    Ok(())
}

pub(crate) fn build_ios_locked(
    ctx: &mut Ctx,
    plan: &BuildPlan,
    lock_root: &Path,
) -> Result<BuildPlan, Failure> {
    claim_build_lock(ctx, lock_root)?;
    let result = with_build_window(ctx, |ctx| {
        ensure_build_budget(ctx)?;
        if plan.decision == BuildDecision::Clean {
            crate::events::stage("prebuild", StageState::Running, None, None);
            run_clean_preparation(ctx, plan)?;
            crate::events::stage("prebuild", StageState::Passed, None, None);
        } else {
            crate::events::stage("prebuild", StageState::Skipped, None, None);
        }
        ensure_build_budget(ctx)?;
        crate::events::stage("native_build", StageState::Running, None, None);
        build_ios(ctx)?;
        crate::events::stage("native_build", StageState::Passed, None, None);
        ensure_build_budget(ctx)?;
        recheck_candidate(ctx)?;
        let fp = recheck_fingerprint(ctx, plan)?;
        ensure_build_budget(ctx)?;
        let retirement = record_build_result(ctx, &fp)?;
        // Publication refuses to commit after expiry; spending the budget inside it still fails the build.
        ensure_build_budget(ctx)?;
        Ok(retirement)
    });
    finish_ios_build(ctx, result, retire_ios_build_output)?;
    Ok(ctx.record.build.clone().expect("build planned"))
}

fn with_build_window<T>(
    ctx: &mut Ctx,
    operation: impl FnOnce(&mut Ctx) -> Result<T, Failure>,
) -> Result<T, Failure> {
    let mut runner = crate::exec::DeadlineRunner {
        inner: ctx.runner,
        deadline_ms: ctx.build_deadline_ms.expect("iOS build window started"),
    };
    let mut scoped = Ctx {
        runner: &mut runner,
        runs_root: ctx.runs_root.clone(),
        native_cache_root: ctx.native_cache_root.clone(),
        native_store_entry: ctx.native_store_entry.take(),
        record: ctx.record.clone(),
        started_ms: ctx.started_ms,
        timings: std::mem::take(&mut ctx.timings),
        notes: std::mem::take(&mut ctx.notes),
        verb: ctx.verb,
        bundle_requests_at_launch: ctx.bundle_requests_at_launch,
        manifest_warm: ctx.manifest_warm.take(),
        lane_owned: ctx.lane_owned,
        build_deadline_ms: ctx.build_deadline_ms,
    };
    let result = operation(&mut scoped);
    let budget = ensure_build_budget(&mut scoped);
    ctx.record = scoped.record;
    ctx.native_store_entry = scoped.native_store_entry;
    ctx.timings = scoped.timings;
    ctx.notes = scoped.notes;
    ctx.bundle_requests_at_launch = scoped.bundle_requests_at_launch;
    ctx.manifest_warm = scoped.manifest_warm;
    ctx.lane_owned = scoped.lane_owned;
    ctx.build_deadline_ms = scoped.build_deadline_ms;
    budget?;
    result
}

fn finish_ios_build(
    ctx: &mut Ctx,
    result: Result<Option<CachedArtifact>, Failure>,
    retire: impl FnOnce(&mut Ctx, CachedArtifact) -> Result<(), Failure>,
) -> Result<(), Failure> {
    let released = release_ios_build_lock(ctx);
    let retirement = result?;
    released?;
    if let Some(source) = retirement {
        retire(ctx, source)?;
    }
    Ok(())
}

fn build_ios(ctx: &mut Ctx) -> Result<(), Failure> {
    ensure_running(ctx.runner, "build")?;
    let project_root = ctx.record.candidate.project_root.clone();
    if let Some(workspace) = ctx.record.scenario.build.ios_workspace.as_ref() {
        ios::validate_workspace(&project_root, workspace)?;
    }
    let output = RunRecord::run_dir(&ctx.runs_root, &ctx.record.run_id).join("ios-build");
    std::fs::create_dir(&output)
        .map_err(|_| build_failure(ctx, "cannot exclusively create iOS build output directory"))?;
    let build = ios::build_spec(
        &project_root,
        &output,
        build_seconds_left(ctx),
        ctx.record.scenario.build.ios_workspace.as_ref(),
    );
    run_finite_build(ctx, &build)?;
    ensure_build_budget(ctx)?;
    if ctx.record.scenario.build.ios_workspace.is_some() {
        let built =
            ios::built_app(&ios::workspace_products(&output)).map_err(|e| build_failure(ctx, e))?;
        let name = built.file_name().expect("app has a name").to_owned();
        std::fs::rename(&built, output.join(name)).map_err(|e| {
            build_failure(
                ctx,
                format!("cannot move the built app into the output: {e}"),
            )
        })?;
    }
    let app = ios::built_app(&output).map_err(|e| build_failure(ctx, e))?;
    let artifact = ios::verify_app(
        ctx.runner,
        &app,
        &ctx.record.candidate.app_id,
        ctx.record
            .scenario
            .candidate
            .dev_client_scheme
            .as_deref()
            .expect("scheme validated"),
    )
    .map_err(|e| build_failure(ctx, e))?;
    ensure_build_budget(ctx)?;
    ctx.record.build.as_mut().expect("build planned").artifact = Some(artifact);
    ctx.save()
}

// Seconds left in the build window, never more than the scenario's own build deadline.
fn build_seconds_left(ctx: &Ctx) -> u64 {
    let full = ctx.record.scenario.deadlines.build_seconds;
    ctx.build_deadline_ms.map_or(full, |deadline| {
        deadline
            .saturating_sub(ctx.runner.monotonic_ms())
            .div_ceil(1000)
            .min(full)
    })
}

fn ensure_build_budget(ctx: &mut Ctx) -> Result<(), Failure> {
    ensure_running(ctx.runner, "build")?;
    if ctx
        .build_deadline_ms
        .is_some_and(|deadline| ctx.runner.monotonic_ms() >= deadline)
    {
        return Err(Failure::new(
            "build",
            FailureCode::BuildFailed,
            "the build budget was exhausted before the build was published",
            format!(
                "Inspect the build result; when this run's owned build group is retired, run qaren cleanup {} --json, then prepare again.",
                ctx.record.run_id
            ),
        )
        .with_recovery(RecoveryReason::BuildBudgetExhausted));
    }
    Ok(())
}

pub(crate) fn build_and_ready(ctx: &mut Ctx) -> Result<(), Failure> {
    ensure_running(ctx.runner, "build")?;
    let port = qaren_metro_port(&ctx.record.scenario);
    let deadline = ctx.record.scenario.deadlines.build_seconds;
    let project_root = ctx.record.candidate.project_root.clone();
    let spec = match ctx.record.scenario.platform {
        Platform::Ios => unreachable!("iOS builds run under build_ios_locked"),
        Platform::Android => {
            if let Some(emulator) = ctx.record.resources.android_emulator.clone() {
                if !project_root.join("android").is_dir() {
                    // Keep the slash so dir-only ignore patterns protect against mid-run candidate drift.
                    let ignored = ctx.runner.run(&CmdSpec::new(
                        "git-check-ignore",
                        "git",
                        &[
                            "-C",
                            &project_root.to_string_lossy(),
                            "check-ignore",
                            "-q",
                            "android/",
                        ],
                        20,
                    ));
                    match ignored.exit_code {
                        Some(0) if !ignored.timed_out => {}
                        Some(1) if !ignored.timed_out => {
                            return Err(Failure::new(
                                "build",
                                FailureCode::BuildFailed,
                                "android/ is absent and not git-ignored; generating it would change the candidate's native inputs during the run",
                                "add android/ to .gitignore, or generate and commit it, then re-run",
                            ));
                        }
                        _ => {
                            return Err(build_failure(
                                ctx,
                                format!(
                                    "cannot tell whether git ignores android/: {}",
                                    ignored.summary()
                                ),
                            ))
                        }
                    }
                    // Like expo run:ios, the borrowed-emulator build generates an absent native dir itself.
                    run_finite_build(
                        ctx,
                        &native_prebuild_spec(
                            &project_root,
                            "android",
                            deadline,
                            &ctx.record.scenario.deps.registry_auth_env,
                        ),
                    )?;
                }
                if !project_root.join("android").join("gradlew").is_file() {
                    return Err(build_failure(
                        ctx,
                        format!(
                            "no Gradle wrapper at {}",
                            project_root.join("android/gradlew").display()
                        ),
                    ));
                }
                run_finite_build(
                    ctx,
                    &android::gradle_assemble_spec(&project_root, &emulator.abi, deadline),
                )?;
                let (path, kind) =
                    locate_built_apk(&project_root).map_err(|e| build_failure(ctx, e))?;
                let sha256 = buildplan::hash_artifact(&path).map_err(|e| build_failure(ctx, e))?;
                let mut plan = ctx.record.build.clone().expect("build planned");
                plan.artifact = Some(CachedArtifact { path, sha256, kind });
                ctx.record.build = Some(plan.clone());
                ctx.save()?;
                crate::events::stage("native_build", StageState::Passed, None, None);
                crate::events::stage("install_launch_ready", StageState::Running, None, None);
                run_reuse_path(ctx, &plan, ctx.runner.now_epoch_ms())?;
                return Ok(());
            }
            let (_, serial, server_port) = ctx
                .record
                .resources
                .adb_endpoint()
                .expect("android allocated");
            android::build_spec(&project_root, &serial, server_port, port, deadline)
        }
    };
    let build_log = RunRecord::run_dir(&ctx.runs_root, &ctx.record.run_id)
        .join("logs")
        .join("build.log");
    ensure_running(ctx.runner, "build")?;
    let spawned = ctx.runner.spawn_group(&spec, &build_log).map_err(|e| {
        Failure::new(
            "build",
            FailureCode::BuildFailed,
            format!("cannot spawn {}: {e}", spec.rendered()),
            "check pnpm/expo availability, run qaren cleanup, then retry prepare",
        )
    })?;
    let identity = capture_pid_identity(ctx.runner, spawned.pid);
    ctx.record.resources.metro = Some(MetroResource {
        port,
        endpoint: format!("http://127.0.0.1:{port}"),
        spawned,
        identity: identity.clone(),
        log: build_log.clone(),
    });
    ctx.record.phase = Phase::Building;
    ctx.save()?;
    if identity.is_none() {
        return Err(Failure::new(
            "build",
            FailureCode::BuildFailed,
            format!(
                "build process exited immediately; see {}",
                build_log.display()
            ),
            format!(
                "inspect the log, then qaren cleanup {} --json",
                ctx.record.run_id
            ),
        )
        .with_evidence(vec![super::log_tail(&build_log, 25)]));
    }
    wait_ready(ctx)
}

pub(crate) fn wait_ready(ctx: &mut Ctx) -> Result<(), Failure> {
    let deadline = ctx.runner.monotonic_ms() + ctx.record.scenario.deadlines.build_seconds * 1000;
    wait_ready_until(ctx, deadline, None)
}

const READY_TICK: Duration = Duration::from_secs(5);
const APP_DOWN_CONFIRMATIONS: u32 = 2;
// shortcut: on Android a PID still missing this long after am start counts as the exit; switch to am start -W if slow emulators need longer.
const ANDROID_FIRST_PID_GRACE_MS: u64 = 60_000;
// simctl launch returns before dyld finishes loading, so a first live PID must outlast it.
const IOS_LAUNCH_SETTLE: Duration = Duration::from_millis(1_250);

// Watches the launch qaren itself issued; a build-owned launch is not watched.
struct AppWatch {
    launched_ms: u64,
    launched_epoch_ms: u64,
    first_pid_grace_ms: u64,
    downs: u32,
}

enum Readiness {
    Ready(Option<u32>),
    // The watched app is alive but Metro is not ready yet.
    AppAlive,
    Pending,
    AppDown,
}

fn wait_ready_until(
    ctx: &mut Ctx,
    deadline: u64,
    mut watch: Option<AppWatch>,
) -> Result<(), Failure> {
    let metro_resource = ctx.record.resources.metro.clone().expect("metro spawned");
    let identity = metro_resource.identity.clone().expect("identity captured");
    loop {
        ensure_running(ctx.runner, "build")?;
        if probe_pid_identity(ctx.runner, &identity) == PidLiveness::Dead {
            return Err(Failure::new(
                "build",
                FailureCode::BuildFailed,
                format!(
                    "build/metro process exited; see {}",
                    metro_resource.log.display()
                ),
                format!(
                    "inspect the log, then qaren cleanup {} --json",
                    ctx.record.run_id
                ),
            )
            .with_evidence(vec![super::log_tail(&metro_resource.log, 25)]));
        }
        match ready_probes(ctx, &metro_resource, watch.is_some()) {
            Readiness::Ready(pid) => {
                let mut settled = true;
                if let (Some(mut launch), Some(pid)) = (watch.take(), pid) {
                    ctx.runner.sleep(IOS_LAUNCH_SETTLE);
                    let udid = ctx
                        .record
                        .resources
                        .ios_simulator
                        .clone()
                        .expect("ios allocated")
                        .udid;
                    let app_id = ctx.record.candidate.app_id.clone();
                    let launchctl = ctx.runner.run(&ios::launchctl_list_spec(&udid));
                    match launchctl
                        .ok()
                        .then(|| ios::app_pid_in_launchctl(&launchctl.stdout, &app_id))
                    {
                        Some(None) => {
                            launch.downs = 1;
                            watch = Some(launch);
                            settled = false;
                        }
                        Some(Some(now)) if now != pid => {
                            let since =
                                ctx.runner.monotonic_ms().saturating_sub(launch.launched_ms);
                            return Err(app_exited_failure(ctx, &launch, since));
                        }
                        Some(Some(_)) => {}
                        // An unreadable settle probe proves nothing; keep watching and settle again.
                        None => {
                            watch = Some(launch);
                            settled = false;
                        }
                    }
                }
                if settled {
                    ensure_running(ctx.runner, "build")?;
                    return Ok(());
                }
            }
            Readiness::AppDown => {
                if let Some(watch) = watch.as_mut() {
                    watch.downs += 1;
                    let since = ctx.runner.monotonic_ms().saturating_sub(watch.launched_ms);
                    if watch.downs >= APP_DOWN_CONFIRMATIONS && since >= watch.first_pid_grace_ms {
                        return Err(app_exited_failure(ctx, watch, since));
                    }
                }
            }
            Readiness::AppAlive => {
                if let Some(watch) = watch.as_mut() {
                    watch.downs = 0;
                }
            }
            Readiness::Pending => {}
        }
        if ctx.runner.monotonic_ms() >= deadline {
            return Err(Failure::new(
                "build",
                FailureCode::ReadyDeadlineExceeded,
                format!(
                    "readiness probes did not all pass within {}s; see {}",
                    ctx.record.scenario.deadlines.build_seconds,
                    metro_resource.log.display()
                ),
                format!(
                    "inspect the log, then qaren cleanup {} --json",
                    ctx.record.run_id
                ),
            )
            .with_evidence(vec![super::log_tail(&metro_resource.log, 25)]));
        }
        ctx.runner.sleep(READY_TICK);
    }
}

// A watched launch probes the app even while Metro is not ready, so a stalled Metro cannot hide its exit.
fn ready_probes(ctx: &mut Ctx, metro_resource: &MetroResource, watched: bool) -> Readiness {
    let port_output = ctx.runner.run(&metro::port_owner_spec(metro_resource.port));
    let port_ours = match metro::parse_port_owner(&port_output) {
        metro::PortOwners::Owned(pid) => {
            metro::pgid_of(ctx.runner, pid) == Some(metro_resource.spawned.pgid)
        }
        _ => false,
    };
    let metro_ready = port_ours && metro::metro_responding(ctx.runner, metro_resource.port);
    if !metro_ready && !watched {
        return Readiness::Pending;
    }
    let app_id = ctx.record.candidate.app_id.clone();
    let app = match ctx.record.scenario.platform {
        Platform::Ios => {
            let sim = ctx
                .record
                .resources
                .ios_simulator
                .clone()
                .expect("ios allocated");
            let container = ctx.runner.run(&ios::app_container_spec(&sim.udid, &app_id));
            if !container.ok() {
                return Readiness::Pending;
            }
            let launchctl = ctx.runner.run(&ios::launchctl_list_spec(&sim.udid));
            if !launchctl.ok() {
                Readiness::Pending
            } else if let Some(pid) = ios::app_pid_in_launchctl(&launchctl.stdout, &app_id) {
                Readiness::Ready(Some(pid))
            } else {
                Readiness::AppDown
            }
        }
        Platform::Android => {
            let Some((adb, serial, server_port)) = ctx.record.resources.adb_endpoint() else {
                return Readiness::Pending;
            };
            let installed =
                ctx.runner
                    .run(&android::pm_path_spec(&adb, server_port, &serial, &app_id));
            if !installed.ok() || !installed.stdout.contains("package:") {
                return Readiness::Pending;
            }
            let running = ctx
                .runner
                .run(&android::pidof_spec(&adb, server_port, &serial, &app_id));
            let pid = running
                .stdout
                .split_whitespace()
                .any(|t| t.parse::<u32>().is_ok());
            // pidof exits 1 with no output when no process matches; anything else is an adb fault.
            let no_process = !running.timed_out
                && (running.ok() || running.exit_code == Some(1))
                && running.stdout.trim().is_empty()
                && running.stderr.trim().is_empty();
            if running.ok() && pid {
                Readiness::Ready(None)
            } else if no_process {
                Readiness::AppDown
            } else {
                Readiness::Pending
            }
        }
    };
    match app {
        Readiness::Ready(_) if !metro_ready => Readiness::AppAlive,
        app => app,
    }
}

fn app_exited_failure(ctx: &mut Ctx, watch: &AppWatch, since_ms: u64) -> Failure {
    let app_id = ctx.record.candidate.app_id.clone();
    let mut detail = format!(
        "{app_id} was not running {}s after qaren launched it; the app exited instead of starting",
        since_ms / 1000
    );
    let retry = "then re-run";
    let next_action = match ctx.record.resources.ios_simulator.clone() {
        Some(sim) => {
            let reports = ctx
                .runner
                .env_var("HOME")
                .map(|home| Path::new(&home).join("Library/Logs/DiagnosticReports"));
            let since = std::time::UNIX_EPOCH
                + Duration::from_millis(watch.launched_epoch_ms.saturating_sub(5_000));
            let facts = reports
                .as_deref()
                .and_then(|dir| ios::recent_crash_facts(dir, &app_id, &sim.udid, since));
            match &facts {
                Some(facts) => {
                    let parts = [
                        facts.exception.as_ref().map(|e| format!("exception {e}")),
                        facts
                            .termination
                            .as_ref()
                            .map(|t| format!("termination {t}")),
                        facts
                            .missing_library
                            .as_ref()
                            .map(|l| format!("missing library {l}")),
                    ];
                    let parts: Vec<_> = parts.into_iter().flatten().collect();
                    detail.push_str(&format!("; crash report: {}", parts.join(", ")));
                }
                None => detail.push_str("; no crash report for this simulator was found"),
            }
            match facts
                .filter(|f| f.missing_library_embedded)
                .and_then(|f| f.missing_library)
                .filter(|l| l.ends_with(".framework"))
            {
                Some(library) => format!(
                    "the installed build cannot load {library}, which usually means an inconsistent CocoaPods install (for example prebuilt React Native pods mixed with source pods); delete ios/Pods and reinstall the pods, or run expo prebuild --clean for a generated ios dir, {retry}"
                ),
                None => format!(
                    "read the newest {app_id} crash report in ~/Library/Logs/DiagnosticReports, fix the crash, {retry}"
                ),
            }
        }
        None => format!("read adb logcat for the {app_id} crash, fix it, {retry}"),
    };
    // Failing with owned resources replaces next_action with cleanup, so the remedy rides in detail too.
    detail.push_str(&format!("; {next_action}"));
    Failure::new("build", FailureCode::AppExitedAtLaunch, detail, next_action)
}

fn ios_app_running(ctx: &mut Ctx, udid: &str, app_id: &str) -> bool {
    let launchctl = ctx.runner.run(&ios::launchctl_list_spec(udid));
    launchctl.ok() && ios::app_running_in_launchctl(&launchctl.stdout, app_id)
}

fn dry_run_receipt(
    runner: &mut dyn Runner,
    scenario: &Scenario,
    cand: &crate::candidate::Candidate,
    scenario_path: &Path,
    scenario_sha256: &str,
    run_id: &str,
    started_ms: u64,
    native_cache_root: &Path,
    borrowed: Option<&ios::Simulator>,
    boot_device: bool,
    sim_name: &str,
    pool_mode: bool,
) -> Result<Receipt, Failure> {
    let now = runner.now_epoch_ms();
    let mut receipt = Receipt::new(
        "prepare",
        run_id,
        ReceiptResult::Planned,
        "planned",
        timefmt::iso8601_utc(now),
    );
    receipt.scenario = Some(crate::receipt::ScenarioIdentity {
        name: scenario.name.clone(),
        platform: match scenario.platform {
            Platform::Ios => "ios".to_string(),
            Platform::Android => "android".to_string(),
        },
        path: scenario_path.to_path_buf(),
        sha256: scenario_sha256.to_string(),
    });
    receipt.candidate = Some(cand.clone());
    let platform = platform_dir(scenario.platform);
    // Handoff mode plans no build decision and no Metro/adb/build commands:
    // qaren stops at allocation and the qaren session owns the rest.
    if scenario.build.owner == BuildOwner::Qaren {
        let mut deps_args = vec!["install", "--frozen-lockfile"];
        if scenario.deps.policy == DepsPolicy::RequirePrewarm {
            deps_args.push("--offline");
        }
        let mut planned: Vec<CmdSpec> = vec![CmdSpec::new(
            "pnpm-install",
            "pnpm",
            &deps_args,
            scenario.deadlines.install_deps_seconds,
        )
        .registry_auth_env(&scenario.deps.registry_auth_env)];
        if scenario.platform == Platform::Ios {
            let ios_spec = scenario.ios.as_ref().expect("validated");
            planned.push(ios::create_spec(
                &ios::sim_name(run_id),
                &ios_spec.device_type,
                &ios_spec.runtime,
            ));
            planned.push(ios::bootstatus_spec(
                "<udid>",
                scenario.deadlines.device_boot_seconds,
            ));
        }
        receipt.planned_commands = planned.iter().map(|s| s.rendered()).collect();
        receipt
            .outcomes
            .insert("build_owner".to_string(), "qaren".to_string());
        receipt.outcomes.insert(
            "handoff".to_string(),
            "would be issued after allocation".to_string(),
        );
        receipt.commands_executed = runner.commands_executed();
        receipt
            .timings_ms
            .insert("total".to_string(), now.saturating_sub(started_ms));
        receipt.next_action =
            "re-run without --dry-run to allocate and issue the handoff".to_string();
        return Ok(receipt);
    }
    // The plan is read-only: the same fingerprint + cache-state decision the
    // real prepare would take, made visible without allocating anything.
    match fingerprint::compute(runner, &cand.repo_root, &cand.project_root, platform) {
        Ok(fp) => {
            let fp = fp.with_ios_workspace(scenario.build.ios_workspace.as_ref());
            let state = buildplan::load_state(&cand.repo_root, platform, &cand.app_id);
            let mut notes = Vec::new();
            let store = cached_artifact(
                native_cache_root,
                platform,
                &cand.app_id,
                &fp,
                &state,
                &mut notes,
            )?;
            receipt.outcomes.extend(notes);
            let inputs = buildplan::DecisionInputs {
                platform,
                app_id: &cand.app_id,
                worktree_root: &cand.repo_root,
                candidate_sha: &cand.git_sha,
                fingerprint: &fp.value,
                fingerprint_parts: &fp.parts,
                fingerprint_complete: fp.complete,
                incompleteness: &fp.incompleteness,
                expo_unavailable: fp.expo_unavailable.as_deref(),
                scheme: scenario.candidate.dev_client_scheme.as_deref(),
                force_clean: scenario.build.strategy == BuildStrategy::Clean,
                native_dir_exists: cand.project_root.join(platform).is_dir(),
                native_dir_in_candidate: fp.native_dir_in_candidate,
            };
            receipt.build = Some(buildplan::decide(&inputs, &state, store));
            receipt.outcomes.extend(fingerprint_notes(&fp));
        }
        Err(failure) => {
            receipt.outcomes.insert(
                "build_plan".to_string(),
                format!("unavailable: {}", failure.detail),
            );
        }
    }
    let port = qaren_metro_port(scenario);
    let deadlines = &scenario.deadlines;
    let mut deps_args = vec!["install", "--frozen-lockfile"];
    if scenario.deps.policy == DepsPolicy::RequirePrewarm {
        deps_args.push("--offline");
    }
    let mut planned: Vec<CmdSpec> = vec![CmdSpec::new(
        "pnpm-install",
        "pnpm",
        &deps_args,
        deadlines.install_deps_seconds,
    )
    .registry_auth_env(&scenario.deps.registry_auth_env)];
    let reuse = receipt
        .build
        .as_ref()
        .is_some_and(|p| p.decision == BuildDecision::Reuse);
    match scenario.platform {
        Platform::Ios => {
            let ios_spec = scenario.ios.as_ref().expect("validated");
            let udid = borrowed.map_or("<udid>", |sim| sim.udid.as_str());
            match borrowed {
                None => {
                    planned.push(ios::create_spec(
                        sim_name,
                        &ios_spec.device_type,
                        &ios_spec.runtime,
                    ));
                    planned.push(ios::bootstatus_spec(udid, deadlines.device_boot_seconds));
                }
                Some(sim) if boot_device && sim.state == ios::SimState::Shutdown => {
                    planned.push(ios::bootstatus_spec(udid, deadlines.device_boot_seconds));
                }
                Some(_) => {}
            }
            if pool_mode {
                receipt.outcomes.insert(
                    "device_pool".to_string(),
                    match borrowed {
                        Some(sim) => format!("would reuse {}", sim.udid),
                        None => format!("would create {sim_name}"),
                    },
                );
                if borrowed.is_some() {
                    planned.push(ios::uninstall_app_spec(udid, &cand.app_id));
                    planned.push(ios::keychain_reset_spec(udid));
                }
            }
            if let Some(sim) = borrowed {
                receipt.device = Some(crate::receipt::DeviceIdentity {
                    ios_udid: Some(sim.udid.clone()),
                    ios_name: Some(sim.name.clone()),
                    ios_device_type: Some(sim.device_type.clone()),
                    ios_runtime: Some(sim.runtime.clone()),
                    ..Default::default()
                });
            }
            planned.push(metro::start_spec(&cand.project_root, port));
            planned.push(ios::build_spec(
                &cand.project_root,
                Path::new("<run_dir>/ios-build"),
                deadlines.build_seconds,
                scenario.build.ios_workspace.as_ref(),
            ));
            planned.push(ios::install_app_spec(
                udid,
                Path::new("<run_dir>/ios-build/<verified-app>.app"),
            ));
            planned.push(metro::request_probe_spec(port));
            planned.push(metro::manifest_spec(port, "ios"));
            planned.extend(ios::lane_read_specs(udid));
            planned.extend(ios::devmenu_defaults_specs(udid, &cand.app_id));
            planned.push(ios::launch_spec(udid, &cand.app_id, port));
            planned.push(ios::app_container_spec(udid, &cand.app_id));
            planned.push(ios::launchctl_list_spec(udid));
        }
        Platform::Android if scenario.android_usb.is_some() => {
            let usb = scenario.android_usb.as_ref().expect("checked");
            let usb_adb_server_port = usb
                .adb_server_port
                .expect("validated qaren-owned usb scenario");
            planned.push(android::usb_adb_server_spec(
                Path::new("<android_home>/platform-tools/adb"),
                usb_adb_server_port,
                &usb.serial,
                Path::new("<home>/.android/adbkey"),
            ));
            planned.push(android::adb_get_state_spec(
                Path::new("<android_home>/platform-tools/adb"),
                usb_adb_server_port,
                &usb.serial,
            ));
            planned.push(android::build_spec(
                &cand.project_root,
                &usb.serial,
                usb_adb_server_port,
                port,
                deadlines.build_seconds,
            ));
        }
        Platform::Android => {
            let android_spec = scenario.android.as_ref().expect("validated");
            let holder = android::holder(run_id);
            planned.push(android::farm_status_spec(
                &android_spec.ssh_host,
                &android_spec.farm_path,
            ));
            planned.push(android::farm_start_spec(
                &android_spec.ssh_host,
                &android_spec.farm_path,
                android_spec.slot,
                &holder,
                deadlines.device_boot_seconds,
            ));
            planned.push(android::tunnel_spec(&android_spec.ssh_host, 0));
            planned.push(android::fetch_adbkey_spec(&android_spec.ssh_host));
            planned.push(android::adb_server_spec(
                Path::new("<android_home>/platform-tools/adb"),
                android_spec.adb_server_port,
                "127.0.0.1:<adb_port>",
                Path::new("<run_dir>/nuc-adbkey"),
            ));
            planned.push(android::adb_connect_spec(
                Path::new("<android_home>/platform-tools/adb"),
                android_spec.adb_server_port,
                "127.0.0.1:<adb_port>",
            ));
            planned.push(android::adb_get_state_spec(
                Path::new("<android_home>/platform-tools/adb"),
                android_spec.adb_server_port,
                "127.0.0.1:<adb_port>",
            ));
            planned.push(android::build_spec(
                &cand.project_root,
                "127.0.0.1:<adb_port>",
                android_spec.adb_server_port,
                port,
                deadlines.build_seconds,
            ));
        }
    }
    if receipt
        .build
        .as_ref()
        .is_some_and(|plan| plan.decision == BuildDecision::Clean && plan.regenerate_native_dir)
    {
        let compile = planned
            .iter()
            .position(|spec| {
                matches!(
                    spec.label.as_str(),
                    "expo-run-ios" | "xcodebuild-ios" | "expo-run-android"
                )
            })
            .expect("every platform build plan contains a compilation command");
        let preparation = if scenario.platform == Platform::Ios {
            planned
                .iter()
                .position(|spec| spec.label == "expo-start")
                .expect("iOS starts Metro before compilation")
        } else {
            compile
        };
        planned.insert(
            preparation,
            native_prebuild_spec(
                &cand.project_root,
                platform,
                deadlines.build_seconds,
                &scenario.deps.registry_auth_env,
            ),
        );
    }
    // Reuse installs the cached binary instead of compiling.
    if reuse {
        let artifact_path = receipt
            .build
            .as_ref()
            .and_then(|p| p.artifact.as_ref())
            .map(|a| a.path.clone())
            .unwrap_or_else(|| PathBuf::from("<cached-artifact>"));
        let scheme = scenario
            .candidate
            .dev_client_scheme
            .as_deref()
            .unwrap_or("<scheme>");
        let url = devclient::launch_url(scheme, port);
        planned.retain(|c| {
            !matches!(
                c.label.as_str(),
                "expo-run-ios"
                    | "xcodebuild-ios"
                    | "expo-run-android"
                    | "simctl-install"
                    | "simctl-launch"
                    | "expo-start"
                    | "metro-request-probe"
                    | "metro-manifest"
                    | "simctl-lane-read"
                    | "simctl-devmenu-defaults"
                    | "simctl-app-container"
                    | "simctl-launchctl"
            )
        });
        match scenario.platform {
            Platform::Ios => {
                let udid = borrowed.map_or("<udid>", |sim| sim.udid.as_str());
                planned.push(metro::start_spec(&cand.project_root, port));
                planned.push(ios::install_app_spec(udid, &artifact_path));
                planned.push(metro::request_probe_spec(port));
                planned.push(metro::manifest_spec(port, "ios"));
                planned.extend(ios::lane_read_specs(udid));
                planned.extend(ios::devmenu_defaults_specs(udid, &cand.app_id));
                planned.push(ios::launch_spec(udid, &cand.app_id, port));
                planned.push(ios::app_container_spec(udid, &cand.app_id));
                planned.push(ios::launchctl_list_spec(udid));
            }
            Platform::Android => {
                let adb = Path::new("<android_home>/platform-tools/adb");
                let (serial, server_port) = match (&scenario.android_usb, &scenario.android) {
                    (Some(usb), _) => (
                        usb.serial.clone(),
                        usb.adb_server_port
                            .expect("validated qaren-owned usb scenario"),
                    ),
                    (None, Some(farm)) => {
                        ("127.0.0.1:<adb_port>".to_string(), farm.adb_server_port)
                    }
                    (None, None) => unreachable!("validated android scenario"),
                };
                planned.push(android::adb_install_spec(
                    adb,
                    server_port,
                    &serial,
                    &artifact_path,
                ));
                planned.push(android::adb_reverse_spec(adb, server_port, &serial, port));
                planned.push(metro::start_spec(&cand.project_root, port));
                planned.push(metro::manifest_spec(port, "android"));
                planned.push(android::am_start_deeplink_spec(
                    adb,
                    server_port,
                    &serial,
                    &url,
                    &cand.app_id,
                ));
            }
        }
    }
    // The tunnel port comes from farm status at allocate time; render the
    // placeholder instead of the literal 0 used to build the spec.
    receipt.planned_commands = planned
        .iter()
        .map(|s| {
            s.rendered().replace(
                "127.0.0.1:0:127.0.0.1:0",
                "127.0.0.1:<adb_port>:127.0.0.1:<adb_port>",
            )
        })
        .collect();
    receipt.commands_executed = runner.commands_executed();
    receipt.timings_ms.insert(
        "total".to_string(),
        runner.now_epoch_ms().saturating_sub(started_ms),
    );
    receipt.next_action = "re-run without --dry-run to allocate resources".to_string();
    Ok(receipt)
}

fn run_launch_command(
    ctx: &mut Ctx,
    spec: &CmdSpec,
    deadline: u64,
    attempts: &mut usize,
    receipt: &mut dyn FnMut(&mut Ctx) -> bool,
) -> Result<crate::exec::CmdOutput, Failure> {
    let mut last = None;
    while let Some(output) = run_budgeted_attempt(ctx, spec, deadline, attempts)? {
        // A launcher that outlives its bound may have started the app; never terminate it without this receipt.
        if !output.timed_out || receipt(ctx) {
            if output.timed_out {
                ctx.notes
                    .push(("launch_proof".into(), "launchctl-job".into()));
            }
            return Ok(output);
        }
        last = Some(output);
    }
    last.ok_or_else(|| launch_deadline_spent(&ctx.record.run_id))
}

fn launch_deadline_spent(run_id: &str) -> Failure {
    Failure::new(
        "build",
        FailureCode::ReadyDeadlineExceeded,
        "preparation deadline spent before dev-client launch",
        format!("run qaren cleanup {run_id} --json, then retry prepare"),
    )
}

// None once the shared preparation budget is spent; each attempt is recorded in the receipt.
fn run_budgeted_attempt(
    ctx: &mut Ctx,
    spec: &CmdSpec,
    deadline: u64,
    attempts: &mut usize,
) -> Result<Option<crate::exec::CmdOutput>, Failure> {
    ensure_running(ctx.runner, "build")?;
    let remaining_ms = deadline.saturating_sub(ctx.runner.monotonic_ms());
    // Command limits are whole seconds; do not start a call beyond the remaining budget.
    if remaining_ms < 1000 {
        ctx.runner.sleep(Duration::from_millis(remaining_ms));
        ensure_running(ctx.runner, "build")?;
        ctx.notes
            .push(("launch_ready_budget".into(), "spent".into()));
        return Ok(None);
    }
    let mut bounded = spec.clone();
    bounded.timeout_seconds = bounded.timeout_seconds.min(remaining_ms / 1000);
    let output = ctx.runner.run(&bounded);
    *attempts += 1;
    let label = format!("{}_attempt_{}", spec.label, attempts);
    ctx.timings.push((label.clone(), output.duration_ms));
    ctx.notes.push((
        label,
        format!(
            "{}; timeout_seconds={}",
            output.summary(),
            bounded.timeout_seconds
        ),
    ));
    ensure_running(ctx.runner, "build")?;
    Ok(Some(output))
}

// expo-dev-launcher abandons its first manifest fetch after EXDevLauncherDefaultRequestTimeout (10 s); launch only once Metro answers inside it.
const DEV_CLIENT_REQUEST_TIMEOUT_MS: u64 = 10_000;
// Metro rebuilds the manifest per request, so one fast answer does not predict the dev client's own.
const DEV_CLIENT_MANIFEST_MARGIN_MS: u64 = DEV_CLIENT_REQUEST_TIMEOUT_MS / 2;
const DEV_CLIENT_MANIFEST_ANSWERS: usize = 2;

// Consecutive manifest answers inside the margin; any other outcome restarts the count.
fn manifest_in_margin(in_margin: usize, warmed: &crate::exec::CmdOutput) -> usize {
    if warmed.ok() && warmed.duration_ms < DEV_CLIENT_MANIFEST_MARGIN_MS {
        in_margin + 1
    } else {
        0
    }
}

// A launch timeout or a too-slow answer is the CDP leg's environmental refusal; any other launch error stays a build failure.
fn launch_failure(
    what: &str,
    launched: &crate::exec::CmdOutput,
    load: Option<f64>,
    attempts: usize,
    run_id: &str,
) -> Failure {
    if !launched.ok() && !launched.timed_out {
        return Failure::new(
            "build",
            FailureCode::BuildFailed,
            format!("{what} failed: {}", launched.summary()),
            format!("run qaren cleanup {run_id} --json, then retry prepare"),
        );
    }
    let measured = match load {
        Some(load) => format!("host 1-minute load {load:.1}"),
        None => "host load unavailable".to_string(),
    };
    if launched.ok() {
        return Failure::new(
            "build",
            FailureCode::CoreRefused,
            format!(
                "{what} did not become ready within the preparation budget: last {}ms after {attempts} attempts ({measured}); an environment refusal",
                launched.duration_ms
            ),
            format!("run qaren cleanup {run_id} --json, then retry prepare"),
        );
    }
    let environment = format!("; an environment refusal after {attempts} attempts");
    Failure::new(
        "build",
        FailureCode::CoreRefused,
        format!(
            "{what} timed out: {} ({measured}{environment})",
            launched.summary()
        ),
        format!("run qaren cleanup {run_id} --json, then retry prepare"),
    )
}

#[cfg(test)]
mod launch_tests {
    use super::*;
    use crate::exec::CmdOutput;

    #[test]
    fn recording_a_build_releases_lock_before_retirement() {
        use std::os::unix::fs::DirBuilderExt;

        for workspace in [false, true] {
            let root = std::env::temp_dir().join(format!(
                "qaren-retirement-{}-{workspace}",
                std::process::id()
            ));
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&root)
                .unwrap();
            let root = root.canonicalize().unwrap();
            let mut scenario: Scenario =
                serde_yaml::from_str(include_str!("../../scenarios/ios-simulator.yaml")).unwrap();
            if workspace {
                scenario.build.ios_workspace = Some(crate::scenario::IosWorkspaceBuild {
                    workspace: "ios/App.xcworkspace".into(),
                    scheme: "App".into(),
                });
            }
            let mut record = RunRecord {
                schema: RUN_SCHEMA.into(),
                run_id: "retirement".into(),
                created_at: "2026-10-30T00:00:00Z".into(),
                scenario,
                scenario_path: root.join("scenario.yaml"),
                scenario_sha256: "0".repeat(64),
                candidate: candidate::Candidate {
                    repo_root: root.clone(),
                    project_root: root.join("test-app"),
                    app_id: "com.rndevagent.testapp".into(),
                    git_sha: "b".repeat(40),
                    git_dirty: false,
                    lockfile_sha256: None,
                    worktree_fingerprint: None,
                },
                phase: Phase::Building,
                substage: None,
                prepare: None,
                build: Some(BuildPlan {
                    decision: BuildDecision::Clean,
                    fingerprint: "rnfp1:test".into(),
                    reason: crate::redact::OutputText::from_output("test build"),
                    evidence: Vec::new(),
                    artifact: None,
                    regenerate_native_dir: false,
                }),
                handoff: None,
                resources: Default::default(),
                failure: None,
                history: Vec::new(),
                terminal: None,
                build_lock: None,
            };
            let run_dir = RunRecord::run_dir(&root, &record.run_id);
            let output = run_dir.join("ios-build");
            let app = output.join("testapp.app");
            let derived = run_dir.join("ios-derived-data");
            std::fs::create_dir_all(&app).unwrap();
            std::fs::write(app.join("binary"), b"native bits").unwrap();
            if workspace {
                std::fs::create_dir(&derived).unwrap();
                std::fs::write(derived.join("build-data"), b"derived bits").unwrap();
            }
            record.build.as_mut().unwrap().artifact = Some(CachedArtifact {
                sha256: buildplan::hash_artifact(&app).unwrap(),
                path: app.clone(),
                kind: ArtifactKind::AppBundle,
            });
            let mut runner = crate::exec::MockRunner::new();
            let lock_root = root.join("locks");
            let holder = LockHolder {
                holder: "retirement-holder".into(),
                run_id: record.run_id.clone(),
                identity: None,
                at: record.created_at.clone(),
                home: None,
                qaren_home: None,
                group: None,
            };
            assert!(matches!(
                buildplan::claim_lock(
                    &mut runner,
                    &lock_root,
                    "ios-build",
                    &holder,
                    LockPolicy::Strict
                ),
                LockOutcome::Claimed { .. }
            ));
            let lock_dir = buildplan::lock_dir(&lock_root, "ios-build");
            record.resources.build_lock = Some(BuildLockResource {
                lock_dir: lock_dir.clone(),
                holder: holder.holder,
            });
            let mut ctx = Ctx {
                runner: &mut runner,
                runs_root: root.clone(),
                native_cache_root: root.join("native-store"),
                native_store_entry: None,
                record,
                started_ms: 0,
                timings: Vec::new(),
                notes: Vec::new(),
                verb: "prepare",
                bundle_requests_at_launch: None,
                manifest_warm: None,
                lane_owned: false,
                build_deadline_ms: None,
            };
            ctx.save().unwrap();
            let fp = NativeFingerprint {
                value: "rnfp1:test".into(),
                file_count: 1,
                native_dir_in_candidate: false,
                complete: true,
                incompleteness: Vec::new(),
                parts: Default::default(),
                expo_fingerprint_ms: None,
                expo_unavailable: None,
            };
            let retirement = record_build_result(&mut ctx, &fp).unwrap();
            assert!(retirement.is_some(), "{:?}", ctx.notes);
            assert!(lock_dir.is_dir());
            assert!(app.is_dir());
            finish_ios_build(&mut ctx, Ok(retirement), |ctx, source| {
                assert!(!lock_dir.exists());
                assert!(ctx.record.resources.build_lock.is_none());
                let saved = RunRecord::load(&root, "retirement").unwrap();
                assert!(saved.resources.build_lock.is_none());
                let cached = saved.build.unwrap().artifact.unwrap();
                assert_ne!(cached.path, app);
                assert!(cached.path.is_dir());
                assert!(output.is_dir());
                retire_ios_build_output(ctx, source)
            })
            .unwrap();
            assert!(!output.exists());
            assert!(!derived.exists());
            std::fs::remove_dir_all(&root).unwrap();
        }
    }

    #[test]
    fn artifact_install_failure_distinguishes_invalid_artifact_timeout_and_install_error() {
        let app_bundle = CachedArtifact {
            path: PathBuf::from("/store/ios/fp/build/testapp.app"),
            sha256: "a".repeat(64),
            kind: ArtifactKind::AppBundle,
        };
        let apk = CachedArtifact {
            path: PathBuf::from(
                "/repo/.qaren/native-cache/artifacts/android/app-fp/run/app-debug.apk",
            ),
            sha256: "b".repeat(64),
            kind: ArtifactKind::Apk,
        };

        let invalid_ios = artifact_install_failure(
            "check-1",
            &app_bundle,
            "artifact changed before install".into(),
            ArtifactInstallFailure::ArtifactInvalid,
        );
        assert_eq!(invalid_ios.code, FailureCode::ArtifactInstallFailed);
        assert!(invalid_ios
            .detail
            .contains("(artifact-invalid): artifact changed before install"));
        assert_eq!(
            invalid_ios.next_action.as_str(),
            "delete the machine store entry /store/ios/fp to force a rebuild, then qaren cleanup check-1 --json and re-run prepare"
        );

        let invalid_apk = artifact_install_failure(
            "check-1",
            &apk,
            "artifact changed before install".into(),
            ArtifactInstallFailure::ArtifactInvalid,
        );
        assert_eq!(invalid_apk.code, FailureCode::ArtifactInstallFailed);
        assert!(invalid_apk
            .detail
            .contains("(artifact-invalid): artifact changed before install"));
        assert_eq!(
            invalid_apk.next_action.as_str(),
            "delete the cached artifact to force a rebuild, then qaren cleanup check-1 --json and re-run prepare"
        );

        for artifact in [&app_bundle, &apk] {
            for (cause, label, summary) in [
                (
                    ArtifactInstallFailure::InstallTimeout,
                    "install-timeout",
                    "[private output withheld]",
                ),
                (
                    ArtifactInstallFailure::InstallFailed,
                    "install-failed",
                    "[private output withheld]",
                ),
            ] {
                let failure = artifact_install_failure("check-1", artifact, summary.into(), cause);
                assert_eq!(failure.code, FailureCode::ArtifactInstallFailed);
                assert!(
                    failure
                        .detail
                        .contains(&format!("({label}): [private output withheld]")),
                    "{}",
                    failure.detail
                );
                assert!(
                    failure.next_action.contains("keep the cached artifact"),
                    "{}",
                    failure.next_action
                );
                assert!(
                    failure
                        .next_action
                        .contains("run qaren cleanup check-1 --json"),
                    "{}",
                    failure.next_action
                );
                assert!(
                    failure.next_action.contains(
                        "inspect the target device, package service, and transport state"
                    ),
                    "{}",
                    failure.next_action
                );
                for forbidden in ["delete", "rebuild", "re-run"] {
                    assert!(
                        !failure.next_action.contains(forbidden),
                        "{forbidden} in {}",
                        failure.next_action
                    );
                }
            }
        }
    }

    fn timed_out() -> CmdOutput {
        CmdOutput {
            timed_out: true,
            duration_ms: 60_058,
            ..Default::default()
        }
    }

    #[test]
    fn a_launch_timeout_refuses_with_diagnostic_load_only() {
        for (load, measured) in [
            (Some(256.0), "host 1-minute load 256.0"),
            (Some(2.0), "host 1-minute load 2.0"),
            (None, "host load unavailable"),
        ] {
            let failure = launch_failure("dev client launch", &timed_out(), load, 2, "check-1");
            assert_eq!(failure.code, FailureCode::CoreRefused);
            assert!(failure.code.is_refusal());
            let detail = failure.detail.to_string();
            assert!(detail.contains(measured), "{detail}");
            assert!(
                detail.contains("an environment refusal after 2 attempts"),
                "{detail}"
            );
            assert!(!detail.contains("envelope"), "{detail}");
            assert_eq!(
                failure.next_action.to_string(),
                "run qaren cleanup check-1 --json, then retry prepare"
            );
        }
    }

    #[test]
    fn an_unanswered_manifest_is_refused_like_a_launch() {
        let slow = launch_failure("dev client manifest", &timed_out(), Some(40.0), 1, "c");
        assert_eq!(slow.code, FailureCode::CoreRefused);
        let detail = slow.detail.to_string();
        assert!(
            detail.starts_with("dev client manifest timed out"),
            "{detail}"
        );
        assert!(detail.contains("an environment refusal"), "{detail}");
        let broken = launch_failure(
            "dev client manifest",
            &CmdOutput::failed(22, "HTTP 500"),
            None,
            1,
            "c",
        );
        assert_eq!(broken.code, FailureCode::BuildFailed);
        assert!(broken
            .detail
            .to_string()
            .starts_with("dev client manifest failed"));
        let late = CmdOutput {
            duration_ms: 11_573,
            ..CmdOutput::success("")
        };
        let late = launch_failure("dev client manifest", &late, Some(40.0), 3, "c");
        assert_eq!(late.code, FailureCode::CoreRefused);
        let detail = late.detail.to_string();
        assert!(
            detail.starts_with(
                "dev client manifest did not become ready within the preparation budget"
            ),
            "{detail}"
        );
        assert!(detail.contains("last 11573ms after 3 attempts"), "{detail}");
        assert!(detail.contains("host 1-minute load 40.0"), "{detail}");
        assert!(detail.contains("an environment refusal"), "{detail}");
    }

    #[test]
    fn a_real_launch_error_stays_a_build_failure() {
        let failure = launch_failure(
            "dev client launch",
            &CmdOutput::failed(1, "no such app"),
            Some(65.0),
            1,
            "check-1",
        );
        assert_eq!(failure.code, FailureCode::BuildFailed);
        assert!(failure
            .detail
            .to_string()
            .contains("dev client launch failed"));
    }
}
