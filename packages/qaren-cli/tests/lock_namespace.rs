use std::ffi::{CString, OsStr, OsString};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use qaren::buildplan::{self, LockHolder, LockOutcome, LockPolicy, ReleaseOutcome};
use qaren::exec::RealRunner;
use qaren::failure::FailureCode;
use qaren::lease;
use qaren::scenario::Platform;

const DEVICE_A: &str = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const DEVICE_B: &str = "BBBBBBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF";
const EMULATOR: &str = "emulator-5554";

#[test]
fn lock_namespace_worker() {
    match std::env::var("QAREN_LOCK_WORKER_ROLE").ok().as_deref() {
        Some("claim") => worker_claim(),
        Some("umask") => worker_umask(),
        _ => {}
    }
}

#[test]
fn opt_out_isolated_homes_both_acquire() {
    let fixture = Fixture::new("off");
    let held = fixture.hold(false, None, "ios", DEVICE_A, "", "strict", "live");
    let rows = held.rows();
    assert!(rows.iter().all(|row| row.claimed()), "{rows:?}");
    assert_ne!(rows[0].used, rows[1].used);
    assert!(rows[0].resolved.ends_with(".qaren/locks"));
    assert!(rows[1].resolved.ends_with(".qaren/locks"));
    assert_ne!(rows[0].resolved, machine_parent());
    held.release();
    fixture.assert_decoys_untouched();
}

#[test]
fn default_isolated_homes_share_one_device_lease() {
    let fixture = Fixture::new("device");
    let held = fixture.hold(true, None, "ios", DEVICE_A, "", "strict", "live");
    let rows = held.rows();
    assert_eq!(
        rows.iter().filter(|row| row.claimed()).count(),
        1,
        "{rows:?}"
    );
    assert_eq!(rows.iter().filter(|row| row.busy()).count(), 1, "{rows:?}");
    assert_eq!(rows[0].resolved, machine_parent());
    assert_eq!(rows[1].resolved, machine_parent());
    assert_eq!(rows[0].used, fixture.path().join("machine"));
    assert_eq!(rows[1].used, rows[0].used);
    let winner = rows.iter().find(|row| row.claimed()).unwrap();
    assert!(winner.lock_dir.ends_with_component_prefix("device-ios-"));
    assert_eq!(
        fs::metadata(&winner.lock_dir).unwrap().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(winner.lock_dir.join("holder.json"))
            .unwrap()
            .mode()
            & 0o777,
        0o600
    );
    let body = fs::read_to_string(winner.lock_dir.join("holder.json")).unwrap();
    assert!(body.contains(&winner.run));
    held.release();
    fixture.assert_decoys_untouched();
    let mut runner = RealRunner::new();
    lease::try_acquire(
        &mut runner,
        &fixture.path().join("machine"),
        Platform::Ios,
        DEVICE_A,
        "after-release",
        None,
    )
    .expect("the loser can claim after the winner releases");
}

#[test]
fn default_host_locks_serialize_one_platform() {
    let fixture = Fixture::new("host");
    for (name, policy, identity, needle) in [
        ("native-build-ios", "strict", "live", "holder process alive"),
        (
            "native-build-android",
            "adopt",
            "live",
            "holder process alive",
        ),
        (
            "native-build-android",
            "adopt",
            "none",
            "holder liveness not proven",
        ),
    ] {
        let held = fixture.hold(true, None, "ios", DEVICE_A, name, policy, identity);
        let rows = held.rows();
        assert_eq!(
            rows.iter().filter(|row| row.claimed()).count(),
            1,
            "{name} {rows:?}"
        );
        assert_eq!(
            rows.iter().filter(|row| row.busy()).count(),
            1,
            "{name} {rows:?}"
        );
        let loser = rows.iter().find(|row| row.busy()).unwrap();
        assert!(loser.detail.contains(needle), "{loser:?}");
        held.release();
    }
}

#[test]
fn different_devices_and_host_platforms_do_not_share_a_leaf() {
    let fixture = Fixture::new("split");
    let mut left = fixture.spawn(true, None, "ios", DEVICE_A, "", "strict", "none", "dev-a");
    let mut right = fixture.spawn(
        true, None, "android", EMULATOR, "", "strict", "none", "dev-b",
    );
    barrier(&mut [&mut left, &mut right]);
    let ios = left.row();
    let android = right.row();
    assert!(ios.claimed() && android.claimed(), "{ios:?} {android:?}");
    assert_ne!(ios.lock_dir, android.lock_dir);
    left.finish();
    right.finish();

    let mut left = fixture.spawn(
        true,
        None,
        "ios",
        DEVICE_B,
        "native-build-ios",
        "strict",
        "none",
        "host-a",
    );
    let mut right = fixture.spawn(
        true,
        None,
        "android",
        EMULATOR,
        "native-build-android",
        "adopt",
        "none",
        "host-b",
    );
    barrier(&mut [&mut left, &mut right]);
    let ios = left.row();
    let android = right.row();
    assert!(ios.claimed() && android.claimed(), "{ios:?} {android:?}");
    assert_ne!(ios.lock_dir, android.lock_dir);
    left.finish();
    right.finish();
}

#[test]
fn explicit_roots_partition_when_they_differ_and_contend_when_they_match() {
    let fixture = Fixture::new("explicit");
    let shared = fixture.child_dir("shared-root");
    let held = fixture.hold(
        true,
        Some(shared.clone()),
        "ios",
        DEVICE_A,
        "",
        "strict",
        "none",
    );
    let rows = held.rows();
    assert_eq!(
        rows.iter().filter(|row| row.claimed()).count(),
        1,
        "{rows:?}"
    );
    assert!(rows.iter().all(|row| row.resolved == shared));
    held.release();

    let left_root = fixture.child_dir("root-a");
    let right_root = fixture.child_dir("root-b");
    let mut left = fixture.spawn(
        false,
        Some(left_root.clone()),
        "android",
        EMULATOR,
        "",
        "strict",
        "none",
        "exp-a",
    );
    let mut right = fixture.spawn(
        false,
        Some(right_root.clone()),
        "android",
        EMULATOR,
        "",
        "strict",
        "none",
        "exp-b",
    );
    barrier(&mut [&mut left, &mut right]);
    let left_row = left.row();
    let right_row = right.row();
    assert!(
        left_row.claimed() && right_row.claimed(),
        "{left_row:?} {right_row:?}"
    );
    assert_eq!(left_row.resolved, left_root);
    assert_eq!(right_row.resolved, right_root);
    left.finish();
    right.finish();
}

#[test]
fn literal_dot_segments_refuse_before_lock_root_normalization() {
    for raw in [
        "/private/var/tmp/./",
        "/private/./var/tmp",
        "/private/var/tmp/../tmp",
    ] {
        assert_eq!(
            buildplan::configured_lock_root(Some(OsStr::new(raw)), Some(OsStr::new("1")), None)
                .unwrap_err(),
            "QAREN_LOCK_ROOT must not contain . or .."
        );
        assert!(buildplan::canonical_lock_root(Path::new(raw)).is_err());
    }
    for (machine, root, advice) in [
        ("1", "/private/var/tmp/./", "or unset it"),
        ("0", "/tmp/../tmp/locks", "or unset it"),
        ("", "relative/locks", "or unset it"),
        ("true", "/tmp/locks", "set it to 1 or 0"),
    ] {
        let receipt =
            prepare_receipt(&[("QAREN_MACHINE_LOCKS", machine), ("QAREN_LOCK_ROOT", root)]);
        assert_eq!(receipt["failure"]["code"], "PREREQ_MISSING");
        assert_eq!(receipt["failure"]["phase"], "validate");
        let next = receipt["failure"]["next_action"].as_str().unwrap();
        assert!(next.contains(advice), "{next}");
        assert!(!next.contains("QAREN_MACHINE_LOCKS=0"), "{next}");
    }
    let receipt = prepare_receipt(&[("QAREN_MACHINE_LOCKS", "true")]);
    let next = receipt["failure"]["next_action"].as_str().unwrap();
    assert!(!next.contains("QAREN_LOCK_ROOT"), "{next}");
}

fn prepare_receipt(env: &[(&str, &str)]) -> serde_json::Value {
    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .args(["prepare", "missing-scenario.yaml", "--json"])
        .env("HOME", std::env::current_dir().unwrap())
        .env_remove("QAREN_LOCK_ROOT")
        .envs(env.iter().copied())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn unsafe_overrides_fail_closed_without_a_home_fallback() {
    let home = OsStr::new("/tmp/qaren-lock-home");
    assert!(buildplan::configured_lock_root(Some(OsStr::new("")), None, Some(home)).is_err());
    assert!(
        buildplan::configured_lock_root(Some(OsStr::new("relative/locks")), None, Some(home))
            .is_err()
    );
    let mut nul = b"/tmp/locks".to_vec();
    nul.insert(4, 0);
    let raw = OsString::from_vec(nul);
    assert!(buildplan::configured_lock_root(Some(&raw), None, Some(home)).is_err());
    let dotted = OsStr::new("/tmp/../tmp/locks");
    let off = Some(OsStr::new("0"));
    assert!(buildplan::configured_lock_root(Some(dotted), off, Some(home)).is_err());
    assert!(buildplan::configured_lock_root(Some(dotted), None, Some(home)).is_err());
    assert_eq!(
        buildplan::configured_lock_root(None, off, Some(home)).unwrap(),
        PathBuf::from("/tmp/qaren-lock-home/.qaren/locks")
    );
    assert_eq!(
        buildplan::configured_lock_root(None, None, Some(home)).unwrap(),
        machine_parent()
    );
    assert_eq!(
        buildplan::configured_lock_root(None, Some(OsStr::new("1")), Some(home)).unwrap(),
        machine_parent()
    );
}

#[test]
fn default_machine_root_falls_back_per_home_and_explicit_one_refuses() {
    let fixture = Fixture::new("fallback");
    let home = fixture.path().join("home");
    let per_home = home.join(".qaren").join("locks");
    let home = Some(home.as_os_str());
    let unsafe_parent = fixture.child_dir("unsafe");
    chmod(&unsafe_parent, &["775"]);
    let missing = fixture.path().join("missing");
    let usable = fixture.path().join("machine");
    let on = Some(OsStr::new("1"));
    let unsupported =
        || Err("machine lock root is unsupported on this operating system".to_string());
    for parent in [
        Ok(unsafe_parent.as_path()),
        Ok(missing.as_path()),
        unsupported(),
    ] {
        for default in [None, Some(OsStr::new(""))] {
            let (root, warning) =
                buildplan::select_lock_root(None, default, home, || probe(parent.clone(), false))
                    .unwrap();
            assert_eq!(root, per_home);
            let warning = warning.expect("the fallback warns");
            assert!(
                warning.contains(&per_home.display().to_string()),
                "{warning}"
            );
            assert!(warning.contains("QAREN_MACHINE_LOCKS=1"), "{warning}");
            assert!(!warning.contains("chmod"), "{warning}");
        }
        let refused = buildplan::select_lock_root(None, on, home, || probe(parent.clone(), false))
            .unwrap_err();
        assert!(
            refused.starts_with("machine lock root is unusable"),
            "{refused}"
        );
        assert!(!refused.contains("chmod"), "{refused}");
        assert!(buildplan::select_lock_root(None, None, None, || probe(parent, false)).is_err());
    }
    assert!(!missing.exists());
    assert!(!per_home.exists());
    for value in [None, on] {
        assert_eq!(
            buildplan::select_lock_root(None, value, home, || probe(Ok(&usable), false)).unwrap(),
            (usable.clone(), None)
        );
    }
    assert_eq!(fs::read_dir(&usable).unwrap().count(), 0);
    let failure = lease::acquire(
        &mut RealRunner::new(),
        &unsafe_parent,
        Platform::Ios,
        DEVICE_A,
        "unsafe-root",
        None,
    )
    .unwrap_err();
    assert_eq!(failure.code, FailureCode::RunRecordUpdateFailed);
    assert!(
        failure.next_action.contains("QAREN_MACHINE_LOCKS=0"),
        "{}",
        failure.next_action.as_str()
    );
    assert!(
        failure.next_action.contains("QAREN_LOCK_ROOT"),
        "{}",
        failure.next_action.as_str()
    );
    assert!(
        !failure.next_action.contains("permissions"),
        "{}",
        failure.next_action.as_str()
    );
}

#[test]
fn a_trusted_parent_that_refuses_the_probe_never_falls_back() {
    let fixture = Fixture::new("readonly");
    let home = fixture.path().join("home");
    let per_home = home.join(".qaren").join("locks");
    let home = Some(home.as_os_str());
    let readonly = fixture.child_dir("readonly");
    chmod(&readonly, &["500"]);
    for machine in [None, Some(OsStr::new("")), Some(OsStr::new("1"))] {
        let refused =
            buildplan::select_lock_root(None, machine, home, || probe(Ok(&readonly), false))
                .unwrap_err();
        assert!(refused.contains("Permission denied"), "{refused}");
        assert!(
            refused.starts_with("machine lock root is unusable"),
            "{refused}"
        );
    }
    assert!(!per_home.exists());
    chmod(&readonly, &["700"]);
    assert_eq!(fs::read_dir(&readonly).unwrap().count(), 0);
}

#[test]
fn a_proven_dead_holder_without_run_records_is_reclaimed() {
    use qaren::exec::{CmdOutput, MockRunner};
    const BIRTH: &str = "Mon Oct 19 09:00:00 2026";
    let fixture = Fixture::new("orphan");
    let deleted = fixture.path().join("deleted-home");
    let kept = fixture.child_dir("kept-home");
    fs::create_dir_all(kept.join(".qaren/runs/old-run")).unwrap();
    let rebooted = "Fri Oct 23 07:00:00 2026";
    for (case, home, lstart, reclaimed) in [
        ("deleted-home", Some(&deleted), "", true),
        ("rebooted", Some(&deleted), rebooted, true),
        ("records-kept", Some(&kept), "", false),
        ("live", Some(&deleted), BIRTH, false),
        ("unrecorded-home", None, "", false),
    ] {
        let root = fixture.child_dir(&format!("root-{case}"));
        let mut old = sample_holder("old-run");
        old.identity = Some(qaren::runrecord::PidIdentity {
            pid: 4242,
            started_at: BIRTH.to_string(),
            command: qaren::redact::OutputText::from_output("qaren check"),
        });
        old.home = home.cloned();
        let name = lease::lock_name(Platform::Ios, DEVICE_A);
        let mut setup = MockRunner::new();
        assert!(matches!(
            buildplan::claim_lock(&mut setup, &root, &name, &old, LockPolicy::Strict),
            LockOutcome::Claimed { .. }
        ));
        let mut mock = MockRunner::new();
        mock.environment.insert(
            "HOME".into(),
            fixture.path().join("new-home").display().to_string(),
        );
        mock.expect_run("ps -p 4242 -o lstart=", CmdOutput::success(lstart));
        if lstart == BIRTH {
            mock.expect_run("ps -p 4242 -o stat=", CmdOutput::success("S"));
        }
        let outcome =
            lease::try_acquire(&mut mock, &root, Platform::Ios, DEVICE_A, "new-run", None);
        let held = buildplan::read_holder(&root.join(&name)).unwrap();
        if reclaimed {
            assert!(outcome.is_ok(), "{case}");
            assert_eq!(held.run_id, "new-run", "{case}");
            assert_eq!(held.home, Some(fixture.path().join("new-home")), "{case}");
        } else {
            let busy = outcome
                .err()
                .unwrap_or_else(|| panic!("{case} was reclaimed"));
            assert_eq!(busy.failure.code, FailureCode::DeviceBusy, "{case}");
            assert_eq!(held.run_id, "old-run", "{case}");
            if case == "records-kept" {
                let next = busy.failure.next_action.as_str();
                let command = format!("HOME='{}' qaren cleanup old-run", kept.display());
                assert!(next.contains(&command), "{next}");
            }
        }
    }
    let root = fixture.child_dir("build");
    let mut old = sample_holder("old-build");
    old.identity = Some(qaren::runrecord::PidIdentity {
        pid: 4343,
        started_at: BIRTH.to_string(),
        command: qaren::redact::OutputText::from_output("qaren prepare"),
    });
    old.home = Some(deleted.clone());
    let mut setup = MockRunner::new();
    must_claim_with(&mut setup, &root, "native-build-ios", &old);
    let mut mock = MockRunner::new();
    mock.expect_run("ps -p 4343 -o lstart=", CmdOutput::success(""));
    let outcome = lease::claim_reclaiming_orphan(
        &mut mock,
        &root,
        "native-build-ios",
        &sample_holder("new-build"),
        LockPolicy::Strict,
    );
    assert!(
        matches!(
            outcome,
            LockOutcome::Claimed {
                adopted_stale: true
            }
        ),
        "{outcome:?}"
    );
    assert!(!deleted.exists());
}

#[test]
fn a_killed_owner_with_a_live_build_group_keeps_the_build_lock() {
    use std::os::unix::process::CommandExt;
    let fixture = Fixture::new("build-group");
    let root = fixture.child_dir("locks");
    let mut runner = RealRunner::new();
    let mut owner = Command::new("/bin/sleep").arg("60").spawn().unwrap();
    let mut build = Command::new("/bin/sleep")
        .arg("60")
        .process_group(0)
        .spawn()
        .unwrap();
    let pgid = build.id() as i32;
    let mut held = sample_holder("killed-build");
    held.identity = Some(
        qaren::runrecord::capture_pid_identity(&mut runner, owner.id() as i32)
            .expect("ps identity"),
    );
    held.home = Some(fixture.path().join("deleted-home"));
    let claimed = buildplan::claim_lock(
        &mut runner,
        &root,
        "native-build-ios",
        &held,
        LockPolicy::Strict,
    );
    assert!(
        matches!(claimed, LockOutcome::Claimed { .. }),
        "{claimed:?}"
    );
    let lock = root.join("native-build-ios");
    buildplan::record_holder_group(&lock, "qaren-killed-build", "killed-build", pgid).unwrap();
    assert_eq!(buildplan::read_holder(&lock).unwrap().group, Some(pgid));
    owner.kill().unwrap();
    owner.wait().unwrap();
    let second = lease::claim_reclaiming_orphan(
        &mut runner,
        &root,
        "native-build-ios",
        &sample_holder("second-build"),
        LockPolicy::Strict,
    );
    let LockOutcome::Contended {
        holder: Some(existing),
        ..
    } = &second
    else {
        panic!("a second build could start: {second:?}");
    };
    let advice = lease::contended_advice(&lock, Some(existing));
    assert!(advice.contains(&format!("pgrep -g {pgid}")), "{advice}");
    assert!(advice.contains(&lock.display().to_string()), "{advice}");
    assert_eq!(
        buildplan::read_holder(&lock).unwrap().run_id,
        "killed-build"
    );
    build.kill().unwrap();
    build.wait().unwrap();
    let after = lease::claim_reclaiming_orphan(
        &mut runner,
        &root,
        "native-build-ios",
        &sample_holder("second-build"),
        LockPolicy::Strict,
    );
    assert!(
        matches!(
            after,
            LockOutcome::Claimed {
                adopted_stale: true
            }
        ),
        "{after:?}"
    );
}

#[test]
fn privileged_callers_keep_private_roots_but_not_the_machine_root() {
    let fixture = Fixture::new("privileged");
    let home = fixture.path().join("home");
    let per_home = home.join(".qaren").join("locks");
    let home = Some(home.as_os_str());
    let usable = fixture.path().join("machine");
    let explicit = fixture.child_dir("explicit");
    let (root, warning) =
        buildplan::select_lock_root(None, None, home, || probe(Ok(&usable), true)).unwrap();
    assert_eq!(root, per_home);
    assert!(warning
        .unwrap()
        .contains("root, setuid or holds Linux capabilities"));
    let refused = buildplan::select_lock_root(None, Some(OsStr::new("1")), home, || {
        probe(Ok(&usable), true)
    })
    .unwrap_err();
    assert!(
        refused.starts_with("machine lock root is unusable"),
        "{refused}"
    );
    assert_eq!(fs::read_dir(&usable).unwrap().count(), 0);
    let off = Some(OsStr::new("0"));
    for (machine, explicit_root, expected) in [
        (off, None, per_home.clone()),
        (None, Some(explicit.as_os_str()), explicit.clone()),
        (off, Some(explicit.as_os_str()), explicit.clone()),
    ] {
        let (root, warning) =
            buildplan::select_lock_root(explicit_root, machine, home, || probe(Ok(&usable), true))
                .unwrap();
        assert_eq!((root.clone(), warning), (expected, None));
        let lock = must_claim(&root, "device-ios-privileged", "privileged");
        assert!(matches!(
            buildplan::release_lock(&lock, "qaren-privileged", "privileged"),
            ReleaseOutcome::Removed
        ));
    }
}

#[test]
fn symlink_fifo_link_and_mode_attacks_do_not_mutate_the_victim() {
    let fixture = Fixture::new("attack");
    let real = fixture.child_dir("real");
    let link = fixture.path().join("root-link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let outcome = claim(&link, "leaf", "symlink-root");
    assert!(matches!(outcome, LockOutcome::Error(_)), "{outcome:?}");
    assert!(fs::read_dir(&real).unwrap().next().is_none());

    let root = fixture.child_dir("leaves");
    let leaf = root.join("leaf");
    fs::create_dir(&leaf).unwrap();
    let inode = fs::metadata(&leaf).unwrap().ino();
    let outcome = claim(&root, "leaf", "empty");
    assert!(
        matches!(outcome, LockOutcome::Contended { holder: None, .. }),
        "{outcome:?}"
    );
    assert_eq!(fs::metadata(&leaf).unwrap().ino(), inode);
    assert!(fs::read_dir(&leaf).unwrap().next().is_none());

    let linked = root.join("linked");
    std::os::unix::fs::symlink(&real, &linked).unwrap();
    let link_inode = fs::symlink_metadata(&linked).unwrap().ino();
    let outcome = claim(&root, "linked", "symlink-leaf");
    assert!(
        matches!(outcome, LockOutcome::Contended { holder: None, .. }),
        "{outcome:?}"
    );
    assert_eq!(fs::symlink_metadata(&linked).unwrap().ino(), link_inode);
    assert!(buildplan::read_holder(&linked).is_none());
    let release = buildplan::release_lock(&linked, "qaren-symlink-leaf", "symlink-leaf");
    assert!(matches!(release, ReleaseOutcome::Refused(_)), "{release:?}");

    let fifo_dir = root.join("fifo");
    fs::create_dir(&fifo_dir).unwrap();
    let fifo = fifo_dir.join("holder.json");
    let path = CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let outcome = claim(&root, "fifo", "fifo");
    assert!(
        matches!(outcome, LockOutcome::Contended { .. }),
        "{outcome:?}"
    );
    assert!(fifo.symlink_metadata().unwrap().file_type().is_fifo());

    let held = must_claim(&root, "hard", "hard");
    fs::hard_link(held.join("holder.json"), held.join("holder-link")).unwrap();
    assert!(buildplan::read_holder(&held).is_none());
    let release = buildplan::release_lock(&held, "qaren-hard", "hard");
    assert!(matches!(release, ReleaseOutcome::Refused(_)), "{release:?}");
    assert_eq!(fs::metadata(held.join("holder.json")).unwrap().nlink(), 2);

    let loose = must_claim(&root, "loose", "loose");
    fs::set_permissions(loose.join("holder.json"), fs::Permissions::from_mode(0o666)).unwrap();
    assert!(buildplan::read_holder(&loose).is_none());
    let release = buildplan::release_lock(&loose, "qaren-loose", "loose");
    assert!(matches!(release, ReleaseOutcome::Refused(_)), "{release:?}");

    let extra = must_claim(&root, "extra", "extra");
    fs::write(extra.join("extra.txt"), "keep").unwrap();
    match buildplan::release_lock(&extra, "qaren-extra", "extra") {
        ReleaseOutcome::Unresolved(detail) => assert!(detail.contains("preserved at"), "{detail}"),
        other => panic!("{other:?}"),
    }
    assert!(find_file(&root, "extra.txt"));

    for name in [".", "..", "a/b", "/tmp/escaped"] {
        let outcome = claim(&root, name, "traversal");
        assert!(
            matches!(outcome, LockOutcome::Error(_)),
            "{name} {outcome:?}"
        );
    }
}

#[test]
fn umask_children_keep_private_modes_or_fail_closed() {
    let fixture = Fixture::new("umask");
    let root = fixture.child_dir("umask-root");
    for mask in [0o022, 0o077] {
        let output = umask_child(&root, mask);
        assert!(output.contains("umask-ok"), "{mask:o} {output}");
        assert!(!root.join("umask-leaf").exists());
    }
    let output = umask_child(&root, 0o777);
    assert!(output.contains("umask-error"), "{output}");
    let leftovers: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(leftovers.is_empty(), "umask 0777 left {leftovers:?} behind");
}

#[test]
fn missing_machine_parent_is_not_created() {
    let missing = if cfg!(target_os = "macos") {
        PathBuf::from("/private/var/no-such-qaren-lock-root")
    } else {
        PathBuf::from("/run/no-such-qaren-lock-root")
    };
    assert!(!missing.exists());
    assert!(buildplan::canonical_lock_root(&missing).is_err());
    let outcome = claim(&missing, "leaf", "missing-parent");
    assert!(matches!(outcome, LockOutcome::Error(_)), "{outcome:?}");
    assert!(!missing.exists());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_machine_parent_resolves_without_writing() {
    let parent = Path::new("/private/var/tmp");
    assert_eq!(buildplan::canonical_lock_root(parent).unwrap(), parent);
    assert!(!parent.join("qaren-lock-namespace-probe").exists());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_deny_only_acl_allows_a_claim_and_an_allow_acl_refuses() {
    let fixture = Fixture::new("acl");
    let deny = fixture.child_dir("deny");
    chmod(&deny, &["+a", "everyone deny delete"]);
    must_claim(&deny, "leaf", "deny");
    chmod(&deny, &["-N"]);
    let allow = fixture.child_dir("allow");
    chmod(&allow, &["+a", "everyone allow read"]);
    let outcome = claim(&allow, "leaf", "allow");
    assert!(matches!(outcome, LockOutcome::Error(_)), "{outcome:?}");
    assert!(!allow.join("leaf").exists());
    chmod(&allow, &["-N"]);
}

struct Fixture(PathBuf);

struct Held {
    children: Vec<Child>,
}

struct Child {
    child: Option<std::process::Child>,
    result: PathBuf,
    done_read: Option<File>,
    release_write: Option<File>,
}

#[derive(Debug)]
struct Row {
    kind: String,
    resolved: PathBuf,
    used: PathBuf,
    lock_dir: PathBuf,
    run: String,
    detail: String,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "qaren-lock-namespace-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path.join("machine"))
            .unwrap();
        Self(path.canonicalize().unwrap())
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn child_dir(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        if !path.exists() {
            fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        }
        path
    }

    fn hold(
        &self,
        machine: bool,
        lock_root: Option<PathBuf>,
        platform: &str,
        device: &str,
        name: &str,
        policy: &str,
        identity: &str,
    ) -> Held {
        let mut left = self.spawn(
            machine,
            lock_root.clone(),
            platform,
            device,
            name,
            policy,
            identity,
            "a",
        );
        let mut right = self.spawn(
            machine, lock_root, platform, device, name, policy, identity, "b",
        );
        barrier(&mut [&mut left, &mut right]);
        Held {
            children: vec![left, right],
        }
    }

    fn spawn(
        &self,
        machine: bool,
        lock_root: Option<PathBuf>,
        platform: &str,
        device: &str,
        name: &str,
        policy: &str,
        identity: &str,
        id: &str,
    ) -> Child {
        let home = self.child_dir(&format!("home-{id}"));
        let decoy = self.child_dir(&format!("qaren-home-{id}"));
        let tmp = self.child_dir(&format!("tmp-{id}"));
        let xdg = self.child_dir(&format!("xdg-{id}"));
        let result = self.0.join(format!("result-{id}"));
        let _ = fs::remove_file(&result);
        let (done_read, done_write) = inheritable_pipe();
        let (release_read, release_write) = inheritable_pipe();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "lock_namespace_worker", "--nocapture"])
            .env("QAREN_LOCK_WORKER_ROLE", "claim")
            .env("HOME", &home)
            .env("QAREN_HOME", &decoy)
            .env("TMPDIR", &tmp)
            .env("XDG_RUNTIME_DIR", &xdg)
            .env("QAREN_LOCK_FIXTURE", &self.0)
            .env("QAREN_LOCK_RESULT", &result)
            .env("QAREN_LOCK_DONE_FD", done_write.as_raw_fd().to_string())
            .env(
                "QAREN_LOCK_RELEASE_FD",
                release_read.as_raw_fd().to_string(),
            )
            .env("QAREN_LOCK_PLATFORM", platform)
            .env("QAREN_LOCK_DEVICE", device)
            .env("QAREN_LOCK_NAME", name)
            .env("QAREN_LOCK_POLICY", policy)
            .env("QAREN_LOCK_RUN", format!("run-{id}"))
            .env("QAREN_LOCK_IDENTITY", identity)
            .env_remove("QAREN_LOCK_ROOT")
            .env_remove(buildplan::MACHINE_LOCKS_ENV)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if !machine {
            command.env(buildplan::MACHINE_LOCKS_ENV, "0");
        }
        if let Some(root) = lock_root {
            command.env("QAREN_LOCK_ROOT", root);
        }
        let child = command.spawn().unwrap();
        drop(done_write);
        drop(release_read);
        Child {
            child: Some(child),
            result,
            done_read: Some(done_read),
            release_write: Some(release_write),
        }
    }

    fn assert_decoys_untouched(&self) {
        for entry in fs::read_dir(&self.0).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy();
            if name.starts_with("qaren-home-")
                || name.starts_with("tmp-")
                || name.starts_with("xdg-")
            {
                assert!(
                    fs::read_dir(&path).unwrap().next().is_none(),
                    "{name} was written"
                );
            }
        }
    }
}

impl Held {
    fn rows(&self) -> Vec<Row> {
        self.children.iter().map(Child::row).collect()
    }

    fn release(self) {
        for child in self.children {
            child.finish();
        }
    }
}

impl Child {
    fn row(&self) -> Row {
        Row::parse(&fs::read_to_string(&self.result).expect("worker result"))
    }

    fn finish(mut self) {
        if let Some(writer) = self.release_write.as_mut() {
            writer.write_all(&[1]).unwrap();
        }
        let mut child = self.child.take().unwrap();
        let status = child.wait().unwrap();
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            pipe.read_to_string(&mut stderr).unwrap();
        }
        assert!(status.success(), "{stderr}");
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let text = self.0.to_string_lossy().into_owned();
        let _ = Command::new("/bin/chmod")
            .args(["-R", "-N", &text])
            .status();
        let _ = Command::new("/bin/chmod")
            .args(["-R", "u+rwx", &text])
            .status();
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Row {
    fn parse(line: &str) -> Self {
        let mut parts = line.trim().split('\t');
        Self {
            kind: parts.next().unwrap_or("").to_string(),
            resolved: PathBuf::from(parts.next().unwrap_or("")),
            used: PathBuf::from(parts.next().unwrap_or("")),
            lock_dir: PathBuf::from(parts.next().unwrap_or("")),
            run: parts.next().unwrap_or("").to_string(),
            detail: parts.next().unwrap_or("").to_string(),
        }
    }

    fn claimed(&self) -> bool {
        self.kind == "ok"
    }

    fn busy(&self) -> bool {
        self.kind == "busy"
    }
}

trait LockName {
    fn ends_with_component_prefix(&self, prefix: &str) -> bool;
}

impl LockName for Path {
    fn ends_with_component_prefix(&self, prefix: &str) -> bool {
        self.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(prefix))
    }
}

fn probe(parent: Result<&Path, String>, privileged: bool) -> buildplan::MachineParent {
    buildplan::probe_machine_parent(parent, privileged)
}

fn claim(root: &Path, name: &str, run: &str) -> LockOutcome {
    let mut runner = RealRunner::new();
    buildplan::claim_lock(
        &mut runner,
        root,
        name,
        &sample_holder(run),
        LockPolicy::Strict,
    )
}

fn must_claim(root: &Path, name: &str, run: &str) -> PathBuf {
    let outcome = claim(root, name, run);
    match outcome {
        LockOutcome::Claimed { .. } => root.join(name),
        other => panic!("expected a claim, got {other:?}"),
    }
}

fn must_claim_with(
    runner: &mut qaren::exec::MockRunner,
    root: &Path,
    name: &str,
    holder: &LockHolder,
) {
    let outcome = buildplan::claim_lock(runner, root, name, holder, LockPolicy::Strict);
    assert!(
        matches!(outcome, LockOutcome::Claimed { .. }),
        "{outcome:?}"
    );
}

fn sample_holder(run: &str) -> LockHolder {
    LockHolder {
        holder: format!("qaren-{run}"),
        run_id: run.to_string(),
        identity: None,
        at: "2026-10-21T00:00:00Z".to_string(),
        home: None,
        group: None,
    }
}

fn worker_claim() {
    let line = claim_line().unwrap_or_else(|error| format!("error\t\t\t\t\t{error}"));
    fs::write(std::env::var("QAREN_LOCK_RESULT").unwrap(), &line).unwrap();
    write_fd(env_fd("QAREN_LOCK_DONE_FD"), 1);
    let _ = read_fd(env_fd("QAREN_LOCK_RELEASE_FD"));
    if let Some(dir) = line.strip_prefix("ok\t").and_then(lock_dir_field) {
        let run = std::env::var("QAREN_LOCK_RUN").unwrap();
        let outcome = buildplan::release_lock(Path::new(dir), &format!("qaren-{run}"), &run);
        assert!(
            matches!(outcome, ReleaseOutcome::Removed | ReleaseOutcome::Absent),
            "{outcome:?}"
        );
    }
}

fn claim_line() -> Result<String, String> {
    let home = std::env::var_os("HOME").ok_or("HOME missing")?;
    let fixture = PathBuf::from(std::env::var_os("QAREN_LOCK_FIXTURE").ok_or("fixture missing")?);
    let resolved = buildplan::configured_lock_root(
        std::env::var_os("QAREN_LOCK_ROOT").as_deref(),
        std::env::var_os(buildplan::MACHINE_LOCKS_ENV).as_deref(),
        Some(home.as_ref()),
    )?;
    let machine = buildplan::machine_lock_parent()?;
    let used = if resolved == machine {
        fixture.join("machine")
    } else {
        resolved.clone()
    };
    let mut runner = RealRunner::new();
    let run = std::env::var("QAREN_LOCK_RUN").unwrap();
    let identity = if std::env::var("QAREN_LOCK_IDENTITY").unwrap() == "live" {
        Some(
            qaren::runrecord::capture_pid_identity(&mut runner, std::process::id() as i32)
                .ok_or("ps identity is unavailable")?,
        )
    } else {
        None
    };
    let platform = match std::env::var("QAREN_LOCK_PLATFORM").unwrap().as_str() {
        "ios" => Platform::Ios,
        "android" => Platform::Android,
        other => return Err(format!("unknown platform {other}")),
    };
    let device = std::env::var("QAREN_LOCK_DEVICE").unwrap();
    let name = std::env::var("QAREN_LOCK_NAME").unwrap();
    if name.is_empty() {
        return match lease::try_acquire(&mut runner, &used, platform, &device, &run, identity) {
            Ok(lease) => Ok(format!(
                "ok\t{}\t{}\t{}\t{run}\t{}",
                resolved.display(),
                used.display(),
                lease.lock_dir.display(),
                lease.holder
            )),
            Err(busy) if busy.failure.code == FailureCode::DeviceBusy => Ok(format!(
                "busy\t{}\t{}\t\t\t{}",
                resolved.display(),
                used.display(),
                one_line(&busy.failure.detail)
            )),
            Err(busy) => Ok(format!(
                "error\t{}\t{}\t\t\t{}",
                resolved.display(),
                used.display(),
                one_line(&busy.failure.detail)
            )),
        };
    }
    let mut holder = sample_holder(&run);
    holder.identity = identity;
    let policy = if std::env::var("QAREN_LOCK_POLICY").unwrap() == "adopt" {
        LockPolicy::AdoptDead
    } else {
        LockPolicy::Strict
    };
    match buildplan::claim_lock(&mut runner, &used, &name, &holder, policy) {
        LockOutcome::Claimed { .. } => Ok(format!(
            "ok\t{}\t{}\t{}\t{run}\t{}",
            resolved.display(),
            used.display(),
            used.join(&name).display(),
            holder.holder
        )),
        LockOutcome::Contended { detail, .. } => Ok(format!(
            "busy\t{}\t{}\t\t\t{}",
            resolved.display(),
            used.display(),
            one_line(&detail)
        )),
        LockOutcome::Error(detail) => Ok(format!(
            "error\t{}\t{}\t\t\t{}",
            resolved.display(),
            used.display(),
            one_line(&detail)
        )),
    }
}

fn worker_umask() {
    let mask: u32 = std::env::var("QAREN_LOCK_UMASK").unwrap().parse().unwrap();
    unsafe { libc::umask(mask as libc::mode_t) };
    let root = PathBuf::from(std::env::var("QAREN_LOCK_ROOT").unwrap());
    match claim(&root, "umask-leaf", "umask-run") {
        LockOutcome::Claimed { .. } => {
            let dir = root.join("umask-leaf");
            let mode = fs::metadata(&dir).unwrap().mode() & 0o777;
            let file = fs::metadata(dir.join("holder.json")).unwrap().mode() & 0o777;
            assert_eq!(mode, 0o700, "directory mode {mode:o}");
            assert_eq!(file, 0o600, "holder mode {file:o}");
            let release = buildplan::release_lock(&dir, "qaren-umask-run", "umask-run");
            assert!(matches!(release, ReleaseOutcome::Removed), "{release:?}");
            println!("umask-ok");
        }
        LockOutcome::Error(detail) => {
            if let Ok(meta) = fs::symlink_metadata(root.join("umask-leaf")) {
                assert_eq!(meta.mode() & 0o077, 0, "{detail}");
            }
            println!("umask-error {detail}");
        }
        LockOutcome::Contended { detail, .. } => panic!("umask claim contended: {detail}"),
    }
}

fn one_line(text: &str) -> String {
    text.replace(['\t', '\n'], " ")
}

fn lock_dir_field(rest: &str) -> Option<&str> {
    rest.split('\t').nth(2).filter(|field| !field.is_empty())
}

fn machine_parent() -> PathBuf {
    buildplan::machine_lock_parent().unwrap().to_path_buf()
}

fn find_file(root: &Path, name: &str) -> bool {
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries {
            let path = entry.unwrap().path();
            if path.file_name().is_some_and(|found| found == name) {
                return true;
            }
            if path.is_dir() {
                pending.push(path);
            }
        }
    }
    false
}

fn chmod(path: &Path, args: &[&str]) {
    let status = Command::new("/bin/chmod")
        .args(args)
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success(), "chmod {args:?} {}", path.display());
}

fn umask_child(root: &Path, mask: u32) -> String {
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "lock_namespace_worker", "--nocapture"])
        .env("QAREN_LOCK_WORKER_ROLE", "umask")
        .env("QAREN_LOCK_ROOT", root)
        .env("QAREN_LOCK_UMASK", mask.to_string())
        .env_remove(buildplan::MACHINE_LOCKS_ENV)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn barrier(children: &mut [&mut Child]) {
    let start = Instant::now();
    let mut pending = children.len();
    while pending > 0 {
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "a lock worker did not reach the barrier"
        );
        for child in children.iter_mut() {
            let Some(file) = child.done_read.as_mut() else {
                continue;
            };
            if !readable(file.as_raw_fd()) {
                continue;
            }
            let mut byte = [0u8; 1];
            assert_eq!(file.read(&mut byte).unwrap(), 1);
            child.done_read = None;
            pending -= 1;
        }
    }
}

fn inheritable_pipe() -> (File, File) {
    let mut fds = [0; 2];
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    for fd in fds {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert!(flags >= 0);
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) },
            0
        );
    }
    unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) }
}

fn env_fd(name: &str) -> i32 {
    std::env::var(name).unwrap().parse().unwrap()
}

fn write_fd(fd: i32, byte: u8) {
    let buffer = [byte];
    assert_eq!(
        unsafe { libc::write(fd, buffer.as_ptr() as *const _, 1) },
        1
    );
}

fn read_fd(fd: i32) -> u8 {
    let mut buffer = [0u8; 1];
    assert_eq!(
        unsafe { libc::read(fd, buffer.as_mut_ptr() as *mut _, 1) },
        1
    );
    buffer[0]
}

fn readable(fd: i32) -> bool {
    let mut pollfd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    unsafe { libc::poll(&mut pollfd, 1, 50) > 0 }
}
