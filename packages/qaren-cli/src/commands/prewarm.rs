use crate::buildplan::{self, DepsPrewarm, PREWARM_SCHEMA};
use crate::candidate::{self, sha256_hex, Candidate};
use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::receipt::{Receipt, ReceiptResult};
use crate::redact::redact_secrets;
use crate::scenario::Scenario;
use crate::timefmt;
use std::path::{Path, PathBuf};

pub struct PrewarmArgs {
    pub scenario_path: PathBuf,
}

// The prewarm record lets require-prewarm prepares run offline without persisting credentials.
pub fn prewarm(runner: &mut dyn Runner, args: &PrewarmArgs) -> Receipt {
    let started_ms = runner.now_epoch_ms();
    match prewarm_validated(runner, args, started_ms) {
        Ok(receipt) => receipt,
        Err(err) => {
            let (failure, cand) = *err;
            let mut receipt = Receipt::new(
                "prewarm",
                "none",
                if failure.code.is_refusal() {
                    ReceiptResult::Refused
                } else {
                    ReceiptResult::Failed
                },
                &failure.phase.clone(),
                timefmt::iso8601_utc(runner.now_epoch_ms()),
            );
            receipt.candidate = cand;
            receipt.next_action = failure.next_action.to_string();
            receipt.failure = Some(failure);
            receipt.commands_executed = runner.commands_executed();
            receipt
        }
    }
}

type PrewarmError = Box<(Failure, Option<Candidate>)>;

fn prewarm_validated(
    runner: &mut dyn Runner,
    args: &PrewarmArgs,
    started_ms: u64,
) -> Result<Receipt, PrewarmError> {
    let (scenario, _raw) = Scenario::load(&args.scenario_path).map_err(|f| Box::new((f, None)))?;
    let scenario_dir = args
        .scenario_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let cand =
        candidate::resolve(runner, &scenario, &scenario_dir).map_err(|f| Box::new((f, None)))?;

    // `pnpm fetch` populates the store for every locked package regardless of
    // the current node_modules state — the guarantee a later --offline
    // install actually depends on. The install then proves the layout links.
    let fetch = runner.run(
        &CmdSpec::new(
            "pnpm-fetch",
            "pnpm",
            &["fetch"],
            scenario.deadlines.install_deps_seconds,
        )
        .cwd(&cand.project_root)
        .env("CI", "1"),
    );
    if !fetch.ok() {
        return Err(Box::new((
            Failure::new(
                "deps",
                FailureCode::DepsInstallFailed,
                format!("pnpm fetch: {}", redact_secrets(&fetch.summary())),
                "fix the dependency fetch (credentials/registry access), then re-run prewarm",
            ),
            Some(cand),
        )));
    }
    let install = runner.run(
        &CmdSpec::new(
            "pnpm-install",
            "pnpm",
            &["install", "--frozen-lockfile"],
            scenario.deadlines.install_deps_seconds,
        )
        .cwd(&cand.project_root)
        .registry_auth_env(&scenario.deps.registry_auth_env)
        // CI turns interactive install prompts into failures.
        .env("CI", "1"),
    );
    if !install.ok() {
        return Err(Box::new((
            Failure::new(
                "deps",
                FailureCode::DepsInstallFailed,
                format!(
                    "pnpm install --frozen-lockfile: {}",
                    redact_secrets(&install.summary())
                ),
                if scenario.deps.registry_auth_env.is_empty() {
                    "fix the dependency install (credentials/registry access), then re-run prewarm"
                } else {
                    "dependency output was withheld; check the declared registry auth environment names and registry setup, then re-run prewarm"
                },
            ),
            Some(cand),
        )));
    }

    // The install ran arbitrary lifecycle scripts; the receipt may only claim
    // the pre-install candidate if the checkout provably did not move.
    let unchanged = candidate::verify_unchanged_with(
        runner,
        &cand,
        scenario.build.owner == crate::scenario::BuildOwner::Qaren,
    )
    .is_ok();
    if !unchanged {
        return Err(Box::new((
            Failure::new(
                "deps",
                FailureCode::CandidateDrifted,
                "the checkout changed while prewarming; the record would not describe a provable candidate"
                    .to_string(),
                "re-run prewarm on a stable checkout",
            ),
            Some(cand),
        )));
    }

    let Some(lockfile_sha256) = cand.lockfile_sha256.clone() else {
        return Err(Box::new((
            Failure::new(
                "deps",
                FailureCode::CandidatePathInvalid,
                "the candidate has no lockfile hash to bind the prewarm to".to_string(),
                "ensure pnpm-lock.yaml exists in the project, then re-run prewarm",
            ),
            Some(cand),
        )));
    };
    // The record must describe the lockfile the install actually satisfied; a
    // mutation during the install leaves nothing provable to bind.
    let lockfile_now = std::fs::read(cand.project_root.join("pnpm-lock.yaml"))
        .ok()
        .map(|bytes| sha256_hex(&bytes));
    if lockfile_now.as_ref() != Some(&lockfile_sha256) {
        return Err(Box::new((
            Failure::new(
                "deps",
                FailureCode::CandidateDrifted,
                "pnpm-lock.yaml changed while prewarming; the record would not describe the installed state"
                    .to_string(),
                "re-run prewarm on a stable checkout",
            ),
            Some(cand),
        )));
    }
    let record = DepsPrewarm {
        schema: PREWARM_SCHEMA.to_string(),
        worktree_root: cand.repo_root.clone(),
        project_root: cand.project_root.clone(),
        lockfile_sha256,
        at: timefmt::iso8601_utc(runner.now_epoch_ms()),
    };
    let path = buildplan::prewarm_path(&cand.repo_root);
    buildplan::save_json(&path, &record).map_err(|e| {
        Box::new((
            Failure::new(
                "deps",
                FailureCode::RunRecordUpdateFailed,
                format!("cannot persist the prewarm record {}: {e}", path.display()),
                "check .qaren directory permissions, then re-run prewarm",
            ),
            Some(cand.clone()),
        ))
    })?;

    let now = runner.now_epoch_ms();
    let mut receipt = Receipt::new(
        "prewarm",
        "none",
        ReceiptResult::Prewarmed,
        "prewarmed",
        timefmt::iso8601_utc(now),
    );
    receipt.candidate = Some(cand);
    receipt.artifacts.insert("prewarm_record".to_string(), path);
    receipt
        .timings_ms
        .insert("total".to_string(), now.saturating_sub(started_ms));
    receipt.commands_executed = runner.commands_executed();
    receipt.next_action =
        "prepare with deps.policy: require-prewarm will now run offline".to_string();
    Ok(receipt)
}
