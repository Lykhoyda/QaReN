pub mod cleanup;
pub mod complete;
pub mod doctor;
pub mod prepare;
pub mod prewarm;
pub mod status;
pub mod update;

use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::receipt::{DeviceIdentity, MetroIdentity, Receipt, ScenarioIdentity};
use crate::runrecord::RunRecord;
use std::path::{Path, PathBuf};

pub fn repo_root_of_cwd(runner: &mut dyn Runner) -> Result<PathBuf, Failure> {
    let output = runner.run(&CmdSpec::new(
        "git-toplevel",
        "git",
        &["rev-parse", "--show-toplevel"],
        20,
    ));
    if !output.ok() {
        return Err(Failure::new(
            "load",
            FailureCode::CandidateGitUnavailable,
            format!("git rev-parse --show-toplevel failed: {}", output.summary()),
            "run qaren from inside the app checkout",
        ));
    }
    Ok(PathBuf::from(output.stdout.trim()))
}

pub fn log_tail(path: &Path, lines: usize) -> String {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL_BYTES: u64 = 65_536;
    let read = || -> std::io::Result<String> {
        let mut file = std::fs::File::open(path)?;
        let len = file.metadata()?.len();
        let start = len.saturating_sub(TAIL_BYTES);
        file.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)?;
        Ok(String::from_utf8_lossy(&buf).into_owned())
    };
    match read() {
        Ok(content) => {
            let all: Vec<&str> = content.lines().collect();
            let start = all.len().saturating_sub(lines);
            all[start..].join("\n")
        }
        Err(e) => format!("(log unreadable: {e})"),
    }
}

pub fn scenario_identity(record: &RunRecord) -> ScenarioIdentity {
    ScenarioIdentity {
        name: record.scenario.name.clone(),
        platform: match record.scenario.platform {
            crate::scenario::Platform::Ios => "ios".to_string(),
            crate::scenario::Platform::Android => "android".to_string(),
        },
        path: record.scenario_path.clone(),
        sha256: record.scenario_sha256.clone(),
    }
}

pub fn device_identity(record: &RunRecord) -> DeviceIdentity {
    let mut identity = DeviceIdentity {
        ios_udid: None,
        ios_name: None,
        ios_device_type: None,
        ios_runtime: None,
        farm_ssh_host: None,
        farm_path: None,
        farm_slot: None,
        farm_lease_holder: None,
        avd: None,
        remote_serial: None,
        remote_adb_port: None,
        tunnel_local_port: None,
        tunnel_identity: None,
        local_adb_serial: None,
        usb_serial: None,
        usb_lock_dir: None,
        usb_lock_holder: None,
    };
    if let Some(sim) = &record.resources.ios_simulator {
        identity.ios_udid = Some(sim.udid.clone());
        identity.ios_name = Some(sim.name.clone());
        identity.ios_device_type = Some(sim.device_type.clone());
        identity.ios_runtime = Some(sim.runtime.clone());
    }
    if let Some(farm) = &record.resources.farm {
        identity.farm_ssh_host = Some(farm.ssh_host.clone());
        identity.farm_path = Some(farm.farm_path.clone());
        identity.farm_slot = Some(farm.slot);
        identity.farm_lease_holder = Some(farm.holder.clone());
        identity.avd = Some(farm.avd.clone());
        identity.remote_serial = Some(farm.remote_serial.clone());
        identity.remote_adb_port = Some(farm.adb_port);
    }
    if let Some(tunnel) = &record.resources.tunnel {
        identity.tunnel_local_port = Some(tunnel.local_port);
        identity.tunnel_identity = tunnel.identity.clone();
    }
    identity.local_adb_serial = record.resources.adb_local_serial.clone();
    if let Some(usb) = &record.resources.usb_device {
        identity.usb_serial = Some(usb.serial.clone());
        identity.usb_lock_dir = Some(usb.lock_dir.clone());
        identity.usb_lock_holder = Some(usb.holder.clone());
    }
    identity
}

pub fn metro_identity(record: &RunRecord) -> Option<MetroIdentity> {
    record.resources.metro.as_ref().map(|m| MetroIdentity {
        port: m.port,
        endpoint: m.endpoint.clone(),
        pid: Some(m.spawned.pid),
        pgid: Some(m.spawned.pgid),
        identity: m.identity.clone(),
    })
}

pub fn attach_artifacts(receipt: &mut Receipt, runs_root: &Path, record: &RunRecord) {
    let run_dir = RunRecord::run_dir(runs_root, &record.run_id);
    receipt
        .artifacts
        .insert("run_dir".to_string(), run_dir.clone());
    receipt
        .artifacts
        .insert("run_record".to_string(), run_dir.join("run.json"));
    if let Some(metro) = &record.resources.metro {
        receipt
            .artifacts
            .insert("build_log".to_string(), metro.log.clone());
    }
    let build_log = run_dir.join("logs/expo-run-ios.log");
    if build_log.is_file() {
        if let Some(metro) = &record.resources.metro {
            receipt
                .artifacts
                .insert("metro_log".into(), metro.log.clone());
        }
        receipt.artifacts.insert("build_log".into(), build_log);
    }
    if let Some(tunnel) = &record.resources.tunnel {
        receipt
            .artifacts
            .insert("tunnel_log".to_string(), tunnel.log.clone());
    }
    if record.handoff.is_some() {
        receipt.artifacts.insert(
            "handoff".to_string(),
            crate::handoff::document_path(runs_root, &record.run_id),
        );
    }
}
