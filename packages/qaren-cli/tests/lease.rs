mod common;

use qaren::buildplan::{read_holder, ReleaseOutcome};
use qaren::exec::{CmdOutput, MockRunner};
use qaren::failure::FailureCode;
use qaren::lease::{acquire, lock_name, release};
use qaren::scenario::Platform;

const UDID: &str = "AAAABBBB-1111-2222-3333-444455556666";

#[test]
fn lock_name_is_one_filesystem_safe_component_per_device() {
    let wireless = lock_name(Platform::Android, "192.168.1.5:5555");
    assert!(!wireless.contains(':') && !wireless.contains('/'));
    assert!(wireless.starts_with("device-android-192.168.1.5_5555-"));
    assert_ne!(
        lock_name(Platform::Android, "a/b"),
        lock_name(Platform::Android, "a_b"),
        "the hash suffix keeps distinct ids distinct after sanitizing"
    );
    assert_ne!(
        lock_name(Platform::Ios, UDID),
        lock_name(Platform::Android, UDID)
    );
}

#[test]
fn acquire_writes_a_holder_and_release_removes_it() {
    let root = common::temp_repo().join("locks");
    let mut mock = MockRunner::new();
    let lease = acquire(
        &mut mock,
        &root,
        Platform::Ios,
        UDID,
        "check-1",
        Some(common::identity(4242, "Wed Aug 12 15:00:00 2026")),
    )
    .unwrap();
    assert_eq!(lease.run_id, "check-1");
    assert_eq!(lease.token.len(), 32);
    assert!(lease.token.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(lease.wire(), format!("check-1:{}", lease.token));
    let holder = read_holder(&lease.lock_dir).expect("holder.json is written");
    assert_eq!(holder.run_id, "check-1");
    assert_eq!(holder.identity.as_ref().unwrap().pid, 4242);
    assert_eq!(mock.remaining(), 0);

    assert_eq!(release(&lease), ReleaseOutcome::Removed);
    assert!(!lease.lock_dir.exists());
    assert_eq!(release(&lease), ReleaseOutcome::Absent);
}

#[test]
fn contention_is_device_busy_and_a_live_holder_is_never_stolen() {
    let root = common::temp_repo().join("locks");
    let mut first = MockRunner::new();
    let lease = acquire(
        &mut first,
        &root,
        Platform::Ios,
        UDID,
        "check-1",
        Some(common::identity(4242, "Wed Aug 12 15:00:00 2026")),
    )
    .unwrap();

    let mut second = MockRunner::new();
    // The holder's birth time still matches and it is not a zombie: alive.
    second.expect_run("ps", CmdOutput::success("Wed Aug 12 15:00:00 2026\n"));
    second.expect_run("ps", CmdOutput::success("S\n"));
    let failure = acquire(&mut second, &root, Platform::Ios, UDID, "check-2", None).unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceBusy);
    assert!(failure.code.is_refusal());
    assert!(
        failure.detail.contains("held for run check-1"),
        "{}",
        failure.detail
    );
    assert_eq!(second.remaining(), 0);
    let holder = read_holder(&lease.lock_dir).unwrap();
    assert_eq!(holder.run_id, "check-1", "the live holder keeps the lease");
}

#[test]
fn a_dead_holder_is_still_not_adopted() {
    let root = common::temp_repo().join("locks");
    let mut first = MockRunner::new();
    let lease = acquire(
        &mut first,
        &root,
        Platform::Ios,
        UDID,
        "check-1",
        Some(common::identity(4242, "Wed Aug 12 15:00:00 2026")),
    )
    .unwrap();

    let mut second = MockRunner::new();
    second.expect_run("ps", CmdOutput::failed(1, ""));
    let failure = acquire(&mut second, &root, Platform::Ios, UDID, "check-2", None).unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceBusy);
    assert!(failure.next_action.contains("qaren cleanup"));
    assert_eq!(read_holder(&lease.lock_dir).unwrap().run_id, "check-1");
}

#[test]
fn release_refuses_a_foreign_holder() {
    let root = common::temp_repo().join("locks");
    let mut mock = MockRunner::new();
    let ours = acquire(&mut mock, &root, Platform::Ios, UDID, "check-1", None).unwrap();
    let foreign = qaren::lease::Lease {
        run_id: "check-9".to_string(),
        token: ours.token.clone(),
        lock_dir: ours.lock_dir.clone(),
        holder: "qaren-check-9".to_string(),
        released_orphan: None,
    };
    assert!(matches!(release(&foreign), ReleaseOutcome::Foreign(_)));
    assert!(ours.lock_dir.exists());
}

#[test]
fn a_rollback_release_that_fails_names_the_lock_in_the_failure() {
    let root = common::temp_repo().join("locks");
    let mut mock = MockRunner::new();
    let lease = acquire(
        &mut mock,
        &root,
        Platform::Ios,
        UDID,
        "check-1",
        Some(common::identity(4242, "Wed Aug 12 15:00:00 2026")),
    )
    .unwrap();
    // An unreadable holder record makes the release refuse rather than guess.
    std::fs::write(lease.lock_dir.join("holder.json"), "not json").unwrap();

    let failure = qaren::lease::release_or_annotate(
        &lease,
        qaren::failure::Failure::new(
            "record",
            FailureCode::RunRecordUpdateFailed,
            "cannot create the run dir",
            "check the run directory permissions",
        ),
    );
    assert!(
        failure.detail.contains("could not be released"),
        "{}",
        failure.detail
    );
    assert!(
        failure
            .next_action
            .contains(&lease.lock_dir.parent().unwrap().display().to_string()),
        "{}",
        failure.next_action
    );
    assert!(lease.lock_dir.exists());

    std::fs::remove_dir_all(&lease.lock_dir).unwrap();
    let clean = qaren::lease::release_or_annotate(
        &lease,
        qaren::failure::Failure::new("record", FailureCode::RunRecordUpdateFailed, "x", "y"),
    );
    assert_eq!(clean.detail, "x", "an absent lock adds nothing");
}

#[test]
fn dead_holder_reclaim_completes_pending_borrowed_ios_stop_before_releasing_lease() {
    use qaren::commands::cleanup::reclaim_dead_holder_with_runtime;
    use qaren::runrecord::{BorrowedIosStop, IosSimResource, Phase, RunRecord};
    let repo = common::temp_repo();
    let lock_root = repo.join("locks");
    let runs_root = repo.join("runs");
    let owner = common::identity(4242, "Wed Aug 12 15:00:00 2026");
    let lease = acquire(
        &mut MockRunner::new(),
        &lock_root,
        Platform::Ios,
        UDID,
        "check-1",
        Some(owner.clone()),
    )
    .unwrap();
    let runtime = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
    let device_type = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "check-1",
        Phase::Ready,
    );
    record.prepare = Some(owner);
    record.scenario.ios = Some(qaren::scenario::IosSpec {
        device_type: device_type.into(),
        runtime: runtime.into(),
    });
    record.resources.device_borrowed = true;
    record.resources.ios_simulator = Some(IosSimResource {
        udid: UDID.into(),
        name: "selected".into(),
        device_type: device_type.into(),
        runtime: runtime.into(),
    });
    record.resources.lease = Some(lease.clone());
    record.resources.arm_borrowed_ios_stop().unwrap();
    record.save(&runs_root).unwrap();

    let node = std::path::Path::new("/usr/local/bin/node");
    let runtime_dir = std::path::Path::new("/runtime");
    let inventory = |state: &str| {
        serde_json::json!({
            "devices": {
                runtime: [{
                    "udid": UDID,
                    "name": "selected",
                    "state": state,
                    "isAvailable": true,
                    "deviceTypeIdentifier": device_type
                }]
            }
        })
        .to_string()
    };

    // Unresolved strict admission retains the lease and pending stop.
    let mut busy_runner = MockRunner::new();
    busy_runner.expect_run("ps -p 4242 -o lstart=", CmdOutput::failed(1, ""));
    let busy = qaren::lease::try_acquire(
        &mut busy_runner,
        &lock_root,
        Platform::Ios,
        UDID,
        "check-2",
        None,
    )
    .unwrap_err();
    busy_runner.expect_run("ps -p 4242 -o lstart=", CmdOutput::failed(1, ""));
    busy_runner.expect_run(
        &format!("fresh-install-preflight.js --platform ios --device {UDID}"),
        CmdOutput {
            exit_code: Some(4),
            stdout: serde_json::json!({
                "v": 1, "platform": "ios", "deviceId": UDID, "status": "busy"
            })
            .to_string(),
            ..Default::default()
        },
    );
    assert!(reclaim_dead_holder_with_runtime(
        &mut busy_runner,
        &runs_root,
        &busy,
        Some((node, runtime_dir)),
    )
    .is_err());
    assert!(lease.lock_dir.exists());
    assert_eq!(
        RunRecord::load(&runs_root, "check-1")
            .unwrap()
            .resources
            .borrowed_ios_stop(),
        BorrowedIosStop::Pending
    );
    assert_eq!(busy_runner.remaining(), 0);

    // Clear admission and verified shutdown complete the stop and release the lease.
    let mut ok = MockRunner::new();
    ok.expect_run("ps -p 4242 -o lstart=", CmdOutput::failed(1, ""));
    let busy = qaren::lease::try_acquire(&mut ok, &lock_root, Platform::Ios, UDID, "check-2", None)
        .unwrap_err();
    ok.expect_run("ps -p 4242 -o lstart=", CmdOutput::failed(1, ""));
    ok.expect_run(
        &format!("fresh-install-preflight.js --platform ios --device {UDID}"),
        CmdOutput::success(
            &serde_json::json!({
                "v": 1, "platform": "ios", "deviceId": UDID, "status": "clear"
            })
            .to_string(),
        ),
    );
    ok.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&inventory("Booted")),
    );
    ok.expect_run(&format!("simctl shutdown {UDID}"), CmdOutput::success(""));
    ok.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&inventory("Shutdown")),
    );
    let recovered =
        reclaim_dead_holder_with_runtime(&mut ok, &runs_root, &busy, Some((node, runtime_dir)))
            .unwrap();
    assert_eq!(recovered, "check-1");
    assert!(!lease.lock_dir.exists());
    let stored = RunRecord::load(&runs_root, "check-1").unwrap();
    assert_eq!(
        stored.resources.borrowed_ios_stop(),
        BorrowedIosStop::Completed
    );
    assert!(stored.resources.lease.is_none());
    assert_eq!(ok.remaining(), 0);
}

#[test]
fn reclaim_of_a_records_gone_holder_with_a_live_group_keeps_the_release_advice() {
    use qaren::buildplan::{claim_lock, LockHolder, LockOutcome, LockPolicy};
    use qaren::commands::cleanup::reclaim_dead_holder_with_runtime;
    let repo = common::temp_repo();
    let lock_root = repo.join("locks");
    let deleted_home = repo.join("deleted-home");
    let held = LockHolder {
        holder: "qaren-old-run".into(),
        run_id: "old-run".into(),
        identity: Some(common::identity(4242, "Wed Aug 12 15:00:00 2026")),
        at: "2026-10-23T00:00:00Z".into(),
        home: Some(deleted_home.clone()),
        group: Some(777),
    };
    let name = lock_name(Platform::Ios, UDID);
    assert!(matches!(
        claim_lock(
            &mut MockRunner::new(),
            &lock_root,
            &name,
            &held,
            LockPolicy::Strict
        ),
        LockOutcome::Claimed { .. }
    ));

    let mut runner = MockRunner::new();
    runner.expect_run("ps -p 4242 -o lstart=", CmdOutput::failed(1, ""));
    runner.expect_run(
        "ps -A -o pid= -o pgid= -o stat=",
        CmdOutput::success("  777   777 S\n"),
    );
    let busy = qaren::lease::try_acquire(
        &mut runner,
        &lock_root,
        Platform::Ios,
        UDID,
        "new-run",
        None,
    )
    .unwrap_err();
    let failure =
        reclaim_dead_holder_with_runtime(&mut runner, &repo.join("runs"), &busy, None).unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceBusy);
    let next = failure.next_action.as_str();
    assert!(next.contains("pgrep -g 777"), "{next}");
    assert!(
        next.contains(&lock_root.join(&name).display().to_string()),
        "{next}"
    );
    assert!(!next.contains("qaren cleanup"), "{next}");
    assert_eq!(
        read_holder(&lock_root.join(&name)).unwrap().run_id,
        "old-run"
    );
    assert_eq!(runner.remaining(), 0);
}

#[test]
fn a_reused_holder_pid_leading_its_own_group_does_not_keep_an_orphaned_lease() {
    use qaren::buildplan::{claim_lock, LockHolder, LockOutcome, LockPolicy};
    let repo = common::temp_repo();
    let lock_root = repo.join("locks");
    let held = LockHolder {
        holder: "qaren-old-run".into(),
        run_id: "old-run".into(),
        identity: Some(common::identity(4242, "Wed Aug 12 15:00:00 2026")),
        at: "2026-10-23T00:00:00Z".into(),
        home: Some(repo.join("deleted-home")),
        group: Some(4242),
    };
    let name = lock_name(Platform::Ios, UDID);
    assert!(matches!(
        claim_lock(
            &mut MockRunner::new(),
            &lock_root,
            &name,
            &held,
            LockPolicy::Strict
        ),
        LockOutcome::Claimed { .. }
    ));

    let mut runner = MockRunner::new();
    runner.expect_run(
        "ps -p 4242 -o lstart=",
        CmdOutput::success("Thu Oct 22 09:00:00 2026\n"),
    );
    let lease = qaren::lease::try_acquire(
        &mut runner,
        &lock_root,
        Platform::Ios,
        UDID,
        "new-run",
        None,
    )
    .unwrap();
    assert_eq!(lease.released_orphan.as_deref(), Some("old-run"));
    assert_eq!(
        read_holder(&lock_root.join(&name)).unwrap().run_id,
        "new-run"
    );
    assert_eq!(runner.remaining(), 0);
}

#[test]
fn cleanup_of_a_run_without_run_json_releases_only_its_orphaned_locks() {
    use qaren::buildplan::{claim_lock, LockHolder, LockOutcome, LockPolicy};
    use qaren::commands::cleanup::cleanup_with_orphan_locks;
    use qaren::receipt::ReceiptResult;
    let repo = common::temp_repo();
    let lock_root = repo.join("locks");
    let runs_root = repo.join("runs");
    let holder_home = repo.join("holder-home");
    std::fs::create_dir_all(holder_home.join(".qaren/runs/old-run/ios-build")).unwrap();
    let held = |run_id: &str, pid: i32, group: Option<i32>| LockHolder {
        holder: format!("qaren-{run_id}"),
        run_id: run_id.into(),
        identity: Some(common::identity(pid, "Wed Aug 12 15:00:00 2026")),
        at: "2026-10-23T00:00:00Z".into(),
        home: Some(holder_home.clone()),
        group,
    };
    let device = lock_name(Platform::Ios, UDID);
    for (name, holder) in [
        (device.as_str(), held("old-run", 4242, None)),
        ("native-build-ios", held("old-run", 4242, Some(777))),
        ("native-build-android", held("other-run", 4343, None)),
    ] {
        assert!(matches!(
            claim_lock(
                &mut MockRunner::new(),
                &lock_root,
                name,
                &holder,
                LockPolicy::Strict
            ),
            LockOutcome::Claimed { .. }
        ));
    }

    let mut busy = MockRunner::new();
    for _ in 0..2 {
        busy.expect_run("ps -p 4242 -o lstart=", CmdOutput::failed(1, ""));
    }
    busy.expect_run(
        "ps -A -o pid= -o pgid= -o stat=",
        CmdOutput::success("  777   777 S\n"),
    );
    let refused =
        cleanup_with_orphan_locks(&mut busy, &runs_root, Some(&lock_root), "old-run", None);
    assert_eq!(refused.result, ReceiptResult::Refused);
    assert_eq!(
        refused.cleanup["lock:native-build-ios"].split(':').next(),
        Some("refused")
    );
    assert_eq!(refused.cleanup[&format!("lock:{device}")], "removed");
    assert!(
        refused.next_action.contains("pgrep -g 777"),
        "{}",
        refused.next_action
    );
    assert!(lock_root.join("native-build-ios").exists());
    assert!(!lock_root.join(&device).exists());

    let mut gone = MockRunner::new();
    gone.expect_run("ps -p 4242 -o lstart=", CmdOutput::failed(1, ""));
    gone.expect_run(
        "ps -A -o pid= -o pgid= -o stat=",
        CmdOutput::success("    1     1 Ss\n"),
    );
    let cleaned =
        cleanup_with_orphan_locks(&mut gone, &runs_root, Some(&lock_root), "old-run", None);
    assert_eq!(
        cleaned.result,
        ReceiptResult::Cleaned,
        "{:?}",
        cleaned.failure
    );
    assert_eq!(cleaned.cleanup["lock:native-build-ios"], "removed");
    assert!(cleaned.failure.is_none());
    assert!(!lock_root.join("native-build-ios").exists());
    assert_eq!(
        read_holder(&lock_root.join("native-build-android"))
            .unwrap()
            .run_id,
        "other-run"
    );
    assert_eq!(gone.remaining(), 0);

    let untouched =
        cleanup_with_orphan_locks(&mut MockRunner::new(), &runs_root, None, "other-run", None);
    assert_eq!(untouched.result, ReceiptResult::Refused);
    assert!(lock_root.join("native-build-android").exists());
}
