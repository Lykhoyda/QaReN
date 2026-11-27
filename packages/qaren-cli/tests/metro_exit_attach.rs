mod common;

use qaren::core::{
    self, Budgets, CoreOutcome, CoreRequest, CoreTarget, MetroLook, RecordedMetro, Verdict,
};
use qaren::exec::{CmdSpec, MockRunner, RealRunner, Runner};
use qaren::failure::{AdmissionCause, Failure, FailureCode, FailureRecovery};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const RUN: &str = "check-20261127T120000Z";
const METRO: i32 = 4100;
const PORT: u16 = 8791;

fn request() -> CoreRequest {
    CoreRequest {
        video_policy: Default::default(),
        run_id: RUN.to_string(),
        t0: 1_770_000_000_000,
        walk_budget_ms: 60_000,
        attach_budget_ms: 20_000,
        plan: "1. Tap \"Tasks\"\n".to_string(),
        prepared: serde_json::json!({"hash":"test","blocks":[]}),
        preflight_calls: vec![],
        platform: "ios".to_string(),
        app_id: "com.rndevagent.testapp".to_string(),
        app_root: PathBuf::from("/tmp/app"),
        run_dir: PathBuf::from("/tmp/qaren-runs/check"),
        lease: format!("{RUN}:abcdef0123456789abcdef0123456789"),
        login_block: None,
        login_marker: None,
        app_source: None,
        target: CoreTarget {
            device_id: "AAAA-1111".to_string(),
            device_name: "qaren-check".to_string(),
            metro_port: PORT,
            metro_url_for_device: format!("http://127.0.0.1:{PORT}"),
            worktree: PathBuf::from("/tmp/app"),
            metro_bundle_requests: None,
            manifest_warm: None,
            warm_lane: false,
            android_launch_url: None,
        },
    }
}

fn envelope(seq: u64, kind: &str, payload: &str) -> String {
    format!(r#"{{"v":1,"runId":"{RUN}","seq":{seq},"type":"{kind}","payload":{payload}}}"#)
}

fn metro(log: &Path) -> RecordedMetro {
    RecordedMetro::new(METRO, PORT, log.to_path_buf())
}

// What the core sends for a refused target list, as the core row "admission names a refused target list"
// prints it (iOS wiring), with this request's budget.
const REFUSED: &str = r#"{"attempt":1,"lastStarted":"attach","lastCompleted":"none","inner":"target_list_unreachable","relaunches":0,"relaunchFailed":false,"liveness":"alive","bundleRequest":"received","elapsedMs":42,"remainingMs":58958,"budgetMs":59000}"#;

// A core that refuses at once, before admission unless `admitted`, and exits 4.
fn core_refusal(code: &str, facts: Option<&str>, admitted: bool, log: &Path) -> CoreOutcome {
    let admission = facts.map_or(String::new(), |facts| format!(r#","admission":{facts}"#));
    let refusal = format!(
        r#"{{"verdict":"REFUSED","code":"{code}","message":"cannot attach to the dev client through Metro 8791: Failed to list CDP targets on port 8791: fetch failed"{admission}}}"#
    );
    let mut stdout = String::new();
    let mut seq = 2;
    if admitted {
        stdout.push_str(&format!("{}\n", envelope(seq, "admitted", "{}")));
        seq += 1;
    }
    stdout.push_str(&format!("{}\n", envelope(seq, "result", &refusal)));
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(4));
    let spec = core::spawn_spec(
        Path::new("/usr/local/bin/node"),
        Path::new("/runtime"),
        Path::new("/tmp/app"),
        &request().lease,
        PORT,
        None,
    );
    let child = core::spawn(&mut mock, &spec, log, &request()).unwrap();
    let budgets = Budgets {
        walk_seconds: 60,
        step_seconds: 10,
    };
    let outcome = core::wait(&mut mock, child, budgets, &mut |_, _| {});
    assert_eq!(code_of(&outcome), code, "the fixture is that refusal");
    assert_eq!(outcome.ledger.admission.is_some(), facts.is_some());
    outcome
}

fn code_of(outcome: &CoreOutcome) -> &str {
    match &outcome.verdict {
        Verdict::Refused { code, .. } => code,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

// A host on which the launcher is reported exited from `exited_after_ms` on (None: never), the Metro port
// refuses a connection or not, and one connect takes `connect_ms` on the scripted clock.
fn host(exited_after_ms: Option<u64>, port_refuses: bool, connect_ms: u64) -> MockRunner {
    let mut mock = MockRunner::new();
    if let Some(after) = exited_after_ms {
        mock.exited_children
            .push((METRO, mock.now_epoch_ms() + after));
    }
    if port_refuses {
        mock.refusing_ports.push(PORT);
    }
    mock.connect_takes_ms = connect_ms;
    mock
}

const UNPROVEN: fn(bool, bool) -> MetroLook = |launcher_exited, port_refused| MetroLook::Unproven {
    launcher_exited,
    port_refused,
};

// G1. The proof itself. A build that needs only one of the two answers, uses a late answer, looks once, or
// does not pause between looks fails the case that separates it.
#[test]
fn only_an_exited_launcher_and_a_refusing_port_in_one_timely_look_is_gone() {
    let repo = common::temp_repo();
    let metro = metro(&repo.join("metro.log"));
    // (name, launcher exited after ms, port refuses, connect ms, expected, looks, scripted ms used)
    let cases: Vec<(&str, Option<u64>, bool, u64, MetroLook, usize, u64)> = vec![
        ("both at the first look", Some(0), true, 0, MetroLook::Gone, 1, 0),
        ("the launcher exits before the second look", Some(500), true, 0, MetroLook::Gone, 2, 1_000),
        ("the launcher exits before the third look", Some(1_500), true, 0, MetroLook::Gone, 3, 2_000),
        ("the launcher exits after the last look", Some(2_500), true, 0, UNPROVEN(false, true), 3, 2_000),
        ("the launcher never exits", None, true, 0, UNPROVEN(false, true), 3, 2_000),
        ("the port does not refuse", Some(0), false, 0, UNPROVEN(true, false), 3, 2_000),
        ("neither", None, false, 0, UNPROVEN(false, false), 3, 2_000),
        // Both answers are right, but the connect returned after the 4 s deadline: not used.
        ("both, but the answer is late", Some(0), true, 4_500, UNPROVEN(true, true), 1, 4_500),
        // 1.2 s per connect: the third look would start with 0.6 s left, so it is not made.
        ("slow connects end the looks early", None, true, 1_200, UNPROVEN(false, true), 2, 3_400),
    ];
    for (name, exited_after, port_refuses, connect_ms, expected, looks, used_ms) in cases {
        let mut mock = host(exited_after, port_refuses, connect_ms);
        let began = mock.now_epoch_ms();
        assert_eq!(metro.look(&mut mock), expected, "{name}");
        assert_eq!(mock.child_reads, vec![METRO; looks], "{name}: looks");
        assert_eq!(mock.now_epoch_ms() - began, used_ms, "{name}: scripted time");
        assert!(mock.calls.is_empty(), "{name}: no command is run");
    }
    // Another child's exit says nothing about the launcher.
    let mut mock = host(None, true, 0);
    mock.exited_children.push((METRO + 1, 0));
    assert_eq!(metro.look(&mut mock), UNPROVEN(false, true));
}

// S1. On the base behaviour the refusal keeps the generic code and Metro is not looked at.
#[test]
fn a_refused_target_list_is_named_a_metro_exit_once_metro_is_proven_gone() {
    let repo = common::temp_repo();
    // The log of a Metro that the build stage restarted once: the pointer names this file, whatever its name.
    let log = repo.join("metro-restart.log");
    std::fs::write(&log, "kept\n").unwrap();
    std::fs::write(repo.join("metro-restart.bundle-requests"), "3\n").unwrap();
    std::fs::write(repo.join("metro-restart.bundle-outcomes"), "2 1\n").unwrap();
    let mut outcome = core_refusal("CDP_NOT_CONNECTED", Some(REFUSED), false, &repo.join("core.log"));
    assert!(outcome.failure.is_none());
    let mut mock = host(Some(0), true, 0);
    let found = core::name_metro_exit(&mut mock, Some(&metro(&log)), &mut outcome);

    assert_eq!(found, Some(MetroLook::Gone));
    assert_eq!(code_of(&outcome), "BUNDLE_LOAD_FAILED");
    assert_eq!(mock.child_reads, [METRO]);
    assert_eq!(outcome.ledger.verdict, "REFUSED");
    let failure = outcome.failure.clone().expect("a CLI-owned refusal");
    assert_eq!(failure.code, FailureCode::BundleLoadFailed);
    assert!(failure.code.is_refusal());
    assert_eq!(failure.phase, "attach");
    assert_eq!(failure.next_action, "inspect_metro_exit");
    assert_eq!(
        failure.detail.to_string(),
        "metro_exited: before admission the core's connection to Metro's target list on port 8791 was refused; QaReN then found its Metro gone (its launcher had exited and the port refused a connection); Metro's log for this port recorded bundle requests: 3; bundle builds: 2 completed, 1 failed"
    );
    let pointer = failure.log.clone().expect("a pointer to the kept Metro log");
    assert_eq!(pointer.file, log.display().to_string());
    assert_eq!(pointer.bytes, Some(5));
    let Some(FailureRecovery::Admission(recovery)) = failure.recovery.as_deref() else {
        panic!("admission recovery expected");
    };
    assert_eq!(recovery.cause, AdmissionCause::MetroExited);
    let facts = recovery.admission.as_ref().expect("the core's facts are kept");
    assert_eq!(facts.inner, "target_list_unreachable");
    assert_eq!(recovery.next_rung, Some(1));
    assert!(!recovery.destroys_state && !recovery.requires_user_ok && !recovery.automatic);
    assert!(recovery.instruction.contains("the log that `failure.log` names"));
    assert!(!recovery.instruction.contains("metro.log"), "no fixed log name");
    assert!(recovery.instruction.contains("did not restart Metro or the app in response"));
    assert!(recovery.instruction.contains("complete any cleanup this receipt asks for"));
    let first = serde_json::to_value(&recovery.ladder[0]).unwrap();
    assert_eq!(first["rung"], 1);
    assert_eq!(first["applicable"], true);
    assert_eq!(first["destroys_state"], false);
    let rung = first["instruction"].as_str().unwrap();
    assert!(rung.contains("re-run once without reset or restart flags"), "{rung}");
    let seen = &outcome.ledger.failure.as_ref().unwrap().seen;
    assert!(seen.starts_with("BUNDLE_LOAD_FAILED: metro_exited: "), "{seen}");
    assert!(!seen.contains("fetch failed"), "{seen}");
}

// S2. Every other ending keeps its own result. Each case is S1 with one fact changed; the first twelve must
// not look at Metro at all. A build that renames more widely fails the case it widens.
#[test]
fn a_refusal_with_another_cause_or_origin_keeps_its_result() {
    let repo = common::temp_repo();
    let log = repo.join("metro.log");
    let core_log = repo.join("core.log");
    let with = |from: &str, to: &str| {
        assert!(REFUSED.contains(from));
        REFUSED.replace(from, to)
    };
    let class = r#""inner":"target_list_unreachable""#;
    let restart = r#""relaunchFailed":false"#;
    let unread: Vec<(&str, &str, Option<String>, bool)> = vec![
        ("another code", "BUSY_FOREIGN_FLOW", Some(REFUSED.to_string()), false),
        ("an admitted run", "CDP_NOT_CONNECTED", Some(REFUSED.to_string()), true),
        ("no facts", "CDP_NOT_CONNECTED", None, false),
        (
            "an untyped failure (a malformed answer, a redirect)",
            "CDP_NOT_CONNECTED",
            Some(with(class, r#""inner":"untyped""#)),
            false,
        ),
        (
            "a list that never answered",
            "CDP_NOT_CONNECTED",
            Some(with(class, r#""inner":"target_list_attempt_timeout""#)),
            false,
        ),
        (
            "an empty target list",
            "CDP_NOT_CONNECTED",
            Some(with(class, r#""inner":"target_list_empty""#)),
            false,
        ),
        (
            "React not ready",
            "CDP_NOT_CONNECTED",
            Some(with(class, r#""inner":"react_readiness_timeout""#)),
            false,
        ),
        (
            "the app's process dead",
            "CDP_NOT_CONNECTED",
            Some(with(r#""liveness":"alive""#, r#""liveness":"dead""#)),
            false,
        ),
        (
            "a failed restart",
            "CDP_NOT_CONNECTED",
            Some(with(restart, r#""relaunchFailed":true"#)),
            false,
        ),
        (
            "a blocked restart",
            "CDP_NOT_CONNECTED",
            Some(with(
                restart,
                r#""relaunchFailed":false,"relaunchBlocked":"device_unreadable""#,
            )),
            false,
        ),
    ];
    for (name, refusal_code, facts, admitted) in unread {
        let mut outcome = core_refusal(refusal_code, facts.as_deref(), admitted, &core_log);
        // Metro is gone in every case: only the refusal's own facts decide.
        let mut mock = host(Some(0), true, 0);
        let found = core::name_metro_exit(&mut mock, Some(&metro(&log)), &mut outcome);
        assert_eq!(found, None, "{name}");
        assert_eq!(code_of(&outcome), refusal_code, "{name}");
        assert!(outcome.failure.is_none(), "{name}");
        assert!(mock.child_reads.is_empty(), "{name}: Metro was not looked at");
    }

    // A refusal the CLI owns is never renamed, even if it carried eligible facts.
    let mut owned = core_refusal("CDP_NOT_CONNECTED", Some(REFUSED), false, &core_log);
    owned.failure = Some(Failure::new(
        "attach",
        FailureCode::CoreRefused,
        "decided by the CLI",
        "re-run",
    ));
    let mut mock = host(Some(0), true, 0);
    assert_eq!(core::name_metro_exit(&mut mock, Some(&metro(&log)), &mut owned), None);
    assert_eq!(owned.failure.unwrap().code, FailureCode::CoreRefused);
    assert!(mock.child_reads.is_empty(), "a CLI-owned refusal");

    // No recorded Metro (an installed app): nothing to ask.
    let mut unrecorded = core_refusal("CDP_NOT_CONNECTED", Some(REFUSED), false, &core_log);
    let mut mock = host(Some(0), true, 0);
    assert_eq!(core::name_metro_exit(&mut mock, None, &mut unrecorded), None);
    assert_eq!(code_of(&unrecorded), "CDP_NOT_CONNECTED");
    assert!(mock.child_reads.is_empty(), "no recorded Metro");

    // Eligible facts, but Metro is not proven gone: three looks, the core's refusal stands, and the caller
    // learns what the looks found, in fixed words.
    for (name, exited_after, port_refuses, words) in [
        (
            "launcher alive",
            None,
            true,
            "not proven: launcher not known to have exited, port refused a connection",
        ),
        (
            "port still accepts",
            Some(0),
            false,
            "not proven: launcher exited, port did not refuse a connection",
        ),
    ] {
        let mut outcome = core_refusal("CDP_NOT_CONNECTED", Some(REFUSED), false, &core_log);
        let mut mock = host(exited_after, port_refuses, 0);
        let found = core::name_metro_exit(&mut mock, Some(&metro(&log)), &mut outcome);
        assert_eq!(found.map(MetroLook::note), Some(words), "{name}");
        assert_eq!(code_of(&outcome), "CDP_NOT_CONNECTED", "{name}");
        assert!(outcome.failure.is_none(), "{name}");
        assert_eq!(mock.child_reads.len(), 3, "{name}: three looks");
    }
}

// RR1. The real runner's answer for a child it started: not exited while it runs, exited once it has ended,
// the same again, with the exited child still in the process table (nothing was collected), still
// collectable by the ordinary reap, and false afterwards. A build that collects the child in the read fails
// where the child must still exist; one that answers for a child it does not own fails at the stranger.
#[test]
fn the_real_runner_reports_an_owned_child_exit_without_collecting_it() {
    let repo = common::temp_repo();
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    let spec = CmdSpec::new("metro-stand-in", "/bin/sh", &["-c", "sleep 0.4"], 0);
    let spawned = runner.spawn_group(&spec, &repo.join("stand-in.log")).unwrap();

    assert!(!runner.child_exited(spawned.pid), "still running");
    let began = Instant::now();
    while !runner.child_exited(spawned.pid) {
        assert!(began.elapsed() < Duration::from_secs(20), "the child never ended");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(runner.child_exited(spawned.pid), "the same answer a second time");
    assert!(exists(spawned.pid), "the exited child is still there to be collected");
    assert!(!runner.child_exited(1), "a process that is no child of this one");
    // A child of this process that the runner did not start, exited and not yet collected.
    let mut stranger = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(!runner.child_exited(stranger.id() as i32), "not a child the runner owns");
    stranger.wait().unwrap();
    assert!(runner.try_reap(spawned.pid), "the ordinary reap still collects it");
    assert!(!runner.child_exited(spawned.pid), "no longer this runner's child");
}

// True while the process, running or exited and not yet collected, has an entry in the process table.
fn exists(pid: i32) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

// RR2. The real runner's port answer, on a port chosen by the system: accepted while something listens,
// refused once nothing does.
#[test]
fn the_real_runner_reads_a_refused_loopback_port() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    assert!(!runner.loopback_refuses(port), "a listener accepts");
    drop(listener);
    assert!(runner.loopback_refuses(port), "nothing listens");
}
