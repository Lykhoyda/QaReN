mod common;

use qaren::commands::cleanup::Outcome;
use qaren::exec::{CmdOutput, MockRunner, Spawned};
use qaren::record::{self, VideoStatus};
use qaren::runrecord::{Phase, PidIdentity, RecorderKind, RecorderResource, RunRecord};
use std::path::PathBuf;

const LSTART: &str = "Wed Aug 12 16:01:00 2026";

#[test]
#[ignore = "requires ffmpeg and ffprobe on PATH"]
fn real_publication_of_the_pr1142_timeline_has_no_dark_frame() {
    use std::process::Command;
    let dir = common::temp_repo();
    std::fs::create_dir_all(dir.join("media")).unwrap();
    let source = record::video_path(&dir);
    // PR1142: admitted at 18.900 s, last row at 33.526 s, runner teardown dark from 34.030 s.
    let generated = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=red:s=16x16:r=30:d=18.9",
            "-f",
            "lavfi",
            "-i",
            "color=green:s=16x16:r=30:d=15.13",
            "-f",
            "lavfi",
            "-i",
            "color=black:s=16x16:r=30:d=6.7",
            "-filter_complex",
            "[0:v][1:v][2:v]concat=n=3:v=1:a=0",
            "-c:v",
            "libx264",
        ])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let original = std::fs::read(&source).unwrap();
    let mut runner = qaren::exec::RealRunner::new();
    assert_eq!(
        record::publication_copy(&mut runner, &dir, Some(18_900), Some(33_526), false),
        VideoStatus::Available,
    );
    let copy = record::published_video_path(&dir);
    let duration = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(&copy)
        .output()
        .unwrap();
    assert!(duration.status.success());
    let seconds: f64 = String::from_utf8(duration.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!((seconds - 14.626).abs() < 0.05, "duration: {seconds}");
    let frames = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(&copy)
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output()
        .unwrap();
    assert!(frames.status.success());
    let dark = frames
        .stdout
        .chunks_exact(16 * 16 * 3)
        .filter(|frame| {
            !frame
                .chunks_exact(3)
                .all(|p| p[1] > 80 && p[0] < 20 && p[2] < 20)
        })
        .count();
    assert_eq!(dark, 0);
    assert_eq!(std::fs::read(&source).unwrap(), original);
    std::fs::remove_dir_all(dir).unwrap();
}

fn walking_record() -> (PathBuf, RunRecord) {
    let repo = common::temp_repo();
    let record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "check-20260812T160000Z",
        Phase::Walking,
    );
    std::fs::create_dir_all(RunRecord::run_dir(&repo, &record.run_id).join("logs")).unwrap();
    record.save(&repo).unwrap();
    (repo, record)
}

fn script_identity(mock: &mut MockRunner) {
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("xcrun simctl io\n"));
}

#[test]
fn ios_start_persists_the_resource_and_waits_for_recording_started() {
    let (root, mut record) = walking_record();
    let mut mock = MockRunner::new();
    mock.expect_spawn_with_log(
        "simctl io U recordVideo --codec h264 --force",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
        "Recording started\n",
    );
    script_identity(&mut mock);

    record::start(
        &mut mock,
        &mut record,
        &root,
        record::RecordTarget::Ios("U"),
    )
    .unwrap();

    let recorder = RunRecord::load(&root, &record.run_id)
        .unwrap()
        .resources
        .recorder
        .unwrap();
    assert_eq!(recorder.pid, Some(7100));
    assert_eq!(recorder.kind, RecorderKind::IosSimulator);
    assert!(recorder.output.ends_with("media/raw.mov"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_start_without_recording_started_is_unavailable_and_the_run_continues() {
    let (root, mut record) = walking_record();
    let mut mock = MockRunner::new();
    mock.expect_spawn_with_log(
        "recordVideo",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
        "booting\n",
    );
    script_identity(&mut mock);
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("/bin/kill -INT 7100", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));

    let status = record::start(
        &mut mock,
        &mut record,
        &root,
        record::RecordTarget::Ios("U"),
    )
    .unwrap_err();

    assert!(
        matches!(&status, VideoStatus::Unavailable(r) if r.contains("did not start")),
        "{status}"
    );
    assert!(record.resources.recorder.is_none());
    assert!(RunRecord::load(&root, &record.run_id)
        .unwrap()
        .resources
        .recorder
        .is_none());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn stop_sends_sigint_and_waits_for_exit() {
    let (root, mut record) = walking_record();
    record.resources.recorder = Some(RecorderResource {
        pid: Some(7100),
        birth: Some(PidIdentity {
            pid: 7100,
            started_at: LSTART.into(),
            command: qaren::redact::OutputText::from_output("xcrun"),
        }),
        pulled_sha256: None,
        kind: RecorderKind::IosSimulator,
        device: "U".into(),
        output: PathBuf::from("raw.mov"),
    });
    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("/bin/kill -INT 7100", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("Z\n"));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));

    assert_eq!(
        record::stop(&mut mock, &mut record, &root),
        Outcome::Removed
    );

    assert!(record.resources.recorder.is_none());
    assert_eq!(mock.remaining(), 0);
    let kill = mock
        .calls
        .iter()
        .find(|c| c.label == "recorder-interrupt")
        .unwrap();
    assert_eq!(kill.args, ["-INT", "7100"]);
}

#[test]
fn a_recorder_with_an_unproven_spawn_is_unresolved() {
    let (root, mut record) = walking_record();
    record.resources.recorder = Some(RecorderResource {
        pid: None,
        birth: None,
        pulled_sha256: None,
        kind: RecorderKind::IosSimulator,
        device: "U".into(),
        output: PathBuf::from("raw.mov"),
    });
    let outcome = record::stop(&mut MockRunner::new(), &mut record, &root);
    assert!(matches!(outcome, Outcome::Unresolved(_)));
    assert!(record.resources.recorder.is_some());
}

// Deletes the worktree directory when git is asked to remove it, as git would.
struct GitRemoves(MockRunner, Option<PathBuf>);

impl qaren::exec::Runner for GitRemoves {
    fn execute(&mut self, spec: &qaren::exec::CmdSpec, interruptible: bool) -> CmdOutput {
        if spec.args.starts_with(&["worktree".into(), "remove".into()]) {
            let _ = std::fs::remove_dir_all(spec.args.last().unwrap());
        }
        if let Some(path) = &self.1 {
            if spec.label == "ps-command" {
                std::fs::rename(path, path.with_extension("backup")).unwrap();
                std::fs::create_dir(path).unwrap();
            } else if spec.label == "kill-group"
                && spec.args.first().map(String::as_str) == Some("-KILL")
            {
                std::fs::remove_dir(path).unwrap();
                std::fs::rename(path.with_extension("backup"), path).unwrap();
            }
        }
        self.0.execute(spec, interruptible)
    }
    fn spawn_group_unchecked(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log: &std::path::Path,
    ) -> std::io::Result<Spawned> {
        self.0.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log: &std::path::Path,
    ) -> std::io::Result<qaren::exec::PipedChild> {
        self.0.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, d: std::time::Duration) {
        self.0.sleep(d)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.0.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.0.commands_executed()
    }
}

fn pr_run_record() -> (PathBuf, RunRecord, PathBuf) {
    let (root, mut record) = walking_record();
    record.resources.recorder = Some(RecorderResource {
        pid: Some(7100),
        birth: Some(PidIdentity {
            pid: 7100,
            started_at: LSTART.into(),
            command: qaren::redact::OutputText::from_output("xcrun"),
        }),
        pulled_sha256: None,
        kind: RecorderKind::IosSimulator,
        device: "U".into(),
        output: PathBuf::from("raw.mov"),
    });
    let wt = qaren::worktree::pr_worktree_path(&RunRecord::run_dir(&root, &record.run_id));
    std::fs::create_dir_all(&wt).unwrap();
    record.resources.pr_worktree = Some(qaren::runrecord::PrWorktreeResource {
        repo_root: root.clone(),
        path: wt.clone(),
    });
    record.save(&root).unwrap();
    (root, record, wt)
}

#[test]
fn a_dead_owners_recorder_is_stopped_and_its_worktree_removed() {
    let (root, record, wt) = pr_run_record();
    let mut mock = MockRunner::new();
    mock.expect_run("ps -p 999", CmdOutput::failed(1, "")); // owner gone
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("/bin/kill -INT 7100", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("du -sk", CmdOutput::success("4\n"));
    mock.expect_run("worktree remove --force", CmdOutput::success(""));
    let mut runner = GitRemoves(mock, None);

    let receipt = qaren::commands::cleanup::cleanup(&mut runner, &root, &record.run_id);

    assert_eq!(receipt.cleanup["recorder"], "removed");
    assert_eq!(
        receipt.cleanup["pr_worktree"],
        "removed (reclaimed 4096 bytes)"
    );
    assert!(!wt.exists());
    let saved = RunRecord::load(&root, &record.run_id).unwrap();
    assert!(saved.resources.recorder.is_none());
    assert!(saved.resources.pr_worktree.is_none());
    assert_eq!(runner.0.remaining(), 0);
}

#[test]
fn a_live_owners_recorder_and_worktree_are_untouched() {
    let (root, record, wt) = pr_run_record();
    let mut mock = MockRunner::new();
    mock.expect_run(
        "ps -p 999",
        CmdOutput::success("Wed Aug 12 15:00:00 2026\n"),
    );
    mock.expect_run("ps -p 999", CmdOutput::success("S\n"));

    let receipt = qaren::commands::cleanup::cleanup(&mut mock, &root, &record.run_id);

    assert!(receipt.cleanup["recorder"].starts_with("refused"));
    assert!(receipt.cleanup["pr_worktree"].starts_with("refused"));
    assert!(wt.exists());
    let saved = RunRecord::load(&root, &record.run_id).unwrap();
    assert!(saved.resources.recorder.is_some());
    assert!(saved.resources.pr_worktree.is_some());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn unknown_identity_abort_never_signals_and_retains_ownership_until_group_absence() {
    let (root, mut record) = walking_record();
    let mut mock = MockRunner::new();
    mock.expect_spawn_with_log(
        "recordVideo",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
        "",
    );
    mock.expect_run("ps", CmdOutput::failed(1, "identity unavailable"));
    mock.expect_run("ps", CmdOutput::failed(1, "identity unavailable"));
    mock.expect_run("ps -A", CmdOutput::success("7100 7100 S\n"));
    mock.expect_run("ps -A", CmdOutput::success("7100 7100 S\n"));
    assert!(record::start(
        &mut mock,
        &mut record,
        &root,
        record::RecordTarget::Ios("U")
    )
    .is_err());
    assert!(mock.calls.iter().all(|spec| spec.program != "/bin/kill"));
    let mut saved = RunRecord::load(&root, &record.run_id).unwrap();
    assert_eq!(saved.resources.recorder.as_ref().unwrap().pid, Some(7100));
    mock.expect_run("ps -A", CmdOutput::success("7100 7100 S\n"));
    mock.expect_run("ps -A", CmdOutput::success("7100 7100 S\n"));
    assert!(matches!(
        record::stop(&mut mock, &mut saved, &root),
        Outcome::Unresolved(_)
    ));
    assert!(saved.resources.recorder.is_some());
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    assert_eq!(record::stop(&mut mock, &mut saved, &root), Outcome::Removed);
    assert!(RunRecord::load(&root, &record.run_id)
        .unwrap()
        .resources
        .recorder
        .is_none());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn failed_persistence_and_abort_keep_the_proven_recorder_for_teardown() {
    let (root, mut record) = walking_record();
    let mut mock = MockRunner::new();
    mock.expect_spawn_with_log(
        "recordVideo",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
        "",
    );
    script_identity(&mut mock);
    mock.expect_run("ps -A", CmdOutput::success("7100 7100 S\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill -TERM", CmdOutput::failed(1, "signal failed"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill -KILL", CmdOutput::failed(1, "signal failed"));
    mock.expect_run("ps -A", CmdOutput::success("7100 7100 S\n"));
    let mut runner = GitRemoves(mock, Some(RunRecord::path(&root, &record.run_id)));
    assert!(record::start(
        &mut runner,
        &mut record,
        &root,
        record::RecordTarget::Ios("U")
    )
    .is_err());
    let mut saved = RunRecord::load(&root, &record.run_id).unwrap();
    assert!(saved.resources.recorder.as_ref().unwrap().birth.is_some());
    runner
        .0
        .expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    runner.0.expect_run("ps", CmdOutput::success("S\n"));
    runner
        .0
        .expect_run("/bin/kill -INT 7100", CmdOutput::success(""));
    runner.0.expect_run("ps", CmdOutput::failed(1, ""));
    runner.0.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    assert_eq!(
        record::stop(&mut runner, &mut saved, &root),
        Outcome::Removed
    );
    assert!(RunRecord::load(&root, &record.run_id)
        .unwrap()
        .resources
        .recorder
        .is_none());
    assert_eq!(runner.0.remaining(), 0);
}

#[test]
fn dead_owner_worktrees_wait_for_each_producer_then_retry_removal() {
    for producer in ["build", "core", "metro"] {
        let (root, mut record, wt) = pr_run_record();
        record.resources.recorder = None;
        match producer {
            "build" => {
                record.resources.begin_build().unwrap();
                record.resources.record_build_spawned(5000, None).unwrap();
            }
            "core" => {
                record.resources.core = Some(qaren::runrecord::CoreResource {
                    pgid: 5000,
                    identity: None,
                })
            }
            "metro" => {
                record.resources.metro = Some(qaren::runrecord::MetroResource {
                    spawned: Spawned {
                        pid: 5000,
                        pgid: 5000,
                    },
                    identity: Some(common::identity(5000, LSTART)),
                    port: 8791,
                    endpoint: "http://localhost:8791".into(),
                    log: root.join("metro.log"),
                })
            }
            _ => unreachable!(),
        }
        record.save(&root).unwrap();
        let mut mock = MockRunner::new();
        if producer == "core" {
            mock.expect_run("ps -p 999", CmdOutput::failed(1, ""));
        }
        if producer == "metro" {
            mock.expect_run("ps -p 5000", CmdOutput::failed(1, ""));
            mock.expect_run("lsof", CmdOutput::failed(2, "inventory unavailable"));
        } else {
            mock.expect_run("ps -A", CmdOutput::failed(1, "inventory unavailable"));
        }
        mock.expect_run("ps -p 999", CmdOutput::failed(1, ""));
        let mut runner = GitRemoves(mock, None);
        let receipt = qaren::commands::cleanup::cleanup(&mut runner, &root, &record.run_id);
        assert!(
            receipt.cleanup["pr_worktree"].contains("retained"),
            "{producer}"
        );
        assert!(wt.exists());
        assert!(RunRecord::load(&root, &record.run_id)
            .unwrap()
            .resources
            .pr_worktree
            .is_some());
        assert!(!runner
            .0
            .calls
            .iter()
            .any(|c| c.label == "git-worktree-remove"));
        assert_eq!(runner.0.remaining(), 0);
        let mut mock = MockRunner::new();
        if producer == "core" {
            mock.expect_run("ps -p 999", CmdOutput::failed(1, ""));
        }
        if producer == "metro" {
            mock.expect_run("ps -p 5000", CmdOutput::failed(1, ""));
            mock.expect_run("lsof", CmdOutput::failed(1, ""));
            mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        } else {
            mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        }
        mock.expect_run("ps -p 999", CmdOutput::failed(1, ""));
        mock.expect_run("du -sk", CmdOutput::success("4\n"));
        mock.expect_run("worktree remove --force", CmdOutput::success(""));
        let mut runner = GitRemoves(mock, None);
        let receipt = qaren::commands::cleanup::cleanup(&mut runner, &root, &record.run_id);
        assert_eq!(
            receipt.cleanup["pr_worktree"], "removed (reclaimed 4096 bytes)",
            "{producer}"
        );
        assert!(!wt.exists());
        assert!(RunRecord::load(&root, &record.run_id)
            .unwrap()
            .resources
            .pr_worktree
            .is_none());
        assert_eq!(runner.0.remaining(), 0);
    }
}

#[test]
fn unbound_metro_groups_retain_worktrees_and_leases_until_positive_absence() {
    for signaled in [false, true] {
        for inventory in [
            CmdOutput::success("1 1 S\n5001 5000 S\n"),
            CmdOutput::failed(1, "inventory denied"),
            CmdOutput::success("malformed\n"),
        ] {
            let (root, mut record, wt) = pr_run_record();
            record.resources.recorder = None;
            record.resources.metro = Some(qaren::runrecord::MetroResource {
                spawned: Spawned {
                    pid: 5000,
                    pgid: 5000,
                },
                identity: Some(common::identity(5000, LSTART)),
                port: 8791,
                endpoint: "http://localhost:8791".into(),
                log: root.join("metro.log"),
            });
            record.resources.lease = Some(
                qaren::lease::acquire(
                    &mut MockRunner::new(),
                    &root.join("locks"),
                    qaren::scenario::Platform::Ios,
                    "fixture-device",
                    &record.run_id,
                    None,
                )
                .unwrap(),
            );
            let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
            record.save(&root).unwrap();
            for attempt in 0..2 {
                let mut mock = MockRunner::new();
                if signaled && attempt == 0 {
                    mock.expect_run("ps -p 5000", CmdOutput::success(&format!("{LSTART}\n")));
                    mock.expect_run("ps -p 5000", CmdOutput::success("S\n"));
                    mock.expect_run("lsof", CmdOutput::failed(1, ""));
                    mock.expect_run("lstart=", CmdOutput::success(LSTART));
                    mock.expect_run("stat=", CmdOutput::success("S"));
                    mock.expect_run("/bin/kill", CmdOutput::success(""));
                    mock.expect_run("lstart=", CmdOutput::success(LSTART));
                    mock.expect_run("stat=", CmdOutput::success("S"));
                    mock.expect_run("/bin/kill", CmdOutput::success(""));
                }
                mock.expect_run("ps -p 5000", CmdOutput::failed(1, ""));
                mock.expect_run("lsof", CmdOutput::failed(1, ""));
                mock.expect_run("ps -A", inventory.clone());
                mock.expect_run("ps -p 999", CmdOutput::failed(1, ""));
                let mut runner = GitRemoves(mock, None);
                let receipt = qaren::commands::cleanup::cleanup(&mut runner, &root, &record.run_id);
                assert!(receipt.cleanup["metro"].starts_with("unresolved"));
                assert!(receipt.cleanup["pr_worktree"].contains("retained"));
                assert!(receipt.cleanup["device_lease"].contains("retained"));
                assert!(wt.exists());
                assert!(lock.exists());
                let saved = RunRecord::load(&root, &record.run_id).unwrap();
                assert_eq!(saved.resources.metro.unwrap().identity.unwrap().pid, 5000);
                assert!(saved.resources.pr_worktree.is_some());
                assert!(saved.resources.lease.is_some());
                assert_eq!(runner.0.remaining(), 0);
            }
            let mut mock = MockRunner::new();
            mock.expect_run("ps -p 5000", CmdOutput::failed(1, ""));
            mock.expect_run("lsof", CmdOutput::failed(1, ""));
            mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
            mock.expect_run("ps -p 999", CmdOutput::failed(1, ""));
            mock.expect_run("du -sk", CmdOutput::success("4\n"));
            mock.expect_run("worktree remove --force", CmdOutput::success(""));
            let mut runner = GitRemoves(mock, None);
            let receipt = qaren::commands::cleanup::cleanup(&mut runner, &root, &record.run_id);
            assert_eq!(receipt.cleanup["metro"], "absent");
            assert_eq!(
                receipt.cleanup["pr_worktree"],
                "removed (reclaimed 4096 bytes)"
            );
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            assert!(!wt.exists());
            assert!(!lock.exists());
            assert_eq!(runner.0.remaining(), 0);
        }
    }
}

#[test]
fn cancellation_during_recorder_readiness_stops_and_retires_the_recorder() {
    let (root, mut record) = walking_record();
    let mut mock = MockRunner::new();
    mock.expect_spawn_with_log(
        "recordVideo",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
        "booting\n",
    );
    script_identity(&mut mock);
    mock.cancel_after = Some(("-o command=".into(), "received SIGTERM".into()));
    mock.expect_run("ps", CmdOutput::success(LSTART));
    mock.expect_run("ps", CmdOutput::success("S"));
    mock.expect_run("/bin/kill -INT 7100", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    let status = record::start(
        &mut mock,
        &mut record,
        &root,
        record::RecordTarget::Ios("U"),
    )
    .unwrap_err();
    assert!(matches!(status, VideoStatus::Unavailable(reason) if reason.contains("SIGTERM")));
    assert!(record.resources.recorder.is_none());
    assert!(RunRecord::load(&root, &record.run_id)
        .unwrap()
        .resources
        .recorder
        .is_none());
    assert_eq!(mock.remaining(), 0);
}

fn android_walking_record() -> (PathBuf, RunRecord) {
    use qaren::runrecord::BorrowedEmulatorResource;
    let (root, mut record) = walking_record();
    record.scenario.platform = qaren::scenario::Platform::Android;
    record.resources.adb_path = Some("/sdk/platform-tools/adb".into());
    record.resources.adb_local_serial = Some("emulator-5600".into());
    record.resources.android_emulator = Some(BorrowedEmulatorResource {
        serial: "emulator-5600".into(),
        avd: "recorder-test".into(),
        server_port: 5155,
        api_level: 37,
        abi: "x86_64".into(),
    });
    let media = RunRecord::run_dir(&root, &record.run_id).join("media");
    std::fs::create_dir_all(&media).unwrap();
    // Bytes supplied by the scripted successful pull; no completion evidence exists yet.
    std::fs::write(media.join("raw.mp4"), "complete recording").unwrap();
    record.resources.device_borrowed = true;
    record.resources.lease = Some(
        qaren::lease::acquire(
            &mut MockRunner::new(),
            &root.join("locks"),
            qaren::scenario::Platform::Android,
            "emulator-5600",
            &record.run_id,
            None,
        )
        .unwrap(),
    );
    record.save(&root).unwrap();
    (root, record)
}

fn android_recording_record() -> (PathBuf, RunRecord) {
    let (root, mut record) = android_walking_record();
    record.resources.recorder = Some(RecorderResource {
        pid: Some(7100),
        birth: Some(common::identity(7100, LSTART)),
        pulled_sha256: None,
        kind: RecorderKind::AndroidEmulator,
        device: "emulator-5600".into(),
        output: PathBuf::from(format!("/data/local/tmp/qaren-{}.mp4", record.run_id)),
    });
    record.save(&root).unwrap();
    (root, record)
}

#[test]
fn android_stop_records_kill_fallback_and_proves_absence_before_pulling() {
    let (root, mut record) = android_recording_record();
    let mut mock = MockRunner::new();
    mock.advance_on = Some(("shell pgrep -f".into(), 30_000));
    mock.adb_servers.push((5155, 41));
    mock.expect_run(
        "adb version",
        CmdOutput::success("Android Debug Bridge version 1.0.41"),
    );
    mock.expect_run("shell pkill -INT -f", CmdOutput::success(""));
    mock.expect_run("shell pgrep -f", CmdOutput::success("42\n"));
    mock.expect_run("shell pkill -KILL -f", CmdOutput::success(""));
    mock.expect_run("shell pgrep -f", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("pull", CmdOutput::success(""));
    mock.expect_run("shell rm -f", CmdOutput::success(""));

    assert_eq!(
        record::stop(&mut mock, &mut record, &root),
        Outcome::Removed
    );
    let persisted = RunRecord::load(&root, &record.run_id).unwrap();
    assert!(persisted
        .history
        .iter()
        .any(|row| row.note.as_str().contains("finalized abnormally")));
    assert!(persisted.resources.recorder.is_none());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_stop_keeps_device_media_and_resource_when_pull_fails_then_recovers() {
    let (root, mut record) = android_recording_record();
    let device_path = record.resources.recorder.as_ref().unwrap().output.clone();
    let mut mock = MockRunner::new();
    mock.adb_servers.push((5155, 41));
    mock.expect_run(
        "adb version",
        CmdOutput::success("Android Debug Bridge version 1.0.41"),
    );
    mock.expect_run("shell pkill -INT -f", CmdOutput::success(""));
    mock.expect_run("shell pgrep -f", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("pull", CmdOutput::failed(1, "Permission denied"));
    assert_eq!(
        record::stop(&mut mock, &mut record, &root),
        Outcome::Unresolved(format!(
            "pull failed; media kept on device at {}",
            device_path.display()
        ))
    );
    assert!(record.resources.recorder.is_some());
    assert!(RunRecord::load(&root, &record.run_id)
        .unwrap()
        .resources
        .recorder
        .is_some());
    assert!(!mock.calls.iter().any(|call| call.label == "adb-rm"));
    assert_eq!(mock.remaining(), 0);

    let mut recovered = RunRecord::load(&root, &record.run_id).unwrap();
    let mut retry = MockRunner::new();
    retry.adb_servers.push((5155, 41));
    retry.expect_run(
        "adb version",
        CmdOutput::success("Android Debug Bridge version 1.0.41"),
    );
    retry.expect_run("shell pkill -INT -f", CmdOutput::failed(1, ""));
    retry.expect_run("shell pgrep -f", CmdOutput::failed(1, ""));
    retry.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    retry.expect_run("pull", CmdOutput::success(""));
    retry.expect_run("shell rm -f", CmdOutput::success(""));
    assert_eq!(
        record::stop(&mut retry, &mut recovered, &root),
        Outcome::Removed
    );
    assert!(RunRecord::load(&root, &record.run_id)
        .unwrap()
        .resources
        .recorder
        .is_none());
    assert!(retry.calls[4]
        .args
        .last()
        .unwrap()
        .ends_with("media/raw.mp4"));
    for call in mock
        .calls
        .iter()
        .chain(&retry.calls)
        .filter(|call| call.program.ends_with("/adb") && call.label != "adb-version")
    {
        assert_eq!(&call.args[..2], &["-s", "emulator-5600"]);
        assert!(call
            .env
            .contains(&("ADB_SERVER_SOCKET".into(), "tcp:127.0.0.1:5155".into())));
    }
    assert_eq!(retry.remaining(), 0);
}

#[test]
fn android_stop_retires_only_after_device_rm_succeeds() {
    let (root, mut record) = android_recording_record();
    let mut mock = MockRunner::new();
    mock.adb_servers.push((5155, 41));
    mock.expect_run(
        "adb version",
        CmdOutput::success("Android Debug Bridge version 1.0.41"),
    );
    mock.expect_run("shell pkill -INT -f", CmdOutput::success(""));
    mock.expect_run("shell pgrep -f", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("pull", CmdOutput::success(""));
    mock.expect_run("shell rm -f", CmdOutput::failed(1, "Permission denied"));
    assert!(
        matches!(record::stop(&mut mock,&mut record,&root),Outcome::Unresolved(reason) if reason.contains("device rm failed"))
    );
    assert!(RunRecord::load(&root, &record.run_id)
        .unwrap()
        .resources
        .recorder
        .is_some());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_start_without_a_path_pgrep_hit_is_unavailable_and_stops() {
    let (root, mut record) = android_walking_record();
    let mut mock = MockRunner::new();
    mock.advance_on = Some(("shell pgrep -f".into(), 10_000));
    mock.expect_run("shell rm -f", CmdOutput::success(""));
    mock.expect_spawn(
        "screenrecord --time-limit 0 --bit-rate 4000000",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
    );
    mock.expect_run("ps", CmdOutput::success(LSTART));
    mock.expect_run("ps", CmdOutput::success("adb shell screenrecord"));
    mock.expect_run("shell pgrep -f", CmdOutput::failed(1, ""));
    mock.adb_servers.push((5155, 41));
    mock.expect_run(
        "adb version",
        CmdOutput::success("Android Debug Bridge version 1.0.41"),
    );
    mock.expect_run("shell pkill -INT -f", CmdOutput::failed(1, ""));
    mock.expect_run("shell pgrep -f", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("pull", CmdOutput::failed(1, "no file"));
    let status = record::start(
        &mut mock,
        &mut record,
        &root,
        record::RecordTarget::Android {
            adb: std::path::Path::new("/sdk/platform-tools/adb"),
            port: 5155,
            serial: "emulator-5600",
        },
    )
    .unwrap_err();
    assert!(
        matches!(status,VideoStatus::Unavailable(reason) if reason.contains("recorder did not start"))
    );
    assert_eq!(mock.calls[1].timeout_seconds, 0);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_stop_refuses_unknown_device_state_and_failed_signals_without_pull_or_rm() {
    for failure in ["INT", "pgrep", "KILL", "after-KILL"] {
        let (root, mut record) = android_recording_record();
        let mut mock = MockRunner::new();
        mock.advance_on = Some(("shell pgrep -f".into(), 30_000));
        mock.adb_servers.push((5155, 41));
        mock.expect_run(
            "adb version",
            CmdOutput::success("Android Debug Bridge version 1.0.41"),
        );
        mock.expect_run(
            "shell pkill -INT -f",
            if failure == "INT" {
                CmdOutput::failed(2, "denied")
            } else {
                CmdOutput::success("")
            },
        );
        if failure != "INT" {
            mock.expect_run(
                "shell pgrep -f",
                if failure == "pgrep" {
                    CmdOutput::failed(2, "unknown")
                } else {
                    CmdOutput::success("42")
                },
            );
            if failure != "pgrep" {
                mock.expect_run(
                    "shell pkill -KILL -f",
                    if failure == "KILL" {
                        CmdOutput::failed(2, "denied")
                    } else {
                        CmdOutput::success("")
                    },
                );
                if failure == "after-KILL" {
                    mock.expect_run("shell pgrep -f", CmdOutput::success("42"));
                }
            }
        }
        assert!(
            matches!(
                record::stop(&mut mock, &mut record, &root),
                Outcome::Unresolved(_)
            ),
            "{failure}"
        );
        assert!(
            RunRecord::load(&root, &record.run_id)
                .unwrap()
                .resources
                .recorder
                .is_some(),
            "{failure}"
        );
        assert!(
            !mock
                .calls
                .iter()
                .any(|call| matches!(call.label.as_str(), "adb-pull" | "adb-rm")),
            "{failure}"
        );
        assert_eq!(mock.remaining(), 0, "{failure}");
    }
}

#[test]
fn android_stop_keeps_device_media_until_successful_pull_evidence_is_persisted() {
    let (root, mut record) = android_recording_record();
    let run_dir = RunRecord::run_dir(&root, &record.run_id);
    let failed_save = run_dir.join(format!(".run.json.tmp.{}", std::process::id()));
    std::fs::create_dir(&failed_save).unwrap();
    let mut mock = MockRunner::new();
    mock.adb_servers.push((5155, 41));
    mock.expect_run(
        "adb version",
        CmdOutput::success("Android Debug Bridge version 1.0.41"),
    );
    mock.expect_run("shell pkill -INT", CmdOutput::success(""));
    mock.expect_run("shell pgrep", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("pull", CmdOutput::success(""));
    let outcome = record::stop(&mut mock, &mut record, &root);
    assert!(
        matches!(outcome, Outcome::Unresolved(reason) if reason.contains("pull evidence was not persisted"))
    );
    assert!(!mock.calls.iter().any(|c| c.label == "adb-rm"));
    assert!(record
        .resources
        .recorder
        .as_ref()
        .unwrap()
        .pulled_sha256
        .is_none());
    assert!(RunRecord::load(&root, &record.run_id)
        .unwrap()
        .resources
        .recorder
        .unwrap()
        .pulled_sha256
        .is_none());
    assert_eq!(mock.remaining(), 0);
    std::fs::remove_dir(failed_save).unwrap();

    // The local bytes alone cannot stand in for the failed evidence save.
    mock.expect_run(
        "adb version",
        CmdOutput::success("Android Debug Bridge version 1.0.41"),
    );
    mock.expect_run("shell pkill -INT", CmdOutput::failed(1, ""));
    mock.expect_run("shell pgrep", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("pull", CmdOutput::success(""));
    mock.expect_run("shell rm", CmdOutput::success(""));
    assert_eq!(
        record::stop(&mut mock, &mut record, &root),
        Outcome::Removed
    );
    assert_eq!(mock.remaining(), 0);
}
