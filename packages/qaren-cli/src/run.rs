use crate::adapters::{android, ios};
use crate::buildplan::BuildDecision;
use crate::cancel::ensure_running;
use crate::candidate::{self, sha256_hex};
use crate::commands::cleanup::{
    cleanup_core, cleanup_process_group, release_lease_outcome, retained_lease_outcome,
    unclean_legs, Outcome,
};
use crate::commands::prepare::{self, finish_receipt, Ctx, FailureCodeStr};
use crate::config::CheckConfig;
use crate::core::{self, Budgets, CoreRequest, CoreTarget, Verdict};
use crate::events::{self, StageState};
use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::github::{self, PrInfo};
use crate::lease;
use crate::publish::PrRunRecord;
use crate::receipt::{Receipt, ReceiptResult};
use crate::recipes;
use crate::record::{self, VideoStatus};
use crate::report::{self, ReportInput};
use crate::runrecord::{
    capture_pid_identity, BorrowedEmulatorResource, FinalVerification, IosSimResource, Phase,
    PrWorktreeResource, Resources, RunRecord, TerminalResult, RUN_SCHEMA,
};
use crate::scenario::{
    is_emulator_serial, AndroidEmulatorSpec, BuildSpec, CandidateSpec, DepsSpec, IosSpec,
    MetroSpec, Platform, Scenario, SCENARIO_SCHEMA,
};
use crate::timefmt;
use crate::worktree;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const DEFAULT_WALK_SECONDS: u64 = 1200;
// Seven 150s judgment schedules during scroll-until, plus 150s for screen work.
pub const DEFAULT_STEP_SECONDS: u64 = 1200;
const MIN_FREE_DISK_KB: u64 = 1024 * 1024;
// One measured cold iOS build (DerivedData, Pods, CocoaPods and native caches) used about 8 GiB.
pub(crate) const CLEAN_IOS_BUILD_FREE_KB: u64 = 10 * 1024 * 1024;

// `check` borrows a simulator against the working tree at project_root.
pub struct RunRequest {
    pub project_root: PathBuf,
    pub config_path: PathBuf,
    pub plan_file: PathBuf,
    pub platform: Platform,
    // None borrows the only booted simulator; lifecycle flags require an exact UDID.
    pub device: Option<String>,
    pub boot_device: bool,
    pub restart_device: bool,
    pub shutdown_device_on_exit: bool,
    pub fresh_install: bool,
    pub runtime_dir: PathBuf,
    pub node: Option<PathBuf>,
    pub lock_root: PathBuf,
    pub runs_root: PathBuf,
    pub native_cache_root: PathBuf,
    pub android_home: Option<String>,
    pub budgets: Budgets,
    // `qaren pr`: the run happens on a detached worktree at this PR's head.
    pub pr: Option<PrTarget>,
}

// The core runtime: QAREN_RUNTIME, else the installed <exe>/../runtime, else the source checkout.
pub fn default_runtime_dir() -> PathBuf {
    runtime_dir_from(
        std::env::var_os("QAREN_RUNTIME"),
        std::env::current_exe().ok(),
    )
}

pub fn runtime_dir_from(explicit: Option<std::ffi::OsString>, exe: Option<PathBuf>) -> PathBuf {
    if let Some(explicit) = explicit.filter(|value| !value.is_empty()) {
        return PathBuf::from(explicit);
    }
    // macOS current_exe() returns a PATH symlink itself, not the installed binary.
    let exe = exe.map(|exe| exe.canonicalize().unwrap_or(exe));
    let Some(bin_dir) = exe.as_deref().and_then(|exe| exe.parent()) else {
        return PathBuf::from("packages/qaren-core/dist");
    };
    let installed = bin_dir.join("../runtime");
    if installed.join("qa").join("walk.js").is_file() {
        return installed.canonicalize().unwrap_or(installed);
    }
    let checkout = bin_dir.join("../../../qaren-core/dist");
    checkout.canonicalize().unwrap_or(checkout)
}

pub fn resolve_node_for_record(record: &RunRecord) -> PathBuf {
    std::env::var_os("QAREN_NODE")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            CheckConfig::load(&record.scenario_path)
                .ok()
                .and_then(|(cfg, _)| cfg.node_path)
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| PathBuf::from("node"))
}

pub struct PrTarget {
    pub target: String,
}

struct PrState {
    info: PrInfo,
    repo_root: PathBuf,
    app_rel: String,
}

struct Device {
    id: String,
    name: String,
    ios: Option<(String, String)>,
    android: Option<BorrowedEmulatorResource>,
    needs_boot: bool,
}

fn platform_str(platform: Platform) -> &'static str {
    match platform {
        Platform::Ios => "ios",
        Platform::Android => "android",
    }
}

pub fn validate_boot_device(
    platform: Platform,
    device: Option<&str>,
    boot_device: bool,
    restart_device: bool,
    shutdown_device_on_exit: bool,
) -> Result<(), Failure> {
    if !boot_device && !restart_device && !shutdown_device_on_exit {
        return Ok(());
    }
    for (enabled, flag) in [
        (boot_device, "--boot-device"),
        (restart_device, "--restart-device"),
        (shutdown_device_on_exit, "--shutdown-device-on-exit"),
    ] {
        if !enabled {
            continue;
        }
        if platform != Platform::Ios {
            return Err(Failure::new(
                "device",
                FailureCode::PlatformUnsupported,
                format!("{flag} is only valid for check on iOS"),
                "use --platform ios with an explicit --device UUID",
            ));
        }
    }
    if boot_device && restart_device {
        return Err(Failure::new(
            "device",
            FailureCode::DeviceUnavailable,
            "--boot-device and --restart-device are redundant; --restart-device already boots the selected simulator",
            "pass --restart-device without --boot-device, or pass --boot-device alone",
        ));
    }
    for (enabled, flag) in [
        (boot_device, "--boot-device"),
        (restart_device, "--restart-device"),
        (shutdown_device_on_exit, "--shutdown-device-on-exit"),
    ] {
        if enabled && device.and_then(ios::canonical_udid).is_none() {
            return Err(Failure::new(
                "device",
                FailureCode::DeviceUnavailable,
                format!("{flag} requires --device with an exact iOS simulator UUID"),
                "pass the selected simulator UUID, not a name or booted alias",
            ));
        }
    }
    Ok(())
}

pub fn run(runner: &mut dyn Runner, req: &RunRequest) -> Receipt {
    let inputs = crate::redact::capture_input_scope()
        .unwrap_or_else(|| std::sync::Arc::new(crate::redact::InputValues::capture()));
    crate::redact::with_input_scope(inputs, || run_scoped(runner, req))
}

fn run_scoped(runner: &mut dyn Runner, req: &RunRequest) -> Receipt {
    let started_ms = runner.now_epoch_ms();
    let mut preflight_jev = None;
    // A PR worktree created before the run record owns it; removed here if the run never got that far.
    let mut unowned_worktree = None;
    let mut receipt = match run_inner(
        runner,
        req,
        started_ms,
        &mut preflight_jev,
        &mut unowned_worktree,
    ) {
        Ok(receipt) => receipt,
        Err(failure) => {
            let failure = ensure_running(runner, &failure.phase)
                .err()
                .unwrap_or(failure);
            events::close_running(StageState::Failed, Some(&failure.code_str()), &[]);
            let result = if failure.code.is_refusal() {
                ReceiptResult::Refused
            } else {
                ReceiptResult::Failed
            };
            let mut receipt = Receipt::new(
                verb(req),
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
    };
    if let Some((repo_root, wt)) = unowned_worktree {
        let outcome = worktree::remove(runner, &repo_root, &wt);
        receipt
            .cleanup
            .insert("pr_worktree".to_string(), outcome.render());
        receipt.commands_executed = runner.commands_executed();
    }
    receipt.preflight_jev = preflight_jev;
    receipt
}

fn verb(req: &RunRequest) -> &'static str {
    if req.pr.is_some() {
        "pr"
    } else {
        "check"
    }
}

fn pr_failure(detail: String) -> Failure {
    Failure::new(
        "pr",
        FailureCode::PrWorktreeFailed,
        detail,
        "re-run qaren pr; the worktree must hold exactly the pull request head",
    )
}

// Failures before the run record exists come back as Err; everything after is
// folded into the record and torn down so nothing outlives the run.
fn run_inner(
    runner: &mut dyn Runner,
    req: &RunRequest,
    started_ms: u64,
    preflight_jev: &mut Option<core::JevRollup>,
    unowned_worktree: &mut Option<(PathBuf, PathBuf)>,
) -> Result<Receipt, Failure> {
    events::stage("preflight", StageState::Running, None, None);
    validate_boot_device(
        req.platform,
        req.device.as_deref(),
        req.boot_device,
        req.restart_device,
        req.shutdown_device_on_exit,
    )?;
    let (config, config_raw) = CheckConfig::load(&req.config_path)?;
    config.validate_for_platform(req.platform)?;
    if req.platform == Platform::Ios {
        if let Some(workspace) = config.ios.as_ref().and_then(|ios| ios.build.as_ref()) {
            ios::validate_workspace(&req.project_root, workspace)?;
        }
    }
    let node = req
        .node
        .clone()
        .or_else(|| config.node_path.as_ref().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("node"));
    preflight_node(runner, &node)?;
    let plan = read_plan(&req.plan_file)?;
    let mut prepared_pr = None;
    let login_source = if let Some(target) = &req.pr {
        let (repo_root, app_rel) = locate_worktree(runner, &req.project_root)?;
        let info = github::pr_view(runner, &target.target, &repo_root)?;
        worktree::fetch_head(runner, &repo_root, &info)?;
        let content = match config.login_block.as_deref() {
            Some(slug) => {
                worktree::login_at_head(runner, &repo_root, &info.head_ref_oid, &app_rel, slug)?
            }
            None => None,
        };
        prepared_pr = Some(PrState {
            info,
            repo_root,
            app_rel,
        });
        serde_json::json!({ "kind": "git", "content": content })
    } else {
        serde_json::json!({ "kind": "owned", "appRoot": app_root_for(&req.config_path, &req.project_root)? })
    };
    let inventory = input_inventory(
        runner,
        &node,
        &req.runtime_dir,
        &plan,
        &req.plan_file,
        &config,
        req.platform,
        &login_source,
    )?;
    let names = inventory_names(&inventory)?;
    // A pull request's login block may only use inputs the owner's plan or login block declares.
    if req.pr.is_some() && config.login_block.is_some() {
        let owned = serde_json::json!({ "kind": "owned", "appRoot": app_root_for(&req.config_path, &req.project_root)? });
        let owner_inventory = input_inventory(
            runner,
            &node,
            &req.runtime_dir,
            &plan,
            &req.plan_file,
            &config,
            req.platform,
            &owned,
        )?;
        let declared = inventory_names(&owner_inventory)?;
        let undeclared: Vec<_> = names
            .iter()
            .filter(|name| !declared.contains(name))
            .cloned()
            .collect();
        if !undeclared.is_empty() {
            return Err(Failure::new(
                "preflight",
                FailureCode::PlanInputMissing,
                format!(
                    "the pull request's login block names runtime inputs the owner's plan and login block do not declare: {}",
                    crate::redact::redact_inputs(&undeclared.join(", "))
                ),
                "declare these inputs in the plan or the checked-out login block, or remove them from the pull request's login block",
            ));
        }
        let candidate_non_secret = non_secret_names(&inventory, &names)?;
        let owner_non_secret = non_secret_names(&owner_inventory, &declared)?;
        if names
            .iter()
            .any(|name| candidate_non_secret.contains(name) != owner_non_secret.contains(name))
        {
            return Err(input_refused());
        }
    }
    let input_owner = crate::redact::capture_input_scope().expect("run input scope");
    let resolved_inputs = input_owner.admit(&names)?;
    let login_snapshot = inventory.get("loginSnapshot").cloned();
    let prepared = preflight_inputs(
        runner,
        &node,
        &req.runtime_dir,
        &plan,
        &req.plan_file,
        &config,
        req.platform,
        &inventory,
        &resolved_inputs,
        preflight_jev,
    )?;
    // The parser read the file by path; the walk must use the bytes that passed.
    if read_plan(&req.plan_file)? != plan {
        return Err(Failure::new(
            "preflight",
            FailureCode::PlanUnparseable,
            format!(
                "{} changed while it was being validated",
                req.plan_file.display()
            ),
            "leave the plan file alone during the run, then re-run",
        ));
    }
    if req.pr.is_none()
        && config.login_block.is_some()
        && input_inventory(
            runner,
            &node,
            &req.runtime_dir,
            &plan,
            &req.plan_file,
            &config,
            req.platform,
            &login_source,
        )? != inventory
    {
        return Err(input_refused());
    }
    let mut device = resolve_device(
        runner,
        req.platform,
        req.device.as_deref(),
        req.boot_device || req.restart_device,
        req.shutdown_device_on_exit,
        req.android_home.as_deref(),
    )?;
    let android_env = device.android.as_ref().map(|emulator| core::AndroidEnv {
        serial: emulator.serial.clone(),
        server_port: emulator.server_port,
        platform_tools: android::adb_path(req.android_home.as_deref().unwrap_or_default())
            .parent()
            .expect("adb lives in platform-tools")
            .to_path_buf(),
    });
    let mut run_id = format!("check-{}", timefmt::compact_utc(started_ms));
    let mut run_dir = RunRecord::run_dir(&req.runs_root, &run_id);
    let mut run_claim = None;
    let mut project_root = req.project_root.clone();
    let mut pr_state = None;
    if let Some(pr) = prepared_pr {
        let PrState {
            info,
            repo_root,
            app_rel,
        } = pr;
        let claim = claim_run_dir(&req.runs_root, &run_id)?;
        run_id = claim.run_id.clone();
        run_dir = claim.path.clone();
        run_claim = Some(claim);
        start_events(req, &run_id, &run_dir);
        let wt = worktree::pr_worktree_path(&run_dir);
        // ponytail: until run.json exists only this process knows the worktree; a SIGKILL here
        // leaves it under the run directory for `git worktree prune`; add durable intent if that bites.
        *unowned_worktree = Some((repo_root.clone(), wt.clone()));
        worktree::add_prepared(runner, &repo_root, &info, &wt)?;
        project_root = if app_rel == "." {
            wt
        } else {
            wt.join(&app_rel)
        };
        if req.platform == Platform::Ios {
            if let Some(workspace) = config.ios.as_ref().and_then(|ios| ios.build.as_ref()) {
                ios::validate_workspace(&project_root, workspace)?;
            }
        }
        pr_state = Some(PrState {
            info,
            repo_root,
            app_rel,
        });
    }
    if pr_state.is_some() && config.login_block.is_some() {
        let actual_source = serde_json::json!({ "kind": "owned", "appRoot": app_root_for(&req.config_path, &project_root)? });
        let actual = input_inventory(
            runner,
            &node,
            &req.runtime_dir,
            &plan,
            &req.plan_file,
            &config,
            req.platform,
            &actual_source,
        )?;
        if actual != inventory {
            return Err(input_refused());
        }
    }
    let (repo_root, project_rel) = locate_worktree(runner, &project_root)?;
    let scenario = build_scenario(&config, req.platform, &device, &repo_root, &project_rel);
    scenario.validate()?;
    let cand = candidate::resolve(runner, &scenario, &project_root)?;
    if let Some(pr) = &pr_state {
        if cand.git_sha != pr.info.head_ref_oid || cand.git_dirty {
            return Err(pr_failure(format!(
                "the worktree is at {} (dirty={}), not the clean pull request head {}",
                cand.git_sha, cand.git_dirty, pr.info.head_ref_oid
            )));
        }
    }
    prepare::check_prereqs(runner, &scenario, req.android_home.as_deref())?;
    std::fs::create_dir_all(&req.runs_root).map_err(|e| {
        Failure::new(
            "preflight",
            FailureCode::RunRecordUpdateFailed,
            format!("cannot create {}: {e}", req.runs_root.display()),
            "check the run directory permissions",
        )
    })?;
    preflight_disk(runner, &req.runs_root, &project_root)?;

    if run_claim.is_none() {
        let claim = claim_run_dir(&req.runs_root, &run_id)?;
        run_id = claim.run_id.clone();
        run_dir = claim.path.clone();
        run_claim = Some(claim);
    }
    let identity = capture_pid_identity(runner, std::process::id() as i32);
    let mut recovered = None;
    let lease = match lease::try_acquire(
        runner,
        &req.lock_root,
        req.platform,
        &device.id,
        &run_id,
        identity.clone(),
    ) {
        Ok(lease) => lease,
        Err(busy) if busy.failure.code == FailureCode::DeviceBusy => {
            recovered = Some(crate::commands::cleanup::reclaim_dead_holder_with_runtime(
                runner,
                &req.runs_root,
                &busy,
                Some((&node, &req.runtime_dir)),
            )?);
            lease::acquire(
                runner,
                &req.lock_root,
                req.platform,
                &device.id,
                &run_id,
                identity.clone(),
            )?
        }
        Err(busy) => return Err(busy.failure),
    };
    // After reclaim, so a dead holder's surviving Metro is stopped by its own cleanup first.
    if let Err(f) = prepare::check_port_free(runner, config.metro_port) {
        return Err(lease::release_or_annotate(&lease, f));
    }

    if pr_state.is_none() {
        start_events(req, &run_id, &run_dir);
    }
    let mut resources = Resources::default();
    resources.lease = Some(lease.clone());
    resources.device_borrowed = true;
    resources.ios_simulator = device
        .ios
        .as_ref()
        .map(|(device_type, runtime)| IosSimResource {
            udid: device.id.clone(),
            name: device.name.clone(),
            device_type: device_type.clone(),
            runtime: runtime.clone(),
        });
    if let Some(emulator) = &device.android {
        let home = req
            .android_home
            .as_deref()
            .expect("resolved with ANDROID_HOME");
        resources.adb_path = Some(android::adb_path(home));
        resources.adb_local_serial = Some(emulator.serial.clone());
        resources.android_emulator = Some(emulator.clone());
    }
    resources.pr_worktree = unowned_worktree
        .as_ref()
        .map(|(repo_root, path)| PrWorktreeResource {
            repo_root: repo_root.clone(),
            path: path.clone(),
        });
    let record = RunRecord {
        schema: RUN_SCHEMA.to_string(),
        run_id: run_id.clone(),
        created_at: timefmt::iso8601_utc(started_ms),
        scenario,
        scenario_path: req.config_path.clone(),
        scenario_sha256: sha256_hex(config_raw.as_bytes()),
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
    if let Err(f) = record.save(&req.runs_root) {
        return Err(lease::release_or_annotate(&lease, f));
    }
    run_claim.as_mut().unwrap().record_owned = true;
    *unowned_worktree = None;
    let mut ctx = Ctx {
        runner,
        runs_root: req.runs_root.clone(),
        native_cache_root: req.native_cache_root.clone(),
        native_store_entry: None,
        record,
        started_ms,
        timings: Vec::new(),
        notes: Vec::new(),
        verb: verb(req),
        bundle_requests_at_launch: None,
    };
    let finish_failed =
        |ctx: Ctx, failure: Failure| finish_failed(ctx, &node, &req.runtime_dir, failure, false);
    if let Some(earlier) = &recovered {
        ctx.notes
            .push(("recovered_run".to_string(), earlier.clone()));
    }
    if let Some(run_id) = &lease.released_orphan {
        ctx.notes.push((
            "device_lease".to_string(),
            lease::orphan_note(&lease.lock_dir, run_id),
        ));
    }
    let t = ctx.mark("preflight", started_ms);
    events::stage("preflight", StageState::Passed, None, None);
    events::stage("deps", StageState::Running, None, None);
    if let Err(f) = ensure_running(&*ctx.runner, "deps") {
        return Ok(finish_failed(ctx, f));
    }

    if recovered.is_some() && req.platform == Platform::Ios {
        let refreshed = match resolve_device(
            ctx.runner,
            req.platform,
            Some(&device.id),
            req.boot_device || req.restart_device,
            req.shutdown_device_on_exit,
            req.android_home.as_deref(),
        ) {
            Ok(refreshed) => refreshed,
            Err(f) => return Ok(finish_failed(ctx, f)),
        };
        if refreshed.ios != device.ios {
            return Ok(finish_failed(
                ctx,
                Failure::new(
                    "device",
                    FailureCode::DeviceUnavailable,
                    "selected simulator runtime or device type changed during lease recovery",
                    "check the exact --device UUID and simulator inventory, then re-run",
                ),
            ));
        }
        device.needs_boot = refreshed.needs_boot;
    }

    let ios_lifecycle = req.boot_device || req.restart_device || req.shutdown_device_on_exit;
    if req.platform == Platform::Ios && (req.fresh_install || ios_lifecycle) {
        if let Err(f) = core::fresh_install_admission(
            ctx.runner,
            &node,
            &req.runtime_dir,
            &project_root,
            &device.id,
            None,
        ) {
            return Ok(finish_failed(ctx, f));
        }
    }
    if req.platform == Platform::Ios {
        if let Err(f) = prepare::install_deps(&mut ctx) {
            return Ok(finish_failed(ctx, f));
        }
        if let Err(f) = ios::require_build(
            ctx.runner,
            &ctx.record.candidate.project_root,
            ctx.record.scenario.build.ios_workspace.as_ref(),
        ) {
            return Ok(finish_failed(ctx, f));
        }
    }
    // Last proof before anything destructive; ios_lifecycle options are iOS-only.
    if req.fresh_install || ios_lifecycle {
        if let Err(f) = core::fresh_install_admission(
            ctx.runner,
            &node,
            &req.runtime_dir,
            &project_root,
            &device.id,
            android_env.as_ref(),
        ) {
            return Ok(finish_failed(ctx, f));
        }
    }
    if req.shutdown_device_on_exit {
        if let Err(f) = ensure_running(&*ctx.runner, "deps") {
            return Ok(finish_failed(ctx, f));
        }
        let prev = ctx.record.resources.borrowed_ios_stop();
        if let Err(f) = ctx.record.resources.arm_borrowed_ios_stop() {
            return Ok(finish_failed(ctx, f));
        }
        if let Err(f) = ctx.save() {
            ctx.record.resources.revert_borrowed_ios_stop(prev);
            return Ok(finish_failed(ctx, f));
        }
    }
    if req.boot_device || req.restart_device {
        let mut restart_shutdown_unresolved = false;
        if let Err(f) = boot_selected_device(
            &mut ctx,
            &device,
            req.restart_device,
            &mut restart_shutdown_unresolved,
        ) {
            return Ok(self::finish_failed(
                ctx,
                &node,
                &req.runtime_dir,
                f,
                restart_shutdown_unresolved && !req.shutdown_device_on_exit,
            ));
        }
    }
    if req.fresh_install {
        if let Err(f) = reset_app(&mut ctx, &device.id, &config.app_id, android_env.as_ref()) {
            return Ok(finish_failed(ctx, f));
        }
    }

    if req.platform == Platform::Android {
        if let Err(f) = prepare::install_deps(&mut ctx) {
            return Ok(finish_failed(ctx, f));
        }
    }
    let t = ctx.mark("deps", t);
    events::stage("deps", StageState::Passed, None, None);
    if let Err(f) = ensure_running(&*ctx.runner, "build") {
        return Ok(finish_failed(ctx, f));
    }
    events::stage("build_decision", StageState::Running, None, None);

    let plan_decision = match prepare::plan_build(&mut ctx) {
        Ok(plan) => plan,
        Err(f) => return Ok(finish_failed(ctx, f)),
    };
    ctx.record.build = Some(plan_decision.clone());
    if plan_decision.decision == BuildDecision::Clean && req.platform == Platform::Ios {
        let shortfall = match tightest_volume(ctx.runner, &[&req.runs_root, &project_root]) {
            Ok((kb, path)) => clean_ios_build_shortfall(kb, path),
            Err(f) => return Ok(finish_failed(ctx, f)),
        };
        if let Some(detail) = shortfall {
            // The receipt's next action becomes `qaren cleanup` once resources are owned, so the detail carries the remedy.
            let detail = format!("{detail}; {FREE_DISK_FIX}");
            let f = Failure::new(
                "build",
                FailureCode::DiskBudgetExceeded,
                detail,
                FREE_DISK_FIX,
            );
            return Ok(finish_failed(ctx, f));
        }
    }
    if plan_decision.decision != BuildDecision::Reuse {
        if let Err(f) = prepare::claim_build_lock(&mut ctx, &req.lock_root) {
            return Ok(finish_failed(ctx, f));
        }
    }
    ctx.record.phase = Phase::ResourcesAllocated;
    if let Err(f) = ctx.save() {
        return Ok(finish_failed(ctx, f));
    }
    let t = ctx.mark("plan", t);
    let decision = plan_decision.decision.as_str();
    events::stage("build_decision", StageState::Passed, Some(decision), None);

    if plan_decision.decision == BuildDecision::Reuse {
        events::stage("prebuild", StageState::Skipped, None, None);
        events::stage("native_build", StageState::Skipped, None, None);
        events::stage("install_launch_ready", StageState::Running, None, None);
        if let Err(f) = prepare::run_reuse_path(&mut ctx, &plan_decision, t) {
            return Ok(finish_failed(ctx, f));
        }
        events::stage("install_launch_ready", StageState::Passed, None, None);
    } else {
        if plan_decision.decision == BuildDecision::Clean {
            events::stage("prebuild", StageState::Running, None, None);
            if let Err(f) = prepare::run_clean_preparation(&mut ctx, &plan_decision) {
                return Ok(finish_failed(ctx, f));
            }
            events::stage("prebuild", StageState::Passed, None, None);
        } else {
            events::stage("prebuild", StageState::Skipped, None, None);
        }
        events::stage("native_build", StageState::Running, None, None);
        if let Err(f) = prepare::build_and_ready(&mut ctx) {
            return Ok(finish_failed(ctx, f));
        }
        // build_and_ready splits native_build from install, as on iOS.
        events::stage("install_launch_ready", StageState::Passed, None, None);
    }
    let t = ctx.mark("build_and_ready", t);
    events::stage("verify", StageState::Running, None, None);
    let fp = match prepare::recheck_fingerprint(&mut ctx, &plan_decision) {
        Ok(fp) => fp,
        Err(f) => return Ok(finish_failed(ctx, f)),
    };
    if plan_decision.decision != BuildDecision::Reuse {
        if let Err(f) = prepare::record_build_result(&mut ctx, &fp) {
            return Ok(finish_failed(ctx, f));
        }
        prepare::release_build_lock(&mut ctx);
    }
    let t = ctx.mark("verify", t);
    events::stage("verify", StageState::Passed, None, None);
    if let Err(f) = ensure_running(&*ctx.runner, "walk") {
        return Ok(finish_failed(ctx, f));
    }

    if pr_state.is_some() {
        if let Err(detail) = candidate::verify_unchanged(ctx.runner, &ctx.record.candidate) {
            let f = Failure::new(
                "pr",
                FailureCode::CandidateDrifted,
                format!("the pull request worktree changed before the walk: {detail}"),
                "re-run qaren pr; nothing may modify the run's worktree",
            );
            return Ok(finish_failed(ctx, f));
        }
    }
    ctx.record.phase = Phase::Walking;
    let at = timefmt::iso8601_utc(ctx.runner.now_epoch_ms());
    ctx.record.push_history(at, "walking");
    if let Err(f) = ctx.save() {
        return Ok(finish_failed(ctx, f));
    }
    // In `qaren pr` the app root is the PR worktree's, so blocks replay and save there.
    let app_root = match app_root_for(&req.config_path, &project_root) {
        Ok(root) => root,
        Err(f) => return Ok(finish_failed(ctx, f)),
    };
    let status_before = worktree_status(ctx.runner, &app_root);
    if let Err(f) = ensure_running(ctx.runner, "walk") {
        return Ok(finish_failed(ctx, f));
    }
    // ⑧: the recording starts before the walk so it shows the first step.
    let mut video = None;
    // Taken before the spawn, so the trim offset can only cut later than the true admission frame.
    let recording_from = ctx.runner.now_epoch_ms();
    if resolved_inputs.has_inputs() {
        events::stage("recording", StageState::Skipped, None, None);
        video = Some(VideoStatus::Unavailable(
            "runtime inputs withhold recording".to_string(),
        ));
    } else if pr_state.is_some() {
        if device
            .android
            .as_ref()
            .is_some_and(|emulator| emulator.api_level < 34)
        {
            events::stage("recording", StageState::Skipped, None, None);
            video = Some(VideoStatus::Unavailable(
                "Android API <34 stops screen recording at 180 s".into(),
            ));
        } else {
            events::stage("recording", StageState::Running, None, None);
            let adb = ctx.record.resources.adb_path.clone();
            let target = match &device.android {
                Some(emulator) => record::RecordTarget::Android {
                    adb: adb.as_deref().expect("borrowed emulator adb path"),
                    port: emulator.server_port,
                    serial: &emulator.serial,
                },
                None => record::RecordTarget::Ios(&device.id),
            };
            if let Err(status) = record::start(ctx.runner, &mut ctx.record, &ctx.runs_root, target)
            {
                events::stage("recording", StageState::Failed, None, None);
                video = Some(status);
            }
        }
    } else {
        events::stage("recording", StageState::Skipped, None, None);
    }
    if req.platform == Platform::Ios && resolved_inputs.has_inputs() {
        ctx.notes.push((
            "platform_log".to_string(),
            "the simulator system log may record displayed field text; see Runtime inputs"
                .to_string(),
        ));
    }
    if let Err(f) = ensure_running(ctx.runner, "walk") {
        return Ok(finish_failed(ctx, f));
    }
    let core_request = CoreRequest {
        run_id: run_id.clone(),
        t0: ctx.runner.now_epoch_ms(),
        walk_budget_ms: req.budgets.walk_seconds.saturating_mul(1000),
        attach_budget_ms: ctx
            .record
            .scenario
            .deadlines
            .attach_seconds
            .saturating_mul(1000),
        plan: plan.clone(),
        prepared,
        preflight_calls: preflight_jev
            .as_ref()
            .map(|j| j.call_details.clone())
            .unwrap_or_default(),
        platform: platform_str(req.platform).to_string(),
        app_id: config.app_id.clone(),
        app_root: app_root.clone(),
        run_dir: run_dir.clone(),
        lease: lease.wire(),
        login_block: config.login_block.clone(),
        login_marker: config.login_marker.clone(),
        target: CoreTarget {
            device_id: device.id.clone(),
            device_name: device.name.clone(),
            metro_port: config.metro_port,
            metro_url_for_device: format!("http://127.0.0.1:{}", config.metro_port),
            worktree: project_root.clone(),
            metro_bundle_requests: ctx
                .bundle_requests_at_launch
                .zip(ctx.record.resources.metro.as_ref())
                .map(|(at_launch, metro)| core::MetroBundleRequests {
                    path: crate::exec::log::bundle_requests_path(&metro.log),
                    at_launch,
                }),
        },
    };
    let spec = core::spawn_spec(
        &node,
        &req.runtime_dir,
        &project_root,
        &lease.wire(),
        config.metro_port,
        android_env.as_ref(),
    );
    // Ownership needs proven absence first: a host already up on this simulator is never the run's.
    let presence =
        (req.platform == Platform::Ios).then(|| ios::probe_runner_hosts(ctx.runner, &device.id));
    if presence == Some(ios::RunnerHostPresence::Unknown) {
        ctx.notes
            .push(("runner_host_probe".to_string(), "unknown".to_string()));
    }
    let runner_host = (presence == Some(ios::RunnerHostPresence::Absent)).then(|| {
        crate::runrecord::RunnerHostResource {
            udid: device.id.clone(),
            bundle_ids: vec![
                ios::RUNNER_HOST_BUNDLE_ID.to_string(),
                ios::RUNNER_TEST_HOST_BUNDLE_ID.to_string(),
            ],
        }
    });
    let core_log = run_dir.join("logs").join("core.log");
    events::core_t0(core_request.t0);
    events::stage("attach", StageState::Running, None, None);
    let core_child = match core::spawn_private(
        ctx.runner,
        &spec,
        &core_log,
        &core_request,
        (resolved_inputs.has_inputs() || login_snapshot.is_some()).then_some(&resolved_inputs),
        login_snapshot.as_ref(),
    ) {
        Ok(child) => child,
        Err(f) => return Ok(finish_failed(ctx, f)),
    };
    ctx.record.resources.core = Some(crate::runrecord::CoreResource {
        pgid: core_child.pid,
        identity: capture_pid_identity(ctx.runner, core_child.pid),
    });
    ctx.record.resources.runner_host = runner_host;
    if let Err(f) = ctx.save() {
        core::abort(core_child);
        return Ok(finish_failed(ctx, f));
    }
    let mut driver_notes = Vec::new();
    let mut outcome = {
        let record = &mut ctx.record;
        let runs_root = &ctx.runs_root;
        let udid = device.id.clone();
        core::wait(ctx.runner, core_child, req.budgets, &mut |runner, pid| {
            match runner_driver(runner, pid, &udid) {
                Some(driver) => {
                    record.resources.runner_drivers.push(driver);
                    if let Err(f) = record.save(runs_root) {
                        driver_notes.push(format!("runner driver {pid} not persisted: {}", f.detail));
                    }
                }
                None => driver_notes.push(format!(
                    "runner driver {pid} is not a proven xcodebuild group leader for this simulator; not recorded"
                )),
            }
        })
    };
    for note in driver_notes {
        ctx.notes.push(("runner_driver".to_string(), note));
    }
    match &outcome.verdict {
        Verdict::Pass => events::close_running(StageState::Passed, None, &["recording"]),
        Verdict::Fail => {
            let code = outcome.failure.as_ref().map(|f| f.code);
            let code = Failure::new("walk", code.unwrap_or(FailureCode::PlanStepFailed), "", "");
            events::close_running(StageState::Failed, Some(&code.code_str()), &["recording"]);
        }
        Verdict::Refused { code, .. } => {
            events::close_running(StageState::Failed, Some(code), &["recording"])
        }
    }
    let t = ctx.mark("walk", t);
    let drift = match (status_before, worktree_status(ctx.runner, &app_root)) {
        (Some(before), Some(after)) => worktree_drift(&before, &after),
        _ => Vec::new(),
    };
    if let Some(exit) = outcome.exit {
        ctx.notes.push(("core_exit".to_string(), exit.to_string()));
    }

    // Captured before teardown removes the candidate worktree.
    let verified = candidate::verify_unchanged(ctx.runner, &ctx.record.candidate);
    let final_verification = FinalVerification {
        tested: ctx.record.candidate.git_sha.clone(),
        matched: verified.is_ok(),
        detail: verified.clone().err(),
    };
    match verified {
        Ok(()) => ctx
            .notes
            .push(("candidate_drift".to_string(), "none".to_string())),
        Err(detail)
            if outcome
                .failure
                .as_ref()
                .is_some_and(|failure| failure.code == FailureCode::RunCancelled) =>
        {
            ctx.notes.push(("candidate_drift".to_string(), detail));
        }
        Err(detail) => {
            outcome.verdict = Verdict::Fail;
            outcome.ledger.verdict = "FAIL".to_string();
            outcome.failure = Some(Failure::new(
                "verify",
                FailureCode::CandidateDrifted,
                format!("the candidate changed during the walk: {detail}"),
                "re-run the check against an unchanged candidate",
            ));
            ctx.notes.push(("candidate_drift".to_string(), detail));
        }
    }
    // The canonical plan copy goes to .qaren/plans only, never into run evidence.
    let recipe = outcome.ledger.recipe.take();
    let ledger_path = run_dir.join("ledger.json");
    if let Err(e) = std::fs::write(
        &ledger_path,
        crate::redact::durable_json(&outcome.ledger).unwrap_or_default(),
    ) {
        ctx.notes.push((
            "ledger".to_string(),
            format!("could not persist {}: {e}", ledger_path.display()),
        ));
    }
    let mut hints = Vec::new();
    let written = outcome.ledger.blocks_written.as_deref().unwrap_or_default();
    let slugs: std::collections::BTreeSet<_> = written
        .iter()
        .chain(
            outcome
                .ledger
                .blocks
                .iter()
                .filter(|block| block.source == "replayed")
                .map(|block| &block.key),
        )
        .collect();
    for slug in slugs {
        if let Some(hint) = crate::actions::login_hint(
            ctx.runner,
            &app_root,
            slug,
            platform_str(req.platform),
            &config,
            pr_state.is_none() || !written.contains(slug),
        ) {
            hints.push(hint);
        }
    }
    if pr_state.is_none()
        && !written.is_empty()
        && crate::actions::corpus_location(ctx.runner, &app_root)
            == (crate::actions::CorpusLocation::Linked { local: true })
    {
        hints.push(crate::actions::corpus_hint(written.len()));
    }
    let mut early_cleanup = Vec::new();
    let mut blocks = Vec::new();
    if pr_state.is_some() {
        if ctx.record.resources.recorder.is_some() {
            let outcome = record::stop(ctx.runner, &mut ctx.record, &ctx.runs_root);
            let state = if outcome.clean() {
                StageState::Passed
            } else {
                StageState::Failed
            };
            if video.is_none() {
                events::stage("recording", state, None, None);
            }
            if !outcome.clean() && video.is_none() {
                video = Some(VideoStatus::Unavailable(
                    "the recorder did not stop cleanly".into(),
                ));
            }
            early_cleanup.push(("recorder".to_string(), outcome.render()));
        }
        let refused;
        (blocks, refused) = worktree::copy_blocks(
            ctx.runner,
            &project_root,
            outcome.ledger.blocks_written.as_deref().unwrap_or_default(),
            &run_dir.join("blocks"),
        );
        if !refused.is_empty() {
            ctx.notes.push((
                "blocks_not_saved".to_string(),
                format!("could not preserve {}", refused.join(", ")),
            ));
        }
    }

    let (mut cleanup, all_clean, ownership_proven) = teardown(
        &mut ctx,
        &node,
        &req.runtime_dir,
        outcome.group_survived,
        false,
    );
    cleanup.splice(..0, early_cleanup);
    ctx.mark("teardown", t);

    let report_path = match report::write(
        &run_dir,
        &ReportInput {
            run_id: &run_id,
            platform: platform_str(req.platform),
            app_id: &config.app_id,
            device: &device.name,
            ledger: &outcome.ledger,
        },
    ) {
        Ok(path) => path,
        Err(f) => return Ok(ctx.fail(f)),
    };

    if let Some(entry) = outcome
        .ledger
        .media_withheld
        .as_ref()
        .and_then(|media| media.screenshots.as_ref().or(media.video.as_ref()))
    {
        ctx.notes
            .push(("media_withheld".to_string(), entry.receipt_note()));
    }
    let (mut result, mut failure) = match &outcome.verdict {
        Verdict::Pass => (ReceiptResult::Pass, None),
        Verdict::Fail => {
            let failure = outcome.failure.clone().unwrap_or_else(|| {
                let (step, seen) = outcome
                    .ledger
                    .failure
                    .as_ref()
                    .map(|f| (f.step, f.seen.clone()))
                    .unwrap_or((0, "the plan did not pass".to_string()));
                Failure::new(
                    "walk",
                    FailureCode::PlanStepFailed,
                    format!("line {step}: {seen}"),
                    "read the report, fix the app or the plan, then re-run",
                )
            });
            (ReceiptResult::Fail, Some(failure))
        }
        Verdict::Refused { code, message } => (
            ReceiptResult::Refused,
            Some(outcome.failure.clone().unwrap_or_else(|| {
                Failure::new(
                    "prove",
                    refusal_code(code),
                    format!("{code}: {message}"),
                    "resolve the refusal, then re-run",
                )
            })),
        ),
    };
    let mut tested_older_commit = None;
    let mut published_video = None;
    if let Some(pr) = &pr_state {
        let raw = record::raw_capture(&run_dir.join("media"));
        let video = video.unwrap_or_else(|| record::finalize(ctx.runner, &run_dir));
        ctx.notes.push(("video".to_string(), video.to_string()));
        if video == VideoStatus::Available {
            if let Some(bytes) = reclaim_raw_capture(&run_dir) {
                ctx.notes.push((
                    "reclaimed".to_string(),
                    format!(
                        "media/{}: {bytes} bytes",
                        raw.file_name().unwrap().to_string_lossy()
                    ),
                ));
            }
        }
        // Only the uploaded copy starts at the admitted app, or after a pre-plan login; the local recording stays complete.
        let video = if video == VideoStatus::Available || outcome.ledger.publication_interrupted {
            let offset = outcome
                .ledger
                .publish_from_ms
                .or(outcome.ledger.admitted_at_ms)
                .map(|at| at.saturating_sub(recording_from));
            // Row t is relative to t0, taken after the recording started, so it can only cut before the true last-row frame.
            let end = outcome.ledger.steps.iter().map(|s| s.t).max();
            record::publication_copy(
                ctx.runner,
                &run_dir,
                offset,
                end,
                outcome.ledger.publication_interrupted,
            )
        } else {
            video
        };
        // ⑭: a head that moved during the run means an older commit was tested.
        match github::pr_view(ctx.runner, &pr.info.url, &pr.repo_root) {
            Ok(now) if now.head_ref_oid != pr.info.head_ref_oid => {
                tested_older_commit = Some(pr.info.head_ref_oid.clone());
            }
            Ok(_) => {}
            Err(f) => ctx
                .notes
                .push(("pr_head_recheck".to_string(), f.detail.to_string())),
        }
        published_video = Some(video);
    }

    let cancelled = match ensure_running(ctx.runner, "finalize") {
        Err(late) => {
            if failure.as_ref().map(|f| f.code) != Some(FailureCode::RunCancelled) {
                result = ReceiptResult::Refused;
                failure = Some(late);
            }
            true
        }
        Ok(()) => failure.as_ref().map(|f| f.code) == Some(FailureCode::RunCancelled),
    };
    ctx.record.terminal = Some(TerminalResult {
        verdict: outcome.ledger.verdict.clone(),
        cancelled,
        final_verification,
        ownership_proven,
    });
    ctx.record.failure = failure.clone();
    ctx.record.phase = if all_clean {
        Phase::Cleaned
    } else {
        Phase::Walking
    };
    let at = timefmt::iso8601_utc(ctx.runner.now_epoch_ms());
    let note: Vec<String> = cleanup.iter().map(|(n, o)| format!("{n}={o}")).collect();
    ctx.record
        .push_history(at, &format!("check finished: {}", note.join(" ")));
    if let Err(f) = ctx.save() {
        return Ok(ctx.fail(f));
    }
    if let (Some(pr), Some(video)) = (&pr_state, published_video) {
        let video_publication = outcome.ledger.video_publication.clone().unwrap_or_default();
        let pr_record = PrRunRecord {
            number: pr.info.number,
            url: pr.info.url.clone(),
            head_ref_oid: pr.info.head_ref_oid.clone(),
            head_ref_name: pr.info.head_ref_name.clone(),
            is_cross_repository: pr.info.is_cross_repository,
            repo_root: pr.repo_root.clone(),
            app_rel: pr.app_rel.clone(),
            platform: platform_str(req.platform).to_string(),
            app_id: config.app_id.clone(),
            device: device.name.clone(),
            plan_sha256: sha256_hex(plan.as_bytes()),
            video,
            video_withholding_reason: video_publication.withholding_reason().map(str::to_string),
            video_publication,
            tested_older_commit: tested_older_commit.is_some(),
            blocks,
            identity_values: identity_values(&device, config.metro_port, &ctx.record.resources),
        };
        let bytes = serde_json::to_vec_pretty(&pr_record).unwrap_or_default();
        if let Err(late) = ensure_running(ctx.runner, "publish") {
            result = ReceiptResult::Refused;
            failure = Some(late);
            ctx.record.terminal.as_mut().unwrap().cancelled = true;
            ctx.record.failure = failure.clone();
            if let Err(f) = ctx.save() {
                return Ok(ctx.fail(f));
            }
        } else if !ctx.record.terminal.as_ref().unwrap().cancelled {
            if let Err(e) = std::fs::write(run_dir.join("pr.json"), bytes) {
                ctx.notes
                    .push(("pr_record".to_string(), format!("could not persist: {e}")));
            }
        }
    }
    let terminal = ctx.record.terminal.as_ref();
    let walk = match result {
        _ if terminal.is_none_or(|t| t.cancelled) => recipes::Walk::Other,
        ReceiptResult::Pass => recipes::Walk::Pass,
        ReceiptResult::Fail if terminal.is_some_and(|t| t.final_verification.matched) => {
            let step = outcome.ledger.failure.as_ref().and_then(|f| f.kind)
                == Some(crate::core::FailureKind::Step);
            if outcome.failure.is_none() && step {
                recipes::Walk::StepFailure
            } else {
                recipes::Walk::OtherFailure
            }
        }
        _ => recipes::Walk::Other,
    };
    let facts = recipes::RunFacts {
        pr: pr_state.is_some(),
        save_plans: config.save_plans != Some(false),
        in_book: recipes::in_book(&app_root, &req.plan_file),
        walk,
        recipe: recipe.as_ref(),
        has_input_values: matches!(&recipe, Some(recipes::RecipeCandidate::Markdown { markdown, .. })
            if crate::redact::redact_inputs(markdown) != *markdown),
    };
    let candidate = ctx.record.candidate.clone();
    let platform = platform_str(req.platform);
    let recipe = match recipes::decide(&facts, || {
        recipes::base_identity(&mut *ctx.runner, &candidate)
    }) {
        recipes::Decision::Nothing => None,
        recipes::Decision::Report(outcome) => Some(outcome),
        recipes::Decision::Save { slug, markdown } => {
            Some(recipes::save(&app_root, slug, markdown))
        }
        recipes::Decision::Mark { broken: true } => {
            Some(recipes::flag(&req.plan_file, platform, &plan))
        }
        recipes::Decision::Mark { broken: false } => {
            Some(recipes::clear(&req.plan_file, platform, &plan))
        }
    };
    let mut receipt = finish_receipt(ctx, result, failure);
    receipt.recipe = recipe;
    receipt.tested_older_commit = tested_older_commit;
    receipt.ledger = Some(report::summarize(&outcome.ledger));
    receipt.blocks_written = outcome.ledger.blocks_written.clone().unwrap_or_default();
    receipt.hints = hints;
    receipt.blocks_not_saved = outcome
        .ledger
        .blocks
        .iter()
        .filter(|block| block.saved == Some(false))
        .map(|block| crate::receipt::BlockNotSaved {
            block: block.key.clone(),
            reason: block.unsavable.clone().unwrap_or_default(),
        })
        .collect();
    receipt.worktree_drift = drift;
    receipt.artifacts.insert("report".to_string(), report_path);
    receipt.artifacts.insert("ledger".to_string(), ledger_path);
    for (name, rendered) in cleanup {
        receipt.cleanup.insert(name, rendered);
    }
    if !all_clean {
        receipt.next_action = format!("qaren cleanup {run_id} --json");
    }
    Ok(receipt)
}

// The raw capture in this run's own directory is redundant once a playable video.mp4 replaces it.
fn reclaim_raw_capture(run_dir: &Path) -> Option<u64> {
    let raw = record::raw_capture(&run_dir.join("media"));
    let meta = std::fs::symlink_metadata(&raw)
        .ok()
        .filter(|m| m.is_file())?;
    std::fs::remove_file(&raw).ok().map(|()| meta.len())
}

// The run's own identifiers, kept privately in pr.json so publication can redact them as whole words.
fn identity_values(device: &Device, metro_port: u16, resources: &Resources) -> Vec<String> {
    let mut values = vec![
        device.name.clone(),
        device.id.clone(),
        metro_port.to_string(),
    ];
    values.extend(resources.adb_local_serial.clone());
    values.extend(resources.usb_device.as_ref().map(|usb| usb.serial.clone()));
    values.extend(
        resources
            .app_install
            .as_ref()
            .map(|install| install.serial.clone()),
    );
    values.extend(
        resources
            .adb_server
            .as_ref()
            .map(|srv| srv.server_port.to_string()),
    );
    values.extend(
        resources
            .tunnel
            .as_ref()
            .map(|tunnel| tunnel.local_port.to_string()),
    );
    values.extend(resources.adb_reverse_port.map(|port| port.to_string()));
    if let Some(emulator) = &resources.android_emulator {
        values.extend([
            emulator.serial.clone(),
            emulator.avd.clone(),
            emulator.server_port.to_string(),
        ]);
    }
    values.retain(|value| !value.is_empty());
    values.sort();
    values.dedup();
    values
}

pub fn app_root_for(config_path: &Path, project_root: &Path) -> Result<PathBuf, Failure> {
    let project = std::fs::canonicalize(project_root).map_err(|e| {
        Failure::new(
            "config",
            FailureCode::ScenarioUnreadable,
            format!(
                "cannot resolve the app root {}: {e}",
                project_root.display()
            ),
            "run check from the app directory that holds .qaren/config.yaml",
        )
    })?;
    let root = config_path
        .parent()
        .filter(|dir| dir.file_name().is_some_and(|name| name == ".qaren"))
        .and_then(Path::parent)
        .and_then(|dir| std::fs::canonicalize(dir).ok())
        .filter(|dir| dir.starts_with(&project))
        .unwrap_or(project);
    Ok(root)
}

pub fn worktree_status(runner: &mut dyn Runner, app_root: &Path) -> Option<BTreeSet<String>> {
    let output = runner.run(&CmdSpec::new(
        "git-worktree-status",
        "git",
        &[
            "-C",
            &app_root.to_string_lossy(),
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
            ".",
            ":(exclude).qaren/actions",
        ],
        20,
    ));
    output.ok().then(|| porcelain_entries(&output.stdout))
}

// One `XY path` entry per change; a rename or copy also names its source path.
pub(crate) fn porcelain_entries(stdout: &str) -> BTreeSet<String> {
    let mut entries = BTreeSet::new();
    let mut records = stdout.split('\0').filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        let renamed = record.starts_with('R') || record.starts_with('C');
        let source = if renamed { records.next() } else { None };
        entries.insert(match source {
            Some(source) => format!("{record}\0{source}"),
            None => record.to_string(),
        });
    }
    entries
}

// Paths whose status changed during the walk, outside the block corpus; diagnostic only.
pub fn worktree_drift(before: &BTreeSet<String>, after: &BTreeSet<String>) -> Vec<String> {
    before
        .symmetric_difference(after)
        .flat_map(|entry| {
            entry
                .get(3..)
                .unwrap_or(entry)
                .split('\0')
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn refusal_code(code: &str) -> FailureCode {
    match code {
        "METRO_ORIGIN_MISMATCH" => FailureCode::MetroOriginMismatch,
        "PLAN_INPUT_MISSING" => FailureCode::PlanInputMissing,
        "PLAN_UNPARSEABLE" => FailureCode::PlanUnparseable,
        "BLOCK_START_MISSING" => FailureCode::BlockStartMissing,
        "JEV_AUTH_FAILED" => FailureCode::JevAuthFailed,
        "JEV_REQUEST_INVALID" => FailureCode::JevRequestInvalid,
        "JEV_UNREACHABLE" => FailureCode::JevUnreachable,
        "RUN_CANCELLED" => FailureCode::RunCancelled,
        _ => FailureCode::CoreRefused,
    }
}

#[cfg(test)]
mod block_start_tests {
    use super::*;

    #[test]
    fn block_start_refusal_retains_typed_receipt_code() {
        let code = refusal_code("BLOCK_START_MISSING");
        assert_eq!(serde_json::to_value(code).unwrap(), "BLOCK_START_MISSING");
        assert!(code.is_refusal());
    }
}

// The borrowed emulator's package list, read like the simulator's inventory: only a clean read decides.
fn app_presence(
    runner: &mut dyn Runner,
    udid: &str,
    app_id: &str,
    android: Option<&core::AndroidEnv>,
) -> ios::AppPresence {
    let Some(emulator) = android else {
        return ios::probe_app_presence(runner, udid, app_id);
    };
    let list = runner.run(&android::pm_list_packages_spec(
        &emulator.platform_tools.join("adb"),
        emulator.server_port,
        &emulator.serial,
        app_id,
    ));
    if !list.ok() || !list.stderr.is_empty() {
        ios::AppPresence::Unknown
    } else if android::package_list_has_exact(&list.stdout, app_id) {
        ios::AppPresence::Installed
    } else {
        ios::AppPresence::ProvenAbsent
    }
}

fn reset_app(
    ctx: &mut Ctx,
    udid: &str,
    app_id: &str,
    android: Option<&core::AndroidEnv>,
) -> Result<(), Failure> {
    ensure_running(ctx.runner, "fresh_install")?;
    let device = if android.is_some() {
        "emulator"
    } else {
        "simulator"
    };
    let unknown = || {
        Failure::new(
            "fresh_install",
            FailureCode::AppPresenceUnknown,
            "a successful structured app inventory could not prove app presence or absence",
            format!("restore {device} inventory access before retrying the fresh install"),
        )
    };
    match app_presence(ctx.runner, udid, app_id, android) {
        ios::AppPresence::Unknown => return Err(unknown()),
        ios::AppPresence::ProvenAbsent => {}
        ios::AppPresence::Installed => {
            let at = timefmt::iso8601_utc(ctx.runner.now_epoch_ms());
            ctx.record.push_history(
                at,
                "fresh install: reset admitted, uninstalling selected app",
            );
            ctx.save()?;
            ensure_running(ctx.runner, "fresh_install")?;
            let uninstalled = match android {
                // adb can exit 0 on a refused uninstall; only its Success line reports removal.
                Some(emulator) => {
                    let output = ctx.runner.run(&android::uninstall_spec(
                        &emulator.platform_tools.join("adb"),
                        emulator.server_port,
                        &emulator.serial,
                        app_id,
                    ));
                    output.ok() && output.stdout.contains("Success")
                }
                None => ctx.runner.run(&ios::uninstall_app_spec(udid, app_id)).ok(),
            };
            if !uninstalled {
                return Err(Failure::new(
                    "fresh_install",
                    FailureCode::AppResetFailed,
                    "uninstall did not complete successfully on the selected device",
                    format!("inspect {device} health and retry the fresh install"),
                ));
            }
            match app_presence(ctx.runner, udid, app_id, android) {
                ios::AppPresence::ProvenAbsent => {}
                ios::AppPresence::Unknown => return Err(unknown()),
                ios::AppPresence::Installed => {
                    return Err(Failure::new(
                        "fresh_install",
                        FailureCode::AppResetFailed,
                        "the selected app remains installed after uninstall",
                        format!("inspect {device} health and retry the fresh install"),
                    ))
                }
            }
        }
    }
    let at = timefmt::iso8601_utc(ctx.runner.now_epoch_ms());
    ctx.record.resources.fresh_install = Some(crate::runrecord::FreshInstallEvidence {
        run_id: ctx.record.run_id.clone(),
        app_id: app_id.to_string(),
        device_id: udid.to_string(),
        proven_absent_at: at.clone(),
        status: crate::runrecord::FreshInstallStatus::ProvenAbsent,
    });
    ctx.record
        .push_history(at, "fresh install: selected app proven absent");
    ctx.save()?;
    ctx.notes
        .push(("fresh_install".to_string(), "proven_absent".to_string()));
    Ok(())
}

fn boot_selected_device(
    ctx: &mut Ctx,
    device: &Device,
    restart: bool,
    restart_shutdown_unresolved: &mut bool,
) -> Result<(), Failure> {
    ensure_running(ctx.runner, "boot_device")?;
    let failed = |detail| {
        Failure::new(
            "boot_device",
            FailureCode::SimulatorBootFailed,
            detail,
            "check the selected simulator's health and inventory, then re-run",
        )
    };
    let Some((device_type, runtime)) = device.ios.as_ref() else {
        return Err(failed(
            "selected simulator lacks recorded runtime and device type",
        ));
    };
    let mut needs_boot = device.needs_boot;
    if restart && !device.needs_boot {
        let shutdown = ios::shutdown_selected_sim(ctx.runner, &device.id, device_type, runtime);
        *restart_shutdown_unresolved = matches!(
            shutdown,
            ios::SelectedSimShutdown::ShutdownFailed | ios::SelectedSimShutdown::ReadbackInvalid
        );
        ensure_running(ctx.runner, "boot_device")?;
        match shutdown {
            ios::SelectedSimShutdown::ShutDown | ios::SelectedSimShutdown::AlreadyShutdown => {
                needs_boot = true;
            }
            ios::SelectedSimShutdown::InventoryInvalid => {
                return Err(failed(
                    "inventory did not prove the exact selected simulator before restart shutdown",
                ))
            }
            ios::SelectedSimShutdown::ShutdownFailed => {
                return Err(failed(
                    "simctl shutdown did not complete successfully for the selected simulator",
                ))
            }
            ios::SelectedSimShutdown::ReadbackInvalid => {
                return Err(failed(
                    "inventory did not prove the exact selected simulator Shutdown with unchanged runtime and device type",
                ))
            }
        }
    }
    prepare::boot_borrowed_ios(ctx, needs_boot)
}

// A driver is recorded only as the leader of its own group, running the runner test for this simulator.
pub fn runner_driver(
    runner: &mut dyn Runner,
    pid: i32,
    udid: &str,
) -> Option<crate::runrecord::RunnerDriverResource> {
    if crate::adapters::metro::pgid_of(runner, pid) != Some(pid) {
        return None;
    }
    let identity = capture_pid_identity(runner, pid)?;
    let command = identity.command.as_str();
    (command.contains("xcodebuild")
        && command.contains("test-without-building")
        && command.contains(udid))
    .then_some(crate::runrecord::RunnerDriverResource {
        pgid: pid,
        identity,
    })
}

fn finish_failed(
    mut ctx: Ctx,
    node: &Path,
    runtime_dir: &Path,
    failure: Failure,
    retain_device_lease: bool,
) -> Receipt {
    let failure = ensure_running(ctx.runner, &failure.phase)
        .err()
        .unwrap_or(failure);
    events::close_running(StageState::Failed, Some(&failure.code_str()), &[]);
    let (cleanup, _, _) = teardown(&mut ctx, node, runtime_dir, false, retain_device_lease);
    let mut receipt = ctx.fail(failure);
    for (name, rendered) in cleanup {
        receipt.cleanup.insert(name, rendered);
    }
    receipt
}

// Returns rendered outcomes, whether every leg is clean, and whether the run's producers are proven gone.
fn teardown(
    ctx: &mut Ctx,
    node: &Path,
    runtime_dir: &Path,
    wait_unresolved: bool,
    retain_device_lease: bool,
) -> (Vec<(String, String)>, bool, bool) {
    events::stage("cleanup", StageState::Running, None, None);
    let mut outcomes: Vec<(String, Outcome)> = Vec::new();
    if let Some(outcome) =
        crate::commands::cleanup::cleanup_build(ctx.runner, &mut ctx.record, &ctx.runs_root)
    {
        outcomes.push(("build_process".to_string(), outcome));
    }
    if let Some(outcome) =
        cleanup_core(ctx.runner, &mut ctx.record, &ctx.runs_root, wait_unresolved)
    {
        outcomes.push(("core".to_string(), outcome));
    }
    if let Some(m) = ctx.record.resources.metro.clone() {
        let outcome = cleanup_process_group(
            ctx.runner,
            m.identity.as_ref(),
            m.spawned.pgid,
            Some(m.port),
        );
        if outcome.clean() {
            ctx.record.resources.metro = None;
        }
        outcomes.push(("metro".to_string(), outcome));
    }
    if let Some(outcome) = crate::commands::cleanup::cleanup_runner_drivers(
        ctx.runner,
        &mut ctx.record,
        &ctx.runs_root,
    ) {
        outcomes.push(("runner_driver".to_string(), outcome));
    }
    if let Some(outcome) = crate::commands::cleanup::cleanup_runner_host(ctx.runner, &ctx.record) {
        outcomes.push(("runner_host".to_string(), outcome));
    }
    // A live recorder still addresses the device, so it gates the lease like the hosts do.
    if ctx.record.resources.recorder.is_some() {
        let outcome = record::stop(ctx.runner, &mut ctx.record, &ctx.runs_root);
        outcomes.push(("recorder".to_string(), outcome));
    }
    prepare::release_build_lock(ctx);
    if ctx.record.resources.ios_simulator.is_some() {
        let outcome = crate::commands::cleanup::cleanup_borrowed_ios(
            ctx.runner,
            &mut ctx.record,
            &ctx.runs_root,
            &outcomes,
            false,
            Some((node, runtime_dir)),
        );
        outcomes.push(("simulator".to_string(), outcome));
    }
    // Released while the lease is still this run's; an unclean leg below retains it.
    outcomes.extend(crate::commands::cleanup::release_borrowed_android(
        ctx.runner,
        &ctx.record,
    ));
    if let Some(lease) = ctx.record.resources.lease.clone() {
        let unclean = unclean_legs(&outcomes);
        let outcome = if retain_device_lease {
            Outcome::Unresolved("restart shutdown is unresolved; device lease retained".into())
        } else if ctx.record.resources.can_release_build_ownership()
            && ctx.record.resources.can_release_borrowed_ios_stop()
            && unclean.is_empty()
        {
            let outcome = release_lease_outcome(lease::release(&lease));
            if outcome.clean() {
                ctx.record.resources.lease = None;
            }
            outcome
        } else {
            retained_lease_outcome(&unclean, &ctx.record.run_id)
        };
        outcomes.push(("device_lease".to_string(), outcome));
    }
    if let Some(wt) = ctx.record.resources.pr_worktree.clone() {
        let outcome = if !crate::commands::cleanup::producers_quiescent(&outcomes) {
            Outcome::Unresolved("producer cleanup is unproven; PR worktree retained".into())
        } else if !ctx.record.resources.can_release_borrowed_ios_stop() {
            Outcome::Unresolved("simulator stop is incomplete; PR worktree retained".into())
        } else {
            worktree::remove(ctx.runner, &wt.repo_root, &wt.path)
        };
        if outcome.clean() {
            ctx.record.resources.pr_worktree = None;
        }
        outcomes.push(("pr_worktree".to_string(), outcome));
    }
    let all_clean = outcomes.iter().all(|(_, o)| o.clean());
    let state = if all_clean {
        StageState::Passed
    } else {
        StageState::Failed
    };
    events::stage("cleanup", state, None, None);
    let producers_gone = crate::commands::cleanup::producers_quiescent(&outcomes);
    let _ = ctx.save();
    (
        outcomes.into_iter().map(|(n, o)| (n, o.render())).collect(),
        all_clean,
        producers_gone,
    )
}

fn read_plan(plan_file: &Path) -> Result<String, Failure> {
    std::fs::read_to_string(plan_file).map_err(|e| {
        Failure::new(
            "preflight",
            FailureCode::PlanUnparseable,
            format!("cannot read {}: {e}", plan_file.display()),
            "pass a readable plan file",
        )
    })
}

pub(crate) fn preflight_node(runner: &mut dyn Runner, node: &Path) -> Result<String, Failure> {
    let output = runner.run(&CmdSpec::new(
        "node-version",
        &node.to_string_lossy(),
        &["--version"],
        10,
    ));
    if !output.ok() {
        return Err(Failure::new(
            "preflight",
            FailureCode::PrereqMissing,
            format!(
                "node at {} did not run: {}",
                node.display(),
                output.summary()
            ),
            "install node >= 24 or set nodePath in .qaren/config.yaml",
        ));
    }
    let major = output
        .stdout
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|m| m.parse::<u64>().ok());
    match major {
        Some(major) if major >= 24 => Ok(output.stdout.trim().to_string()),
        _ => Err(Failure::new(
            "preflight",
            FailureCode::NodeUnsupported,
            format!(
                "node at {} reports {:?}; qaren needs node >= 24",
                node.display(),
                output.stdout.trim()
            ),
            "point nodePath in .qaren/config.yaml at a node >= 24",
        )),
    }
}

// Run storage sits on the home volume with Xcode's DerivedData; the app's Pods sit under the project.
fn preflight_disk(
    runner: &mut dyn Runner,
    runs_root: &Path,
    project_root: &Path,
) -> Result<(), Failure> {
    let (kb, path) = tightest_volume(runner, &[runs_root, project_root])?;
    if kb < MIN_FREE_DISK_KB {
        return Err(Failure::new(
            "preflight",
            FailureCode::DiskBudgetExceeded,
            format!(
                "only {} MiB free under {}; a run needs at least {} MiB",
                kb / 1024,
                path.display(),
                MIN_FREE_DISK_KB / 1024
            ),
            "free disk space, then re-run",
        ));
    }
    Ok(())
}

pub(crate) const FREE_DISK_FIX: &str = "free space you own on that volume, such as old Xcode DerivedData under ~/Library/Developer/Xcode/DerivedData or `pnpm store prune`, then re-run";

pub(crate) fn clean_ios_build_shortfall(kb: u64, path: &Path) -> Option<String> {
    (kb < CLEAN_IOS_BUILD_FREE_KB).then(|| {
        format!(
            "{:.1} GiB free on the volume holding {}; a clean iOS build needs about {} GiB",
            kb as f64 / (1024.0 * 1024.0),
            path.display(),
            CLEAN_IOS_BUILD_FREE_KB / (1024 * 1024)
        )
    })
}

// The least free volume among `paths` from one `df -Pk`: (available KiB, its path).
pub(crate) fn tightest_volume<'a>(
    runner: &mut dyn Runner,
    paths: &[&'a Path],
) -> Result<(u64, &'a Path), Failure> {
    let shown = paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let mut args = vec!["-Pk".to_string()];
    args.extend(paths.iter().map(|path| path.to_string_lossy().into_owned()));
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = runner.run(&CmdSpec::new("df", "df", &args, 10));
    if !output.ok() {
        return Err(Failure::new(
            "preflight",
            FailureCode::PrereqMissing,
            format!(
                "df could not report free space under {shown}: {}",
                output.summary()
            ),
            "make df available on PATH and the run directory readable, then re-run",
        ));
    }
    output
        .stdout
        .lines()
        .skip(1)
        .zip(paths)
        .map(|(line, path)| {
            let kb = line.split_whitespace().nth(3)?.parse::<u64>().ok()?;
            Some((kb, *path))
        })
        .collect::<Option<Vec<_>>>()
        .and_then(|volumes| volumes.into_iter().min_by_key(|(kb, _)| *kb))
        .ok_or_else(|| {
            Failure::new(
                "preflight",
                FailureCode::PrereqMissing,
                format!("df -Pk output for {shown} had no readable available-space column"),
                "check that df prints the POSIX table for the run directory, then re-run",
            )
        })
}

fn resolve_device(
    runner: &mut dyn Runner,
    platform: Platform,
    device: Option<&str>,
    select_from_inventory: bool,
    shutdown_device_on_exit: bool,
    android_home: Option<&str>,
) -> Result<Device, Failure> {
    match platform {
        Platform::Android => borrow_emulator(runner, device, android_home),
        Platform::Ios => {
            let strict_inventory = select_from_inventory || shutdown_device_on_exit;
            let output = runner.run(&if strict_inventory {
                ios::list_devices_spec()
            } else {
                ios::list_booted_spec()
            });
            if !output.ok() || (strict_inventory && !output.stderr.is_empty()) {
                return Err(Failure::new(
                    "device",
                    FailureCode::DeviceUnavailable,
                    format!("simctl list failed: {}", output.summary()),
                    "check Xcode and CoreSimulator, then re-run",
                ));
            }
            let borrow = |sim: &ios::Simulator| Device {
                id: sim.udid.clone(),
                name: sim.name.clone(),
                ios: Some((sim.device_type.clone(), sim.runtime.clone())),
                android: None,
                needs_boot: sim.state == ios::SimState::Shutdown,
            };
            if strict_inventory {
                return device
                    .and_then(|udid| ios::parse_selected_sim(&output.stdout, udid))
                    .filter(|sim| select_from_inventory || sim.state == ios::SimState::Booted)
                    .map(|sim| borrow(&sim))
                    .ok_or_else(|| Failure::new(
                        "device",
                        FailureCode::DeviceUnavailable,
                        "selected UUID is not one available iOS simulator in the required power state with complete metadata",
                        "check the exact --device UUID and simulator inventory, then re-run",
                    ));
            }
            let Some(sims) = ios::parse_booted_sims(&output.stdout) else {
                return Err(Failure::new(
                    "device",
                    FailureCode::DeviceUnavailable,
                    "simctl list output was unparseable".to_string(),
                    "check Xcode and CoreSimulator, then re-run",
                ));
            };
            if let Some(udid) = device {
                let matching: Vec<_> = sims.iter().filter(|sim| sim.udid == udid).collect();
                return match matching.as_slice() {
                    [sim] => Ok(borrow(sim)),
                    _ => Err(Failure::new(
                        "device",
                        FailureCode::DeviceUnavailable,
                        format!(
                            "{udid} is not a booted iOS simulator ({} booted)",
                            sims.len()
                        ),
                        "boot the simulator named by --device, then re-run",
                    )),
                };
            }
            match sims.as_slice() {
                [sim] => Ok(borrow(sim)),
                [] => Err(Failure::new(
                    "device",
                    FailureCode::DeviceUnavailable,
                    "no booted iOS simulator".to_string(),
                    "boot the simulator to walk on, then re-run",
                )),
                many => Err(Failure::new(
                    "device",
                    FailureCode::DeviceUnavailable,
                    format!(
                        "{} booted iOS simulators; qaren check borrows exactly one",
                        many.len()
                    ),
                    "shut down the simulators you are not testing on, then re-run",
                )),
            }
        }
    }
}

// Borrowing requires an existing server without claiming its process lifecycle.
fn borrow_emulator(
    runner: &mut dyn Runner,
    device: Option<&str>,
    android_home: Option<&str>,
) -> Result<Device, Failure> {
    let unavailable = |detail: String, next: &str| {
        Failure::new("device", FailureCode::DeviceUnavailable, detail, next)
    };
    let adb = android_home
        .map(android::adb_path)
        .filter(|adb| adb.is_file())
        .ok_or_else(|| {
            Failure::new(
                "device",
                FailureCode::PrereqMissing,
                "ANDROID_HOME is unset or has no platform-tools/adb",
                "export ANDROID_HOME to the Android SDK your emulator runs from, then re-run",
            )
        })?;
    let port = android::borrowed_server_port(
        runner.env_var("ADB_SERVER_SOCKET").as_deref(),
        runner.env_var("ANDROID_ADB_SERVER_PORT").as_deref(),
    )
    .map_err(|detail| {
        unavailable(
            detail,
            "point ADB_SERVER_SOCKET at the local adb server your emulator uses, then re-run",
        )
    })?;
    let Ok(server) = runner.adb_server_version(port) else {
        return Err(unavailable(
            format!("no adb server is running on port {port}; start your emulator first"),
            "boot the emulator (which starts its adb server), then re-run",
        ));
    };
    // A client of another version would kill the borrowed server and start its own.
    let client = runner.run(&android::client_version_spec(&adb));
    let Some(client) = client
        .ok()
        .then(|| android::parse_client_version(&client.stdout))
        .flatten()
    else {
        return Err(Failure::new(
            "device",
            FailureCode::PrereqMissing,
            format!("cannot read the version of {}", adb.display()),
            "check the platform-tools under ANDROID_HOME, then re-run",
        ));
    };
    if client != server {
        return Err(unavailable(
            format!(
                "adb at {} is version {client}, the running server is {server}; running it would restart the server",
                android_home.unwrap_or_default()
            ),
            "use the same platform-tools as the running adb server, then re-run",
        ));
    }
    let listed = runner.run(&android::devices_spec(&adb, port));
    if !listed.ok() {
        return Err(unavailable(
            format!("adb devices failed: {}", listed.summary()),
            "check the adb server, then re-run",
        ));
    }
    let attached = android::parse_devices(&listed.stdout);
    let emulators: Vec<&str> = attached
        .iter()
        .filter(|(serial, state)| state == "device" && is_emulator_serial(serial))
        .map(|(serial, _)| serial.as_str())
        .collect();
    let physical = attached
        .iter()
        .filter(|(serial, _)| !serial.starts_with("emulator-"))
        .count();
    let ignored = if physical == 0 {
        String::new()
    } else {
        format!("; {physical} other device(s) ignored: physical devices are not supported in this release")
    };
    let mut boot_completed = |serial: &str| {
        let output = runner.run(&android::getprop_spec(
            &adb,
            port,
            serial,
            "sys.boot_completed",
        ));
        if output.ok() {
            Ok(output.stdout.trim() == "1")
        } else {
            Err(unavailable(
                format!(
                    "cannot read sys.boot_completed of {serial}: {}",
                    output.summary()
                ),
                "check that the emulator is responsive, then re-run",
            ))
        }
    };
    let not_booted = |serials: &[&str]| {
        unavailable(
            format!(
                "{} has not finished booting (sys.boot_completed is not 1)",
                serials.join(", ")
            ),
            "wait for the emulator to finish booting, then re-run",
        )
    };
    let serial = match device {
        Some(wanted) => {
            let serial = emulators
                .iter()
                .find(|serial| **serial == wanted)
                .copied()
                .ok_or_else(|| {
                    unavailable(
                        format!(
                            "{wanted} is not a booted emulator on the adb server at port {port} ({} booted{ignored})",
                            emulators.len()
                        ),
                        "boot the emulator named by --device, then re-run",
                    )
                })?;
            if !boot_completed(serial)? {
                return Err(not_booted(&[serial]));
            }
            serial
        }
        None => {
            let mut ready = Vec::new();
            for serial in &emulators {
                if boot_completed(serial)? {
                    ready.push(*serial);
                }
            }
            match ready.as_slice() {
                [one] => *one,
                [] if !emulators.is_empty() => return Err(not_booted(&emulators)),
                [] => {
                    return Err(unavailable(
                        format!("no booted emulator{ignored}"),
                        "boot the emulator to walk on, then re-run",
                    ))
                }
                many => {
                    return Err(unavailable(
                        format!(
                            "{} booted emulators; qaren check borrows exactly one{ignored}",
                            many.len()
                        ),
                        "pass --device emulator-NNNN, or shut down the emulators you are not testing on",
                    ))
                }
            }
        }
    }
    .to_string();
    let mut read = |spec: CmdSpec, what: &str| {
        let output = runner.run(&spec);
        if output.ok() {
            Ok(output.stdout.trim().to_string())
        } else {
            Err(unavailable(
                format!("cannot read {what} of {serial}: {}", output.summary()),
                "check that the emulator is responsive, then re-run",
            ))
        }
    };
    let malformed = |what: &str| {
        unavailable(
            format!("{serial} reported an unreadable {what}"),
            "check the emulator image, then re-run",
        )
    };
    let api_level = read(
        android::getprop_spec(&adb, port, &serial, "ro.build.version.sdk"),
        "ro.build.version.sdk",
    )?
    .parse::<u32>()
    .map_err(|_| malformed("ro.build.version.sdk"))?;
    let abi = read(
        android::getprop_spec(&adb, port, &serial, "ro.product.cpu.abi"),
        "ro.product.cpu.abi",
    )?;
    if abi.is_empty()
        || !abi
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
    {
        return Err(malformed("ro.product.cpu.abi"));
    }
    let avd = android::parse_avd_name(&read(
        android::avd_name_spec(&adb, port, &serial),
        "the AVD name",
    )?)
    .ok_or_else(|| malformed("AVD name"))?;
    Ok(Device {
        id: serial.clone(),
        name: avd.clone(),
        ios: None,
        android: Some(BorrowedEmulatorResource {
            serial,
            avd,
            server_port: port,
            api_level,
            abi,
        }),
        needs_boot: false,
    })
}

fn locate_worktree(
    runner: &mut dyn Runner,
    project_root: &Path,
) -> Result<(PathBuf, String), Failure> {
    let output = runner.run(&CmdSpec::new(
        "git-toplevel",
        "git",
        &[
            "-C",
            &project_root.to_string_lossy(),
            "rev-parse",
            "--show-toplevel",
        ],
        20,
    ));
    if !output.ok() {
        return Err(Failure::new(
            "validate",
            FailureCode::CandidateGitUnavailable,
            format!("git rev-parse --show-toplevel failed: {}", output.summary()),
            "run qaren check from inside a git checkout of the app",
        ));
    }
    let repo_root = PathBuf::from(output.stdout.trim());
    let invalid = |detail: String| {
        Failure::new(
            "validate",
            FailureCode::CandidatePathInvalid,
            detail,
            "run qaren check from the app root inside its git checkout",
        )
    };
    let canonical_repo = repo_root
        .canonicalize()
        .map_err(|e| invalid(format!("cannot resolve {}: {e}", repo_root.display())))?;
    let canonical_project = project_root
        .canonicalize()
        .map_err(|e| invalid(format!("cannot resolve {}: {e}", project_root.display())))?;
    let rel = canonical_project
        .strip_prefix(&canonical_repo)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| {
            invalid(format!(
                "{} is not inside its git toplevel {}",
                canonical_project.display(),
                canonical_repo.display()
            ))
        })?;
    Ok((
        canonical_repo,
        if rel.is_empty() { ".".to_string() } else { rel },
    ))
}

fn build_scenario(
    config: &CheckConfig,
    platform: Platform,
    device: &Device,
    repo_root: &Path,
    project_rel: &str,
) -> Scenario {
    Scenario {
        schema: SCENARIO_SCHEMA.to_string(),
        name: "check".to_string(),
        platform,
        candidate: CandidateSpec {
            project_root: project_rel.to_string(),
            app_id: config.app_id.clone(),
            revision: "HEAD".to_string(),
            worktree: Some(repo_root.to_string_lossy().into_owned()),
            dev_client_scheme: config.dev_client_scheme.clone(),
        },
        metro: Some(MetroSpec {
            port: config.metro_port,
        }),
        ios: device.ios.as_ref().map(|(device_type, runtime)| IosSpec {
            device_type: device_type.clone(),
            runtime: runtime.clone(),
        }),
        android: None,
        android_usb: None,
        android_emulator: device.android.as_ref().map(|emulator| AndroidEmulatorSpec {
            serial: emulator.serial.clone(),
            avd: emulator.avd.clone(),
        }),
        build: BuildSpec {
            ios_workspace: config
                .ios
                .as_ref()
                .filter(|_| platform == Platform::Ios)
                .and_then(|ios| ios.build.clone()),
            ..BuildSpec::default()
        },
        deps: DepsSpec {
            registry_auth_env: config.registry_auth_env.clone(),
            ..DepsSpec::default()
        },
        deadlines: config.deadlines.clone(),
    }
}

fn start_events(req: &RunRequest, run_id: &str, run_dir: &Path) {
    events::run(run_id, verb(req), platform_str(req.platform));
    events::attach(&run_dir.join("logs").join("events.jsonl"));
    crate::progress::watch_hint(run_id);
}

struct RunDirClaim {
    run_id: String,
    path: PathBuf,
    record_owned: bool,
}

impl Drop for RunDirClaim {
    fn drop(&mut self) {
        if !self.record_owned {
            // Remove only empty directories; preserve any evidence or external changes.
            let _ = std::fs::remove_dir(self.path.join("logs"));
            let _ = std::fs::remove_dir(self.path.join("screenshots"));
            let _ = std::fs::remove_dir(&self.path);
        }
    }
}

fn claim_run_dir(runs_root: &Path, base_id: &str) -> Result<RunDirClaim, Failure> {
    let cannot = |what: &Path, e: std::io::Error| {
        Failure::new(
            "record",
            FailureCode::RunRecordUpdateFailed,
            format!("cannot create {}: {e}", what.display()),
            "check the run directory permissions",
        )
    };
    std::fs::create_dir_all(runs_root).map_err(|e| cannot(runs_root, e))?;
    for suffix in 0..u64::MAX {
        let run_id = if suffix == 0 {
            base_id.to_string()
        } else {
            format!("{base_id}-{suffix:06}")
        };
        let path = RunRecord::run_dir(runs_root, &run_id);
        match std::fs::create_dir(&path) {
            Ok(()) => {
                let claim = RunDirClaim {
                    run_id,
                    path,
                    record_owned: false,
                };
                std::fs::create_dir(claim.path.join("logs")).map_err(|e| cannot(&claim.path, e))?;
                std::fs::create_dir(claim.path.join("screenshots"))
                    .map_err(|e| cannot(&claim.path, e))?;
                return Ok(claim);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(cannot(&path, e)),
        }
    }
    Err(Failure::new(
        "record",
        FailureCode::RunAlreadyExists,
        format!("no available run id for {base_id}"),
        "check the run directory contents",
    ))
}

const PRIVATE_REPLY_MAX: usize = 4 * 1024 * 1024;

fn input_refused() -> Failure {
    Failure::new(
        "preflight",
        FailureCode::CoreRefused,
        "runtime input admission refused",
        "use a matching runtime and an unchanged owned plan and login corpus",
    )
}

fn inventory_names(value: &Value) -> Result<Vec<String>, Failure> {
    if value.get("inputProtocol").and_then(Value::as_u64) != Some(1)
        || value.get("ok").and_then(Value::as_bool) != Some(true)
    {
        return Err(input_refused());
    }
    let names: Vec<String> = value
        .get("requiredInputs")
        .and_then(Value::as_array)
        .ok_or_else(input_refused)?
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|name| crate::redact::valid_input_name(name))
                .map(String::from)
                .ok_or_else(input_refused)
        })
        .collect::<Result<_, _>>()?;
    if names.len() > 64 || names.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(input_refused());
    }
    non_secret_names(value, &names)?;
    Ok(names)
}

fn non_secret_names(value: &Value, required: &[String]) -> Result<Vec<String>, Failure> {
    let Some(raw) = value.get("nonSecretInputs") else {
        return Ok(Vec::new());
    };
    let names = raw
        .as_array()
        .ok_or_else(input_refused)?
        .iter()
        .map(|name| {
            name.as_str()
                .filter(|name| crate::redact::valid_input_name(name))
                .map(String::from)
                .ok_or_else(input_refused)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if names.is_empty()
        || names.len() > 64
        || names.windows(2).any(|pair| pair[0] >= pair[1])
        || names.iter().any(|name| !required.contains(name))
    {
        return Err(input_refused());
    }
    Ok(names)
}

fn plan_unparseable(value: &Value, plan_file: &Path) -> Option<Failure> {
    let entries = value.get("refused")?.as_array()?;
    if entries.is_empty() {
        return None;
    }
    let mut problems = Vec::new();
    let mut repairs = Vec::new();
    for entry in entries {
        let line = entry.get("line")?.as_u64()?;
        let reason = entry.get("reason")?.as_str()?;
        let action = entry.get("nextAction")?.as_str()?;
        if reason.trim().is_empty() || action.trim().is_empty() {
            return None;
        }
        problems.push(format!("{}: line {line}: {reason}", plan_file.display()));
        repairs.push(format!(
            "edit {} at line {line}: {action}",
            plan_file.display()
        ));
    }
    Some(Failure::new(
        "preflight",
        FailureCode::PlanUnparseable,
        problems.join("; "),
        format!("{}; then re-run", repairs.join("; ")),
    ))
}

#[allow(clippy::too_many_arguments)]
fn input_inventory(
    runner: &mut dyn Runner,
    node: &Path,
    runtime: &Path,
    plan: &str,
    plan_file: &Path,
    config: &CheckConfig,
    platform: Platform,
    source: &Value,
) -> Result<Value, Failure> {
    let mut request = serde_json::json!({ "v": 1, "phase": "input-inventory", "plan": plan, "platform": platform_str(platform), "appId": config.app_id });
    if let Some(slug) = &config.login_block {
        request["login"] = serde_json::json!({ "slug": slug, "source": source });
    }
    let mut bytes = serde_json::to_vec(&request).map_err(|_| input_refused())?;
    bytes.push(b'\n');
    let output = runner.run_private(&core::private_preflight_spec(node, runtime), &bytes);
    if output.timed_out() || output.stdout().len() > PRIVATE_REPLY_MAX {
        return Err(input_refused());
    }
    let value: Value = serde_json::from_str(output.stdout().trim()).map_err(|_| input_refused())?;
    if output.exit_code() == Some(4)
        && value.get("code").and_then(Value::as_str) == Some("PLAN_UNPARSEABLE")
    {
        return Err(plan_unparseable(&value, plan_file).unwrap_or_else(input_refused));
    }
    if output.exit_code() != Some(0) {
        return Err(input_refused());
    }
    inventory_names(&value)?;
    let fields = value.as_object().ok_or_else(input_refused)?;
    if fields.keys().any(|key| {
        ![
            "ok",
            "inputProtocol",
            "requiredInputs",
            "nonSecretInputs",
            "loginSnapshot",
        ]
        .contains(&key.as_str())
    }) {
        return Err(input_refused());
    }
    match (&config.login_block, value.get("loginSnapshot")) {
        (None, None) => {}
        (Some(slug), Some(snapshot))
            if snapshot.as_object().is_some_and(|map| map.len() == 2)
                && snapshot.get("slug").and_then(Value::as_str) == Some(slug.as_str())
                && snapshot
                    .get("content")
                    .is_some_and(|content| content.is_null() || content.is_string()) => {}
        _ => return Err(input_refused()),
    }
    Ok(value)
}

#[allow(clippy::too_many_arguments)]
fn preflight_inputs(
    runner: &mut dyn Runner,
    node: &Path,
    runtime: &Path,
    plan: &str,
    plan_file: &Path,
    config: &CheckConfig,
    platform: Platform,
    inventory: &Value,
    inputs: &crate::redact::ResolvedInputs<'_>,
    accounting: &mut Option<core::JevRollup>,
) -> Result<Value, Failure> {
    let unavailable = || {
        Failure::new(
            "preflight",
            FailureCode::JevUnreachable,
            "the fixed Jev probe or plan judgments did not succeed",
            "this plan has phrase or unrecognised lines that need Jev: set a valid TYPESAFE_API_KEY, or quote every target and ✓ line",
        )
    };
    let mut request = serde_json::json!({ "v": 1, "phase": "plan-preflight", "plan": plan, "platform": platform_str(platform), "appId": config.app_id });
    if let Some(login) = inventory.get("loginSnapshot") {
        request["loginSnapshot"] = login.clone();
    }
    let mut bytes = Vec::new();
    inputs
        .write_private(&mut bytes, &request, None)
        .map_err(|_| input_refused())?;
    // The core decides whether the plan needs Jev; a missing key fails its probe before any device.
    let output = runner.run_private(&core::private_preflight_spec(node, runtime), &bytes);
    if output.stdout().len() > PRIVATE_REPLY_MAX {
        return Err(input_refused());
    }
    let value = serde_json::from_str::<Value>(output.stdout().trim()).map_err(|_| unavailable())?;
    let jev = value
        .get("jev")
        .cloned()
        .and_then(|v| serde_json::from_value::<core::JevRollup>(v).ok());
    *accounting = jev;
    if output.exit_code() == Some(0)
        && !output.timed_out()
        && value.get("ok").and_then(Value::as_bool) == Some(true)
    {
        if value.get("inputProtocol").and_then(Value::as_u64) != Some(1)
            || inventory_names(&value)? != inputs.names()
            || non_secret_names(&value, inputs.names())?
                != non_secret_names(inventory, inputs.names())?
            || value.as_object().is_none_or(|fields| {
                fields.keys().any(|key| {
                    ![
                        "ok",
                        "inputProtocol",
                        "requiredInputs",
                        "nonSecretInputs",
                        "prepared",
                        "jev",
                        "jevRequired",
                    ]
                    .contains(&key.as_str())
                })
            })
        {
            return Err(input_refused());
        }
        let prepared = value
            .get("prepared")
            .filter(|p| p.get("blocks").is_some_and(Value::is_array));
        // An absent or non-boolean jevRequired counts as required, so an older core cannot skip the probe.
        let jev_required = value.get("jevRequired").and_then(Value::as_bool) != Some(false);
        if let (Some(prepared), Some(jev)) = (prepared, accounting.as_ref()) {
            if prepared.get("hash").and_then(Value::as_str) == Some(&sha256_hex(plan.as_bytes()))
                && (!jev_required
                    || jev
                        .call_details
                        .iter()
                        .any(|c| c.scope == "preflight" && c.outcome == "ok"))
            {
                return Ok(prepared.clone());
            }
        }
        return Err(unavailable());
    }
    match (
        output.exit_code(),
        value.get("code").and_then(Value::as_str),
    ) {
        (Some(4), Some("PLAN_UNPARSEABLE")) if !output.timed_out() => {
            Err(plan_unparseable(&value, plan_file).unwrap_or_else(input_refused))
        }
        (Some(4), Some("CORE_REFUSED")) => Err(
            if value.get("message").and_then(Value::as_str) == Some("runtime input privacy refused")
            {
                Failure::new(
                    "preflight",
                    FailureCode::CoreRefused,
                    "runtime input privacy refused: a value appears in the plan, the login block or the app id",
                    "remove the value from the plan and the login block, or use a value the app id does not contain, then re-run",
                )
            } else {
                Failure::new(
                    "preflight",
                    FailureCode::CoreRefused,
                    "runtime inputs are invalid",
                    "supply bounded owner-resolved runtime inputs",
                )
            },
        ),
        _ => Err(unavailable()),
    }
}
