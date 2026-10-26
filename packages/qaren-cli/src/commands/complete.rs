use crate::exec::Runner;
use crate::failure::{Failure, FailureCode};
use crate::handoff;
use crate::receipt::{Receipt, ReceiptResult};
use crate::runrecord::{Phase, RunRecord};
use crate::timefmt;
use crate::{candidate, commands};
use std::path::Path;

// `qaren complete <run-id> <evidence>` binds the qaren managed-build
// receipt to a handed-off run. It is pure validation plus one record update:
// a refusal mutates nothing, so the handoff stays pending and the managed
// chain can retry. Evidence is the build log (or the receipt line alone)
// produced by the session-integrated build.
pub fn complete(
    runner: &mut dyn Runner,
    runs_root: &Path,
    run_id: &str,
    evidence_path: &Path,
) -> Receipt {
    let arrived_at_ms = runner.now_epoch_ms();
    let emitted_at = timefmt::iso8601_utc(arrived_at_ms);
    let mut receipt = Receipt::new(
        "complete",
        run_id,
        ReceiptResult::Refused,
        "load",
        emitted_at,
    );

    let refuse = |mut receipt: Receipt, failure: Failure| -> Receipt {
        // Drift is stale evidence here, not an execution failure: complete
        // declines to bind and mutates nothing.
        receipt.result = if failure.code.is_refusal()
            || matches!(
                failure.code,
                FailureCode::CandidateDrifted | FailureCode::ReadyDeadlineExceeded
            ) {
            ReceiptResult::Refused
        } else {
            ReceiptResult::Failed
        };
        receipt.phase = failure.phase.clone();
        receipt.next_action = failure.next_action.to_string();
        receipt.failure = Some(failure);
        receipt
    };

    let record = match RunRecord::load(runs_root, run_id) {
        Ok(record) => record,
        Err(failure) => {
            let mut receipt = refuse(receipt, failure);
            receipt.result = ReceiptResult::Unknown;
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
    };
    receipt.scenario = Some(commands::scenario_identity(&record));
    receipt.candidate = Some(record.candidate.clone());
    receipt.device = Some(commands::device_identity(&record));

    let pending = match (&record.phase, &record.handoff) {
        (Phase::HandedOff, Some(state)) if state.completed_at.is_none() => state.clone(),
        (Phase::HandedOff, Some(state)) => {
            let failure = Failure::new(
                "complete",
                FailureCode::HandoffNotPending,
                format!(
                    "run {run_id} already bound managed-build evidence at {}; refusing to adopt a second receipt",
                    state.completed_at.clone().unwrap_or_default()
                ),
                format!("qaren cleanup {run_id} --json when the journey is done"),
            );
            let mut receipt = refuse(receipt, failure);
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
        _ => {
            let failure = Failure::new(
                "complete",
                FailureCode::HandoffNotPending,
                format!(
                    "run {run_id} is at phase {} and holds no pending handoff; complete only binds evidence to a handed-off run",
                    record.phase.as_str()
                ),
                "prepare with build.owner: qaren to issue a handoff first",
            );
            let mut receipt = refuse(receipt, failure);
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
    };

    let document = match load_handoff_document(runs_root, run_id, &pending.document_sha256) {
        Ok(document) => document,
        Err(failure) => {
            let mut receipt = refuse(receipt, failure);
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
    };
    if let Err(failure) =
        handoff::verify_validity_window(&record, &document, arrived_at_ms, "complete")
    {
        let mut receipt = refuse(receipt, failure);
        receipt.commands_executed = runner.commands_executed();
        return receipt;
    }

    let (evidence, evidence_sha256) = match read_evidence(evidence_path) {
        Ok(evidence) => evidence,
        Err(failure) => {
            let mut receipt = refuse(receipt, failure);
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
    };
    let accepted = handoff::extract_receipt_payload(&evidence)
        .and_then(|payload| handoff::validate_receipt_payload(&payload, &pending.expected));
    let accepted = match accepted {
        Ok(accepted) => accepted,
        Err((code, detail)) => {
            let failure = Failure::new(
                "complete",
                code,
                detail,
                "re-run the managed build through the qaren session bound to the exact handoff device, then pass its build log",
            );
            let mut receipt = refuse(receipt, failure);
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
    };

    // Replay guard: a receipt whose install generation an earlier completed
    // run already bound for the same worktree/app/device is stale evidence
    // from a previous managed install, not this handoff's build.
    match install_generation_already_bound(runs_root, run_id, &accepted) {
        Ok(Some(prior_run)) => {
            let failure = Failure::new(
                "complete",
                FailureCode::HandoffEvidenceMismatch,
                format!(
                    "stale evidence: install generation {:?} was already bound by run {prior_run} for this worktree/app/device; a fresh managed build produces a new install generation",
                    accepted.install_generation
                ),
                "re-run the managed build through the qaren session, then pass its build log",
            );
            let mut receipt = refuse(receipt, failure);
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
        Err(failure) => {
            let mut receipt = refuse(receipt, failure);
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
        Ok(None) => {}
    }

    // The allocation must still be provably this run's before evidence is
    // bound to it: a cleaned-up or foreign device refuses.
    if let Err(failure) = verify_allocation_owned(runner, &record) {
        let mut receipt = refuse(receipt, failure);
        receipt.commands_executed = runner.commands_executed();
        return receipt;
    }

    // Stale-candidate refusal, checked immediately before persisting: the
    // worktree must still be exactly what the handoff described, or the
    // receipt would be bound to a misattributed candidate identity.
    if let Err(failure) = recheck_candidate(runner, &record) {
        let mut receipt = refuse(receipt, failure);
        receipt.commands_executed = runner.commands_executed();
        return receipt;
    }

    let completed_at = timefmt::iso8601_utc(runner.now_epoch_ms());
    let mut updated = record;
    if let Some(state) = &mut updated.handoff {
        state.accepted = Some(accepted.clone());
        state.completed_at = Some(completed_at.clone());
        state.evidence_sha256 = Some(evidence_sha256);
    }
    updated.push_history(
        completed_at,
        "handoff completed: managed install receipt bound",
    );
    if let Err(failure) = updated.save(runs_root) {
        let mut receipt = refuse(receipt, failure);
        receipt.commands_executed = runner.commands_executed();
        return receipt;
    }

    receipt.result = ReceiptResult::Ready;
    receipt.phase = updated.phase.as_str().to_string();
    receipt
        .outcomes
        .insert("handoff".to_string(), "completed".to_string());
    receipt.outcomes.insert(
        "install_receipt".to_string(),
        format!(
            "bound: {} on {} (artifact {}, build generation {})",
            accepted.app_id,
            accepted.device_id,
            accepted.artifact_digest,
            accepted.build_generation
        ),
    );
    receipt.next_action = format!(
        "agents attach via qaren; after session teardown run: qaren cleanup {run_id} --json"
    );
    receipt.commands_executed = runner.commands_executed();
    commands::attach_artifacts(&mut receipt, runs_root, &updated);
    receipt
}

fn load_handoff_document(
    runs_root: &Path,
    run_id: &str,
    expected_sha256: &str,
) -> Result<handoff::HandoffDocument, Failure> {
    let path = handoff::document_path(runs_root, run_id);
    let raw = std::fs::read(&path).map_err(|e| {
        Failure::new(
            "complete",
            FailureCode::RunRecordInvalid,
            format!(
                "cannot read issued handoff document {}: {e}",
                path.display()
            ),
            format!("qaren cleanup {run_id} --json, then re-run prepare"),
        )
    })?;
    if candidate::sha256_hex(&raw) != expected_sha256 {
        return Err(Failure::new(
            "complete",
            FailureCode::RunRecordInvalid,
            format!(
                "{} no longer matches the issued handoff document",
                path.display()
            ),
            format!("qaren cleanup {run_id} --json, then re-run prepare"),
        ));
    }
    serde_json::from_slice(&raw).map_err(|e| {
        Failure::new(
            "complete",
            FailureCode::RunRecordInvalid,
            format!("issued handoff document {} is invalid: {e}", path.display()),
            format!("qaren cleanup {run_id} --json, then re-run prepare"),
        )
    })
}

// A cleaned-up, deleted, renamed, or foreign-held allocation refuses before
// any evidence is bound to it.
fn verify_allocation_owned(runner: &mut dyn Runner, record: &RunRecord) -> Result<(), Failure> {
    let unowned = |detail: String| {
        Failure::new(
            "complete",
            FailureCode::OwnershipUnproven,
            detail,
            format!(
                "qaren cleanup {} --json, then re-run prepare",
                record.run_id
            ),
        )
    };
    match record.scenario.platform {
        crate::scenario::Platform::Ios => {
            let Some(sim) = &record.resources.ios_simulator else {
                return Err(unowned("no simulator allocation is recorded".to_string()));
            };
            let list = runner.run(&crate::adapters::ios::list_devices_spec());
            if !list.ok() {
                return Err(unowned(format!("simctl list failed: {}", list.summary())));
            }
            match crate::adapters::ios::parse_sim_presence(&list.stdout, &sim.udid) {
                crate::adapters::ios::SimPresence::Present { name, .. } if name == sim.name => {
                    Ok(())
                }
                other => Err(unowned(format!(
                    "the run-scoped simulator {} is no longer provably this run's ({other:?})",
                    sim.udid
                ))),
            }
        }
        crate::scenario::Platform::Android => {
            let Some(usb) = &record.resources.usb_device else {
                return Err(unowned("no USB device claim is recorded".to_string()));
            };
            match crate::buildplan::read_holder(&usb.lock_dir) {
                Some(holder) if holder.holder == usb.holder && holder.run_id == record.run_id => {
                    Ok(())
                }
                Some(_) => Err(unowned(format!(
                    "the exclusive claim on {} is held by another run",
                    usb.serial
                ))),
                None => Err(unowned(format!(
                    "the exclusive claim on {} is gone or unreadable",
                    usb.serial
                ))),
            }
        }
    }
}

fn install_generation_already_bound(
    runs_root: &Path,
    self_run_id: &str,
    accepted: &handoff::AcceptedReceipt,
) -> Result<Option<String>, Failure> {
    let runs_path = runs_root.to_path_buf();
    let runs = std::fs::read_dir(&runs_path).map_err(|e| {
        Failure::new(
            "complete",
            FailureCode::HandoffEvidenceMismatch,
            format!(
                "cannot prove replay history because {} is unreadable: {e}",
                runs_path.display()
            ),
            "restore readable qaren run history before retrying complete",
        )
    })?;
    for entry in runs {
        let entry = entry.map_err(|e| {
            Failure::new(
                "complete",
                FailureCode::HandoffEvidenceMismatch,
                format!(
                    "cannot prove replay history because an entry under {} is unreadable: {e}",
                    runs_path.display()
                ),
                "restore readable qaren run history before retrying complete",
            )
        })?;
        let other_id = entry.file_name().to_string_lossy().into_owned();
        // NOTE: only directories carrying run.json are runs; anything else under the runs root is not history.
        if other_id == self_run_id || !RunRecord::path(runs_root, &other_id).is_file() {
            continue;
        }
        let other = RunRecord::load(runs_root, &other_id).map_err(|failure| {
            Failure::new(
                "complete",
                FailureCode::HandoffEvidenceMismatch,
                format!(
                    "cannot prove replay history because run record {other_id:?} at {} is unreadable: {}",
                    RunRecord::path(runs_root, &other_id).display(),
                    failure.detail
                ),
                "restore or resolve the named qaren run record before retrying complete",
            )
        })?;
        let Some(state) = &other.handoff else {
            continue;
        };
        let Some(prior) = &state.accepted else {
            continue;
        };
        if prior.worktree_key == accepted.worktree_key
            && prior.app_root_key == accepted.app_root_key
            && prior.platform == accepted.platform
            && prior.device_id == accepted.device_id
            && prior.app_id == accepted.app_id
            && prior.install_generation == accepted.install_generation
        {
            return Ok(Some(other_id));
        }
    }
    Ok(None)
}

// Bounded evidence read: a regular file up to 64 MiB. A FIFO or device file
// would block forever and a giant log would exhaust memory; both refuse.
const MAX_EVIDENCE_BYTES: u64 = 64 * 1024 * 1024;

fn read_evidence(path: &Path) -> Result<(String, String), Failure> {
    let missing = |detail: String| {
        Failure::new(
            "complete",
            FailureCode::HandoffEvidenceMissing,
            detail,
            "pass the managed build log (or the receipt line) produced by the qaren session",
        )
    };
    // lstat before open: opening a writerless FIFO would block forever, so
    // anything but a plain regular file (symlinks included) is refused
    // without ever opening it. The fd-level check below then covers the
    // ordinary swap race; an adversarial same-instant swap is outside this
    // tool's trust model (the evidence lives in the operator's own workspace).
    let pre = std::fs::symlink_metadata(path)
        .map_err(|e| missing(format!("cannot read evidence {}: {e}", path.display())))?;
    if !pre.is_file() {
        return Err(missing(format!(
            "evidence {} is not a plain regular file",
            path.display()
        )));
    }
    let file = std::fs::File::open(path)
        .map_err(|e| missing(format!("cannot read evidence {}: {e}", path.display())))?;
    let meta = file
        .metadata()
        .map_err(|e| missing(format!("cannot read evidence {}: {e}", path.display())))?;
    if !meta.is_file() {
        return Err(missing(format!(
            "evidence {} is not a regular file",
            path.display()
        )));
    }
    use std::io::Read;
    let mut raw = Vec::new();
    file.take(MAX_EVIDENCE_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|e| missing(format!("cannot read evidence {}: {e}", path.display())))?;
    if raw.len() as u64 > MAX_EVIDENCE_BYTES {
        return Err(missing(format!(
            "evidence {} exceeds the {MAX_EVIDENCE_BYTES}-byte bound; pass the build log of one run",
            path.display()
        )));
    }
    // Build logs may carry arbitrary bytes around the receipt line; decode
    // lossily and let strict JSON parsing gate the receipt itself. The hash
    // is over the exact bytes, for the audit pointer in the run record.
    Ok((
        String::from_utf8_lossy(&raw).into_owned(),
        candidate::sha256_hex(&raw),
    ))
}

// Complete-time drift check: the live worktree must still match the identity
// recorded at prepare/handoff time, looking through the session's declared
// integration surface (the applied integration is expected to be live here).
fn recheck_candidate(runner: &mut dyn Runner, record: &RunRecord) -> Result<(), Failure> {
    candidate::verify_unchanged_with(runner, &record.candidate, true).map_err(|detail| {
        Failure::new(
            "complete",
            FailureCode::CandidateDrifted,
            format!("{detail} since the handoff"),
            format!(
                "the handoff no longer describes this worktree; qaren cleanup {} --json, then re-run prepare on a stable checkout",
                record.run_id
            ),
        )
    })
}
