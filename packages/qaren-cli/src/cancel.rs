use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, Ordering};

static CAUGHT: AtomicI32 = AtomicI32::new(0);
// One stop line per process: the handler that claims it writes it and ends the process; any other returns.
static LINE_CLAIMED: AtomicBool = AtomicBool::new(false);
// Bit n set: STOP_SIGNALS[n] carries the stop-line handler, so internal helpers can hand it back.
static STOP_INSTALLED: AtomicU8 = AtomicU8::new(0);

const STOP_SIGNALS: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];

// Unit-test hooks only (not compiled into qaren): a pause after the line is claimed, a signal raised after
// the first disposition change, and a forced failure of one installation step, so isolated child
// processes can aim at those windows.
#[cfg(test)]
static TEST_HOLD_AFTER_CLAIM: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
static TEST_AFTER_FIRST_CHANGE: AtomicI32 = AtomicI32::new(0);
// 1: blocking the signals, 2: a disposition, 3: restoring the mask.
#[cfg(test)]
static TEST_FAIL_STEP: AtomicU8 = AtomicU8::new(0);

fn test_fails(step: u8) -> bool {
    #[cfg(test)]
    {
        TEST_FAIL_STEP.load(Ordering::SeqCst) == step
    }
    #[cfg(not(test))]
    {
        let _ = step;
        false
    }
}

// Fixed bytes, each written with one write(2): a signal handler may not format or allocate.
const SECOND_SIGNAL_LINE: &[u8] = b"qaren: stopped at once by a second signal; if it had started a run, qaren cleanup <run-id> or the next run on this device can release what QaReN proves that run held\n";
const STOP_LINE_TERM: &[u8] = b"qaren: stopped by SIGTERM before it exited normally; if it was working on a run, check qaren status <run-id> before running it again\n";
const STOP_LINE_INT: &[u8] = b"qaren: stopped by SIGINT before it exited normally; if it was working on a run, check qaren status <run-id> before running it again\n";
const STOP_LINE_HUP: &[u8] = b"qaren: stopped by SIGHUP before it exited normally; if it was working on a run, check qaren status <run-id> before running it again\n";

// write(2) is async-signal-safe; it is retried after EINTR and short writes. A closed or redirected-away
// stderr drops the line, and a full one delays it.
fn write_all_stderr(line: &[u8]) {
    let mut written = 0;
    while written < line.len() {
        let rest = &line[written..];
        let n = unsafe { libc::write(2, rest.as_ptr().cast(), rest.len()) };
        if n > 0 {
            written += n as usize;
        } else if n < 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR)
        {
            continue;
        } else {
            return;
        }
    }
}

// True for the one handler, on any thread, that writes the line and then ends the process.
fn claim_line() -> bool {
    !LINE_CLAIMED.swap(true, Ordering::SeqCst)
}

// A second signal ends check or pr at once, after one line; the next run reclaims whatever this one held.
extern "C" fn on_signal(signal: libc::c_int) {
    if CAUGHT.swap(signal, Ordering::SeqCst) != 0 && claim_line() {
        write_all_stderr(SECOND_SIGNAL_LINE);
        unsafe { libc::_exit(128 + signal) };
    }
}

// Every other command still stops on TERM, INT or HUP exactly as the default action would, after one line
// that names the signal that ends it.
extern "C" fn on_stop_signal(signal: libc::c_int) {
    if !claim_line() {
        return;
    }
    #[cfg(test)]
    while TEST_HOLD_AFTER_CLAIM.load(Ordering::SeqCst) {
        std::hint::spin_loop();
    }
    write_all_stderr(match signal {
        libc::SIGINT => STOP_LINE_INT,
        libc::SIGHUP => STOP_LINE_HUP,
        _ => STOP_LINE_TERM,
    });
    // The re-raised signal stays blocked until this handler returns, then ends the process by that signal.
    unsafe {
        libc::signal(signal, libc::SIG_DFL);
        libc::raise(signal);
    }
}

enum Installed {
    Yes,
    KeptIgnored,
    Failed,
}

// The three stop signals stay blocked while a handler runs on its thread.
fn set_handler(signal: libc::c_int, handler: libc::sighandler_t, keep_ignored: bool) -> Installed {
    // A forced failure takes effect before any change, as a refused sigaction would.
    if test_fails(2) {
        return Installed::Failed;
    }
    unsafe {
        let mut current: libc::sigaction = std::mem::zeroed();
        if keep_ignored {
            if libc::sigaction(signal, std::ptr::null(), &mut current) != 0 {
                return Installed::Failed;
            }
            if current.sa_sigaction == libc::SIG_IGN {
                return Installed::KeptIgnored;
            }
        }
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = handler;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        for blocked in STOP_SIGNALS {
            libc::sigaddset(&mut action.sa_mask, blocked);
        }
        if libc::sigaction(signal, &action, std::ptr::null_mut()) == 0 {
            Installed::Yes
        } else {
            Installed::Failed
        }
    }
}

// Blocks the three stop signals, gives each `handler` (keeping inherited SIG_IGN when `keep_ignored`),
// then restores the caller's mask, so a signal arriving meanwhile waits for the new handler instead of
// meeting a half-installed set. Any failure is reported while the signals are still blocked and ends
// the command before it starts any work: exit 1, nothing to clean up.
fn install_all(handler: libc::sighandler_t, keep_ignored: bool, track: bool, failure: &[u8]) {
    unsafe {
        let mut stop: libc::sigset_t = std::mem::zeroed();
        let mut inherited: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut stop);
        for signal in STOP_SIGNALS {
            libc::sigaddset(&mut stop, signal);
        }
        // A forced failure (tests only) replaces the call, so it takes the same branch a refused one would.
        let blocked = if test_fails(1) {
            -1
        } else {
            libc::pthread_sigmask(libc::SIG_BLOCK, &stop, &mut inherited)
        };
        if blocked != 0 {
            write_all_stderr(failure);
            // nothing has changed yet
            libc::_exit(1);
        }
        for (bit, signal) in STOP_SIGNALS.into_iter().enumerate() {
            match set_handler(signal, handler, keep_ignored) {
                Installed::Yes => {
                    if track {
                        STOP_INSTALLED.fetch_or(1 << bit, Ordering::SeqCst);
                    }
                }
                Installed::KeptIgnored => {}
                Installed::Failed => {
                    write_all_stderr(failure);
                    // a disposition was refused
                    libc::_exit(1);
                }
            }
            #[cfg(test)]
            if bit == 0 {
                let raise = TEST_AFTER_FIRST_CHANGE.load(Ordering::SeqCst);
                if raise != 0 {
                    libc::raise(raise);
                }
            }
        }
        let restored = if test_fails(3) {
            -1
        } else {
            libc::pthread_sigmask(libc::SIG_SETMASK, &inherited, std::ptr::null_mut())
        };
        if restored != 0 {
            write_all_stderr(failure);
            // the caller's mask could not be restored
            libc::_exit(1);
        }
    }
}

// The first thing `main` does; a disposition inherited as ignored (nohup, background job) stays ignored.
pub fn install_stop_line() {
    install_all(
        on_stop_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
        true,
        true,
        b"qaren: could not install its stop-signal handler, so it stopped before doing anything; run it again\n",
    );
}

// Internal helper modes (qaren talking to itself) keep the default actions their callers expect. Best
// effort: a reset that fails leaves the stop-line handler, which still ends the helper by that signal.
pub fn restore_stop_defaults() {
    let installed = STOP_INSTALLED.swap(0, Ordering::SeqCst);
    for (bit, signal) in STOP_SIGNALS.into_iter().enumerate() {
        if installed & (1 << bit) != 0 {
            set_handler(signal, libc::SIG_DFL, false);
        }
    }
}

// check and pr: run cancellation takes over all three signals, ignored ones included, as at the pin.
pub fn install() {
    install_all(
        on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
        false,
        false,
        b"qaren: could not install its cancellation handler, so it stopped before starting the run; run it again\n",
    );
}

pub fn caught() -> i32 {
    CAUGHT.load(Ordering::SeqCst)
}

pub fn reason(caught: i32, parent_at_start: u32, parent_now: u32) -> Option<String> {
    match caught {
        0 if parent_now != parent_at_start => Some("the calling process exited".to_string()),
        0 => None,
        libc::SIGTERM => Some("received SIGTERM".to_string()),
        libc::SIGINT => Some("received SIGINT".to_string()),
        libc::SIGHUP => Some("received SIGHUP".to_string()),
        other => Some(format!("received signal {other}")),
    }
}

pub(crate) fn ensure_running(
    runner: &dyn crate::exec::Runner,
    next_phase: &str,
) -> Result<(), crate::failure::Failure> {
    match runner.cancellation() {
        Some(reason) => Err(crate::failure::Failure::cancelled(next_phase, &reason)),
        None => Ok(()),
    }
}

#[cfg(test)]
mod transition_tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const ROLE: &str = "QAREN_CANCEL_TEST_ROLE";
    const STOP_FAILURE: &str = "qaren: could not install its stop-signal handler, so it stopped before doing anything; run it again\n";
    const CANCEL_FAILURE: &str = "qaren: could not install its cancellation handler, so it stopped before starting the run; run it again\n";

    // Known start: the three signals unblocked and at their default actions, whatever the suite inherited.
    fn reset_signal_state() {
        unsafe {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            for signal in STOP_SIGNALS {
                libc::sigaddset(&mut set, signal);
                libc::signal(signal, libc::SIG_DFL);
            }
            libc::pthread_sigmask(libc::SIG_UNBLOCK, &set, std::ptr::null_mut());
        }
    }

    fn child_fail(why: &str) -> ! {
        write_all_stderr(format!("child: {why}\n").as_bytes());
        unsafe { libc::_exit(3) }
    }

    fn wait_until(what: &str, ready: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready() {
            if Instant::now() > deadline {
                child_fail(what);
            }
            std::hint::spin_loop();
        }
    }

    // Each role runs in a re-executed copy of this test binary, so installed handlers never touch the suite.
    #[test]
    fn transition_child() {
        let Ok(role) = std::env::var(ROLE) else {
            return;
        };
        reset_signal_state();
        match role.as_str() {
            // A HUP raised right after TERM's handler changed must wait for HUP's own handler.
            "stop-line" => {
                TEST_AFTER_FIRST_CHANGE.store(libc::SIGHUP, Ordering::SeqCst);
                install_stop_line();
                // The pending HUP is delivered when the mask returns; reaching here would be a bug.
                write_all_stderr(b"not stopped\n");
                unsafe { libc::_exit(0) };
            }
            // The same window at the check/pr handoff: the HUP must reach run cancellation as a first signal.
            "handoff" => {
                install_stop_line();
                TEST_AFTER_FIRST_CHANGE.store(libc::SIGHUP, Ordering::SeqCst);
                install();
                let line = if caught() == libc::SIGHUP {
                    "caught SIGHUP\n"
                } else {
                    "not caught\n"
                };
                write_all_stderr(line.as_bytes());
                unsafe { libc::_exit(0) };
            }
            // Two threads in the handler: the main thread claims the line and is held; this test's second
            // thread then takes SIGHUP itself. raise() returns only after its handler returned, so the winner
            // is released only once the loser is back in ordinary code.
            "two-threads" => {
                install_stop_line();
                TEST_HOLD_AFTER_CLAIM.store(true, Ordering::SeqCst);
                let main_thread = unsafe { libc::pthread_self() };
                std::thread::spawn(move || {
                    if unsafe { libc::pthread_kill(main_thread, libc::SIGTERM) } != 0 {
                        child_fail("could not signal the main thread");
                    }
                    wait_until("the main thread never claimed the line", || {
                        LINE_CLAIMED.load(Ordering::SeqCst)
                    });
                    if unsafe { libc::raise(libc::SIGHUP) } != 0 {
                        child_fail("could not raise SIGHUP");
                    }
                    TEST_HOLD_AFTER_CLAIM.store(false, Ordering::SeqCst);
                });
                loop {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
            // A failed installation step ends the command before it does any work.
            role if role.starts_with("fail-") => {
                let (installer, step) = role[5..].split_once('-').unwrap();
                let step: u8 = step.parse().unwrap();
                if installer == "handoff" {
                    install_stop_line();
                    TEST_FAIL_STEP.store(step, Ordering::SeqCst);
                    install();
                } else {
                    TEST_FAIL_STEP.store(step, Ordering::SeqCst);
                    install_stop_line();
                }
                write_all_stderr(b"work started\n");
                unsafe { libc::_exit(0) };
            }
            other => panic!("unknown role {other}"),
        }
    }

    // The child is waited for at most 10 s, then killed and reaped, so a regression cannot hang the suite.
    fn run_role(role: &str) -> (std::process::ExitStatus, String) {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "cancel::transition_tests::transition_child", "--nocapture", "--test-threads=1", "-q"])
            .env(ROLE, role)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let reader = std::thread::spawn(move || {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut stderr, &mut text).unwrap();
            text
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("role {role} did not end within 10 s");
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        (status, reader.join().unwrap())
    }

    // S-10
    #[test]
    fn a_signal_during_startup_installation_waits_for_its_handler() {
        let (status, err) = run_role("stop-line");
        assert_eq!(err, String::from_utf8_lossy(STOP_LINE_HUP));
        assert_eq!(status.signal(), Some(libc::SIGHUP));
    }

    // S-11
    #[test]
    fn a_signal_during_the_handoff_reaches_run_cancellation() {
        let (status, err) = run_role("handoff");
        assert_eq!(err, "caught SIGHUP\n");
        assert_eq!(status.code(), Some(0));
    }

    // S-12
    #[test]
    fn a_second_thread_in_the_handler_writes_nothing() {
        let (status, err) = run_role("two-threads");
        assert_eq!(err, String::from_utf8_lossy(STOP_LINE_TERM));
        assert_eq!(status.signal(), Some(libc::SIGTERM));
    }

    // S-13
    #[test]
    fn a_failed_startup_installation_stops_before_any_work() {
        for step in 1..=3 {
            let (status, err) = run_role(&format!("fail-start-{step}"));
            assert_eq!(err, STOP_FAILURE, "step {step}");
            assert_eq!(status.code(), Some(1), "step {step}");
        }
    }

    // S-14
    #[test]
    fn a_failed_handoff_installation_stops_before_the_run() {
        for step in 1..=3 {
            let (status, err) = run_role(&format!("fail-handoff-{step}"));
            assert_eq!(err, CANCEL_FAILURE, "step {step}");
            assert_eq!(status.code(), Some(1), "step {step}");
        }
    }
}
