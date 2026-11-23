#![cfg(unix)]
// The macOS CI smoke (ci.yml, job metro-bind): the dev-server start an iOS run makes, on a real Node,
// pnpm and Expo CLI, must answer on 127.0.0.1 and listen on loopback only. Ignored by default: it
// needs an installed Expo project (QAREN_METRO_SMOKE_APP) and an output folder (QAREN_METRO_SMOKE_OUT).
//
// The test stops the Metro it started on every outcome it reaches, a caught SIGINT, SIGTERM or SIGHUP
// and a panic of its own included. A test process that is killed before that stop leaves Metro running; nothing here covers
// that. The job therefore runs only on a single-use hosted runner (its first step refuses any other).
mod common;

use qaren::adapters::metro::{
    self, BindClass, BindObservation, BoundAddr, Listen, Listeners, StatusProbe,
};
use qaren::adapters::pnpm;
use qaren::commands::cleanup::cleanup;
use qaren::exec::{CmdSpec, RealRunner, Runner};
use qaren::runrecord::{
    capture_pid_identity, probe_pid_identity, MetroResource, Phase, PidLiveness, RunRecord,
};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

const RUN_ID: &str = "metro-smoke";
// The readiness budget: Metro answers /status once its bundler is ready, and the wait ends on the
// first conclusive observation, so a green run uses seconds of it.
const READY_SECONDS: u64 = 300;
const MAX_HOLD_SECONDS: u64 = 600;

enum Seen {
    V4,
    V6Only,
    NotLoopback,
    Blind(String),
    Exited,
    NotReady,
    Cancelled(String),
    Setup(String),
}

// A line for the log that cannot panic: after the spawn nothing may skip the stop, and println!
// panics when stdout is closed.
fn say(line: &str) {
    let _ = writeln!(std::io::stdout(), "{line}");
}

// The stop: the product's cleanup on the saved record (it signals only a group whose leader it
// proves), then the product's own read of the port must say that nothing listens on it, on any
// address. Nothing else is ever signalled. Both also run after a caught signal: cleanup uses the
// runner's uninterruptible path, and so does the read.
fn stop_and_prove(runner: &mut dyn Runner, runs: &Path, port: u16) -> String {
    let receipt = cleanup(runner, runs, RUN_ID);
    let metro = receipt
        .cleanup
        .get("metro")
        .cloned()
        .unwrap_or_else(|| "no result".to_string());
    if metro != "removed" && metro != "absent" {
        return format!("unresolved: the stop reported {metro:?}");
    }
    match metro::parse_port_owner(&runner.execute(&metro::port_owner_spec(port), false)) {
        metro::PortOwners::Free => metro,
        other => format!(
            "unresolved: the stop reported {metro:?} but the read of port {port} gave {other:?}, not Free; that listener was not signalled"
        ),
    }
}

// The address a Node server gets for the host name localhost under these Node options, through
// pnpm as the start goes: what `expo start --localhost` binds.
fn localhost_bind(
    runner: &mut dyn Runner,
    app: &Path,
    options: Option<&str>,
) -> Result<String, String> {
    const LISTEN: &str = "require('node:net').createServer().listen(0, 'localhost', function () { console.log(this.address().address); this.close(); })";
    let mut spec =
        CmdSpec::new("localhost-bind", "pnpm", &["exec", "node", "-e", LISTEN], 60).cwd(app);
    if let Some(options) = options {
        spec = spec
            .env("NODE_OPTIONS", options)
            .env("npm_config_node_options", options);
        spec.args
            .insert(0, format!("--config.node-options={options}"));
    }
    let output = runner.run(&spec);
    match output.stdout.lines().last().map(str::trim) {
        Some(address) if output.ok() && !address.is_empty() => Ok(address.to_string()),
        _ => Err(output.summary()),
    }
}

fn dir_from(name: &str) -> PathBuf {
    let value = std::env::var_os(name).unwrap_or_else(|| {
        panic!("METRO_SMOKE_SETUP: {name} is not set; next: set it to an absolute directory (the metro-bind job in .github/workflows/ci.yml shows both)")
    });
    let path = PathBuf::from(value);
    assert!(
        path.is_absolute(),
        "METRO_SMOKE_SETUP: {name} is not an absolute path; next: set it to an absolute directory"
    );
    path
}

fn observed(port: u16, seen: Option<&BindObservation>) -> String {
    match seen {
        Some(seen) => format!(
            "listeners seen: {}; 127.0.0.1 {:?}; [::1] {:?}",
            metro::listener_forms(&seen.listeners, port),
            seen.v4,
            seen.v6
        ),
        None => "no Metro of this run was seen owning the port".to_string(),
    }
}

// A port nothing listens on in either family, by the read the product uses for the port's owner.
// The error is the last read that failed, so a broken lsof is not reported as a busy host.
fn free_port(runner: &mut dyn Runner) -> Result<u16, String> {
    let mut last = String::new();
    for _ in 0..5 {
        let port = match std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()) {
            Ok(address) => address.port(),
            Err(e) => {
                last = format!("binding 127.0.0.1:0 failed: {e}");
                continue;
            }
        };
        match metro::parse_port_owner(&runner.run(&metro::port_owner_spec(port))) {
            metro::PortOwners::Free => return Ok(port),
            other => last = format!("the owner read of port {port} gave {other:?}"),
        }
    }
    Err(last)
}

// The proven owner itself listens beyond loopback.
fn exposed_by(listeners: &Listeners, owner: i32) -> bool {
    matches!(listeners, Listeners::Seen(seen)
        if seen.iter().any(|(pid, addr)| *pid == owner
            && matches!(addr, BoundAddr::Wildcard | BoundAddr::Other)))
}

fn on_ipv4_loopback(listeners: &Listeners, owner: i32) -> bool {
    matches!(listeners, Listeners::Seen(seen) if seen.contains(&(owner, BoundAddr::V4Loopback)))
}

fn answered(seen: &BindObservation) -> bool {
    [seen.v4, seen.v6].contains(&StatusProbe::Running)
}

#[test]
#[ignore = "starts a real Expo dev server; the macOS metro-bind job runs it with QAREN_METRO_SMOKE_APP set"]
fn qarens_own_metro_answers_on_ipv4_loopback() {
    let app = dir_from("QAREN_METRO_SMOKE_APP");
    let out = dir_from("QAREN_METRO_SMOKE_OUT");
    assert!(
        app.join("node_modules/.bin/expo").exists(),
        "METRO_SMOKE_SETUP: {} has no installed expo; next: run pnpm install --frozen-lockfile there",
        app.display()
    );
    // The local cancel row only; checked here, before anything can run.
    let hold_seconds = match std::env::var("QAREN_METRO_SMOKE_HOLD_SECONDS") {
        Err(_) => 0,
        Ok(value) => match value.parse::<u64>() {
            Ok(seconds) if seconds <= MAX_HOLD_SECONDS => seconds,
            _ => panic!(
                "METRO_SMOKE_SETUP: QAREN_METRO_SMOKE_HOLD_SECONDS is {value:?}; next: unset it, or set a whole number of seconds up to {MAX_HOLD_SECONDS} (the local cancel row uses 120)"
            ),
        },
    };
    qaren::cancel::install();

    // The record lives in the output folder, so the uploaded artifact holds it. The run folder is
    // claimed exclusively, as a run claims its own (run.rs): two invocations that shared it would
    // overwrite each other's record, and each stop would then signal the other's Metro.
    let runs = out.join("runs");
    let dir = RunRecord::run_dir(&runs, RUN_ID);
    let claimed = std::fs::create_dir_all(&runs)
        .and_then(|()| std::fs::create_dir(&dir))
        .and_then(|()| std::fs::create_dir(dir.join("logs")));
    if let Err(e) = claimed {
        panic!(
            "METRO_SMOKE_SETUP: cannot claim {} for this run: {e}; next: if it already exists, another smoke used or is using this output folder: set QAREN_METRO_SMOKE_OUT to a new empty directory (mktemp -d); otherwise check that it is writable and the disk is not full",
            dir.display()
        );
    }
    let log = dir.join("logs/metro.log");
    let root = std::panic::catch_unwind(common::temp_repo).unwrap_or_else(|_| {
        panic!(
            "METRO_SMOKE_SETUP: cannot create a scratch folder under {}; next: check that the temp folder is writable and the disk is not full",
            std::env::temp_dir().display()
        )
    });
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    let mut last = None;
    let mut waiting = String::from("the port was not read");
    let mut port = 0;
    let mut group = 0;
    let mut command = String::new();
    let mut seconds = 0;
    let mut used_runs = runs.clone();
    let mut started_metro = false;

    // Every exit of this block reaches the stop below, a panic included.
    let seen = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Seen {
        // A run proves this before it starts anything (run.rs): a launcher that leaves the group
        // would put Metro outside the group the stop signals.
        let proof = pnpm::prove_group(
            &mut runner,
            &pnpm::group_probe_spec(&app),
            pnpm::PROBE_ATTEMPTS,
            120,
        );
        if let Some(reason) = runner.cancellation() {
            return Seen::Cancelled(reason);
        }
        match proof.outcome {
            pnpm::GroupOutcome::Proved => {}
            pnpm::GroupOutcome::Unproven => {
                return Seen::Setup(format!(
                    "pnpm exec did not prove that it keeps the process group; next: {}",
                    pnpm::GROUP_FIX
                ))
            }
            pnpm::GroupOutcome::TimedOut => {
                return Seen::Setup(format!(
                    "the pnpm process-group probe timed out ({} attempts, {} ms); next: re-run once, a loaded host can starve it",
                    proof.attempts.len(),
                    proof.elapsed_ms
                ))
            }
        }

        // The inputs an iOS run gives the start (commands/prepare.rs, spawn_metro_only).
        let preload = qaren::expo_updates::write_preload(&dir, &app);
        let inherited = runner.env_var("NODE_OPTIONS");
        let read = runner.run_private(
            &CmdSpec::new(
                "pnpm-node-options",
                "pnpm",
                &["config", "get", "node-options", "--json"],
                15,
            )
            .cwd(&app),
            &[],
        );
        let configured = (read.exit_code() == Some(0) && !read.timed_out())
            .then(|| metro::parse_pnpm_node_options(read.stdout()))
            .flatten()
            .flatten();
        let base = configured.or(inherited);

        // Can this host show the regression? With the base options alone a server on localhost must
        // get ::1, and with IPv4-first added 127.0.0.1; otherwise green would prove nothing. The
        // option is spelled out here, not taken from the product, so this stays a fact about the host.
        let ipv4_first = match base.as_deref() {
            Some(base) => format!("{base} --dns-result-order=ipv4first"),
            None => "--dns-result-order=ipv4first".to_string(),
        };
        let binds = (
            localhost_bind(&mut runner, &app, base.as_deref()),
            localhost_bind(&mut runner, &app, Some(&ipv4_first)),
        );
        if let Some(reason) = runner.cancellation() {
            return Seen::Cancelled(reason);
        }
        match binds {
            (Ok(plain), Ok(first)) if plain == "::1" && first == "127.0.0.1" => {
                say(&format!("localhost binds: base options -> {plain}; with --dns-result-order=ipv4first -> {first}"));
            }
            (Ok(plain), Ok(first)) => return Seen::Blind(format!(
                "a Node server on localhost binds {plain} with the base options and {first} with --dns-result-order=ipv4first added"
            )),
            (plain, first) => return Seen::Setup(format!(
                "the localhost bind check could not run: base options {plain:?}; with --dns-result-order=ipv4first {first:?}; next: re-run once (a loaded host can time it out); if it repeats, run `pnpm exec node -e 0` in the installed fixture and fix what it reports"
            )),
        }

        // Picked last, close to the start, and read free in both families.
        port = match free_port(&mut runner) {
            Ok(free) => free,
            Err(_) if runner.cancellation().is_some() => {
                return Seen::Cancelled(runner.cancellation().unwrap_or_default())
            }
            Err(read) => return Seen::Setup(format!(
                "no free TCP port was proven in five tries; last: {read}; next: re-run once; if the last read is Unknown again, lsof fails or times out on this host: run `lsof -nP -iTCP -sTCP:LISTEN` there"
            )),
        };
        let mut record =
            common::base_record(&root, &common::ios_scenario_yaml(port), RUN_ID, Phase::Walking);
        let spec = metro::start_spec(
            &app,
            port,
            Listen::Loopback,
            metro::expo_online(&runner),
            preload.as_deref(),
            base.as_deref(),
        );
        command = spec.rendered();
        // Checked before any socket opens: this job must never serve beyond loopback. A change of the
        // loopback flag (literal-loopback binding is tracked upstream) updates this line with it.
        if !spec.args.iter().any(|arg| arg == "--localhost") {
            return Seen::NotLoopback;
        }
        if let Some(reason) = runner.cancellation() {
            return Seen::Cancelled(reason);
        }
        if let Err(e) = record.save(&runs) {
            return Seen::Setup(format!(
                "cannot save the run record under {}: {e:?}; next: check that QAREN_METRO_SMOKE_OUT is writable and the disk is not full",
                runs.display()
            ));
        }
        let spawned = match runner.spawn_group(&spec, &log) {
            Ok(spawned) => spawned,
            // Err proves that nothing was spawned; a caught signal is one such Err.
            Err(_) if runner.cancellation().is_some() => {
                return Seen::Cancelled(runner.cancellation().unwrap_or_default())
            }
            Err(e) => return Seen::Setup(format!(
                "cannot spawn {command}: {e}; next: check that pnpm is on PATH (corepack enable pnpm) and that the fixture is installed"
            )),
        };
        started_metro = true;
        group = spawned.pgid;
        // For a run that is killed before its stop, on a machine that is kept.
        say(&format!(
            "METRO_SMOKE_STARTED: Metro process group {group} on port {port}; log {}; if this test is killed before its stop: read `lsof -nP -iTCP:{port} -sTCP:LISTEN` and `ps -o pgid=,command= -p <that pid>`, and only if that is this run's `expo start --port {port}` in group {group}, end it with `kill -TERM -- -{group}`",
            log.display()
        ));
        let identity = capture_pid_identity(&mut runner, spawned.pid);
        record.resources.metro = Some(MetroResource {
            port,
            endpoint: format!("http://127.0.0.1:{port}"),
            spawned: spawned.clone(),
            identity: identity.clone(),
            log: log.clone(),
        });
        if record.save(&runs).is_err() {
            // Keep the identity this process holds: a second place for the same record.
            used_runs = root.join("runs");
            if let Err(e) = record.save(&used_runs) {
                return Seen::Setup(format!(
                    "the run record of the started Metro could not be saved under {} or {}: {e:?}; next: check free disk space, then re-run",
                    runs.display(),
                    used_runs.display()
                ));
            }
        }

        // The turn of wait_metro_responding, without its restart: liveness, port ownership, then the
        // bind observation. The budget is checked after each turn's observations, as there.
        let started = runner.monotonic_ms();
        let deadline = started + READY_SECONDS * 1000;
        let seen = loop {
            if let Some(reason) = runner.cancellation() {
                break Seen::Cancelled(reason);
            }
            if !identity
                .as_ref()
                .is_some_and(|id| probe_pid_identity(&mut runner, id) != PidLiveness::Dead)
            {
                break Seen::Exited;
            }
            let owner = match metro::parse_port_owner(&runner.run(&metro::port_owner_spec(port))) {
                metro::PortOwners::Owned(pid) => match metro::pgid_of(&mut runner, pid) {
                    Some(owner_group) if owner_group == group => Some(pid),
                    Some(owner_group) => {
                        waiting = format!(
                            "port {port} is owned by pid {pid} of another process group ({owner_group})"
                        );
                        None
                    }
                    None => {
                        waiting =
                            format!("the process group of port owner pid {pid} could not be read");
                        None
                    }
                },
                metro::PortOwners::Free => {
                    waiting = format!("nothing listens on port {port}");
                    None
                }
                other => {
                    waiting = format!("the owner read of port {port} gave {other:?}");
                    None
                }
            };
            if let Some(owner) = owner {
                waiting = format!("pid {owner} of this run's group owns port {port}");
                let (mut observation, class) = metro::observe_bind(&mut runner, port, Some(owner));
                // The listeners are read before the probes, and Expo CLI opens the port on all
                // interfaces for an instant to test it before Metro listens. So a wider listener
                // counts only when Metro answered and one fresh listener read, made after that
                // answer, still shows the same owner on it; with no answer the wait goes on.
                if exposed_by(&observation.listeners, owner) && answered(&observation) {
                    observation.listeners =
                        metro::parse_listeners(&runner.run(&metro::listen_spec(port)), port);
                    if exposed_by(&observation.listeners, owner) {
                        last = Some(observation);
                        break Seen::NotLoopback;
                    }
                }
                let listeners = observation.listeners.clone();
                last = Some(observation);
                match class {
                    // Green needs the listener itself on 127.0.0.1, not only an answer there.
                    BindClass::V4 if on_ipv4_loopback(&listeners, owner) => break Seen::V4,
                    BindClass::V6Only => break Seen::V6Only,
                    _ => {}
                }
            }
            if runner.monotonic_ms() >= deadline {
                // A signal caught in this turn made its reads fail: that is a cancellation.
                break match runner.cancellation() {
                    Some(reason) => Seen::Cancelled(reason),
                    None => Seen::NotReady,
                };
            }
            runner.sleep(Duration::from_secs(2));
        };
        seconds = runner.monotonic_ms().saturating_sub(started) / 1000;
        if !matches!(seen, Seen::V4) {
            return seen;
        }
        // The local cancel row only: keep the proven Metro up so a signal lands while it runs.
        if hold_seconds > 0 {
            say(&format!(
                "METRO_SMOKE_HOLDING: Metro listens on 127.0.0.1:{port}; test process {}; up to {hold_seconds} s",
                std::process::id()
            ));
            let until = runner.monotonic_ms() + hold_seconds * 1000;
            while runner.monotonic_ms() < until && runner.cancellation().is_none() {
                runner.sleep(Duration::from_secs(1));
            }
        }
        Seen::V4
    }))
    .unwrap_or_else(|_| {
        Seen::Setup(
            "the test panicked; its message is above this line in the log; next: read it, then fix the test or the product function it names"
                .into(),
        )
    });

    let stopped = if started_metro {
        stop_and_prove(&mut runner, &used_runs, port)
    } else {
        "nothing was started".to_string()
    };
    let _ = runner.flush_logs();
    // The only stops that prove this run's Metro gone.
    let gone = !started_metro || stopped == "removed" || stopped == "absent";
    // A signal caught after the last check, during the hold or the stop: a green verdict then is a
    // cancellation. A red verdict already diagnosed is kept.
    let seen = match (seen, runner.cancellation()) {
        (Seen::V4, Some(reason)) => Seen::Cancelled(reason),
        (seen, _) => seen,
    };

    let observed = observed(port, last.as_ref());
    let upstream = "if this change touched neither the Metro start (packages/qaren-cli/src/adapters/metro.rs, src/exec.rs) nor the fixture, compare this job's Versions step with the last green run on develop (Node, the runner image) and the fixture's lockfile history";
    let (bind, verdict) = match &seen {
        Seen::V4 => ("127.0.0.1", None),
        Seen::V6Only => ("[::1]-only", Some(format!(
            "METRO_SMOKE_IPV6_ONLY: QaReN's Metro, started as an iOS run starts it, answered on [::1]:{port} and never on 127.0.0.1:{port}, which QaReN and the dev client use; {observed}; next: an iOS run with this Node, Expo CLI and Metro configuration, on a Mac whose localhost resolves to ::1 first, would restart its Metro on all interfaces or refuse METRO_BIND_IPV6_ONLY; check in this order: (1) the start: start_spec and dev_server_node_options in packages/qaren-cli/src/adapters/metro.rs must pass --dns-result-order=ipv4first three ways; (2) the Metro configuration of the fixture this job installed: a metro.config.js, or a file it loads, that calls dns.setDefaultResultOrder overrides that option; (3) if neither changed, compare this job's Versions step with the last green run on develop (Node, the runner image) and the fixture's lockfile history"
        ))),
        Seen::NotLoopback => ("not-loopback", Some(format!(
            "METRO_SMOKE_NOT_LOOPBACK: QaReN's iOS Metro start is not loopback-only (command: {command}); {observed}; next: Listen::Loopback in packages/qaren-cli/src/adapters/metro.rs must pass --localhost and Metro must then listen on 127.0.0.1 only; {upstream}"
        ))),
        Seen::Blind(detail) => ("blind", Some(format!(
            "METRO_SMOKE_BLIND: on this host {detail}; the smoke proves the IPv4-first option only where these are ::1 and 127.0.0.1; next: return the smoke to its plan owner (AI-466 slice 4) with this line"
        ))),
        Seen::Exited => ("inconclusive", Some(format!(
            "METRO_SMOKE_METRO_EXITED: the dev server exited before it answered, or its process could not be read; next: read runs/{RUN_ID}/logs/metro.log in the metro-bind-smoke artifact; if the log shows the port in use, another process took port {port} first: re-run once; {upstream}"
        ))),
        Seen::NotReady => ("inconclusive", Some(format!(
            "METRO_SMOKE_NOT_READY: QaReN's Metro was not proven to answer on 127.0.0.1:{port} within {READY_SECONDS} s; last port read: {waiting}; {observed}; next: read runs/{RUN_ID}/logs/metro.log in the metro-bind-smoke artifact; the wait ends as soon as Metro answers, so without a defect only a host that starves Metro for the whole budget, another process holding port {port}, or a port read that keeps failing (lsof, ps) causes this: re-run once"
        ))),
        Seen::Cancelled(reason) => ("inconclusive", Some(format!(
            "METRO_SMOKE_CANCELLED: {reason}; Metro stop: {stopped}; next: nothing, unless the run was not meant to be cancelled: then re-run"
        ))),
        Seen::Setup(detail) => ("inconclusive", Some(format!("METRO_SMOKE_SETUP: {detail}"))),
    };
    let left = (!gone).then(|| format!(
        "METRO_SMOKE_METRO_LEFT: the stop did not prove this run's Metro gone ({stopped}); process group {group}, port {port}; QaReN signals only a process group whose leader it can prove, so nothing else was signalled; next: on CI the single-use hosted runner ends it; on a machine that is kept, read `lsof -nP -iTCP:{port} -sTCP:LISTEN` and `ps -o pgid=,command= -p <that pid>`, and only if that is this run's `expo start --port {port}` in group {group}, end it with `kill -TERM -- -{group}`; then read the group stop in packages/qaren-cli/src/commands/cleanup.rs"
    ));
    let failure = match (verdict, left) {
        (Some(verdict), Some(left)) => Some(format!("{verdict}; {left}")),
        (verdict, left) => verdict.or(left),
    }
    .map(|failure| failure.replace(['\n', '\r'], " "));
    let evidence = format!(
        "bind={bind}\nobserved={observed}\nseconds={seconds}\nport={port}\ncleanup_metro={stopped}\ncommand={command}\nfailure={}\n",
        failure.as_deref().unwrap_or("")
    );
    // Inside the folder this run claimed, so nothing that was in the output folder is overwritten.
    let written = std::fs::write(dir.join("result.txt"), &evidence);
    say(evidence.trim_end());
    if let Some(failure) = failure {
        panic!("{failure}");
    }
    written.expect("METRO_SMOKE_SETUP: cannot write result.txt in the run folder; next: check that QAREN_METRO_SMOKE_OUT is writable and the disk is not full");
}
