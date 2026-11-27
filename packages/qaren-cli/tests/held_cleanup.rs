#![cfg(unix)]
// AI-763: `qaren cleanup` of a held iOS check, and the next run's reclaim, while the held Metro's group
// drains after its launcher exited on TERM; and the one line a stop signal or a failed write leaves.
mod common;

use qaren::exec::RealRunner;
use qaren::failure::FailureCode;
use qaren::receipt::ReceiptResult;
use qaren::runrecord::{
    capture_pid_identity, FinalVerification, Held, IosSimResource, MetroResource, Phase, RunRecord,
    TerminalResult,
};
use qaren::scenario::Platform;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const UDID: &str = "AAAABBBB-1111-2222-3333-444455556666";
const ROLE: &str = "QAREN_HELD_CLEANUP_ROLE";

// ---- fixture processes: this test binary re-run with ROLE set ----

static TERM_SEEN: AtomicBool = AtomicBool::new(false);

extern "C" fn on_term(_: libc::c_int) {
    TERM_SEEN.store(true, Ordering::SeqCst);
}

// A Metro stand-in: owns a listening port and, after TERM, keeps running for LINGER ms
// (for good when unset), acknowledging the TERM in a file.
fn member(dir: &Path) -> ! {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    unsafe {
        libc::signal(
            libc::SIGTERM,
            on_term as extern "C" fn(libc::c_int) as libc::sighandler_t,
        )
    };
    let linger = std::env::var("FIXTURE_LINGER_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok());
    // Release mode: after TERM, stay until the test creates this file (30 s at most).
    let release = std::env::var_os("FIXTURE_RELEASE").map(PathBuf::from);
    let port = listener.local_addr().unwrap().port();
    std::fs::write(dir.join("member.port.tmp"), port.to_string()).unwrap();
    std::fs::rename(dir.join("member.port.tmp"), dir.join("member.port")).unwrap();
    let mut term_at: Option<Instant> = None;
    loop {
        let _ = listener.accept();
        if TERM_SEEN.load(Ordering::SeqCst) && term_at.is_none() {
            term_at = Some(Instant::now());
            std::fs::write(dir.join("member.term"), "term").unwrap();
        }
        if let (Some(at), Some(ms)) = (term_at, linger) {
            if at.elapsed() >= Duration::from_millis(ms) {
                std::process::exit(0);
            }
        }
        if let (Some(at), Some(release)) = (term_at, release.as_ref()) {
            if release.exists() {
                std::process::exit(0);
            }
            if at.elapsed() >= Duration::from_secs(30) {
                std::process::exit(3);
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn fixture_process() {
    let Ok(role) = std::env::var(ROLE) else {
        return;
    };
    let dir = PathBuf::from(std::env::var("FIXTURE_DIR").unwrap());
    match role.as_str() {
        "member" => member(&dir),
        other => panic!("unknown fixture role {other}"),
    }
}

// ---- supervision: each fixture child is reaped the moment it exits, as launchd reaps a held run's ----

struct Supervised {
    child: Arc<Mutex<Child>>,
    pid: i32,
    status: Arc<Mutex<Option<ExitStatus>>>,
    reaper: Option<JoinHandle<()>>,
}

fn supervise(child: Child) -> Supervised {
    let pid = child.id() as i32;
    let child = Arc::new(Mutex::new(child));
    let status = Arc::new(Mutex::new(None));
    let (c, s) = (child.clone(), status.clone());
    let reaper = std::thread::spawn(move || loop {
        if let Some(exit) = c.lock().unwrap().try_wait().unwrap() {
            *s.lock().unwrap() = Some(exit);
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    });
    Supervised {
        child,
        pid,
        status,
        reaper: Some(reaper),
    }
}

impl Supervised {
    fn exit(&self) -> Option<ExitStatus> {
        *self.status.lock().unwrap()
    }
}

impl Drop for Supervised {
    fn drop(&mut self) {
        // std never signals a child it has already reaped, so this cannot reach a reused pid.
        let _ = self.child.lock().unwrap().kill();
        if let Some(reaper) = self.reaper.take() {
            let _ = reaper.join();
        }
    }
}

struct HeldMetro {
    leader: Supervised,
    member: Supervised,
    port: u16,
    dir: PathBuf,
}

impl HeldMetro {
    fn term_seen(&self) -> bool {
        self.dir.join("member.term").exists()
    }
    fn release(&self) -> PathBuf {
        self.dir.join("member.release")
    }
    // The fixture `ps` barriers for a subprocess cleanup: wait for the leader's reaping, and (with
    // `release`) release the member right after the escalation decision listing.
    // A barrier the fixture `ps` could not meet leaves this file; a row that saw it proves nothing.
    fn assert_fixture_clean(&self) {
        let error = self.dir.join("fixture.error");
        assert!(
            !error.exists(),
            "fixture error: {}",
            std::fs::read_to_string(&error).unwrap_or_default()
        );
    }

    // Positive proof that the fixture `ps` met its KILL-step barrier and then ran the real probe.
    fn assert_barrier_passed(&self) {
        self.assert_fixture_clean();
        assert!(self.dir.join("barrier.done").exists(), "the KILL-step barrier never completed");
    }

    fn barriers(&self, command: &mut Command, release: bool) {
        command
            .env("HELD_LEADER", self.leader.pid.to_string())
            .env("HELD_TERM_FILE", self.dir.join("member.term"))
            .env("HELD_PROBES", self.dir.join("leader.probes"))
            .env("HELD_FIXTURE_ERROR", self.dir.join("fixture.error"))
            .env("HELD_BARRIER_DONE", self.dir.join("barrier.done"));
        if release {
            command.env("HELD_RELEASE", self.release());
        }
    }
}

// RealRunner, plus one hook: after cleanup's first process-group listing (its escalation decision at the
// KILL step) the member is released. The decision therefore always sees the member present, however the
// host schedules the test.
struct Observed {
    inner: RealRunner,
    release: PathBuf,
    term: PathBuf,
    leader: String,
    leader_exit: Arc<Mutex<Option<ExitStatus>>>,
    leader_probes: usize,
    // Also wait for the member to have exited and been reaped (H-5's control state).
    member_exit: Option<Arc<Mutex<Option<ExitStatus>>>>,
}

impl qaren::exec::Runner for Observed {
    fn env_var(&self, name: &str) -> Option<String> {
        self.inner.env_var(name)
    }
    fn env_var_os(&self, name: &str) -> Option<std::ffi::OsString> {
        self.inner.env_var_os(name)
    }
    fn env_names(&self) -> Vec<String> {
        self.inner.env_names()
    }
    fn execute(&mut self, spec: &qaren::exec::CmdSpec, interruptible: bool) -> qaren::exec::CmdOutput {
        // The leader's birth is probed at entry, at TERM and at KILL. The KILL-step probe runs only once the
        // member acknowledged TERM and the leader's reaper has reaped it; a fixture that cannot get there fails.
        if spec.label == "ps-lstart" && spec.args.contains(&self.leader) {
            self.leader_probes += 1;
            if self.leader_probes == 3 {
                let (term, exit, member) =
                    (self.term.clone(), self.leader_exit.clone(), self.member_exit.clone());
                wait_for(Duration::from_secs(10), "the member saw TERM and the leader was reaped", || {
                    term.exists()
                        && exit.lock().unwrap().is_some()
                        && member.as_ref().is_none_or(|m| m.lock().unwrap().is_some())
                });
            }
        }
        let output = self.inner.execute(spec, interruptible);
        if spec.label == "ps-groups" && !self.release.exists() {
            std::fs::write(&self.release, "go").unwrap();
        }
        output
    }
    fn execute_private(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> qaren::exec::PrivateOutput {
        self.inner.execute_private(spec, input, interruptible)
    }
    fn spawn_group_unchecked(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log: &Path,
    ) -> std::io::Result<qaren::exec::Spawned> {
        self.inner.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log: &Path,
    ) -> std::io::Result<qaren::exec::PipedChild> {
        self.inner.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, duration: Duration) {
        self.inner.sleep(duration)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.inner.now_epoch_ms()
    }
    fn monotonic_ms(&self) -> u64 {
        self.inner.monotonic_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.inner.commands_executed()
    }
    fn try_reap(&mut self, pid: i32) -> bool {
        self.inner.try_reap(pid)
    }
}

fn observed(metro: &HeldMetro) -> Observed {
    Observed {
        inner: RealRunner::new(),
        release: metro.release(),
        term: metro.dir.join("member.term"),
        leader: metro.leader.pid.to_string(),
        leader_exit: metro.leader.status.clone(),
        leader_probes: 0,
        member_exit: None,
    }
}

fn observed_until_member_exits(metro: &HeldMetro) -> Observed {
    Observed {
        member_exit: Some(metro.member.status.clone()),
        ..observed(metro)
    }
}

enum Stop {
    // Exits this long after TERM.
    After(u64),
    // Exits once the test releases it.
    OnRelease,
    // Never exits by itself.
    Never,
}

// Leader: a launcher that exits on TERM (default action). Member: the Metro stand-in in its group.
fn held_metro(dir: &Path, stop: Stop) -> HeldMetro {
    let dir = dir.join("metro");
    std::fs::create_dir_all(&dir).unwrap();
    let leader = Command::new("/bin/sleep")
        .arg("120")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let leader = supervise(leader);
    let mut member = Command::new(std::env::current_exe().unwrap());
    member
        .args(["--exact", "fixture_process", "--nocapture", "--test-threads=1"])
        .env(ROLE, "member")
        .env("FIXTURE_DIR", &dir)
        .env_remove("FIXTURE_LINGER_MS")
        .env_remove("FIXTURE_RELEASE")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(leader.pid);
    match stop {
        Stop::After(ms) => {
            member.env("FIXTURE_LINGER_MS", ms.to_string());
        }
        Stop::OnRelease => {
            member.env("FIXTURE_RELEASE", dir.join("member.release"));
        }
        Stop::Never => {}
    }
    let member = supervise(member.spawn().unwrap());
    wait_for(Duration::from_secs(20), "the member bound its port", || {
        dir.join("member.port").exists()
    });
    let port = std::fs::read_to_string(dir.join("member.port"))
        .unwrap()
        .parse()
        .unwrap();
    HeldMetro {
        leader,
        member,
        port,
        dir,
    }
}

fn wait_for(limit: Duration, what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting until {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

struct Home {
    root: common::TempRepo,
}

impl Home {
    fn new() -> Self {
        let home = Home {
            root: common::temp_repo(),
        };
        // tests/fixtures/held-cleanup-fixture.ts is this suite's `ps` (helper scan answered empty, the
        // subprocess barriers) and its slow node. Copied so it can be made executable; node strips its types.
        let fixture = home.fixture();
        std::fs::create_dir_all(fixture.parent().unwrap()).unwrap();
        std::fs::copy(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/held-cleanup-fixture.ts"),
            &fixture,
        )
        .unwrap();
        std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bin = home.root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::os::unix::fs::symlink(&fixture, bin.join("ps")).unwrap();
        home
    }
    fn fixture(&self) -> PathBuf {
        self.root.join("fixture/held-cleanup-fixture.ts")
    }
    fn home(&self) -> PathBuf {
        self.root.join("home")
    }
    fn runs(&self) -> PathBuf {
        self.home().join("runs")
    }
    fn locks(&self) -> PathBuf {
        self.root.join("locks")
    }
    fn path(&self) -> String {
        format!(
            "{}:{}",
            self.root.join("bin").display(),
            std::env::var("PATH").unwrap_or_default()
        )
    }
    fn qaren(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_qaren"));
        command
            .env("QAREN_HOME", self.home())
            .env("QAREN_LOCK_ROOT", self.locks())
            .env("HOME", &*self.root)
            .env("PATH", self.path())
            .env("QAREN_PROGRESS", "off")
            .env("NODE_NO_WARNINGS", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
}

// The record a held iOS check leaves when its process exits (run.rs teardown with hold).
fn held_record(home: &Home, run_id: &str, metro: &HeldMetro) {
    let mut runner = RealRunner::new();
    let yaml = common::ios_scenario_yaml(metro.port);
    let mut record = common::base_record(&home.root, &yaml, run_id, Phase::Walking);
    let dir = RunRecord::run_dir(&home.runs(), run_id);
    std::fs::create_dir_all(dir.join("logs")).unwrap();
    record.resources.metro = Some(MetroResource {
        port: metro.port,
        endpoint: format!("http://127.0.0.1:{}", metro.port),
        spawned: qaren::exec::Spawned {
            pid: metro.leader.pid,
            pgid: metro.leader.pid,
        },
        identity: Some(capture_pid_identity(&mut runner, metro.leader.pid).unwrap()),
        log: dir.join("logs/metro.log"),
    });
    let ios = record.scenario.ios.clone().unwrap();
    record.resources.device_borrowed = true;
    record.resources.ios_simulator = Some(IosSimResource {
        udid: UDID.into(),
        name: "QA iPhone".into(),
        device_type: ios.device_type,
        runtime: ios.runtime,
        boot_authorized: false,
        owned_by_run: false,
        booted_proven_at: None,
    });
    record.terminal = Some(TerminalResult {
        verdict: "FAIL".into(),
        cancelled: false,
        final_verification: FinalVerification {
            tested: "b".repeat(40),
            matched: true,
            detail: None,
            classification: None,
        },
        ownership_proven: false,
    });
    record.held = Some(Held {
        since: "2026-11-27T10:00:00Z".into(),
        reason: "retained for inspection".into(),
        retained: vec!["metro".into(), "simulator".into(), "device_lease".into()],
    });
    let mut mock = qaren::exec::MockRunner::new();
    mock.environment
        .insert("QAREN_HOME".into(), home.home().display().to_string());
    let lease = qaren::lease::acquire(
        &mut mock,
        &home.locks(),
        Platform::Ios,
        UDID,
        run_id,
        record.prepare.clone(),
    )
    .unwrap();
    record.resources.lease = Some(lease);
    record.save(&home.runs()).unwrap();
}

fn next_lease(home: &Home) -> Result<(), FailureCode> {
    let mut runner = RealRunner::new();
    qaren::lease::try_acquire(&mut runner, &home.locks(), Platform::Ios, UDID, "check-next", None)
        .map(|lease| {
            qaren::lease::release(&lease);
        })
        .map_err(|busy| busy.failure.code)
}

fn port_answers(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

// ---- H rows: the held Metro's drain ----

// H-1: the member is still stopping at the KILL step's decision and exits by itself only after it.
#[test]
fn h1_cleanup_waits_for_a_draining_metro_and_releases_the_lease() {
    let home = Home::new();
    let metro = held_metro(&home.root, Stop::OnRelease);
    held_record(&home, "check-held-h1", &metro);
    let receipt =
        qaren::commands::cleanup::cleanup(&mut observed(&metro), &home.runs(), "check-held-h1");
    assert!(metro.term_seen(), "the member never saw TERM");
    assert!(metro.release().exists(), "cleanup never listed the group");
    assert_eq!(receipt.result, ReceiptResult::Cleaned, "{:?}", receipt.cleanup);
    assert_eq!(receipt.cleanup["metro"], "removed");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    wait_for(Duration::from_secs(2), "the member was reaped", || {
        metro.member.exit().is_some()
    });
    assert_eq!(metro.member.exit().unwrap().code(), Some(0), "the member exited by itself");
    assert!(!port_answers(metro.port));
    assert!(next_lease(&home).is_ok());
}

// H-2: the next run's reclaim of the dead holder meets the same drain.
#[test]
fn h2_reclaim_of_a_held_run_waits_for_its_draining_metro() {
    let home = Home::new();
    let metro = held_metro(&home.root, Stop::OnRelease);
    held_record(&home, "check-held-h2", &metro);
    let mut runner = observed(&metro);
    let busy = qaren::lease::try_acquire(&mut runner, &home.locks(), Platform::Ios, UDID, "check-next", None)
        .expect_err("the held run still holds the lease");
    let reclaimed = qaren::commands::cleanup::reclaim_dead_holder(&mut runner, &home.runs(), &busy);
    assert!(metro.term_seen());
    assert!(metro.release().exists(), "the reclaim never listed the group");
    match reclaimed {
        Ok(run_id) => assert_eq!(run_id, "check-held-h2"),
        Err(failure) => panic!("reclaim refused: {:?} {}", failure.code, failure.detail),
    }
    wait_for(Duration::from_secs(2), "the member was reaped", || {
        metro.member.exit().is_some()
    });
    assert_eq!(metro.member.exit().unwrap().code(), Some(0), "the member exited by itself");
    assert!(next_lease(&home).is_ok());
}

// H-3: the user's shape, with a second qaren process that prints.
#[test]
fn h3_cleanup_and_chain_runs_the_next_qaren_command() {
    let home = Home::new();
    // The fixture `ps` holds the same barriers as `Observed` for this subprocess.
    let metro = held_metro(&home.root, Stop::OnRelease);
    held_record(&home, "check-held-h3", &metro);
    let mut shell = Command::new("/bin/sh");
    metro.barriers(&mut shell, true);
    let out = shell
        .args([
            "-c",
            r#""$1" cleanup "$2" --json > "$3/c.json" 2> "$3/c.err" && : > "$3/started" && "$1" status "$2" --json > "$3/s.json" 2> "$3/s.err""#,
            "sh",
            env!("CARGO_BIN_EXE_qaren"),
            "check-held-h3",
            home.root.to_str().unwrap(),
        ])
        .env("QAREN_HOME", home.home())
        .env("QAREN_LOCK_ROOT", home.locks())
        .env("HOME", &*home.root)
        .env("PATH", home.path())
        .env("QAREN_PROGRESS", "off")
        .env("NODE_NO_WARNINGS", "1")
        .output()
        .unwrap();
    let read = |name: &str| std::fs::read_to_string(home.root.join(name)).unwrap_or_default();
    let cleanup: serde_json::Value = serde_json::from_str(&read("c.json")).unwrap();
    assert_eq!(cleanup["result"], "cleaned", "{}", read("c.err"));
    assert!(read("c.err").contains("qaren cleanup: cleaned"));
    assert!(home.root.join("started").exists(), "the && chain skipped the next command");
    let status: serde_json::Value = serde_json::from_str(&read("s.json")).unwrap();
    assert_eq!(status["run_id"], "check-held-h3");
    assert!(out.status.success(), "{out:?}");
    metro.assert_barrier_passed();
    assert!(metro.term_seen());
    assert!(metro.release().exists(), "cleanup never listed the group");
    wait_for(Duration::from_secs(2), "the member was reaped", || {
        metro.member.exit().is_some()
    });
    assert_eq!(metro.member.exit().unwrap().code(), Some(0), "the member exited by itself");
}

// H-4: a member that never exits is never signalled again; cleanup refuses with its next step.
#[test]
fn h4_a_metro_member_that_never_exits_is_left_alone_and_the_lease_kept() {
    let home = Home::new();
    let metro = held_metro(&home.root, Stop::Never);
    held_record(&home, "check-held-h4", &metro);
    let receipt =
        qaren::commands::cleanup::cleanup(&mut observed(&metro), &home.runs(), "check-held-h4");
    assert!(metro.term_seen());
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.failure.as_ref().map(|f| f.code), Some(FailureCode::CleanupIncomplete));
    assert!(
        receipt.cleanup["metro"].starts_with("unresolved: process group not proven gone within a 20 s wait"),
        "{:?}",
        receipt.cleanup
    );
    assert!(receipt.cleanup["device_lease"].starts_with("unresolved: retained"));
    assert!(metro.member.exit().is_none(), "the member must not be signalled");
    assert!(port_answers(metro.port), "the member must still answer");
    assert!(receipt.next_action.contains("re-run qaren cleanup check-held-h4"));
    assert_eq!(next_lease(&home), Err(FailureCode::DeviceBusy));
}

// H-5 control: a member that stops within the TERM grace cleans on the base too.
#[test]
fn h5_control_member_stopping_within_the_grace_cleans() {
    let home = Home::new();
    let metro = held_metro(&home.root, Stop::After(0));
    held_record(&home, "check-held-h5", &metro);
    let receipt =
        qaren::commands::cleanup::cleanup(&mut observed_until_member_exits(&metro), &home.runs(), "check-held-h5");
    wait_for(Duration::from_secs(2), "the member was reaped", || {
        metro.member.exit().is_some()
    });
    assert_eq!(metro.member.exit().unwrap().code(), Some(0), "the member exited at TERM by itself");
    assert!(metro.term_seen());
    assert_eq!(receipt.result, ReceiptResult::Cleaned, "{:?}", receipt.cleanup);
    assert_eq!(receipt.cleanup["metro"], "removed");
    assert!(next_lease(&home).is_ok());
}

// ---- S rows: one line per stop signal or failed write ----

const SECOND_LINE: &str = "qaren: stopped at once by a second signal; if it had started a run, qaren cleanup <run-id> or the next run on this device can release what QaReN proves that run held\n";
const STOP_TERM_LINE: &str = "qaren: stopped by SIGTERM before it exited normally; if it was working on a run, check qaren status <run-id> before running it again\n";

struct SlowCheck {
    home: Home,
    release: PathBuf,
    done: PathBuf,
    child: Child,
}

impl Drop for SlowCheck {
    fn drop(&mut self) {
        // Release the slow node probe and wait for it to finish before its folder goes away.
        let _ = std::fs::write(&self.release, "go");
        let _ = self.child.kill();
        let _ = self.child.wait();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.done.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

// A check held in preflight: QAREN_NODE answers only once released, and gives up by itself after 30 s.
fn slow_check() -> SlowCheck {
    let home = Home::new();
    let app = home.root.join("app");
    std::fs::create_dir_all(app.join(".qaren")).unwrap();
    std::fs::write(
        app.join(".qaren/config.yaml"),
        "appId: com.example.app\ndevClientScheme: testapp\n",
    )
    .unwrap();
    std::fs::write(app.join("plan.md"), "# Plan\n\n1. Tap \"Go\"\n").unwrap();
    let mark = home.root.join("node-started");
    let release = home.root.join("node-release");
    let done = home.root.join("node-done");
    let child = home
        .qaren()
        .args(["check", "--plan-file", "plan.md"])
        .current_dir(&app)
        .env("QAREN_NODE", home.fixture())
        .env("HELD_NODE_MARK", &mark)
        .env("HELD_NODE_RELEASE", &release)
        .env("HELD_NODE_DONE", &done)
        .env_remove("CI")
        .spawn()
        .unwrap();
    // Owned from spawn: a timeout below still releases the probe and reaps the check.
    let check = SlowCheck {
        home,
        release,
        done,
        child,
    };
    wait_for(Duration::from_secs(20), "check reached the node probe", || {
        mark.exists()
    });
    check
}

fn stopped(pid: i32) -> bool {
    Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim_start().starts_with('T'))
}

// The signals are all pending before the process runs again: SIGSTOP, wait until stopped, send, SIGCONT.
fn burst(pid: i32, signals: &[libc::c_int]) {
    assert_eq!(unsafe { libc::kill(pid, libc::SIGSTOP) }, 0);
    wait_for(Duration::from_secs(5), "the process stopped", || stopped(pid));
    for signal in signals {
        assert_eq!(unsafe { libc::kill(pid, *signal) }, 0);
    }
    assert_eq!(unsafe { libc::kill(pid, libc::SIGCONT) }, 0);
}

fn wait_output(child: &mut Child) -> (ExitStatus, String, String) {
    use std::io::Read;
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "the process did not end");
        std::thread::sleep(Duration::from_millis(10));
    };
    let mut out = String::new();
    let mut err = String::new();
    child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
    child.stderr.take().unwrap().read_to_string(&mut err).unwrap();
    (status, out, err)
}

// S-1: a second signal during check prints exactly one line, writes no receipt and no run directory.
#[test]
fn s1_a_second_signal_ends_check_with_one_line() {
    let mut check = slow_check();
    burst(check.child.id() as i32, &[libc::SIGTERM, libc::SIGHUP]);
    let (status, out, err) = wait_output(&mut check.child);
    assert_eq!(out, "");
    assert_eq!(err, SECOND_LINE);
    assert!(matches!(status.code(), Some(129) | Some(143)), "{status:?}");
    let runs = check.home.runs();
    assert!(!runs.exists() || std::fs::read_dir(&runs).unwrap().next().is_none());
}

// S-2 control: one signal still ends check through run cancellation, with its receipt.
#[test]
fn s2_one_signal_still_ends_check_with_its_receipt() {
    let mut check = slow_check();
    assert_eq!(unsafe { libc::kill(check.child.id() as i32, libc::SIGTERM) }, 0);
    let (status, out, err) = wait_output(&mut check.child);
    let receipt: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(status.code(), Some(4));
    assert_eq!(receipt["failure"]["code"], "RUN_CANCELLED");
    assert!(!err.contains("stopped"), "{err}");
}

// A child that is continued, killed and reaped if a test ends early, even after SIGSTOP.
struct Guarded(Child);

impl Drop for Guarded {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            unsafe { libc::kill(self.0.id() as i32, libc::SIGCONT) };
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

// Starts the real `qaren cleanup` of a run whose member never exits, and returns once the member has seen
// TERM: cleanup then still has its whole 20 s wait (1.5 s grace on the base) ahead of it.
fn cleanup_in_grace(home: &Home, run_id: &str, metro: &HeldMetro, pre: Option<libc::c_int>) -> Guarded {
    let mut command = home.qaren();
    command.args(["cleanup", run_id, "--json"]);
    metro.barriers(&mut command, false);
    if let Some(ignored) = pre {
        unsafe {
            command.pre_exec(move || {
                libc::signal(ignored, libc::SIG_IGN);
                Ok(())
            });
        }
    }
    let mut child = Guarded(command.spawn().unwrap());
    wait_for(Duration::from_secs(20), "cleanup sent TERM", || metro.term_seen());
    assert!(child.0.try_wait().unwrap().is_none(), "cleanup must still be running");
    child
}

// S-3: cleanup has no run cancellation; one TERM inside its wait prints one line and still ends it by SIGTERM.
#[test]
fn s3_one_signal_ends_cleanup_with_one_line() {
    let home = Home::new();
    let metro = held_metro(&home.root, Stop::Never);
    held_record(&home, "check-held-s3", &metro);
    let mut child = cleanup_in_grace(&home, "check-held-s3", &metro, None);
    burst(child.0.id() as i32, &[libc::SIGTERM]);
    let (status, out, err) = wait_output(&mut child.0);
    assert_eq!(out, "");
    assert_eq!(err, STOP_TERM_LINE);
    assert_eq!(status.signal(), Some(libc::SIGTERM));
    metro.assert_fixture_clean();
    assert_eq!(next_lease(&home), Err(FailureCode::DeviceBusy), "an interrupted cleanup keeps the lease");
}

// S-4: a burst of stop signals still prints one line and ends the process by one of them.
#[test]
fn s4_a_burst_of_stop_signals_prints_one_line() {
    let home = Home::new();
    let metro = held_metro(&home.root, Stop::Never);
    held_record(&home, "check-held-s4", &metro);
    let mut child = cleanup_in_grace(&home, "check-held-s4", &metro, None);
    burst(child.0.id() as i32, &[libc::SIGTERM, libc::SIGHUP, libc::SIGINT]);
    let (status, out, err) = wait_output(&mut child.0);
    assert_eq!(out, "");
    // One complete line, naming the signal that ended the process.
    let named = match status.signal() {
        Some(libc::SIGTERM) => "SIGTERM",
        Some(libc::SIGHUP) => "SIGHUP",
        Some(libc::SIGINT) => "SIGINT",
        other => panic!("ended by {other:?}"),
    };
    assert_eq!(err, STOP_TERM_LINE.replace("SIGTERM", named));
    metro.assert_fixture_clean();
}

// S-5: a stop signal inherited as ignored stays ignored; cleanup finishes with its receipt.
#[test]
fn s5_an_ignored_hangup_stays_ignored() {
    let home = Home::new();
    // The member never exits, so cleanup is certainly still running when SIGHUP arrives.
    let metro = held_metro(&home.root, Stop::Never);
    held_record(&home, "check-held-s5", &metro);
    let mut child = cleanup_in_grace(&home, "check-held-s5", &metro, Some(libc::SIGHUP));
    // Delivered while cleanup is held stopped, so it can only be handled by the running cleanup.
    burst(child.0.id() as i32, &[libc::SIGHUP]);
    let (status, out, err) = wait_output(&mut child.0);
    let receipt: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(status.code(), Some(1), "{err}");
    assert_eq!(receipt["result"], "failed");
    assert!(!err.contains("stopped by"), "{err}");
    // Cleanup met the KILL-step barrier and ran its whole wait.
    metro.assert_barrier_passed();
    let leg = receipt["cleanup"]["metro"].as_str().unwrap_or_default();
    assert!(
        leg.starts_with("unresolved: process group not proven gone within a 20 s wait"),
        "{leg}"
    );
}

// S-6: an empty plain listing prints one line; JSON stays an empty list.
#[test]
fn s6_empty_listings_print_a_line() {
    let home = Home::new();
    let app = home.root.join("empty-app");
    std::fs::create_dir_all(&app).unwrap();
    for (args, plain) in [
        (vec!["plans"], "no saved plans in this app's .qaren/plans\n"),
        (vec!["actions", "list"], "no saved blocks in this app's .qaren/actions\n"),
    ] {
        let out = home.qaren().args(&args).current_dir(&app).output().unwrap();
        assert_eq!(out.status.code(), Some(0), "{args:?}");
        assert_eq!(String::from_utf8_lossy(&out.stdout), plain);
        let mut json = args.clone();
        json.push("--json");
        let out = home.qaren().args(&json).current_dir(&app).output().unwrap();
        assert_eq!(out.status.code(), Some(0), "{json:?}");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "[]");
    }
}

// A pipe whose reader is already closed: every write to it fails.
// Stdout is a pipe whose only reader is closed. The pipe is made inside the target child after fork, so no
// other process, such as a child another test spawns meanwhile, can inherit a reader and keep it open.
fn readerless_stdout(command: &mut Command) -> &mut Command {
    command.stdout(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            let mut fds = [0; 2];
            if libc::pipe(fds.as_mut_ptr()) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            libc::close(fds[0]);
            if libc::dup2(fds[1], 1) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            libc::close(fds[1]);
            Ok(())
        })
    }
}

// S-7: watch says so when it cannot write its output.
#[test]
fn s7_watch_reports_an_output_it_cannot_write() {
    let home = Home::new();
    let run = home.runs().join("check-watch");
    std::fs::create_dir_all(run.join("logs")).unwrap();
    std::fs::write(run.join("logs/events.jsonl"), "").unwrap();
    let out = readerless_stdout(home.qaren().args(["watch", "check-watch", "--json"]))
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "qaren watch: stopped because it could not write its output; run it again with its output going somewhere writable\n"
    );
    assert_eq!(out.status.code(), Some(0));
}

// S-8: verbatim output without a final newline is flushed and checked, not lost at exit.
#[test]
fn s8_actions_show_reports_an_output_it_cannot_write() {
    let home = Home::new();
    let app = home.root.join("app");
    std::fs::create_dir_all(app.join(".qaren/actions")).unwrap();
    std::fs::write(app.join(".qaren/actions/tap-go.yaml"), "# intent: x").unwrap();
    let out = readerless_stdout(home.qaren().args(["actions", "show", "tap-go"]).current_dir(&app))
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "qaren actions: could not write its output; run it again with its output going somewhere writable\n"
    );
    assert_eq!(out.status.code(), Some(1));
}

// S-9: watch keeps the handler: a signal while it follows a live run leaves the line and still ends it.
#[test]
fn s9_watch_stopped_by_a_signal_leaves_one_line() {
    let home = Home::new();
    let run = home.runs().join("check-follow");
    std::fs::create_dir_all(run.join("logs")).unwrap();
    // A live run's first events, without an end: watch prints the stage and keeps following.
    std::fs::write(
        run.join("logs/events.jsonl"),
        concat!(
            r#"{"v":1,"seq":1,"at":1,"event":"run","payload":{"runId":"check-follow","verb":"check","platform":"ios","ownerPid":1}}"#,
            "\n",
            r#"{"v":1,"seq":2,"at":2,"event":"stage","payload":{"name":"preflight","state":"passed","ms":1}}"#,
            "\n"
        ),
    )
    .unwrap();
    let frames = home.root.join("watch-frames");
    let mut child = Guarded(
        home.qaren()
            .args(["watch", "check-follow", "--plain"])
            .stdout(std::fs::File::create(&frames).unwrap())
            .spawn()
            .unwrap(),
    );
    // Its first frame is the readiness barrier: watch is past startup and following.
    wait_for(Duration::from_secs(10), "watch printed its first frame", || {
        std::fs::read_to_string(&frames).is_ok_and(|text| text.contains("Preflight"))
    });
    assert!(child.0.try_wait().unwrap().is_none(), "watch must still be following");
    assert_eq!(unsafe { libc::kill(child.0.id() as i32, libc::SIGTERM) }, 0);
    child.0.stdout = None;
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "watch did not end");
        std::thread::sleep(Duration::from_millis(10));
    };
    let mut err = String::new();
    std::io::Read::read_to_string(&mut child.0.stderr.take().unwrap(), &mut err).unwrap();
    assert_eq!(err, STOP_TERM_LINE);
    assert_eq!(status.signal(), Some(libc::SIGTERM));
}

// S-15: --version and a receipt that cannot be written say so, with a next step.
#[test]
fn s15_version_and_receipt_report_an_output_they_cannot_write() {
    let home = Home::new();
    let out = readerless_stdout(home.qaren().arg("--version")).output().unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "qaren --version: could not write its output; run it again with its output going somewhere writable\n"
    );
    assert_eq!(out.status.code(), Some(1));
    let out = readerless_stdout(home.qaren().args(["status", "check-s15", "--json"]))
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "qaren status: could not write its receipt to stdout; if it started or changed a run, check that run with qaren status before running it again with its output going somewhere writable\n"
    );
    assert_eq!(out.status.code(), Some(1));
}
