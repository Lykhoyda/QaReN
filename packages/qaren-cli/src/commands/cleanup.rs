use crate::adapters::{android, ios, metro};
use crate::exec::{CmdOutput, CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::receipt::{Receipt, ReceiptResult};
use crate::runrecord::{
    probe_pid_identity, AppRemoval, GroupCleanupResult, Phase, PidIdentity, PidLiveness, RunRecord,
};
use crate::scenario::Platform;
use crate::timefmt;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Removed,
    RemovedBytes(Option<u64>),
    Absent,
    // A borrowed resource this run never owned; left exactly as found.
    Kept,
    Refused(String),
    Unresolved(String),
}

impl Outcome {
    pub fn render(&self) -> String {
        match self {
            Outcome::Removed => "removed".to_string(),
            Outcome::RemovedBytes(Some(bytes)) => format!("removed (reclaimed {bytes} bytes)"),
            Outcome::RemovedBytes(None) => "removed (reclaimed bytes unknown)".into(),
            Outcome::Absent => "absent".to_string(),
            Outcome::Kept => "kept".to_string(),
            Outcome::Refused(reason) => format!("refused: {reason}"),
            Outcome::Unresolved(reason) => format!("unresolved: {reason}"),
        }
    }

    pub fn clean(&self) -> bool {
        matches!(
            self,
            Outcome::Removed | Outcome::RemovedBytes(_) | Outcome::Absent | Outcome::Kept
        )
    }

    fn group_result(&self) -> GroupCleanupResult {
        match self {
            Outcome::Removed | Outcome::RemovedBytes(_) => GroupCleanupResult::Removed,
            Outcome::Absent => GroupCleanupResult::Absent,
            Outcome::Refused(_) => GroupCleanupResult::Refused,
            _ => GroupCleanupResult::Unresolved,
        }
    }
}

pub fn cleanup(runner: &mut dyn Runner, runs_root: &Path, run_id: &str) -> Receipt {
    cleanup_with(runner, runs_root, run_id, None)
}

// A dead holder's device lease is reclaimed only through that run's own cleanup proofs.
pub fn reclaim_dead_holder(
    runner: &mut dyn Runner,
    runs_root: &Path,
    busy: &crate::lease::Busy,
) -> Result<String, Failure> {
    reclaim_dead_holder_with_runtime(runner, runs_root, busy, None)
}

pub fn reclaim_dead_holder_with_runtime(
    runner: &mut dyn Runner,
    runs_root: &Path,
    busy: &crate::lease::Busy,
    runtime_context: Option<(&Path, &Path)>,
) -> Result<String, Failure> {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    let (Some(holder), Some(PidLiveness::Dead | PidLiveness::AliveForeign)) =
        (busy.holder.as_ref(), busy.liveness)
    else {
        return Err(busy.failure.clone());
    };
    // No cleanup can run without the holder's records; keep the lease's own release advice.
    if crate::lease::records_gone(holder) {
        return Err(busy.failure.clone());
    }
    let run_id = holder.run_id.clone();
    let refuse = |detail: String| {
        Failure::new(
            "lease",
            FailureCode::DeviceBusy,
            format!("the device lease is held by run {run_id}, whose qaren process is gone, but {detail}"),
            format!(
                "run {} once its resources are accounted for",
                crate::lease::cleanup_command(&run_id, holder)
            ),
        )
    };
    let record = RunRecord::load(runs_root, &run_id)
        .map_err(|f| refuse(format!("its run record is not readable here: {}", f.detail)))?;
    let owned_by_holder = matches!(
        (&record.prepare, &holder.identity),
        (Some(a), Some(b)) if a.pid == b.pid && a.started_at == b.started_at
    ) && record
        .resources
        .lease
        .as_ref()
        .is_some_and(|l| l.holder == holder.holder && l.run_id == holder.run_id);
    if !owned_by_holder {
        return Err(refuse(
            "its run record does not name the lease holder's process; nothing was cleaned".into(),
        ));
    }
    let receipt = cleanup_with_runtime(runner, runs_root, &run_id, None, runtime_context);
    if receipt.result != ReceiptResult::Cleaned {
        let unproven: Vec<String> = receipt
            .cleanup
            .iter()
            .filter(|(_, outcome)| {
                !matches!(outcome.as_str(), "removed" | "absent" | "kept")
                    && !outcome.starts_with("removed (reclaimed ")
            })
            .map(|(leg, outcome)| format!("{leg}={outcome}"))
            .collect();
        return Err(refuse(format!(
            "its cleanup is not proven ({})",
            unproven.join(", ")
        )));
    }
    Ok(run_id)
}

// A run that never wrote run.json, or whose records were deleted, can still hold locks; only the orphan gate may release them.
pub fn cleanup_with_orphan_locks(
    runner: &mut dyn Runner,
    runs_root: &Path,
    lock_root: Option<&Path>,
    run_id: &str,
    remove_app: Option<&str>,
) -> Receipt {
    let mut receipt = cleanup_with(runner, runs_root, run_id, remove_app);
    let unavailable = receipt
        .failure
        .as_ref()
        .is_some_and(|f| f.code == FailureCode::RunRecordUnavailable);
    let Some(lock_root) = lock_root.filter(|_| unavailable && remove_app.is_none()) else {
        return receipt;
    };
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    let outcomes = release_orphan_locks(runner, lock_root, run_id);
    if outcomes.is_empty() {
        return receipt;
    }
    let refused: Vec<&str> = outcomes
        .iter()
        .filter_map(|(_, outcome)| match outcome {
            Outcome::Refused(reason) => Some(reason.as_str()),
            _ => None,
        })
        .collect();
    if refused.is_empty() {
        receipt.result = ReceiptResult::Cleaned;
        receipt.failure = None;
        receipt.next_action = String::new();
    } else {
        receipt.next_action = refused.join("; ");
    }
    receipt.cleanup.extend(
        outcomes
            .iter()
            .map(|(leg, outcome)| (leg.clone(), outcome.render())),
    );
    receipt.commands_executed = runner.commands_executed();
    receipt
}

fn release_orphan_locks(
    runner: &mut dyn Runner,
    lock_root: &Path,
    run_id: &str,
) -> Vec<(String, Outcome)> {
    let Ok(entries) = std::fs::read_dir(lock_root) else {
        return Vec::new();
    };
    // Probe in name order so the receipt and the probe sequence never depend on readdir order.
    let mut dirs: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
    dirs.sort();
    let mut outcomes = Vec::new();
    for dir in dirs {
        let Some(held) = crate::buildplan::read_holder(&dir).filter(|held| held.run_id == run_id)
        else {
            continue;
        };
        let liveness = held
            .identity
            .as_ref()
            .map(|identity| probe_pid_identity(runner, identity));
        let outcome = if crate::lease::release_orphan(runner, &dir, &held, liveness) {
            Outcome::Removed
        } else {
            Outcome::Refused(crate::lease::contended_advice(&dir, Some(&held)))
        };
        let name = dir.file_name().unwrap_or_default().to_string_lossy();
        outcomes.push((format!("lock:{name}"), outcome));
    }
    outcomes
}

// `remove_app` confirms "<run-id>/<remote-serial>/<app-id>"; None skips uninstall.
pub fn cleanup_with(
    runner: &mut dyn Runner,
    runs_root: &Path,
    run_id: &str,
    remove_app: Option<&str>,
) -> Receipt {
    cleanup_with_runtime(runner, runs_root, run_id, remove_app, None)
}

pub fn cleanup_with_runtime(
    runner: &mut dyn Runner,
    runs_root: &Path,
    run_id: &str,
    remove_app: Option<&str>,
    runtime_context: Option<(&Path, &Path)>,
) -> Receipt {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    let mut record = match RunRecord::load(runs_root, run_id) {
        Ok(record) => record,
        Err(failure) => {
            let mut receipt = Receipt::new(
                "cleanup",
                run_id,
                ReceiptResult::Refused,
                "load",
                timefmt::iso8601_utc(runner.now_epoch_ms()),
            );
            receipt.next_action = failure.next_action.to_string();
            receipt.failure = Some(failure);
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
    };
    if let Some(confirmation) = remove_app {
        if let Err(detail) = removal_confirmed(&record, confirmation) {
            let mut receipt = Receipt::new(
                "cleanup",
                run_id,
                ReceiptResult::Refused,
                record.phase.as_str(),
                timefmt::iso8601_utc(runner.now_epoch_ms()),
            );
            receipt.scenario = Some(super::scenario_identity(&record));
            receipt.candidate = Some(record.candidate.clone());
            receipt.device = Some(super::device_identity(&record));
            let next_action = match record.resources.android_emulator.as_ref() {
                Some(emulator) => format!(
                    "omit --remove-app; to remove the app, run adb -s {} uninstall {} yourself",
                    emulator.serial, record.candidate.app_id
                ),
                None => "re-run with --remove-app --confirm-remove-app <run-id>/<remote-serial>/<app-id> naming exactly this run, its leased emulator serial and its app id, or omit --remove-app for legacy cleanup".to_string(),
            };
            receipt.failure = Some(Failure::new(
                "cleanup",
                FailureCode::AppRemovalNotConfirmed,
                detail,
                next_action.clone(),
            ));
            receipt.next_action = next_action;
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
    }

    let owner_refusal =
        || Outcome::Refused("the run's qaren process is alive or unproven gone".to_string());
    let producers = record.resources.core.is_some() || !record.resources.runner_drivers.is_empty();
    // A held pool creation lock means the creator may still be counting, creating or enrolling.
    let guarded_simulator = !record.resources.can_release_borrowed_ios_stop()
        || record.resources.pool_create_lock.is_some()
        || (record.resources.device_borrowed
            && record.resources.ios_simulator.is_some()
            && record.resources.lease.is_some());
    let owner = match (producers || guarded_simulator, &record.prepare) {
        (true, Some(prepare)) => Some(probe_pid_identity(runner, prepare)),
        _ => None,
    };
    if owner == Some(PidLiveness::AliveMatching)
        || (guarded_simulator
            && !matches!(owner, Some(PidLiveness::Dead | PidLiveness::AliveForeign)))
    {
        return finish_cleanup(
            runner,
            runs_root,
            run_id,
            remove_app,
            &mut record,
            vec![(
                if guarded_simulator {
                    "simulator"
                } else {
                    "core"
                }
                .to_string(),
                owner_refusal(),
            )],
            false,
        );
    }

    let mut outcomes: Vec<(String, Outcome)> = Vec::new();

    if let Some(outcome) = cleanup_build(runner, &mut record, runs_root) {
        outcomes.push(("build_process".to_string(), outcome));
    }

    if record.resources.core.is_some() {
        let owner_gone = matches!(owner, Some(PidLiveness::Dead | PidLiveness::AliveForeign));
        let outcome = if owner_gone {
            cleanup_core(runner, &mut record, runs_root, false)
        } else {
            Some(owner_refusal())
        };
        if let Some(outcome) = outcome {
            outcomes.push(("core".to_string(), outcome));
        }
    }
    if let Some(m) = record.resources.metro.clone() {
        outcomes.push((
            "metro".to_string(),
            cleanup_process_group(runner, m.identity.as_ref(), m.spawned.pgid, Some(m.port)),
        ));
    }

    if !record.resources.runner_drivers.is_empty() {
        let owner_gone = matches!(owner, Some(PidLiveness::Dead | PidLiveness::AliveForeign));
        let outcome = if owner_gone {
            cleanup_runner_drivers(runner, &mut record, runs_root)
        } else {
            Some(owner_refusal())
        };
        if let Some(outcome) = outcome {
            outcomes.push(("runner_driver".to_string(), outcome));
        }
    }

    if let Some(outcome) = cleanup_runner_host(runner, &record) {
        outcomes.push(("runner_host".to_string(), outcome));
    }

    let owner_alive = !guarded_simulator
        && (record.resources.recorder.is_some() || record.resources.pr_worktree.is_some())
        && !record.prepare.as_ref().is_some_and(|owner| {
            matches!(
                probe_pid_identity(runner, owner),
                PidLiveness::Dead | PidLiveness::AliveForeign
            )
        });
    if record.resources.recorder.is_some() {
        let outcome = if owner_alive {
            owner_refusal()
        } else {
            crate::record::stop(runner, &mut record, runs_root)
        };
        outcomes.push(("recorder".to_string(), outcome));
    }

    match record.scenario.platform {
        Platform::Ios => {
            if let Some(sim) = record.resources.ios_simulator.clone() {
                let outcome = if record.resources.device_borrowed {
                    cleanup_borrowed_ios(
                        runner,
                        &mut record,
                        runs_root,
                        &outcomes,
                        owner_alive,
                        runtime_context,
                    )
                } else if !record.resources.can_release_build_ownership() {
                    Outcome::Unresolved(
                        "build process cleanup is unproven; simulator retained".into(),
                    )
                } else {
                    cleanup_simulator(runner, &sim.udid, &sim.name)
                };
                outcomes.push(("simulator".to_string(), outcome));
            }
        }
        // A borrowed emulator has no owned server, tunnel or claim; the lease release below still gates on its legs.
        Platform::Android if record.resources.android_emulator.is_some() => {
            outcomes.extend(release_borrowed_android(runner, &record));
        }
        Platform::Android => {
            let server = record.resources.adb_server.clone();
            let is_usb =
                record.resources.usb_device.is_some() || record.scenario.android_usb.is_some();
            let mut removal_evidence_persisted = true;
            // Removal needs the lease, tunnel and private server alive to prove ownership.
            if remove_app.is_some() {
                let (mut outcome, removal) = remove_app_install(runner, &record);
                if let (Some(removal), Some(install)) =
                    (removal, record.resources.app_install.as_mut())
                {
                    install.removal = Some(removal);
                    // The removal must be durable before any lease release.
                    if let Err(failure) = record.save(runs_root) {
                        removal_evidence_persisted = false;
                        outcome = Outcome::Unresolved(format!(
                            "{} but the removal record could not be persisted: {}",
                            outcome.render(),
                            failure.detail
                        ));
                    }
                }
                outcomes.push(("app_install".to_string(), outcome));
            }
            // A recorded reverse mapping lives device-side; it can only be
            // removed through the run's own live adb server.
            if let Some(reverse_port) = record.resources.adb_reverse_port {
                match (
                    record.resources.adb_local_serial.clone(),
                    record.resources.adb_path.clone(),
                    &server,
                ) {
                    (Some(serial), Some(adb), Some(srv)) => {
                        push_reverse_outcome(
                            runner,
                            &record,
                            &mut outcomes,
                            reverse_port,
                            serial,
                            adb,
                            srv,
                            is_usb,
                        );
                    }
                    // A mapping was recorded but the path to remove it was
                    // never fully persisted; it cannot be proven gone.
                    _ => outcomes.push((
                        "adb_reverse".to_string(),
                        Outcome::Unresolved(format!(
                            "a reverse mapping tcp:{reverse_port} is recorded but the run's adb serial/path/server record is incomplete; remove it manually if present"
                        )),
                    )),
                }
            }
            if !is_usb {
                match (
                    record.resources.adb_local_serial.clone(),
                    record.resources.adb_path.clone(),
                    &server,
                ) {
                    (Some(serial), Some(adb), Some(srv)) => {
                        // Disconnecting is only meaningful while the run's own adb
                        // server is still alive; killing the server below drops the
                        // connection either way.
                        let server_alive = srv.identity.as_ref().is_some_and(|i| {
                            probe_pid_identity(runner, i) == PidLiveness::AliveMatching
                        });
                        let outcome = if !android::is_tunneled_serial(&serial) {
                            Outcome::Refused(format!(
                                "recorded serial {serial:?} is not a loopback tunnel endpoint"
                            ))
                        } else if server_alive {
                            disconnect_adb(runner, &adb, srv.server_port, &serial)
                        } else {
                            Outcome::Absent
                        };
                        outcomes.push(("adb_connection".to_string(), outcome));
                    }
                    // A recorded adb path without a serial means connect never
                    // succeeded; there is no connection resource to remove.
                    (None, _, _) => {}
                    _ => outcomes.push((
                        "adb_connection".to_string(),
                        Outcome::Refused(
                            "record carries an adb serial without a path/server; not touching adb"
                                .to_string(),
                        ),
                    )),
                }
            }
            if let Some(srv) = server {
                outcomes.push((
                    "adb_server".to_string(),
                    cleanup_process_group(
                        runner,
                        srv.identity.as_ref(),
                        srv.spawned.pgid,
                        Some(srv.server_port),
                    ),
                ));
            }
            // Keyed off its own resource, not the server: prepare can die
            // between writing the key and spawning the server.
            if let Some(vendor_key) = record.resources.adb_vendor_key.clone() {
                let run_dir = RunRecord::run_dir(runs_root, run_id);
                let key_normal = vendor_key
                    .components()
                    .all(|c| !matches!(c, std::path::Component::ParentDir));
                let key_outcome = if !key_normal || !vendor_key.starts_with(&run_dir) {
                    Outcome::Refused(format!(
                        "recorded vendor key {} is outside the run directory; not deleting",
                        vendor_key.display()
                    ))
                } else {
                    match std::fs::remove_file(&vendor_key) {
                        Ok(()) => Outcome::Removed,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Outcome::Absent,
                        Err(e) => Outcome::Unresolved(format!("cannot remove vendor key: {e}")),
                    }
                };
                outcomes.push(("adb_vendor_key".to_string(), key_outcome));
            }
            let mut tunnel_clean = true;
            let mut tunnel_port = None;
            if let Some(tunnel) = record.resources.tunnel.clone() {
                let outcome = cleanup_process_group(
                    runner,
                    tunnel.identity.as_ref(),
                    tunnel.spawned.pgid,
                    Some(tunnel.local_port),
                );
                tunnel_clean = outcome.clean();
                tunnel_port = Some(tunnel.local_port);
                outcomes.push(("tunnel".to_string(), outcome));
            }
            if let Some(farm) = record.resources.farm.clone() {
                // The lease invariant is about the forwarded port, not the
                // process group: an unresolvable group whose port probes
                // positively free still cannot expose the next lease, while a
                // foreign, shared or indeterminate port keeps the slot held.
                let forward_gone = tunnel_clean
                    || tunnel_port.is_some_and(|p| {
                        let output = runner.run(&metro::port_owner_spec(p));
                        metro::parse_port_owner(&output) == metro::PortOwners::Free
                    });
                // Releasing the lease while our forward may still be live would
                // let the next lease's device be exposed through the old run's
                // local port; the slot stays held until the port is proven free.
                let outcome = if !removal_evidence_persisted {
                    Outcome::Refused(
                        "app removal evidence could not be persisted; retaining the farm lease"
                            .to_string(),
                    )
                } else if forward_gone {
                    cleanup_farm(
                        runner,
                        &farm.ssh_host,
                        &farm.farm_path,
                        farm.slot,
                        &farm.holder,
                    )
                } else {
                    Outcome::Refused(
                        "the tunnel is neither proven removed nor its local port proven \
                         free; retaining the farm lease so the forwarded port cannot \
                         expose the next lease"
                            .to_string(),
                    )
                };
                outcomes.push(("farm_lease".to_string(), outcome));
            }
            // The exclusive device claim is released last, and only once every
            // resource capable of addressing the device (reverse mapping, adb
            // server, and the build/metro process group that drives adb with
            // this run's server socket and serial) is proven removed or absent
            // — releasing earlier could hand the phone to the next run while
            // this run still reaches it.
            // A foreign holder proves this run's claim never succeeded
            // (persist-before-claim; Strict claims are never adopted), so it
            // reads as absent.
            if let Some(usb) = record.resources.usb_device.clone() {
                let device_paths_clean = outcomes
                    .iter()
                    .filter(|(name, _)| {
                        name == "adb_reverse" || name == "adb_server" || name == "metro"
                    })
                    .all(|(_, o)| o.clean());
                let outcome = if !device_paths_clean {
                    Outcome::Refused(
                        "resources that can still address the device are not proven gone; retaining the exclusive claim"
                            .to_string(),
                    )
                } else {
                    match crate::buildplan::release_lock(&usb.lock_dir, &usb.holder, &record.run_id)
                    {
                        crate::buildplan::ReleaseOutcome::Removed => Outcome::Removed,
                        crate::buildplan::ReleaseOutcome::Absent => Outcome::Absent,
                        // Foreign proves this run's Strict claim never
                        // succeeded; nothing of ours remains to release.
                        crate::buildplan::ReleaseOutcome::Foreign(_) => Outcome::Absent,
                        crate::buildplan::ReleaseOutcome::Refused(reason) => {
                            Outcome::Refused(reason)
                        }
                        crate::buildplan::ReleaseOutcome::Unresolved(reason) => {
                            Outcome::Unresolved(reason)
                        }
                    }
                };
                outcomes.push(("usb_device_claim".to_string(), outcome));
            }
        }
    }

    if let Some(lease) = record.resources.lease.clone() {
        let unclean = unclean_legs(&outcomes);
        let outcome = if record.resources.can_release_build_ownership()
            && record.resources.can_release_borrowed_ios_stop()
            && unclean.is_empty()
        {
            release_lease_outcome(crate::lease::release(&lease))
        } else {
            retained_lease_outcome(&unclean, &record.run_id)
        };
        if outcome.clean() {
            record.resources.lease = None;
        }
        outcomes.push(("device_lease".to_string(), outcome));
    }

    if let Some(wt) = record.resources.pr_worktree.clone() {
        let expected = crate::worktree::pr_worktree_path(&RunRecord::run_dir(runs_root, run_id));
        let outcome = if owner_alive {
            owner_refusal()
        } else if !producers_quiescent(&outcomes) {
            Outcome::Unresolved("producer cleanup is unproven; PR worktree retained".into())
        } else if !record.resources.can_release_borrowed_ios_stop() {
            Outcome::Unresolved("simulator stop is incomplete; PR worktree retained".into())
        } else if wt.path != expected {
            Outcome::Refused(format!(
                "recorded worktree {} is not this run's; not removing it",
                wt.path.display()
            ))
        } else {
            crate::worktree::remove(runner, &wt.repo_root, &wt.path)
        };
        if outcome.clean() {
            record.resources.pr_worktree = None;
        }
        outcomes.push(("pr_worktree".to_string(), outcome));
    }

    if let Some(lock) = record.resources.build_lock.clone() {
        let outcome = if !record.resources.can_release_build_ownership() {
            Outcome::Unresolved("build process cleanup is unproven; build lock retained".into())
        } else {
            release_recorded_lock(&lock, &record.run_id)
        };
        outcomes.push(("build_lock".to_string(), outcome));
    }
    // Cleanup ran the simulator legs first, so a crashed creation's unrecorded simulator is gone before the count is.
    if let Some(lock) = record.resources.pool_create_lock.clone() {
        let simulator_clean = outcomes
            .iter()
            .all(|(leg, outcome)| leg != "simulator" || outcome.clean());
        let outcome = if simulator_clean {
            release_recorded_lock(&lock, &record.run_id)
        } else {
            Outcome::Unresolved("simulator cleanup is unproven; pool creation lock retained".into())
        };
        outcomes.push(("pool_create_lock".to_string(), outcome));
    }

    finish_cleanup(
        runner,
        runs_root,
        run_id,
        remove_app,
        &mut record,
        outcomes,
        true,
    )
}

fn release_recorded_lock(lock: &crate::runrecord::BuildLockResource, run_id: &str) -> Outcome {
    match crate::buildplan::release_lock(&lock.lock_dir, &lock.holder, run_id) {
        crate::buildplan::ReleaseOutcome::Removed => Outcome::Removed,
        crate::buildplan::ReleaseOutcome::Absent => Outcome::Absent,
        // Foreign: this run never won the lock, or a later build adopted it after this run died (AdoptDead).
        crate::buildplan::ReleaseOutcome::Foreign(_) => Outcome::Absent,
        crate::buildplan::ReleaseOutcome::Refused(reason) => Outcome::Refused(reason),
        crate::buildplan::ReleaseOutcome::Unresolved(reason) => Outcome::Unresolved(reason),
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_cleanup(
    runner: &mut dyn Runner,
    runs_root: &Path,
    run_id: &str,
    remove_app: Option<&str>,
    record: &mut RunRecord,
    outcomes: Vec<(String, Outcome)>,
    persist: bool,
) -> Receipt {
    let all_clean = outcomes.iter().all(|(_, o)| o.clean());
    let any_refused = outcomes
        .iter()
        .any(|(_, o)| matches!(o, Outcome::Refused(_)));
    let result = if all_clean {
        ReceiptResult::Cleaned
    } else if any_refused {
        ReceiptResult::Refused
    } else {
        ReceiptResult::Failed
    };

    let at = timefmt::iso8601_utc(runner.now_epoch_ms());
    let prev_phase = record.phase;
    let save_result = if persist {
        let note: Vec<String> = outcomes
            .iter()
            .map(|(n, o)| format!("{n}={}", o.render()))
            .collect();
        record.push_history(at.clone(), &format!("cleanup: {}", note.join(" ")));
        if all_clean {
            record.phase = Phase::Cleaned;
        } else if remove_app.is_some() && record.phase == Phase::Cleaned {
            record.phase = Phase::Failed;
        }
        record.save(runs_root)
    } else {
        Ok(())
    };
    // A cleaned verdict that could not be made durable is not a cleaned run:
    // the next status would read the stale phase and contradict this receipt.
    // The receipt must also carry the durable phase, not the in-memory one.
    let result = match (&save_result, result) {
        (Err(_), ReceiptResult::Cleaned) => {
            record.phase = prev_phase;
            ReceiptResult::Failed
        }
        (_, r) => r,
    };

    let mut receipt = Receipt::new("cleanup", run_id, result, record.phase.as_str(), at);
    receipt.scenario = Some(super::scenario_identity(&record));
    receipt.candidate = Some(record.candidate.clone());
    receipt.device = Some(super::device_identity(&record));
    receipt.build = record.build.clone();
    receipt.build_lock = record.build_lock.clone();
    receipt.core_cleanup = record.resources.core_cleanup.clone();
    receipt.fresh_install = record.resources.fresh_install.clone();
    receipt.lane = record.resources.lane.clone();
    for (name, outcome) in &outcomes {
        receipt.cleanup.insert(name.clone(), outcome.render());
    }
    if let (Some(_), Some(removal)) = (
        remove_app,
        record
            .resources
            .app_install
            .as_ref()
            .and_then(|i| i.removal.as_ref()),
    ) {
        receipt
            .outcomes
            .insert("app_removal_at".to_string(), removal.at.clone());
        receipt.outcomes.insert(
            "app_removal_outcome".to_string(),
            removal.outcome.to_string(),
        );
        receipt.outcomes.insert(
            "app_installed_sha256".to_string(),
            removal.installed_sha256.clone(),
        );
        receipt.outcomes.insert(
            "app_removal_uninstall".to_string(),
            removal.uninstall.to_string(),
        );
        receipt.outcomes.insert(
            "app_removal_pm_path".to_string(),
            removal.pm_path_after.to_string(),
        );
        receipt.outcomes.insert(
            "app_removal_package_list".to_string(),
            removal.package_list_after.to_string(),
        );
    }
    receipt.failure = match result {
        ReceiptResult::Refused => Some(Failure::new(
            "cleanup",
            FailureCode::OwnershipUnproven,
            format!(
                "not proven ours or unresolved: {}",
                outcomes
                    .iter()
                    .filter(|(_, o)| !o.clean())
                    .map(|(n, o)| format!("{n} ({})", o.render()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            "resolve the listed resources manually; qaren will not touch them",
        )),
        ReceiptResult::Failed => Some(Failure::new(
            "cleanup",
            FailureCode::CleanupIncomplete,
            format!(
                "some resources could not be resolved: {}",
                outcomes
                    .iter()
                    .filter(|(_, o)| matches!(o, Outcome::Unresolved(_)))
                    .map(|(n, o)| format!("{n} ({})", o.render()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            format!("re-run qaren cleanup {run_id} --json"),
        )),
        _ => None,
    };
    if let Err(save_failure) = save_result {
        receipt.outcomes.insert(
            "record_saved".to_string(),
            format!("failed: {}", save_failure.detail),
        );
        receipt.failure = Some(Failure::new(
            "cleanup",
            FailureCode::RunRecordUpdateFailed,
            format!(
                "cleanup outcomes were computed but the run record could not be persisted: {}",
                save_failure.detail
            ),
            format!("fix .qaren permissions, then re-run qaren cleanup {run_id} --json"),
        ));
    }
    receipt.next_action = match result {
        ReceiptResult::Cleaned => "nothing left; the run is fully cleaned".to_string(),
        _ => receipt
            .failure
            .as_ref()
            .map(|f| f.next_action.to_string())
            .unwrap_or_default(),
    };
    receipt.commands_executed = runner.commands_executed();
    super::attach_artifacts(&mut receipt, runs_root, &record);
    receipt
}

// The recorded serial must match the adapter that owns it: a loopback endpoint
// for farm runs, the exclusively claimed serial for USB runs. Anything else is
// not ours to address.
#[allow(clippy::too_many_arguments)]
fn push_reverse_outcome(
    runner: &mut dyn Runner,
    record: &RunRecord,
    outcomes: &mut Vec<(String, Outcome)>,
    reverse_port: u16,
    serial: String,
    adb: std::path::PathBuf,
    srv: &crate::runrecord::AdbServerResource,
    is_usb: bool,
) {
    let serial_legal = if is_usb {
        record
            .resources
            .usb_device
            .as_ref()
            .is_some_and(|usb| usb.serial == serial)
    } else {
        android::is_tunneled_serial(&serial)
    };
    let liveness = srv.identity.as_ref().map(|i| probe_pid_identity(runner, i));
    let outcome = if !serial_legal {
        Outcome::Refused(format!(
            "recorded serial {serial:?} does not match the run's device adapter; not addressing it"
        ))
    } else {
        match liveness {
            Some(PidLiveness::AliveMatching) => {
                let removed = runner.run(&android::adb_reverse_remove_spec(
                    &adb,
                    srv.server_port,
                    &serial,
                    reverse_port,
                ));
                if removed.timed_out {
                    Outcome::Unresolved("adb reverse --remove timed out".to_string())
                } else if removed.ok() {
                    Outcome::Removed
                } else if listener_not_found(&removed) {
                    // A missing *device* error is not proof of absence.
                    Outcome::Absent
                } else {
                    Outcome::Unresolved(format!(
                        "adb reverse --remove tcp:{reverse_port}: {}",
                        removed.summary()
                    ))
                }
            }
            // Reverse forwards live on the device keyed to the transport of
            // the run's own adb server; that server proven gone means the
            // transport closed and adbd dropped the mapping with it.
            Some(PidLiveness::Dead) | Some(PidLiveness::AliveForeign) => Outcome::Absent,
            Some(PidLiveness::Unknown) | None => Outcome::Unresolved(
                "the run's adb server liveness is unprovable; the reverse mapping cannot be resolved"
                    .to_string(),
            ),
        }
    };
    outcomes.push(("adb_reverse".to_string(), outcome));
}

fn removal_confirmed(record: &RunRecord, confirmation: &str) -> Result<(), String> {
    if record.resources.android_emulator.is_some() {
        return Err("a borrowed emulator keeps the app; uninstall it yourself".to_string());
    }
    let farm_route = record.scenario.platform == Platform::Android
        && record.resources.usb_device.is_none()
        && record.scenario.android_usb.is_none();
    let Some(farm) = record.resources.farm.as_ref().filter(|_| farm_route) else {
        return Err(
            "app removal is supported only for the leased Android emulator route; this run records no farm lease"
                .to_string(),
        );
    };
    let expected = format!(
        "{}/{}/{}",
        record.run_id, farm.remote_serial, record.candidate.app_id
    );
    if confirmation == expected {
        Ok(())
    } else {
        Err(format!(
            "confirmation {confirmation:?} does not name this run, its leased emulator serial and its app id as <run-id>/<remote-serial>/<app-id>; nothing was touched"
        ))
    }
}

fn probe_evidence(output: &CmdOutput) -> crate::redact::OutputText {
    let code = output
        .exit_code
        .map_or("none".to_string(), |c| c.to_string());
    crate::redact::OutputText::from_output(&format!(
        "exit={code} timed_out={} stdout={:?} stderr={:?}",
        output.timed_out, output.stdout, output.stderr
    ))
}

// A silent `pm path` exit 1 can mean absence; require an independent package-list read.
fn absence_proven(path: &CmdOutput, list: &CmdOutput, app_id: &str) -> Result<bool, String> {
    if path.timed_out || path.exit_code.is_none() {
        return Err(format!("pm path: {}", path.summary()));
    }
    if !list.ok() || !list.stderr.is_empty() {
        return Err(format!("pm list packages: {}", list.summary()));
    }
    if !path.stderr.is_empty() {
        return Err(format!("pm path: {}", path.summary()));
    }
    if !android::pm_path_packages(&path.stdout).is_empty()
        || android::package_list_has_exact(&list.stdout, app_id)
    {
        return Ok(false);
    }
    Ok(true)
}

fn identity_owned(
    runner: &mut dyn Runner,
    what: &str,
    identity: Option<&PidIdentity>,
) -> Result<(), Outcome> {
    match identity.map(|i| probe_pid_identity(runner, i)) {
        Some(PidLiveness::AliveMatching) => Ok(()),
        Some(PidLiveness::Dead) | Some(PidLiveness::AliveForeign) => Err(Outcome::Refused(
            format!("the run's {what} is no longer this run's process; the device path is not proven ours"),
        )),
        Some(PidLiveness::Unknown) => Err(Outcome::Unresolved(format!(
            "{what} liveness probe was inconclusive"
        ))),
        None => Err(Outcome::Refused(format!(
            "the run's {what} was recorded without a process identity"
        ))),
    }
}

// Re-prove ownership at the destructive boundary; preserve any prior removal evidence.
fn remove_app_install(
    runner: &mut dyn Runner,
    record: &RunRecord,
) -> (Outcome, Option<AppRemoval>) {
    let Some(install) = record.resources.app_install.as_ref() else {
        return (
            Outcome::Refused(
                "no successful installation is recorded for this run; a legacy record cannot prove which package it owns"
                    .to_string(),
            ),
            None,
        );
    };
    if let Some(removal) = &install.removal {
        return (
            if removal.outcome == "removed" || removal.outcome == "absent" {
                Outcome::Absent
            } else {
                Outcome::Refused(format!(
                    "a prior removal attempt remains {}; preserving its evidence without retrying removal",
                    removal.outcome
                ))
            },
            None,
        );
    }
    let (Some(farm), Some(tunnel), Some(server), Some(serial), Some(adb)) = (
        record.resources.farm.as_ref(),
        record.resources.tunnel.as_ref(),
        record.resources.adb_server.as_ref(),
        record.resources.adb_local_serial.as_ref(),
        record.resources.adb_path.as_ref(),
    ) else {
        return (
            Outcome::Refused(
                "the run record lacks the farm lease, tunnel, adb server, serial or adb path needed to prove ownership"
                    .to_string(),
            ),
            None,
        );
    };
    let app_id = record.candidate.app_id.as_str();
    let artifact_sha = install.artifact.sha256.to_ascii_lowercase();
    if install.app_id != app_id
        || install.serial != *serial
        || install.server_port != server.server_port
        || install.artifact.kind != crate::buildplan::ArtifactKind::Apk
        || artifact_sha.len() != 64
    {
        return (
            Outcome::Refused(
                "the recorded installation is bound to a different app id, serial, adb server or artifact than this run's resources"
                    .to_string(),
            ),
            None,
        );
    }
    if !record.farm_serial_consistent() {
        return (
            Outcome::Refused(format!(
                "recorded serial {serial:?} is not the tunnel endpoint of farm port {}",
                farm.adb_port
            )),
            None,
        );
    }

    let status = runner.run(&android::farm_status_spec(&farm.ssh_host, &farm.farm_path));
    if !status.ok() {
        return (
            Outcome::Unresolved(format!("farm status unreachable: {}", status.summary())),
            None,
        );
    }
    let Some(slot) = android::parse_slot_status(&status.stdout, farm.slot) else {
        return (
            Outcome::Unresolved(format!(
                "farm status has no parseable line for slot {}",
                farm.slot
            )),
            None,
        );
    };
    if !farm.matches_live(&slot) {
        return (
            Outcome::Refused(format!(
                "slot {} is live as lease={:?} avd={} serial={} adb_port={} state={}, not this run's {:?} {} {} {} device",
                farm.slot,
                android::lease_holder_token(&slot.lease),
                slot.avd,
                slot.serial,
                slot.adb_port,
                slot.state,
                farm.holder,
                farm.avd,
                farm.remote_serial,
                farm.adb_port
            )),
            None,
        );
    }
    if let Err(outcome) = identity_owned(runner, "tunnel", tunnel.identity.as_ref()) {
        return (outcome, None);
    }
    if let Err(outcome) = identity_owned(runner, "adb server", server.identity.as_ref()) {
        return (outcome, None);
    }
    let port = server.server_port;
    let state = runner.run(&android::adb_get_state_spec(adb, port, serial));
    if !state.ok() || state.stdout.trim() != "device" {
        return (
            Outcome::Unresolved(format!(
                "device state through the run's adb server: {}",
                state.summary()
            )),
            None,
        );
    }

    let path_before = runner.run(&android::pm_path_spec(adb, port, serial, app_id));
    if path_before.timed_out || path_before.exit_code.is_none() {
        return (
            Outcome::Unresolved(format!("pm path: {}", path_before.summary())),
            None,
        );
    }
    let paths = android::pm_path_packages(&path_before.stdout);
    if !paths.is_empty() && (!path_before.ok() || !path_before.stderr.is_empty()) {
        return (
            Outcome::Unresolved(format!("pm path: {}", path_before.summary())),
            None,
        );
    }
    let apk_path = match paths.as_slice() {
        [] => {
            let list = runner.run(&android::pm_list_packages_spec(adb, port, serial, app_id));
            return match absence_proven(&path_before, &list, app_id) {
                Ok(true) => (
                    Outcome::Absent,
                    Some(AppRemoval {
                        at: timefmt::iso8601_utc(runner.now_epoch_ms()),
                        outcome: crate::redact::OutputText::from_output("absent"),
                        installed_sha256: String::new(),
                        uninstall: crate::redact::OutputText::from_output("not issued: package absent before removal"),
                        pm_path_after: probe_evidence(&path_before),
                        package_list_after: probe_evidence(&list),
                    }),
                ),
                Ok(false) => (
                    Outcome::Refused(
                        "pm path reports no path while the package list still names the package; not guessing"
                            .to_string(),
                    ),
                    None,
                ),
                Err(reason) => (
                    Outcome::Unresolved(format!("installed state could not be read: {reason}")),
                    None,
                ),
            };
        }
        [path] if android::is_user_base_apk_path(path) => path.clone(),
        [path] => {
            return (
                Outcome::Refused(format!(
                    "installed path {path:?} is not a user base.apk under /data/app; not addressing it"
                )),
                None,
            )
        }
        many => {
            return (
                Outcome::Refused(format!(
                    "{} package paths reported; split or multiple APKs are outside the supported single-APK installation path",
                    many.len()
                )),
                None,
            )
        }
    };
    let hash_out = runner.run(&android::sha256sum_spec(adb, port, serial, &apk_path));
    if !hash_out.ok() {
        return (
            Outcome::Unresolved(format!(
                "installed APK hash could not be read: {}",
                hash_out.summary()
            )),
            None,
        );
    }
    let Some(installed_sha) = android::parse_sha256sum(&hash_out.stdout, &apk_path) else {
        return (
            Outcome::Unresolved(format!(
                "sha256sum output was unparseable: {}",
                hash_out.summary()
            )),
            None,
        );
    };
    if installed_sha != artifact_sha {
        return (
            Outcome::Refused(format!(
                "installed base.apk sha256 {installed_sha} does not match this run's installed artifact {artifact_sha}"
            )),
            None,
        );
    }

    let at = timefmt::iso8601_utc(runner.now_epoch_ms());
    let uninstall = runner.run(&android::uninstall_spec(adb, port, serial, app_id));
    let path_after = runner.run(&android::pm_path_spec(adb, port, serial, app_id));
    let list_after = runner.run(&android::pm_list_packages_spec(adb, port, serial, app_id));
    let reported_success = uninstall.ok() && uninstall.stdout.contains("Success");
    let outcome = match (
        reported_success,
        absence_proven(&path_after, &list_after, app_id),
    ) {
        (true, Ok(true)) => Outcome::Removed,
        (_, Ok(false)) => Outcome::Unresolved("package still present after uninstall".to_string()),
        (false, Ok(true)) => Outcome::Unresolved(format!(
            "uninstall did not report Success ({}) although the package now probes absent",
            uninstall.summary()
        )),
        (_, Err(reason)) => Outcome::Unresolved(format!("absence could not be proven: {reason}")),
    };
    let removal = AppRemoval {
        at,
        outcome: crate::redact::OutputText::from_output(&outcome.render()),
        installed_sha256: installed_sha,
        uninstall: probe_evidence(&uninstall),
        pm_path_after: probe_evidence(&path_after),
        package_list_after: probe_evidence(&list_after),
    };
    (outcome, Some(removal))
}

// Neither record carries exact host PID/birth ownership, so observation cannot authorize signals.
pub(crate) fn cleanup_scoped_runner_hosts(runner: &mut dyn Runner, udid: &str) -> Outcome {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    match settled_runner_hosts(runner, udid, false) {
        ios::RunnerHostPresence::Absent => Outcome::Absent,
        ios::RunnerHostPresence::Present => Outcome::Unresolved(
            "runner host present without exact process ownership; left untouched".into(),
        ),
        ios::RunnerHostPresence::Unknown => Outcome::Unresolved(
            "exact simulator runner host absence is unknown; left untouched".into(),
        ),
    }
}

fn settled_runner_hosts(
    runner: &mut dyn Runner,
    udid: &str,
    after_terminate: bool,
) -> ios::RunnerHostPresence {
    let mut presence = ios::RunnerHostPresence::Unknown;
    for attempt in 0..3 {
        presence = ios::probe_runner_hosts(runner, udid);
        if presence == ios::RunnerHostPresence::Absent
            || (presence == ios::RunnerHostPresence::Present && !after_terminate)
        {
            return presence;
        }
        if attempt < 2 {
            runner.sleep(std::time::Duration::from_millis(200));
        }
    }
    presence
}

// A bundle id cannot prove whether XCTest is still initializing; only observe a leftover host.
fn cleanup_owned_runner_host(
    runner: &mut dyn Runner,
    host: &crate::runrecord::RunnerHostResource,
) -> Outcome {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    match settled_runner_hosts(runner, &host.udid, false) {
        ios::RunnerHostPresence::Absent => return Outcome::Absent,
        ios::RunnerHostPresence::Unknown => {
            return Outcome::Unresolved(
                "exact simulator runner host absence is unknown; left untouched".into(),
            )
        }
        ios::RunnerHostPresence::Present => {}
    }
    match settled_runner_hosts(runner, &host.udid, true) {
        ios::RunnerHostPresence::Absent => Outcome::Absent,
        ios::RunnerHostPresence::Present => Outcome::Unresolved(
            "runner host remains; automation shutdown is unproven; left untouched".into(),
        ),
        ios::RunnerHostPresence::Unknown => {
            Outcome::Unresolved("runner host absence is unknown; left untouched".into())
        }
    }
}

// Each recorded driver group is signaled only while its recorded leader identity still matches.
pub(crate) fn cleanup_runner_drivers(
    runner: &mut dyn Runner,
    record: &mut RunRecord,
    runs_root: &Path,
) -> Option<Outcome> {
    if record.resources.runner_drivers.is_empty() {
        return None;
    }
    let mut outcomes = Vec::new();
    let mut kept = Vec::new();
    for driver in record.resources.runner_drivers.clone() {
        let outcome = cleanup_ios_automation_group(runner, Some(&driver.identity), driver.pgid);
        if !outcome.clean() {
            kept.push(driver);
        }
        outcomes.push(outcome);
    }
    let previous = std::mem::replace(&mut record.resources.runner_drivers, kept);
    if record.save(runs_root).is_err() {
        record.resources.runner_drivers = previous;
        return Some(Outcome::Unresolved(
            "runner driver retirement could not be persisted".into(),
        ));
    }
    let removed = outcomes
        .iter()
        .any(|outcome| matches!(outcome, Outcome::Removed | Outcome::RemovedBytes(_)));
    Some(
        outcomes
            .into_iter()
            .find(|outcome| !outcome.clean())
            .unwrap_or(if removed {
                Outcome::Removed
            } else {
                Outcome::Absent
            }),
    )
}

// Interrupt only the driver so XCTest can cancel its session before its helpers exit.
pub(crate) fn cleanup_ios_automation_group(
    runner: &mut dyn Runner,
    identity: Option<&PidIdentity>,
    pgid: i32,
) -> Outcome {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    if pgid < 2 {
        return Outcome::Refused("invalid iOS automation process group".into());
    }
    runner.try_reap(pgid);
    match metro::group_presence(runner, pgid) {
        metro::GroupPresence::Absent => return Outcome::Absent,
        metro::GroupPresence::Unknown => {
            return Outcome::Unresolved("iOS automation group inventory is unknown".into())
        }
        metro::GroupPresence::Present => {}
    }
    let Some(identity) = identity.filter(|identity| identity.pid == pgid) else {
        return Outcome::Unresolved("iOS automation driver identity is unproven".into());
    };
    if probe_pid_identity(runner, identity) != PidLiveness::AliveMatching {
        runner.sleep(Duration::from_millis(300));
        runner.try_reap(pgid);
        return match metro::group_presence(runner, pgid) {
            metro::GroupPresence::Absent => Outcome::Absent,
            _ => Outcome::Unresolved("iOS automation driver ownership is unproven".into()),
        };
    }
    if !crate::runrecord::probe_pid_birth(runner, identity).1 {
        return Outcome::Unresolved("iOS automation driver birth changed; left untouched".into());
    }
    runner.run(&CmdSpec::new(
        "kill-group",
        "/bin/kill",
        &["-INT", "--", &pgid.to_string()],
        10,
    ));
    for _ in 0..30 {
        runner.sleep(Duration::from_secs(1));
        runner.try_reap(pgid);
        match metro::group_presence(runner, pgid) {
            metro::GroupPresence::Absent => return Outcome::Removed,
            metro::GroupPresence::Unknown => break,
            metro::GroupPresence::Present => {}
        }
        if probe_pid_identity(runner, identity) != PidLiveness::AliveMatching {
            break;
        }
    }
    Outcome::Unresolved(
        "iOS automation did not finish graceful cancellation; left untouched".into(),
    )
}

pub(crate) fn cleanup_runner_host(runner: &mut dyn Runner, record: &RunRecord) -> Option<Outcome> {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    let sim = record.resources.ios_simulator.as_ref()?;
    if record.resources.core.is_none()
        && record.resources.core_cleanup.is_none()
        && record.resources.runner_host.is_none()
    {
        return None;
    }
    let lease = record.resources.lease.as_ref()?;
    let held = crate::buildplan::read_holder(&lease.lock_dir)
        .is_some_and(|h| h.holder == lease.holder && h.run_id == record.run_id);
    if !held {
        return None;
    }
    if record.resources.core.is_some()
        || record
            .resources
            .core_cleanup
            .as_ref()
            .is_some_and(|evidence| {
                !matches!(
                    evidence.outcome,
                    crate::runrecord::GroupCleanupResult::Removed
                        | crate::runrecord::GroupCleanupResult::Absent
                )
            })
    {
        return Some(Outcome::Refused(
            "core quiescence is unproven; runner host left untouched".into(),
        ));
    }
    if !record.resources.runner_drivers.is_empty() {
        return Some(Outcome::Refused(
            "runner driver quiescence is unproven; runner host left untouched".into(),
        ));
    }
    Some(match record.resources.runner_host.as_ref() {
        Some(host) if host.udid == sim.udid => cleanup_owned_runner_host(runner, host),
        _ => cleanup_scoped_runner_hosts(runner, &sim.udid),
    })
}

// Releases what a run put on a borrowed emulator: its Metro reverse and the core's runner.
// The adb server, the app and the emulator are never touched.
pub(crate) fn release_borrowed_android(
    runner: &mut dyn Runner,
    record: &RunRecord,
) -> Vec<(String, Outcome)> {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    let Some(emulator) = record.resources.android_emulator.as_ref() else {
        return Vec::new();
    };
    let mut legs: Vec<&str> = Vec::new();
    if record.resources.adb_reverse_port.is_some() {
        legs.push("adb_reverse");
    }
    // Only a walk starts a runner. Walking is saved before the core spawns, so a run killed
    // while spawning it is probed too.
    if record.phase == Phase::Walking
        || record.resources.core.is_some()
        || record.resources.core_cleanup.is_some()
    {
        legs.push("android_runner");
    }
    if legs.is_empty() {
        return Vec::new();
    }
    let every = |outcome: Outcome| {
        legs.iter()
            .map(|leg| (leg.to_string(), outcome.clone()))
            .collect::<Vec<_>>()
    };
    if !record.holds_device_lease() {
        return every(Outcome::Refused(
            "the device lease is not held by this run".into(),
        ));
    }
    let (Some(adb), Some(serial)) = (
        record.resources.adb_path.clone(),
        record.resources.adb_local_serial.clone(),
    ) else {
        return every(Outcome::Unresolved(
            "the run's adb path or serial is not recorded; remove its reverse and runner manually"
                .into(),
        ));
    };
    if serial != emulator.serial {
        return every(Outcome::Refused(format!(
            "recorded serial {serial:?} is not the borrowed emulator {:?}; not addressing it",
            emulator.serial
        )));
    }
    let port = emulator.server_port;
    if let Err(reason) = android::borrowed_server_compatible(runner, &adb, port) {
        return every(Outcome::Unresolved(reason));
    }
    legs.iter()
        .map(|leg| {
            let outcome = match *leg {
                "adb_reverse" => {
                    let reverse_port = record.resources.adb_reverse_port.expect("leg recorded");
                    release_reverse(runner, &adb, port, &serial, reverse_port)
                }
                _ => release_android_runner(runner, record, &adb, port, &serial),
            };
            (leg.to_string(), outcome)
        })
        .collect()
}

fn release_reverse(
    runner: &mut dyn Runner,
    adb: &Path,
    port: u16,
    serial: &str,
    reverse_port: u16,
) -> Outcome {
    let removed = runner.run(&android::adb_reverse_remove_spec(
        adb,
        port,
        serial,
        reverse_port,
    ));
    if removed.timed_out {
        Outcome::Unresolved("adb reverse --remove timed out".to_string())
    } else if listener_not_found(&removed) {
        Outcome::Absent
    } else if !removed.ok() {
        Outcome::Unresolved(format!(
            "adb reverse --remove tcp:{reverse_port}: {}",
            removed.summary()
        ))
    } else {
        // A reported removal counts only once the device no longer lists the mapping.
        let listed = runner.run(&android::adb_reverse_list_spec(adb, port, serial));
        if !listed.ok() {
            Outcome::Unresolved(format!("adb reverse --list: {}", listed.summary()))
        } else if android::reverse_listed(&listed.stdout, reverse_port) {
            Outcome::Unresolved(format!(
                "adb reverse --remove tcp:{reverse_port} succeeded but the device still lists it"
            ))
        } else {
            Outcome::Removed
        }
    }
}

// adb's own "listener 'tcp:<port>' not found": the mapping is positively absent.
fn listener_not_found(output: &CmdOutput) -> bool {
    (output.stdout.contains("listener") || output.stderr.contains("listener"))
        && (output.stdout.contains("not found") || output.stderr.contains("not found"))
}

// The checks of the core's runner reaper, ported so cleanup needs no Node runtime.
fn release_android_runner(
    runner: &mut dyn Runner,
    record: &RunRecord,
    adb: &Path,
    port: u16,
    serial: &str,
) -> Outcome {
    let core_quiescent = record.resources.core.is_none()
        && record
            .resources
            .core_cleanup
            .as_ref()
            .is_none_or(|evidence| {
                matches!(
                    evidence.outcome,
                    GroupCleanupResult::Removed | GroupCleanupResult::Absent
                )
            });
    if !core_quiescent {
        return Outcome::Refused("core quiescence is unproven; runner left untouched".into());
    }
    if !record.resources.runner_drivers.is_empty() {
        return Outcome::Refused(
            "runner driver quiescence is unproven; runner left untouched".into(),
        );
    }
    let found = match read_runner(runner, adb, port, serial) {
        Ok(state) => state,
        Err(reason) => return Outcome::Unresolved(reason),
    };
    if found.absent() {
        return Outcome::Absent;
    }
    for host_port in found.forwards {
        runner.run(&android::forward_remove_spec(adb, port, serial, host_port));
    }
    for package in android::RUNNER_PACKAGES {
        runner.run(&android::force_stop_spec(adb, port, serial, package));
    }
    match read_runner(runner, adb, port, serial) {
        Ok(after) if after.absent() => Outcome::Removed,
        Ok(after) => Outcome::Unresolved(format!(
            "the runner remains after force-stop (forward {}, instrumentation {})",
            if after.forward_remains {
                "listed"
            } else {
                "gone"
            },
            if after.instrumenting {
                "running"
            } else {
                "gone"
            }
        )),
        Err(reason) => Outcome::Unresolved(reason),
    }
}

struct RunnerState {
    forwards: Vec<u16>,
    forward_remains: bool,
    instrumenting: bool,
}

impl RunnerState {
    fn absent(&self) -> bool {
        !self.forward_remains && !self.instrumenting
    }
}

// Only successful reads count; a failed probe never reads as absence.
fn read_runner(
    runner: &mut dyn Runner,
    adb: &Path,
    port: u16,
    serial: &str,
) -> Result<RunnerState, String> {
    let forwards = runner.run(&android::forward_list_spec(adb, port));
    if !forwards.ok() {
        return Err(format!("adb forward --list: {}", forwards.summary()));
    }
    let processes = runner.run(&android::runner_processes_spec(adb, port, serial));
    if !processes.ok() {
        return Err(format!(
            "dumpsys activity processes: {}",
            processes.summary()
        ));
    }
    let Some(instrumenting) = android::runner_in_processes(&processes.stdout) else {
        return Err("dumpsys activity processes: unrecognised output".to_string());
    };
    Ok(RunnerState {
        forwards: android::runner_forwards(&forwards.stdout, serial),
        forward_remains: android::runner_forward_remains(&forwards.stdout, serial),
        instrumenting,
    })
}

pub(crate) fn producers_quiescent(outcomes: &[(String, Outcome)]) -> bool {
    outcomes
        .iter()
        .filter(|(name, _)| {
            matches!(
                name.as_str(),
                "build_process"
                    | "core"
                    | "metro"
                    | "recorder"
                    | "runner_driver"
                    | "runner_host"
                    | "android_runner"
            )
        })
        .all(|(_, outcome)| matches!(outcome, Outcome::Removed | Outcome::Absent))
}

pub(crate) fn unclean_legs(outcomes: &[(String, Outcome)]) -> Vec<String> {
    outcomes
        .iter()
        .filter(|(_, o)| !o.clean())
        .map(|(name, _)| name.clone())
        .collect()
}

pub(crate) fn retained_lease_outcome(unclean: &[String], run_id: &str) -> Outcome {
    Outcome::Unresolved(format!(
        "retained: {} not proven gone; qaren cleanup {run_id} releases it",
        unclean.join(", ")
    ))
}

// A foreign holder proves this run's Strict claim never succeeded, so there is nothing of ours to release.
pub(crate) fn release_lease_outcome(outcome: crate::buildplan::ReleaseOutcome) -> Outcome {
    match outcome {
        crate::buildplan::ReleaseOutcome::Removed => Outcome::Removed,
        crate::buildplan::ReleaseOutcome::Absent => Outcome::Absent,
        crate::buildplan::ReleaseOutcome::Foreign(_) => Outcome::Absent,
        crate::buildplan::ReleaseOutcome::Refused(reason) => Outcome::Refused(reason),
        crate::buildplan::ReleaseOutcome::Unresolved(reason) => Outcome::Unresolved(reason),
    }
}

pub(crate) fn reclaimed_bytes(runner: &mut dyn Runner, path: &Path) -> Option<u64> {
    let output = runner.run(&CmdSpec::new(
        "cleanup-storage-size",
        "du",
        &["-sk", &path.to_string_lossy()],
        10,
    ));
    output
        .ok()
        .then(|| {
            output
                .stdout
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()?
                .checked_mul(1024)
        })
        .flatten()
}

fn kill_group(
    runner: &mut dyn Runner,
    identity: Option<&PidIdentity>,
    pgid: i32,
    signal: &str,
) -> Result<(), Outcome> {
    let probed = identity
        .filter(|i| i.pid == pgid)
        .map(|i| crate::runrecord::probe_pid_birth(runner, i));
    if !probed.is_some_and(|(_, pinned)| pinned) {
        let liveness = probed.map(|(liveness, _)| liveness);
        runner.try_reap(pgid);
        return Err(
            if liveness == Some(PidLiveness::Dead)
                && metro::group_presence(runner, pgid) == metro::GroupPresence::Absent
            {
                Outcome::Removed
            } else {
                Outcome::Unresolved(
                    "process group signal withheld: current leader ownership is unproven".into(),
                )
            },
        );
    }
    runner.run(&CmdSpec::new(
        "kill-group",
        "/bin/kill",
        &[signal, "--", &format!("-{pgid}")],
        10,
    ));
    Ok(())
}

pub(crate) fn cleanup_build(
    runner: &mut dyn Runner,
    record: &mut RunRecord,
    runs_root: &Path,
) -> Option<Outcome> {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    use crate::runrecord::{BuildCompletionEvidence, BuildProcess};
    let (pgid, outcome) = match record.resources.build_process()? {
        BuildProcess::SpawnPending => {
            return Some(Outcome::Unresolved(
                "build spawn identity is unproven".into(),
            ))
        }
        BuildProcess::Running { pgid, identity } => (
            *pgid,
            cleanup_process_group(runner, identity.as_ref(), *pgid, None),
        ),
    };
    let mut retired = record.clone();
    if retired
        .resources
        .finish_build(BuildCompletionEvidence::Group {
            pgid,
            outcome: outcome.group_result(),
        })
        .is_ok()
    {
        if retired.save(runs_root).is_err() {
            return Some(Outcome::Unresolved(
                "build retirement could not be persisted".into(),
            ));
        }
        *record = retired;
    }
    Some(outcome)
}

pub(crate) fn cleanup_core(
    runner: &mut dyn Runner,
    record: &mut RunRecord,
    runs_root: &Path,
    wait_unresolved: bool,
) -> Option<Outcome> {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    use crate::runrecord::CoreCleanupEvidence;
    let core = record.resources.core.clone()?;
    let mut outcome = cleanup_process_group(runner, core.identity.as_ref(), core.pgid, None);
    if wait_unresolved && outcome.clean() {
        outcome = Outcome::Unresolved("the core exit/pipe grace remained unresolved".into());
    }
    let previous = record.resources.core_cleanup.clone();
    record.resources.core_cleanup = Some(CoreCleanupEvidence {
        run_id: record.run_id.clone(),
        pgid: core.pgid,
        at: timefmt::iso8601_utc(runner.now_epoch_ms()),
        outcome: outcome.group_result(),
    });
    if record.save(runs_root).is_err() {
        record.resources.core_cleanup = previous;
        return Some(Outcome::Unresolved(
            "core cleanup evidence could not be persisted".into(),
        ));
    }
    if outcome.clean() {
        record.resources.core = None;
        if record.save(runs_root).is_err() {
            record.resources.core = Some(core);
            return Some(Outcome::Unresolved(
                "core resource retirement could not be persisted".into(),
            ));
        }
    }
    Some(outcome)
}

// Unported groups require a complete group inventory; signaling remains ownership-gated.
pub(crate) fn cleanup_process_group(
    runner: &mut dyn Runner,
    identity: Option<&PidIdentity>,
    pgid: i32,
    port: Option<u16>,
) -> Outcome {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    // kill -pgid with 0/1/negative has catastrophic special semantics; a record
    // carrying such a value is corrupt and must be refused.
    if pgid < 2 {
        return Outcome::Refused(format!(
            "recorded pgid {pgid} is not a plausible process group"
        ));
    }
    if port.is_none() {
        use metro::GroupPresence;
        // An unreaped leader keeps the group present; its owner reaps it first (never a release by itself).
        runner.try_reap(pgid);
        match metro::group_presence(runner, pgid) {
            GroupPresence::Absent => return Outcome::Absent,
            GroupPresence::Unknown => {
                return Outcome::Unresolved("process-group inventory is unknown".into())
            }
            GroupPresence::Present => {}
        }
        if !identity.is_some_and(|i| {
            i.pid == pgid && probe_pid_identity(runner, i) == PidLiveness::AliveMatching
        }) {
            // Observation only: 10.3s additional budget (300ms settle + one 10s inventory probe).
            runner.sleep(Duration::from_millis(300));
            runner.try_reap(pgid);
            return match metro::group_presence(runner, pgid) {
                GroupPresence::Absent => Outcome::Absent,
                GroupPresence::Present => Outcome::Unresolved(
                    "process group remains but its leader ownership is unproven".into(),
                ),
                GroupPresence::Unknown => {
                    Outcome::Unresolved("process-group inventory after settling is unknown".into())
                }
            };
        }
        if let Err(outcome) = kill_group(runner, identity, pgid, "-TERM") {
            return outcome;
        }
        runner.sleep(Duration::from_millis(1500));
        if let Err(outcome) = kill_group(runner, identity, pgid, "-KILL") {
            return outcome;
        }
        runner.sleep(Duration::from_millis(300));
        runner.try_reap(pgid);
        return match metro::group_presence(runner, pgid) {
            GroupPresence::Absent => Outcome::Removed,
            GroupPresence::Present => {
                Outcome::Unresolved("process group survived TERM and KILL".into())
            }
            GroupPresence::Unknown => {
                Outcome::Unresolved("process-group inventory after KILL is unknown".into())
            }
        };
    }
    let leader = identity.map(|recorded| probe_pid_identity(runner, recorded));
    let group_live_via_port = port.map(|p| {
        let output = runner.run(&metro::port_owner_spec(p));
        match metro::parse_port_owner(&output) {
            metro::PortOwners::Owned(pid) => {
                metro::pgid_of(runner, pid).map(|owner_pgid| owner_pgid == pgid)
            }
            metro::PortOwners::Free => Some(false),
            _ => None,
        }
    });

    let proven_ours = identity.is_some_and(|recorded| recorded.pid == pgid)
        && leader == Some(PidLiveness::AliveMatching);
    let outcome = if proven_ours {
        if let Err(outcome) = kill_group(runner, identity, pgid, "-TERM") {
            return outcome;
        }
        runner.sleep(Duration::from_millis(1500));
        if let Err(outcome) = kill_group(runner, identity, pgid, "-KILL") {
            return outcome;
        }
        runner.sleep(Duration::from_millis(300));
        let leader_after = identity.map(|recorded| probe_pid_identity(runner, recorded));
        if leader_after == Some(PidLiveness::AliveMatching) {
            return Outcome::Unresolved("group leader survived TERM and KILL".to_string());
        }
        if let Some(p) = port {
            let output = runner.run(&metro::port_owner_spec(p));
            match metro::parse_port_owner(&output) {
                metro::PortOwners::Free => {}
                metro::PortOwners::Owned(pid) => match metro::pgid_of(runner, pid) {
                    Some(owner) if owner == pgid => {
                        return Outcome::Unresolved(format!(
                            "port {p} still owned by the group after KILL"
                        ))
                    }
                    Some(_) => {}
                    None => {
                        return Outcome::Unresolved(format!(
                            "port {p} owner could not be attributed after KILL"
                        ))
                    }
                },
                metro::PortOwners::Multiple => {
                    return Outcome::Unresolved(format!(
                        "port {p} has multiple listeners after KILL"
                    ))
                }
                metro::PortOwners::Unknown => {
                    return Outcome::Unresolved(format!(
                        "port {p} state could not be determined after KILL"
                    ))
                }
            }
        }
        Outcome::Removed
    } else {
        match leader {
            // No recorded identity: a free or foreign port proves nothing about a
            // group that may still be starting up; never guess absent.
            None => Outcome::Unresolved(
                "no recorded leader identity; \
             resolve the process group manually"
                    .to_string(),
            ),
            Some(PidLiveness::Dead) => match group_live_via_port {
                Some(Some(false)) | None => Outcome::Absent,
                Some(Some(true)) => Outcome::Unresolved(
                    "process group remains but its leader ownership is unproven".into(),
                ),
                Some(None) => {
                    Outcome::Unresolved("port owner pgid could not be determined".to_string())
                }
            },
            Some(PidLiveness::AliveForeign) => Outcome::Unresolved(
                "ownership unproven: the recorded leader birth identity belongs to another process"
                    .into(),
            ),
            Some(PidLiveness::Unknown) => {
                Outcome::Unresolved("pid liveness probe was inconclusive".to_string())
            }
            Some(PidLiveness::AliveMatching) => {
                Outcome::Unresolved("recorded leader does not match the process group".into())
            }
        }
    };
    if !matches!(outcome, Outcome::Absent | Outcome::Removed) {
        return outcome;
    }
    runner.try_reap(pgid);
    match metro::group_presence(runner, pgid) {
        metro::GroupPresence::Absent => outcome,
        metro::GroupPresence::Present => {
            Outcome::Unresolved("process group remains present".into())
        }
        metro::GroupPresence::Unknown => {
            Outcome::Unresolved("process-group inventory is unknown".into())
        }
    }
}

pub(crate) fn cleanup_borrowed_ios(
    runner: &mut dyn Runner,
    record: &mut RunRecord,
    runs_root: &Path,
    outcomes: &[(String, Outcome)],
    external_owner_alive: bool,
    runtime_context: Option<(&Path, &Path)>,
) -> Outcome {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    match record.resources.borrowed_ios_stop() {
        crate::runrecord::BorrowedIosStop::NotArmed => return Outcome::Kept,
        crate::runrecord::BorrowedIosStop::Completed => return Outcome::Absent,
        crate::runrecord::BorrowedIosStop::Pending => {}
    }
    if external_owner_alive {
        return Outcome::Refused("the run's qaren process is alive or unproven gone".into());
    }
    if !record.holds_device_lease() {
        return Outcome::Refused("the device lease is not held by this run".into());
    }
    if !record.resources.can_release_build_ownership() {
        return Outcome::Unresolved("build process cleanup is unproven; simulator retained".into());
    }
    if !producers_quiescent(outcomes)
        || record.resources.core.is_some()
        || !record.resources.runner_drivers.is_empty()
        || record.resources.recorder.is_some()
    {
        return Outcome::Unresolved("producer cleanup is unproven; simulator retained".into());
    }
    let Some(sim) = record
        .resources
        .ios_simulator
        .clone()
        .filter(crate::runrecord::Resources::ios_simulator_canonical)
    else {
        return Outcome::Refused(
            "recorded simulator resource is missing or lacks canonical identity".into(),
        );
    };
    if record
        .scenario
        .ios
        .as_ref()
        .is_some_and(|spec| spec.device_type != sim.device_type || spec.runtime != sim.runtime)
    {
        return Outcome::Refused(
            "recorded simulator resource does not match scenario runtime or device type".into(),
        );
    }
    if !record.candidate.project_root.is_dir() {
        return Outcome::Unresolved(
            "candidate working directory is unavailable for strict foreign-driver admission; simulator retained"
                .into(),
        );
    }
    let default_ctx;
    let resolved_ctx = match runtime_context {
        Some((node, runtime_dir)) => Some((node, runtime_dir)),
        None => {
            default_ctx = (
                crate::run::resolve_node_for_record(record),
                crate::run::default_runtime_dir(),
            );
            Some((default_ctx.0.as_path(), default_ctx.1.as_path()))
        }
    };
    let Some((node, runtime_dir)) =
        resolved_ctx.filter(|(n, r)| !n.as_os_str().is_empty() && !r.as_os_str().is_empty())
    else {
        return Outcome::Unresolved(
            "CLI runtime context is unavailable for strict foreign-driver admission; simulator retained"
                .into(),
        );
    };
    if let Err(failure) = crate::core::fresh_install_admission(
        runner,
        node,
        runtime_dir,
        &record.candidate.project_root,
        &sim.udid,
        None,
        None,
    ) {
        return Outcome::Unresolved(format!(
            "strict foreign-driver admission did not clear simulator stop: {}",
            failure.detail
        ));
    }
    let outcome = match ios::shutdown_selected_sim(
        runner,
        &sim.udid,
        &sim.device_type,
        &sim.runtime,
    ) {
        ios::SelectedSimShutdown::ShutDown => Outcome::Removed,
        ios::SelectedSimShutdown::AlreadyShutdown => Outcome::Absent,
        ios::SelectedSimShutdown::InventoryInvalid => Outcome::Unresolved(
            "simulator inventory did not prove the exact selected simulator before shutdown; simulator retained"
                .into(),
        ),
        ios::SelectedSimShutdown::ShutdownFailed => Outcome::Unresolved(
            "simctl shutdown did not complete successfully for the selected simulator".into(),
        ),
        ios::SelectedSimShutdown::ReadbackInvalid => Outcome::Unresolved(
            "inventory did not prove the exact selected simulator Shutdown with unchanged runtime and device type"
                .into(),
        ),
    };
    if !matches!(outcome, Outcome::Removed | Outcome::Absent) {
        return outcome;
    }
    let prev = record.resources.borrowed_ios_stop();
    if record
        .resources
        .complete_borrowed_ios_stop(&sim.udid)
        .is_err()
    {
        return Outcome::Unresolved(
            "simulator stop completion transition is invalid; simulator stop state retained".into(),
        );
    }
    if let Err(failure) = record.save(runs_root) {
        record.resources.revert_borrowed_ios_stop(prev);
        return Outcome::Unresolved(format!(
            "simulator stop completed but the run record could not be persisted: {}",
            failure.detail
        ));
    }
    outcome
}

fn cleanup_simulator(runner: &mut dyn Runner, udid: &str, expected_name: &str) -> Outcome {
    let list = runner.run(&ios::list_devices_spec());
    if !list.ok() {
        return Outcome::Unresolved(format!("simctl list failed: {}", list.summary()));
    }
    // An empty udid is a pending allocation whose create crashed before the
    // udid was learned; the run-scoped name is the recovery key.
    let (resolved_udid, state) = if udid.is_empty() {
        match ios::parse_sim_named(&list.stdout, expected_name) {
            ios::SimNamed::Absent => return Outcome::Absent,
            ios::SimNamed::Unparseable => {
                return Outcome::Unresolved("simctl list output was unparseable".to_string())
            }
            ios::SimNamed::Ambiguous(n) => {
                return Outcome::Refused(format!(
                    "{n} simulators carry the run-scoped name {expected_name:?}; not guessing"
                ))
            }
            ios::SimNamed::Found { udid, state } => (udid, state),
        }
    } else {
        match ios::parse_sim_presence(&list.stdout, udid) {
            ios::SimPresence::Absent => return Outcome::Absent,
            ios::SimPresence::Unparseable => {
                return Outcome::Unresolved("simctl list output was unparseable".to_string())
            }
            ios::SimPresence::Present { name, state } => {
                if name != expected_name {
                    return Outcome::Refused(format!(
                        "simulator {udid} is named {name:?}, expected {expected_name:?}; not ours to delete"
                    ));
                }
                (udid.to_string(), state)
            }
        }
    };
    if state == "Booted" {
        let shutdown = runner.run(&ios::shutdown_spec(&resolved_udid));
        if !shutdown.ok() {
            return Outcome::Unresolved(format!("simctl shutdown failed: {}", shutdown.summary()));
        }
    }
    let data_path = serde_json::from_str::<serde_json::Value>(&list.stdout)
        .ok()
        .and_then(|list| {
            list["devices"].as_object().and_then(|devices| {
                devices
                    .values()
                    .filter_map(|v| v.as_array())
                    .flatten()
                    .find(|device| device["udid"].as_str() == Some(&resolved_udid))
                    .and_then(|device| device["dataPath"].as_str().map(std::path::PathBuf::from))
            })
        });
    let bytes = data_path
        .as_deref()
        .filter(|path| path.is_absolute())
        .and_then(|path| reclaimed_bytes(runner, path));
    let delete = runner.run(&ios::delete_spec(&resolved_udid));
    if delete.ok() {
        Outcome::RemovedBytes(bytes)
    } else {
        Outcome::Unresolved(format!("simctl delete failed: {}", delete.summary()))
    }
}

fn disconnect_adb(runner: &mut dyn Runner, adb: &Path, server_port: u16, serial: &str) -> Outcome {
    let output = runner.run(&android::adb_disconnect_spec(adb, server_port, serial));
    if output.timed_out {
        return Outcome::Unresolved("adb disconnect timed out".to_string());
    }
    if output.ok() {
        Outcome::Removed
    } else if output.stdout.contains("no such device") || output.stderr.contains("no such device") {
        Outcome::Absent
    } else {
        Outcome::Unresolved(format!("adb disconnect {serial}: {}", output.summary()))
    }
}

fn cleanup_farm(
    runner: &mut dyn Runner,
    ssh_host: &str,
    farm_path: &str,
    slot: u8,
    holder: &str,
) -> Outcome {
    let status = runner.run(&android::farm_status_spec(ssh_host, farm_path));
    if !status.ok() {
        return Outcome::Unresolved(format!("farm status unreachable: {}", status.summary()));
    }
    let Some(slot_status) = android::parse_slot_status(&status.stdout, slot) else {
        return Outcome::Unresolved(format!("farm status has no parseable line for slot {slot}"));
    };
    let lease_holder = android::lease_holder_token(&slot_status.lease);
    if slot_status.lease == "free" {
        if slot_status.state == "down" {
            return Outcome::Absent;
        }
        return Outcome::Refused(format!(
            "slot {slot} has no lease but state {:?}; a foreign emulator may be running",
            slot_status.state
        ));
    }
    if lease_holder != holder {
        return Outcome::Refused(format!(
            "slot {slot} is leased by {lease_holder:?}, not {holder:?}; not ours to stop"
        ));
    }
    let stop = runner.run(&android::farm_stop_spec(ssh_host, farm_path, slot));
    if stop.ok() && stop.stdout.contains(&format!("stopped slot={slot}")) {
        Outcome::Removed
    } else {
        Outcome::Unresolved(format!("android-farm stop: {}", stop.summary()))
    }
}

#[cfg(test)]
mod integrity_tests {
    use super::*;
    use crate::exec::MockRunner;

    const BIRTH: &str = "Wed Aug 12 16:01:00 2026";

    const HOST_UDID: &str = "AAAABBBB-1111-2222-3333-444455556666";

    fn host_probe(runner: &mut MockRunner, output: CmdOutput) {
        let inventory = serde_json::json!({"devices":{
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{
                "udid": HOST_UDID, "state":"Booted", "isAvailable":true,
                "name":"owned", "deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"
            }]
        }});
        runner.expect_run(
            "simctl list devices -j",
            CmdOutput::success(&inventory.to_string()),
        );
        runner.expect_run("launchctl list", output);
    }

    #[test]
    fn runner_host_transient_unknown_is_reproven_in_the_same_cleanup() {
        let mut runner = MockRunner::new();
        host_probe(&mut runner, CmdOutput::failed(1, "temporarily unavailable"));
        host_probe(
            &mut runner,
            CmdOutput::success("PID Status Label\n1 0 com.apple.SpringBoard\n"),
        );
        assert!(matches!(
            cleanup_scoped_runner_hosts(&mut runner, HOST_UDID),
            Outcome::Absent
        ));
        assert_eq!(runner.remaining(), 0);
        assert!(!runner
            .calls
            .iter()
            .any(|spec| spec.label == "simctl-terminate"));
        assert!(runner.calls.iter().all(|spec| match spec.label.as_str() {
            "simctl-list" => spec.timeout_seconds == 30,
            "simctl-launchctl" => spec.timeout_seconds == 20,
            _ => false,
        }));
    }

    #[test]
    fn runner_host_unknown_stays_unresolved_after_bounded_reads() {
        let mut runner = MockRunner::new();
        for _ in 0..3 {
            host_probe(&mut runner, CmdOutput::success("incomplete\n"));
        }
        assert!(matches!(
            cleanup_scoped_runner_hosts(&mut runner, HOST_UDID),
            Outcome::Unresolved(_)
        ));
        assert_eq!(runner.remaining(), 0);
        assert_eq!(runner.calls.len(), 6);
    }

    #[test]
    fn automation_cancellation_never_escalates_when_initialization_does_not_settle() {
        let mut runner = MockRunner::new();
        let identity = crate::runrecord::PidIdentity {
            pid: 9000,
            started_at: "Wed Aug 12 16:02:00 2026".into(),
            command: crate::redact::OutputText::from_output(""),
        };
        let present = CmdOutput::success("1 1 S\n9000 9000 S\n9001 9000 S\n");
        runner.expect_run("ps -A", present.clone());
        for _ in 0..2 {
            runner.expect_run("lstart=", CmdOutput::success(&identity.started_at));
            runner.expect_run("stat=", CmdOutput::success("S"));
        }
        runner.expect_run("/bin/kill -INT -- 9000", CmdOutput::success(""));
        for _ in 0..30 {
            runner.expect_run("ps -A", present.clone());
            runner.expect_run("lstart=", CmdOutput::success(&identity.started_at));
            runner.expect_run("stat=", CmdOutput::success("S"));
        }
        assert!(matches!(
            cleanup_ios_automation_group(&mut runner, Some(&identity), 9000),
            Outcome::Unresolved(_)
        ));
        assert_eq!(runner.remaining(), 0);
        assert_eq!(
            runner
                .calls
                .iter()
                .filter(|c| c.program == "/bin/kill")
                .count(),
            1
        );
    }

    #[test]
    fn owned_runner_host_waits_for_natural_exit_without_terminating() {
        for transient in [
            "PID Status Label\n42 0 dev.lykhoyda.rndevagent.fastrunner\n",
            "incomplete\n",
        ] {
            let mut runner = MockRunner::new();
            host_probe(
                &mut runner,
                CmdOutput::success("PID Status Label\n42 0 dev.lykhoyda.rndevagent.fastrunner\n"),
            );
            host_probe(&mut runner, CmdOutput::success(transient));
            host_probe(
                &mut runner,
                CmdOutput::success("PID Status Label\n1 0 com.apple.SpringBoard\n"),
            );
            let host = crate::runrecord::RunnerHostResource {
                udid: HOST_UDID.into(),
                bundle_ids: vec![ios::RUNNER_HOST_BUNDLE_ID.into()],
            };
            assert!(matches!(
                cleanup_owned_runner_host(&mut runner, &host),
                Outcome::Absent
            ));
            assert_eq!(runner.remaining(), 0);
            assert_eq!(
                runner
                    .calls
                    .iter()
                    .filter(|spec| spec.label == "simctl-terminate")
                    .count(),
                0
            );
        }
    }

    #[test]
    fn every_signal_rechecks_identity_with_and_without_a_port() {
        for port in [None, Some(8081)] {
            for change_at in ["TERM", "KILL"] {
                for changed in [
                    CmdOutput::success("foreign birth"),
                    CmdOutput::failed(1, "unknown"),
                ] {
                    let identity = PidIdentity {
                        pid: 5000,
                        started_at: BIRTH.into(),
                        command: crate::redact::OutputText::from_output("node"),
                    };
                    let mut runner = MockRunner::new();
                    if port.is_none() {
                        runner.expect_run("ps -A", CmdOutput::success("5000 5000 S\n"));
                    }
                    runner.expect_run("lstart=", CmdOutput::success(BIRTH));
                    runner.expect_run("stat=", CmdOutput::success("S"));
                    if port.is_some() {
                        runner.expect_run("lsof", CmdOutput::success("5000\n"));
                        runner.expect_run("pgid=", CmdOutput::success("5000"));
                    }
                    if change_at == "KILL" {
                        runner.expect_run("lstart=", CmdOutput::success(BIRTH));
                        runner.expect_run("stat=", CmdOutput::success("S"));
                        runner.expect_run("/bin/kill -TERM", CmdOutput::success(""));
                    }
                    runner.expect_run("lstart=", changed);
                    let outcome = cleanup_process_group(&mut runner, Some(&identity), 5000, port);
                    assert!(matches!(outcome, Outcome::Unresolved(_)), "{outcome:?}");
                    let signals: Vec<_> = runner
                        .calls
                        .iter()
                        .filter(|c| c.program == "/bin/kill")
                        .map(|c| c.args[0].as_str())
                        .collect();
                    assert_eq!(
                        signals,
                        if change_at == "KILL" {
                            vec!["-TERM"]
                        } else {
                            vec![]
                        }
                    );
                    assert_eq!(runner.remaining(), 0);
                }
            }
        }
    }

    #[test]
    fn simulator_removal_reports_measured_bytes_including_pending_recovery() {
        for udid in ["AAAA-1111", ""] {
            let mut runner = MockRunner::new();
            runner.expect_run("simctl list", CmdOutput::success(r#"{"devices":{"rt":[{"udid":"AAAA-1111","name":"qaren-run","state":"Shutdown","dataPath":"/owned/simulator/data"}]}}"#));
            runner.expect_run(
                "du -sk /owned/simulator/data",
                CmdOutput::success("12\t/owned/simulator/data\n"),
            );
            runner.expect_run("simctl delete AAAA-1111", CmdOutput::success(""));
            let outcome = cleanup_simulator(&mut runner, udid, "qaren-run");
            assert!(outcome.clean());
            assert_eq!(outcome.render(), "removed (reclaimed 12288 bytes)");
            assert_eq!(runner.remaining(), 0);
        }
    }
}
