use crate::adapters::ios;
use crate::buildplan::{self, ReleaseOutcome};
use crate::commands::cleanup::{
    cleanup_ios_automation_group, cleanup_scoped_runner_hosts, Outcome,
};
use crate::core;
use crate::exec::{ChildHandle, CmdSpec, Runner};
use crate::lease::{self, Lease};
use crate::redact::OutputText;
use crate::runrecord::{
    capture_pid_identity, probe_pid_identity, validate_run_id, PidIdentity, PidLiveness,
};
use crate::scenario::Platform;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
pub struct NativeSuite {
    pub schema: String,
    pub run_id: String,
    pub device_id: String,
    pub owner: PidIdentity,
    pub lock_dir: PathBuf,
    pub lease: Option<Lease>,
    pub process: SuiteProcess,
    pub suite_exit: Option<i32>,
    pub cleanup: Option<CleanupEvidence>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SuiteProcess {
    NotSpawned,
    SpawnPending,
    Spawned {
        pgid: i32,
        identity: Option<PidIdentity>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CleanupEvidence {
    pub group: OutputText,
    #[serde(default)]
    pub admission_clear: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner_host: Option<OutputText>,
}

fn roots(runner: &dyn Runner) -> Result<(PathBuf, PathBuf), String> {
    let home = runner
        .env_var("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("HOME must be absolute")?;
    let locks = buildplan::host_lock_root(
        runner.env_var_os("QAREN_LOCK_ROOT").as_deref(),
        runner.env_var_os(buildplan::MACHINE_LOCKS_ENV).as_deref(),
        Some(home.as_os_str()),
    )
    .map_err(|error| match buildplan::lock_root_next_action(&error) {
        Some(advice) => format!("{error}; {advice}"),
        None => error,
    })?;
    let qaren_home = crate::qaren_home(
        runner.env_var_os("QAREN_HOME").as_deref(),
        Some(home.as_os_str()),
    )?;
    Ok((qaren_home.join("native-suites"), locks))
}

fn checkout() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
}

fn admit(runner: &mut dyn Runner, device: &str) -> Result<(), String> {
    core::fresh_install_admission(
        runner,
        Path::new("node"),
        &checkout().join("packages/qaren-core/dist"),
        checkout(),
        device,
        None,
        None,
    )
    .map(|_| ())
    .map_err(|_| "strict device admission did not prove the simulator clear".into())
}

fn identity(runner: &mut dyn Runner, pid: i32) -> Option<PidIdentity> {
    capture_pid_identity(runner, pid).map(|mut identity| {
        identity.command = OutputText::from_output("");
        identity
    })
}

fn save(dir: &Path, record: &NativeSuite) -> Result<(), String> {
    buildplan::save_json(&dir.join("suite.json"), record)
        .map_err(|_| "native suite record could not be saved".into())
}

fn release(record: &NativeSuite) -> Result<(), String> {
    let outcome = match &record.lease {
        Some(lease) => lease::release(lease),
        None => buildplan::release_lock(
            &record.lock_dir,
            &format!("qaren-{}", record.run_id),
            &record.run_id,
        ),
    };
    match outcome {
        ReleaseOutcome::Removed | ReleaseOutcome::Absent => Ok(()),
        _ => Err("native suite lease release was not proven".into()),
    }
}

fn mark_not_spawned(record: &mut NativeSuite) {
    record.process = SuiteProcess::NotSpawned;
    record.cleanup = Some(CleanupEvidence {
        group: OutputText::from_output("not_spawned"),
        admission_clear: false,
        runner_host: None,
    });
}

fn rollback(dir: &Path, record: &mut NativeSuite) -> Result<(), String> {
    mark_not_spawned(record);
    let saved = save(dir, record);
    release(record)?;
    saved
}

fn finish(
    runner: &mut dyn Runner,
    dir: &Path,
    record: &mut NativeSuite,
    child: Option<&mut dyn ChildHandle>,
) -> Result<(), String> {
    let group = match &record.process {
        SuiteProcess::NotSpawned => return rollback(dir, record),
        SuiteProcess::SpawnPending => {
            return Err("spawn identity was not persisted; lease retained".into())
        }
        SuiteProcess::Spawned { pgid, identity } => {
            let mut group = cleanup_ios_automation_group(runner, identity.as_ref(), *pgid);
            if !group.clean()
                && record.suite_exit.is_none()
                && child.is_some_and(|child| matches!(child.try_wait(), Ok(Some(_))))
            {
                group = cleanup_ios_automation_group(runner, identity.as_ref(), *pgid);
            }
            group
        }
    };
    let absent = matches!(group, Outcome::Removed | Outcome::Absent);
    let runner_host = absent.then(|| cleanup_scoped_runner_hosts(runner, &record.device_id));
    let hosts_absent = matches!(runner_host, Some(Outcome::Absent));
    record.cleanup = Some(CleanupEvidence {
        group: crate::redact::OutputText::from_output(&group.render()),
        admission_clear: false,
        runner_host: runner_host
            .map(|outcome| outcome.render())
            .map(|text| crate::redact::OutputText::from_output(&text)),
    });
    save(dir, record)?;
    if !absent || !hosts_absent {
        return Err(
            "group and exact simulator runner host absence are not both proven; lease retained"
                .into(),
        );
    }
    release(record)
}

fn execute(runner: &mut dyn Runner, dir: &Path, record: &mut NativeSuite) -> Result<(), String> {
    record.process = SuiteProcess::SpawnPending;
    if let Err(error) = save(dir, record) {
        rollback(dir, record)?;
        return Err(error);
    }
    let spec = CmdSpec::new(
        "native-ios-suite",
        "/bin/bash",
        &[
            "--noprofile",
            "--norc",
            "-c",
            "IFS= read -r start && [ \"$start\" = start ] || exit 4; exec /bin/bash \"$1\" >&2",
            "native-ios-suite",
            &checkout()
                .join("scripts/test-native-ios.sh")
                .to_string_lossy(),
        ],
        1200,
    )
    .cwd(checkout())
    .env(
        "RN_IOS_TEST_DESTINATION",
        &format!("platform=iOS Simulator,id={}", record.device_id),
    )
    .env(
        "RN_IOS_TEST_RESULTS",
        &dir.join("native-tests.xcresult").to_string_lossy(),
    )
    .env("BASH_ENV", "/dev/null")
    .env("TYPESAFE_API_KEY", "");
    let mut child = runner
        .spawn_piped(&spec, &dir.join("suite.log"))
        .map_err(|_| "spawn did not establish a recorded child; lease retained")?;
    if child.pid < 2 {
        return Err("spawn returned an invalid group identity; lease retained".into());
    }
    let identity = identity(runner, child.pid);
    let known = identity.is_some();
    record.process = SuiteProcess::Spawned {
        pgid: child.pid,
        identity,
    };
    save(dir, record)?;
    let grouped = record.lease.as_ref().is_some_and(|lease| {
        buildplan::record_holder_group(&lease.lock_dir, &lease.holder, &lease.run_id, child.pid)
            .is_ok()
    });
    let started = known
        && grouped
        && runner.cancellation().is_none()
        && child
            .stdin
            .write_all(b"start\n")
            .and_then(|_| child.stdin.flush())
            .is_ok();
    drop(child.stdin);
    drop(child.stdout);
    if started {
        let deadline = runner.monotonic_ms().saturating_add(1_200_000);
        loop {
            if runner.cancellation().is_some() {
                break;
            }
            match child.handle.try_wait() {
                Ok(Some(code)) => {
                    record.suite_exit = Some(code);
                    break;
                }
                Err(_) => break,
                Ok(None) if runner.monotonic_ms() >= deadline => break,
                Ok(None) => runner.sleep(Duration::from_millis(100)),
            }
        }
        save(dir, record)?;
    }
    let cleaned = finish(runner, dir, record, Some(child.handle.as_mut()));
    let _ = child.handle.try_wait();
    cleaned?;
    if let Some(reason) = runner.cancellation() {
        return Err(reason);
    }
    if !started {
        return Err("suite was not admitted through the start gate".into());
    }
    Ok(())
}

fn canonical_device(device: &str) -> Result<String, String> {
    ios::canonical_udid(device).ok_or_else(|| "--device must be an exact simulator UUID".into())
}

fn select_device(runner: &mut dyn Runner, device: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Inventory {
        devices: BTreeMap<String, Vec<Simulator>>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Simulator {
        udid: String,
        state: String,
        is_available: bool,
    }
    let device = canonical_device(device)?;
    let output = runner.run(&ios::list_devices_spec());
    let inventory: Inventory =
        serde_json::from_str(&output.stdout).map_err(|_| "simulator inventory is unreadable")?;
    let matches: Vec<_> = inventory
        .devices
        .iter()
        .flat_map(|(runtime, sims)| sims.iter().map(move |sim| (runtime, sim)))
        .filter(|(_, sim)| sim.udid.eq_ignore_ascii_case(&device))
        .collect();
    match matches.as_slice() {
        [(runtime, sim)]
            if output.ok()
                && output.stderr.is_empty()
                && sim.udid == device
                && runtime.starts_with("com.apple.CoreSimulator.SimRuntime.iOS-")
                && sim.is_available
                && matches!(sim.state.as_str(), "Booted" | "Shutdown") =>
        {
            Ok(device)
        }
        _ => Err("selected UUID is not one available booted or shutdown iOS simulator".into()),
    }
}

pub fn run(runner: &mut dyn Runner, device: &str) -> Result<NativeSuite, String> {
    let device_id = select_device(runner, device)?;
    let (suites, locks) = roots(runner)?;
    let owner =
        identity(runner, std::process::id() as i32).ok_or("suite owner identity is unknown")?;
    let locks = buildplan::canonical_lock_root(&locks)?;
    let run_id = format!(
        "native-ios-{}-{}",
        runner.now_epoch_ms(),
        std::process::id()
    );
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&suites)
        .map_err(|_| "cannot create native suite root")?;
    let dir = suites.join(&run_id);
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .map_err(|_| "cannot claim native suite run directory")?;
    let lock_dir = buildplan::lock_dir(&locks, &lease::lock_name(Platform::Ios, &device_id));
    let mut record = NativeSuite {
        schema: "qaren-native-suite/1".into(),
        run_id,
        device_id,
        owner,
        lock_dir,
        lease: None,
        process: SuiteProcess::NotSpawned,
        suite_exit: None,
        cleanup: None,
    };
    let result = (|| {
        save(&dir, &record)?;
        record.lease = Some(
            lease::acquire(
                runner,
                &locks,
                Platform::Ios,
                &record.device_id,
                &record.run_id,
                Some(record.owner.clone()),
            )
            .map_err(|_| "device lease could not be acquired")?,
        );
        if let Err(error) = save(&dir, &record).and_then(|_| admit(runner, &record.device_id)) {
            rollback(&dir, &mut record)?;
            return Err(error);
        }
        execute(runner, &dir, &mut record)
    })();
    result.map_err(|error: String| {
        format!("{}: {error}; record: {}", record.run_id, dir.display())
    })?;
    Ok(record)
}

pub fn recover(runner: &mut dyn Runner, run_id: &str) -> Result<NativeSuite, String> {
    validate_run_id(run_id).map_err(|_| "invalid native suite run id")?;
    let (suites, locks) = roots(runner)?;
    let dir = suites.join(run_id);
    let raw =
        std::fs::read(dir.join("suite.json")).map_err(|_| "native suite record is unreadable")?;
    let mut record: NativeSuite =
        serde_json::from_slice(&raw).map_err(|_| "native suite record is invalid")?;
    let locks = buildplan::existing_lock_root(&locks)?;
    let expected = buildplan::lock_dir(&locks, &lease::lock_name(Platform::Ios, &record.device_id));
    let holder_name = format!("qaren-{run_id}");
    if record.schema != "qaren-native-suite/1"
        || record.run_id != run_id
        || canonical_device(&record.device_id)? != record.device_id
        || record.owner.pid < 2
        || record.owner.started_at.is_empty()
        || record.lock_dir != expected
        || record.lease.as_ref().is_some_and(|lease| {
            lease.run_id != run_id || lease.holder != holder_name || lease.lock_dir != expected
        })
        || (record.lease.is_none() && !matches!(record.process, SuiteProcess::NotSpawned))
        || matches!(&record.process, SuiteProcess::Spawned { pgid, identity }
            if *pgid < 2 || identity.as_ref().is_some_and(|i| i.pid != *pgid || i.started_at.is_empty()))
    {
        return Err("native suite ownership record does not match its canonical lease".into());
    }
    if !matches!(
        probe_pid_identity(runner, &record.owner),
        PidLiveness::Dead | PidLiveness::AliveForeign
    ) {
        return Err("original suite owner is live or unknown; recovery refused".into());
    }
    match std::fs::symlink_metadata(&expected) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let clean = record
                .cleanup
                .as_ref()
                .is_some_and(|e| match record.process {
                    SuiteProcess::NotSpawned => e.group == "not_spawned",
                    SuiteProcess::Spawned { .. } => {
                        matches!(e.group.as_str(), "removed" | "absent")
                            && match e.runner_host.as_deref() {
                                Some("absent") => true,
                                None => e.admission_clear,
                                _ => false,
                            }
                    }
                    SuiteProcess::SpawnPending => false,
                });
            return if clean {
                Ok(record)
            } else {
                Err("lease is missing without completed cleanup evidence".into())
            };
        }
        Ok(meta) if meta.is_dir() && expected.canonicalize().ok().as_ref() == Some(&expected) => {}
        _ => return Err("canonical device lease cannot be verified".into()),
    }
    let holder =
        buildplan::read_holder(&expected).ok_or("actual device lease holder is unreadable")?;
    if holder.holder != holder_name
        || holder.run_id != run_id
        || !holder
            .identity
            .as_ref()
            .is_some_and(|i| i.pid == record.owner.pid && i.started_at == record.owner.started_at)
    {
        return Err("actual device lease does not match the recorded suite owner".into());
    }
    if matches!(record.process, SuiteProcess::SpawnPending) {
        if holder.group.is_some() {
            return Err("pending spawn has a recorded process group; lease retained".into());
        }
        if !matches!(
            cleanup_scoped_runner_hosts(runner, &record.device_id),
            Outcome::Absent
        ) {
            return Err("exact simulator runner host absence is not proven; lease retained".into());
        }
        // The start gate cannot open until Spawned is durable.
        mark_not_spawned(&mut record);
        save(&dir, &record)?;
        release(&record)?;
        return Ok(record);
    }
    finish(runner, &dir, &mut record, None)?;
    Ok(record)
}

#[cfg(test)]
mod lock_root_tests {
    use super::roots;
    use crate::exec::RealRunner;
    use std::ffi::OsString;
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::process::Command;

    #[test]
    fn non_utf8_lock_root_worker() {
        if std::env::var_os("QAREN_NONUTF8_LOCK_WORKER").is_none() {
            return;
        }
        let expected = std::env::var_os("QAREN_LOCK_ROOT").expect("lock root");
        let runner = RealRunner::new();
        let (_suites, via_suite) = roots(&runner).expect("suite root");
        let via_resolver = crate::buildplan::configured_lock_root(
            std::env::var_os("QAREN_LOCK_ROOT").as_deref(),
            std::env::var_os(crate::buildplan::MACHINE_LOCKS_ENV).as_deref(),
            std::env::var_os("HOME").as_deref(),
        )
        .expect("resolver root");
        assert_eq!(via_suite, via_resolver);
        assert_eq!(via_suite.as_os_str(), expected.as_os_str());
        println!("nonutf8-ok");
    }

    #[test]
    fn suites_follow_qaren_home_but_the_lock_root_does_not() {
        let mut runner = crate::exec::MockRunner::new();
        runner.environment.insert("HOME".into(), "/home-a".into());
        runner
            .environment
            .insert("QAREN_LOCK_ROOT".into(), "/locks-a".into());
        let (suites, locks) = roots(&runner).unwrap();
        assert_eq!(suites, std::path::Path::new("/home-a/.qaren/native-suites"));
        runner
            .environment
            .insert("QAREN_HOME".into(), "/side-home".into());
        let (side, side_locks) = roots(&runner).unwrap();
        assert_eq!(side, std::path::Path::new("/side-home/native-suites"));
        assert_eq!(side_locks, locks);
        runner.environment.insert("QAREN_HOME".into(), "rel".into());
        assert!(roots(&runner).unwrap_err().contains("QAREN_HOME"));
    }

    #[test]
    fn non_utf8_absolute_lock_root_reaches_the_suite_and_the_resolver() {
        let dir = std::env::temp_dir().join(format!(
            "qaren-nonutf8-{}-{}",
            std::process::id(),
            crate::timefmt::epoch_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let home = dir.join("home");
        std::fs::create_dir(&home).unwrap();
        let mut bytes = dir.join("locks").as_os_str().as_bytes().to_vec();
        bytes.push(0xff);
        let lock_root = OsString::from_vec(bytes);
        let result = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_suite::lock_root_tests::non_utf8_lock_root_worker",
                "--nocapture",
            ])
            .env("HOME", &home)
            .env("QAREN_LOCK_ROOT", &lock_root)
            .env("QAREN_NONUTF8_LOCK_WORKER", "1")
            .env_remove(crate::buildplan::MACHINE_LOCKS_ENV)
            .output()
            .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            result.status.success(),
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(String::from_utf8_lossy(&result.stdout).contains("nonutf8-ok"));
    }
}
