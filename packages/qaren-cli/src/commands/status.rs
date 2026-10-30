use crate::adapters::{android, ios, metro};
use crate::exec::Runner;
use crate::failure::{Failure, FailureCode};
use crate::receipt::{Receipt, ReceiptResult};
use crate::runrecord::{probe_pid_identity, Phase, PidLiveness, RunRecord};
use crate::scenario::Platform;
use crate::timefmt;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Probe {
    Pass,
    Fail,
    Inconclusive,
}

// Spawn/tempfile/wait errors surface as exit_code None; only a real exit code
// may produce a definitive pass/fail.
fn tri(output: &crate::exec::CmdOutput, pass: bool) -> Probe {
    if output.timed_out || output.exit_code.is_none() {
        Probe::Inconclusive
    } else if pass {
        Probe::Pass
    } else {
        Probe::Fail
    }
}

pub fn status(runner: &mut dyn Runner, runs_root: &Path, run_id: &str) -> Receipt {
    let record = match RunRecord::load(runs_root, run_id) {
        Ok(record) => record,
        Err(failure) => {
            let mut receipt = Receipt::new(
                "status",
                run_id,
                ReceiptResult::Unknown,
                "load",
                timefmt::iso8601_utc(runner.now_epoch_ms()),
            );
            receipt.next_action = failure.next_action.to_string();
            receipt.failure = Some(failure);
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
    };

    let (result, outcomes, failure) = match record.phase {
        Phase::Cleaned => (ReceiptResult::Cleaned, Vec::new(), None),
        // A recorded contention outcome is a refusal, not an execution
        // failure; status must echo the same classification prepare emitted.
        Phase::Failed => {
            let refused = record.failure.as_ref().is_some_and(|f| f.code.is_refusal());
            (
                if refused {
                    ReceiptResult::Refused
                } else {
                    ReceiptResult::Failed
                },
                Vec::new(),
                record.failure.clone(),
            )
        }
        Phase::Ready | Phase::Walking => probe_ready(runner, &record),
        Phase::HandedOff => probe_handoff(runner, runs_root, &record),
        Phase::Created | Phase::DepsInstalled | Phase::ResourcesAllocated | Phase::Building => {
            probe_working(runner, &record)
        }
    };

    let mut receipt = Receipt::new(
        "status",
        run_id,
        result,
        record.phase.as_str(),
        timefmt::iso8601_utc(runner.now_epoch_ms()),
    );
    receipt.scenario = Some(super::scenario_identity(&record));
    receipt.candidate = Some(record.candidate.clone());
    receipt.device = Some(super::device_identity(&record));
    receipt.metro = super::metro_identity(&record);
    receipt.build = record.build.clone();
    for (name, probe) in outcomes {
        let value = match probe {
            Probe::Pass => "pass",
            Probe::Fail => "fail",
            Probe::Inconclusive => "inconclusive",
        };
        receipt.outcomes.insert(name, value.to_string());
    }
    receipt.build_lock = record.build_lock.clone();
    receipt.recovery = failure.as_ref().and_then(|f| f.build_recovery().cloned());
    receipt.failure = failure;
    if let Some(substage) = &record.substage {
        receipt
            .outcomes
            .insert("substage".to_string(), substage.clone());
    }
    // Recorded state, distinct from the handoff_issued probe row: a run can
    // record `completed` while the live probe row independently fails.
    if let Some(handoff) = &record.handoff {
        receipt.outcomes.insert(
            "handoff_state".to_string(),
            if handoff.completed_at.is_some() {
                "completed".to_string()
            } else {
                "issued".to_string()
            },
        );
    }
    receipt.next_action = match result {
        ReceiptResult::Ready if record.phase == Phase::HandedOff => {
            match record.handoff.as_ref().and_then(|h| h.completed_at.as_ref()) {
                Some(_) => format!(
                    "the managed install is bound; agents attach via qaren, then: qaren cleanup {run_id} --json"
                ),
                None => format!(
                    "run the qaren managed build/bind chain (docs/qa/cooperative-qa.md), then: qaren complete {run_id} <build-log> --json"
                ),
            }
        }
        ReceiptResult::Ready => "resources are live; agents can attach".to_string(),
        ReceiptResult::Working => "prepare is still running; poll status again".to_string(),
        ReceiptResult::Cleaned => "nothing to do; the run is fully cleaned".to_string(),
        // The recorded failure knows whether anything is owned; a pre-allocation
        // failure's fix-and-retry action must not be replaced with cleanup.
        ReceiptResult::Failed | ReceiptResult::Refused => receipt
            .failure
            .as_ref()
            .map(|f| f.next_action.to_string())
            .unwrap_or_else(|| format!("qaren cleanup {run_id} --json")),
        _ => "re-run status; if still unknown, inspect the run directory".to_string(),
    };
    // Retention is the record's intent; the probe rows above say whether Metro and the lease are still live.
    if let Some(held) = record
        .held
        .as_ref()
        .filter(|_| record.phase == Phase::Walking)
    {
        receipt.outcomes.insert(
            "held".to_string(),
            format!(
                "{} since {}: {}",
                held.reason,
                held.since,
                held.retained.join(", ")
            ),
        );
        receipt.next_action = format!(
            "look at the simulator if needed, then qaren cleanup {run_id} --json to release Metro, the simulator and the device lease"
        );
        receipt.held = Some(held.clone());
    }
    receipt.commands_executed = runner.commands_executed();
    super::attach_artifacts(&mut receipt, runs_root, &record);
    receipt
}

fn overall(outcomes: &[(String, Probe)]) -> ReceiptResult {
    if outcomes.iter().any(|(_, p)| *p == Probe::Fail) {
        ReceiptResult::Failed
    } else if outcomes.iter().any(|(_, p)| *p == Probe::Inconclusive) {
        ReceiptResult::Unknown
    } else {
        ReceiptResult::Ready
    }
}

fn probe_ready(
    runner: &mut dyn Runner,
    record: &RunRecord,
) -> (ReceiptResult, Vec<(String, Probe)>, Option<Failure>) {
    let mut outcomes = Vec::new();

    // A ready run without a recorded build decision cannot bind its evidence
    // to a native fingerprint; report the gap instead of full readiness.
    if record.build.is_none() {
        outcomes.push(("build_plan_recorded".to_string(), Probe::Inconclusive));
    }

    if let Some(m) = &record.resources.metro {
        let port_output = runner.run(&metro::port_owner_spec(m.port));
        let port_probe = match metro::parse_port_owner(&port_output) {
            metro::PortOwners::Owned(pid) => {
                if metro::pgid_of(runner, pid) == Some(m.spawned.pgid) {
                    Probe::Pass
                } else {
                    Probe::Fail
                }
            }
            metro::PortOwners::Free | metro::PortOwners::Multiple => Probe::Fail,
            metro::PortOwners::Unknown => Probe::Inconclusive,
        };
        outcomes.push(("metro_port_owned".to_string(), port_probe));
        outcomes.push((
            "metro_responding".to_string(),
            if port_probe != Probe::Pass {
                // Do not talk to a listener that is not proven ours.
                Probe::Inconclusive
            } else if metro::metro_responding(runner, m.port) {
                Probe::Pass
            } else {
                Probe::Fail
            },
        ));
    } else {
        outcomes.push(("metro_recorded".to_string(), Probe::Fail));
    }

    match record.scenario.platform {
        Platform::Ios => probe_ios(runner, record, &mut outcomes),
        Platform::Android => probe_android(runner, record, &mut outcomes),
    }

    let result = overall(&outcomes);
    let failure = (result == ReceiptResult::Failed).then(|| {
        Failure::new(
            "status",
            FailureCode::Interrupted,
            "one or more readiness probes now fail for a run recorded as ready",
            format!("qaren cleanup {} --json", record.run_id),
        )
    });
    (result, outcomes, failure)
}

// A handed-off run owns only its allocation (simulator or USB claim) plus the
// issued handoff document; Metro, build, install, and app runtime belong to
// the qaren session and are never probed here. The one exception is a
// read-only app_installed probe on the run-scoped iOS simulator once the
// managed install receipt is bound.
fn probe_handoff(
    runner: &mut dyn Runner,
    runs_root: &Path,
    record: &RunRecord,
) -> (ReceiptResult, Vec<(String, Probe)>, Option<Failure>) {
    let mut outcomes = Vec::new();
    // The document on disk must be byte-identical to what this run issued —
    // a rewritten or foreign handoff.json fails the probe rather than passing
    // on mere existence.
    let document_path = crate::handoff::document_path(runs_root, &record.run_id);
    let (handoff_probe, document) = match &record.handoff {
        Some(state) => match std::fs::read(&document_path) {
            Ok(raw) if crate::candidate::sha256_hex(&raw) == state.document_sha256 => {
                match serde_json::from_slice::<crate::handoff::HandoffDocument>(&raw) {
                    Ok(document) => (Probe::Pass, Some(document)),
                    Err(_) => (Probe::Fail, None),
                }
            }
            Ok(_) => (Probe::Fail, None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Probe::Fail, None),
            Err(_) => (Probe::Inconclusive, None),
        },
        None => (Probe::Fail, None),
    };
    outcomes.push(("handoff_issued".to_string(), handoff_probe));
    let completed = record
        .handoff
        .as_ref()
        .is_some_and(|h| h.completed_at.is_some());
    let validity_failure = (!completed && handoff_probe == Probe::Pass)
        .then(|| {
            crate::handoff::verify_validity_window(
                record,
                document
                    .as_ref()
                    .expect("passing handoff probe has document"),
                runner.now_epoch_ms(),
                "status",
            )
        })
        .and_then(Result::err);
    if !completed && handoff_probe == Probe::Pass {
        outcomes.push((
            "handoff_validity".to_string(),
            if validity_failure.is_some() {
                Probe::Fail
            } else {
                Probe::Pass
            },
        ));
    }
    match record.scenario.platform {
        Platform::Ios => {
            if probe_ios_simulator(runner, record, &mut outcomes) && completed {
                if let Some(sim) = &record.resources.ios_simulator {
                    let container = runner.run(&ios::app_container_spec(
                        &sim.udid,
                        &record.candidate.app_id,
                    ));
                    outcomes.push(("app_installed".to_string(), tri(&container, container.ok())));
                }
            }
        }
        Platform::Android => {
            probe_usb_claim(runner, record, &mut outcomes);
        }
    }
    if let Some(failure) = validity_failure {
        let result = if failure.code == FailureCode::ReadyDeadlineExceeded {
            ReceiptResult::Refused
        } else {
            ReceiptResult::Failed
        };
        return (result, outcomes, Some(failure));
    }
    let result = overall(&outcomes);
    let failure = (result == ReceiptResult::Failed).then(|| {
        Failure::new(
            "status",
            FailureCode::Interrupted,
            "one or more allocation probes now fail for a handed-off run",
            format!("qaren cleanup {} --json", record.run_id),
        )
    });
    (result, outcomes, failure)
}

fn probe_ios_simulator(
    runner: &mut dyn Runner,
    record: &RunRecord,
    outcomes: &mut Vec<(String, Probe)>,
) -> bool {
    let Some(sim) = &record.resources.ios_simulator else {
        outcomes.push(("simulator_recorded".to_string(), Probe::Fail));
        return false;
    };
    if record.resources.device_borrowed {
        return probe_borrowed_ios_simulator(runner, record, sim, outcomes);
    }
    let list = runner.run(&ios::list_devices_spec());
    let sim_probe = if !list.ok() {
        Probe::Inconclusive
    } else {
        match ios::parse_sim_presence(&list.stdout, &sim.udid) {
            ios::SimPresence::Present { name, state } if name == sim.name && state == "Booted" => {
                Probe::Pass
            }
            ios::SimPresence::Unparseable => Probe::Inconclusive,
            _ => Probe::Fail,
        }
    };
    outcomes.push(("simulator_booted".to_string(), sim_probe));
    sim_probe == Probe::Pass
}

// A borrowed simulator is ours only while this run holds its lease; app visibility alone is not custody.
fn probe_borrowed_ios_simulator(
    runner: &mut dyn Runner,
    record: &RunRecord,
    sim: &crate::runrecord::IosSimResource,
    outcomes: &mut Vec<(String, Probe)>,
) -> bool {
    if !record.holds_device_lease() {
        outcomes.push(("device_lease_held".to_string(), Probe::Fail));
        return false;
    }
    outcomes.push(("device_lease_held".to_string(), Probe::Pass));
    let list = runner.run(&ios::list_devices_spec());
    let sim_probe = if !list.ok() || !list.stderr.is_empty() || list.stdout.len() >= 1024 * 1024 {
        Probe::Inconclusive
    } else {
        match ios::parse_selected_sim(&list.stdout, &sim.udid) {
            Some(observed)
                if observed.state == ios::SimState::Booted
                    && observed.device_type == sim.device_type
                    && observed.runtime == sim.runtime =>
            {
                Probe::Pass
            }
            _ => Probe::Fail,
        }
    };
    outcomes.push(("simulator_booted".to_string(), sim_probe));
    sim_probe == Probe::Pass
}

fn probe_usb_claim(
    runner: &mut dyn Runner,
    record: &RunRecord,
    outcomes: &mut Vec<(String, Probe)>,
) -> bool {
    let _ = runner;
    let Some(usb) = &record.resources.usb_device else {
        outcomes.push(("usb_recorded".to_string(), Probe::Fail));
        return false;
    };
    // The recorded claim must be exactly the device the scenario named; an
    // inconsistent record must never cause a probe against another device.
    let scenario_bound = record
        .scenario
        .android_usb
        .as_ref()
        .is_some_and(|spec| spec.serial == usb.serial);
    if !scenario_bound {
        outcomes.push(("usb_recorded".to_string(), Probe::Fail));
        return false;
    }
    // The exclusive claim is the ownership root for every dependent probe.
    let lock_probe = match usb.lock_dir.try_exists() {
        Ok(false) => Probe::Fail,
        Err(_) => Probe::Inconclusive,
        Ok(true) => match crate::buildplan::read_holder(&usb.lock_dir) {
            Some(holder) if holder.holder == usb.holder && holder.run_id == record.run_id => {
                Probe::Pass
            }
            Some(_) => Probe::Fail,
            None => Probe::Inconclusive,
        },
    };
    outcomes.push(("usb_lock_held".to_string(), lock_probe));
    lock_probe == Probe::Pass
}

fn probe_ios(runner: &mut dyn Runner, record: &RunRecord, outcomes: &mut Vec<(String, Probe)>) {
    if !probe_ios_simulator(runner, record, outcomes) {
        // Without a proven owned+booted simulator, dependent app probes would
        // either address a foreign device or fail for the wrong reason.
        if record.resources.ios_simulator.is_some() {
            outcomes.push(("app_probes".to_string(), Probe::Inconclusive));
        }
        return;
    }
    let sim = record
        .resources
        .ios_simulator
        .as_ref()
        .expect("simulator probe passed");

    let container = runner.run(&ios::app_container_spec(
        &sim.udid,
        &record.candidate.app_id,
    ));
    outcomes.push(("app_installed".to_string(), tri(&container, container.ok())));

    let launchctl = runner.run(&ios::launchctl_list_spec(&sim.udid));
    outcomes.push((
        "app_running".to_string(),
        tri(
            &launchctl,
            launchctl.ok()
                && ios::app_running_in_launchctl(&launchctl.stdout, &record.candidate.app_id),
        ),
    ));
}

fn probe_android(runner: &mut dyn Runner, record: &RunRecord, outcomes: &mut Vec<(String, Probe)>) {
    if record.resources.android_emulator.is_some() {
        probe_borrowed_emulator(runner, record, outcomes);
        return;
    }
    if record.resources.usb_device.is_some() || record.scenario.android_usb.is_some() {
        probe_usb(runner, record, outcomes);
        return;
    }
    let Some(farm) = &record.resources.farm else {
        outcomes.push(("farm_recorded".to_string(), Probe::Fail));
        return;
    };
    let status = runner.run(&android::farm_status_spec(&farm.ssh_host, &farm.farm_path));
    let lease_probe = if !status.ok() {
        Probe::Inconclusive
    } else {
        match android::parse_slot_status(&status.stdout, farm.slot) {
            Some(slot) if farm.matches_live(&slot) => Probe::Pass,
            Some(_) => Probe::Fail,
            None => Probe::Inconclusive,
        }
    };
    outcomes.push(("farm_lease_held".to_string(), lease_probe));
    if lease_probe != Probe::Pass {
        // Without a proven lease the forwarded endpoint may belong to someone
        // else now; do not address it even read-only.
        outcomes.push(("device_probes".to_string(), Probe::Inconclusive));
        return;
    }

    let tunnel_probe = match &record.resources.tunnel {
        Some(tunnel) => match &tunnel.identity {
            Some(identity) => match probe_pid_identity(runner, identity) {
                PidLiveness::AliveMatching => Probe::Pass,
                PidLiveness::Dead | PidLiveness::AliveForeign => Probe::Fail,
                PidLiveness::Unknown => Probe::Inconclusive,
            },
            None => Probe::Inconclusive,
        },
        None => Probe::Fail,
    };
    outcomes.push(("tunnel_alive".to_string(), tunnel_probe));
    if tunnel_probe != Probe::Pass {
        // A dead tunnel means the loopback port may now be a foreign listener.
        outcomes.push(("device_probes".to_string(), Probe::Inconclusive));
        return;
    }

    let Some(serial) = &record.resources.adb_local_serial else {
        outcomes.push(("adb_serial_recorded".to_string(), Probe::Fail));
        return;
    };
    if !record.farm_serial_consistent() {
        outcomes.push(("adb_serial_recorded".to_string(), Probe::Fail));
        return;
    }
    let Some(adb) = record.resources.adb_path.clone() else {
        outcomes.push(("adb_available".to_string(), Probe::Inconclusive));
        return;
    };
    let server_probe = match &record.resources.adb_server {
        Some(server) => match &server.identity {
            Some(identity) => match probe_pid_identity(runner, identity) {
                PidLiveness::AliveMatching => Probe::Pass,
                PidLiveness::Dead | PidLiveness::AliveForeign => Probe::Fail,
                PidLiveness::Unknown => Probe::Inconclusive,
            },
            None => Probe::Inconclusive,
        },
        None => Probe::Fail,
    };
    outcomes.push(("adb_server_alive".to_string(), server_probe));
    if server_probe != Probe::Pass {
        // Without the run's own adb server there is no owned path to the device.
        outcomes.push(("device_probes".to_string(), Probe::Inconclusive));
        return;
    }
    let server_port = record
        .resources
        .adb_server
        .as_ref()
        .map(|s| s.server_port)
        .expect("server probe passed");
    probe_device_and_app(runner, record, &adb, server_port, serial, outcomes);
}

// A borrowed emulator is reached only through the adb server it was borrowed from.
fn probe_borrowed_emulator(
    runner: &mut dyn Runner,
    record: &RunRecord,
    outcomes: &mut Vec<(String, Probe)>,
) {
    let emulator = record
        .resources
        .android_emulator
        .as_ref()
        .expect("borrowed branch");
    let Some(serial) = record
        .resources
        .adb_local_serial
        .as_ref()
        .filter(|s| **s == emulator.serial)
    else {
        outcomes.push(("adb_serial_recorded".to_string(), Probe::Fail));
        return;
    };
    let Some(adb) = record.resources.adb_path.clone() else {
        outcomes.push(("adb_available".to_string(), Probe::Inconclusive));
        return;
    };
    let port = emulator.server_port;
    let alive = runner.adb_server_version(port).is_ok();
    outcomes.push((
        "adb_server_alive".to_string(),
        if alive { Probe::Pass } else { Probe::Fail },
    ));
    // Without a server, or with an adb that would restart it, no adb client runs.
    if !alive || android::borrowed_server_compatible(runner, &adb, port).is_err() {
        outcomes.push(("device_probes".to_string(), Probe::Inconclusive));
        return;
    }
    probe_device_and_app(runner, record, &adb, port, serial, outcomes);
}

fn probe_device_and_app(
    runner: &mut dyn Runner,
    record: &RunRecord,
    adb: &Path,
    server_port: u16,
    serial: &str,
    outcomes: &mut Vec<(String, Probe)>,
) {
    let state = runner.run(&android::adb_get_state_spec(adb, server_port, serial));
    let device_probe = tri(&state, state.ok() && state.stdout.trim() == "device");
    outcomes.push(("device_online".to_string(), device_probe));
    if device_probe != Probe::Pass {
        outcomes.push(("app_probes".to_string(), Probe::Inconclusive));
        return;
    }

    let installed = runner.run(&android::pm_path_spec(
        adb,
        server_port,
        serial,
        &record.candidate.app_id,
    ));
    outcomes.push((
        "app_installed".to_string(),
        tri(
            &installed,
            installed.ok() && installed.stdout.contains("package:"),
        ),
    ));

    let running = runner.run(&android::pidof_spec(
        adb,
        server_port,
        serial,
        &record.candidate.app_id,
    ));
    let has_pid = running
        .stdout
        .split_whitespace()
        .any(|t| t.parse::<u32>().is_ok());
    outcomes.push((
        "app_running".to_string(),
        tri(&running, running.ok() && has_pid),
    ));
}

fn probe_usb(runner: &mut dyn Runner, record: &RunRecord, outcomes: &mut Vec<(String, Probe)>) {
    if !probe_usb_claim(runner, record, outcomes) {
        // Without a proven exclusive claim the device may belong to another
        // run now; do not address it even read-only. (An inconsistent record
        // stops at usb_recorded without a dependent-probe row.)
        if outcomes
            .last()
            .is_some_and(|(name, _)| name == "usb_lock_held")
        {
            outcomes.push(("device_probes".to_string(), Probe::Inconclusive));
        }
        return;
    }
    let usb = record
        .resources
        .usb_device
        .as_ref()
        .expect("usb claim probe passed");

    let server_probe = match &record.resources.adb_server {
        Some(server) => match &server.identity {
            Some(identity) => match probe_pid_identity(runner, identity) {
                PidLiveness::AliveMatching => Probe::Pass,
                PidLiveness::Dead | PidLiveness::AliveForeign => Probe::Fail,
                PidLiveness::Unknown => Probe::Inconclusive,
            },
            None => Probe::Inconclusive,
        },
        None => Probe::Fail,
    };
    outcomes.push(("adb_server_alive".to_string(), server_probe));
    if server_probe != Probe::Pass {
        outcomes.push(("device_probes".to_string(), Probe::Inconclusive));
        return;
    }
    let (Some(adb), Some(serial), Some(server_port)) = (
        record.resources.adb_path.clone(),
        record.resources.adb_local_serial.clone(),
        record.resources.adb_server.as_ref().map(|s| s.server_port),
    ) else {
        outcomes.push(("adb_serial_recorded".to_string(), Probe::Fail));
        return;
    };
    let port_bound = record
        .scenario
        .android_usb
        .as_ref()
        .is_some_and(|spec| spec.adb_server_port == Some(server_port));
    if serial != usb.serial || !port_bound {
        outcomes.push(("adb_serial_recorded".to_string(), Probe::Fail));
        return;
    }

    let state = runner.run(&android::adb_get_state_spec(&adb, server_port, &serial));
    let device_probe = tri(&state, state.ok() && state.stdout.trim() == "device");
    outcomes.push(("device_online".to_string(), device_probe));
    if device_probe != Probe::Pass {
        outcomes.push(("app_probes".to_string(), Probe::Inconclusive));
        return;
    }

    let installed = runner.run(&android::pm_path_spec(
        &adb,
        server_port,
        &serial,
        &record.candidate.app_id,
    ));
    outcomes.push((
        "app_installed".to_string(),
        tri(
            &installed,
            installed.ok() && installed.stdout.contains("package:"),
        ),
    ));

    let running = runner.run(&android::pidof_spec(
        &adb,
        server_port,
        &serial,
        &record.candidate.app_id,
    ));
    let has_pid = running
        .stdout
        .split_whitespace()
        .any(|t| t.parse::<u32>().is_ok());
    outcomes.push((
        "app_running".to_string(),
        tri(&running, running.ok() && has_pid),
    ));
}

fn probe_working(
    runner: &mut dyn Runner,
    record: &RunRecord,
) -> (ReceiptResult, Vec<(String, Probe)>, Option<Failure>) {
    let Some(prepare_identity) = &record.prepare else {
        // No identity was ever captured, so liveness cannot be probed.
        return (
            ReceiptResult::Unknown,
            vec![("prepare_recorded".to_string(), Probe::Inconclusive)],
            None,
        );
    };
    match probe_pid_identity(runner, prepare_identity) {
        PidLiveness::AliveMatching => (
            ReceiptResult::Working,
            vec![("prepare_running".to_string(), Probe::Pass)],
            None,
        ),
        PidLiveness::Dead | PidLiveness::AliveForeign => (
            ReceiptResult::Failed,
            vec![("prepare_running".to_string(), Probe::Fail)],
            Some(interrupted(record)),
        ),
        PidLiveness::Unknown => (
            ReceiptResult::Unknown,
            vec![("prepare_running".to_string(), Probe::Inconclusive)],
            None,
        ),
    }
}

fn interrupted(record: &RunRecord) -> Failure {
    Failure::new(
        record.phase.as_str(),
        FailureCode::Interrupted,
        format!(
            "prepare died at phase {} without recording an outcome",
            record.phase.as_str()
        ),
        format!("qaren cleanup {} --json", record.run_id),
    )
}
