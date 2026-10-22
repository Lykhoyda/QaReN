use crate::adapters::{android, devclient, ios, metro};
use crate::buildplan::{
    self, ArtifactKind, ArtifactStatus, BuildDecision, BuildPlan, CachedArtifact, LockHolder,
    LockOutcome, LockPolicy, StateStatus, StoreRecord,
};
use crate::cancel::ensure_running;
use crate::candidate;
use crate::events::StageState;
use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::fingerprint::{self, NativeFingerprint};
use crate::handoff::{self, ExpectedReceipt, HandoffDocument, HandoffState, HANDOFF_SCHEMA};
use crate::pool::{self, PoolMember};
use crate::receipt::{Receipt, ReceiptResult};
use crate::redact::redact_secrets;
use crate::runrecord::{
    capture_pid_identity, probe_pid_identity, AppInstallResource, BuildLockResource, FarmResource,
    IosSimResource, MetroResource, Phase, PidLiveness, RunRecord, TunnelResource,
    UsbDeviceResource, RUN_SCHEMA,
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
        failure = ensure_running(self.runner, &failure.phase)
            .err()
            .unwrap_or(failure);
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
        if self.record.resources.any_owned() && failure.code != FailureCode::ArtifactInstallFailed {
            failure.next_action = crate::redact::OutputText::from_output(&format!(
                "qaren cleanup {} --json",
                self.record.run_id
            ));
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
    for (name, value) in &ctx.notes {
        receipt.outcomes.insert(name.clone(), value.clone());
    }
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
    .then_some(POOL_FALLBACK);
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
        let mut dry_outcome = pool_fallback.map(str::to_string);
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
                    return Err(pool_refusal(scan, pool_cap, &[]))
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
        pool_fallback = Some(POOL_IDENTITY_FALLBACK);
    }
    if selected.is_some() && identity.is_none() {
        // Like check's run-directory claim, an unrecorded claim is dropped on refusal.
        let _ = std::fs::remove_dir_all(&run_dir);
        return Err(Failure::new(
            "lease",
            FailureCode::OwnershipUnproven,
            "this prepare process's birth identity could not be proven, so it cannot hold a device lease",
            if pool_scan.is_some() {
                "ensure ps can read this process's start time, then re-run, or pass --new for a temporary simulator"
            } else {
                "ensure ps can read this process's start time, then re-run"
            },
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
                Err(pool_refusal(scan, pool_cap, &occupied))
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
        ctx.notes
            .push(("device_pool".to_string(), fallback.to_string()));
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
    let borrowed_admission = |ctx: &mut Ctx| {
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
        )
    };
    // A pool member is QaReN's to boot; a --device target only with --boot-device.
    let may_boot = args.boot_device || pool_claimed;
    if selected.is_some() || pool_claimed {
        // Recovery may have changed the target; the pre-lease observation is not authority.
        if let Err(f) =
            reprove_borrowed_ios(&mut ctx, may_boot).and_then(|_| borrowed_admission(&mut ctx))
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
        if let Err(f) = borrowed_admission(&mut ctx) {
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

    if plan.decision != BuildDecision::Reuse {
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

    if plan.decision != BuildDecision::Reuse {
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
fn allocate_ios(ctx: &mut Ctx, pool: Option<(&Path, &Path)>) -> Result<(), Failure> {
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
        let refusal = match scan_pool(ctx.runner, pool_root, &ios, true) {
            Err(f) => Some(f),
            Ok(scan) if scan.present.len() as u32 >= cap => Some(pool_refusal(&scan, cap, &[])),
            Ok(_) => None,
        };
        if let Some(f) = refusal {
            release_pool_create_lock(ctx);
            return Err(f);
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

fn pool_refusal(scan: &PoolScan, cap: u32, occupied: &[String]) -> Failure {
    let raise = "raise ios.max_devices, or pass --new for a temporary simulator";
    if scan.candidates.is_empty() {
        let members: Vec<String> = scan
            .present
            .iter()
            .map(|m| format!("{} ({}, {}, {})", m.udid, m.name, m.device_type, m.runtime))
            .collect();
        return Failure::new(
            "device",
            FailureCode::DeviceUnavailable,
            format!(
                "the QaReN simulator pool is at ios.max_devices {cap} and no member matches the scenario's device type and runtime: {}",
                members.join("; ")
            ),
            format!("delete an unused member with `xcrun simctl delete <UDID>`, {raise}"),
        );
    }
    let detail = if occupied.is_empty() {
        "no member is free".to_string()
    } else {
        occupied.join("; ")
    };
    Failure::new(
        "device",
        FailureCode::DeviceBusy,
        format!("the QaReN simulator pool is at ios.max_devices {cap} and every matching member is occupied: {detail}"),
        format!("wait for or clean up the holding run, {raise}"),
    )
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
