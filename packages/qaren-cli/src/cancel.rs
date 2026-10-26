use std::sync::atomic::{AtomicI32, Ordering};

static CAUGHT: AtomicI32 = AtomicI32::new(0);

// A second signal exits at once; the next run reclaims whatever this one held.
extern "C" fn on_signal(signal: libc::c_int) {
    if CAUGHT.swap(signal, Ordering::SeqCst) != 0 {
        unsafe { libc::_exit(128 + signal) };
    }
}

pub fn install() {
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        unsafe {
            libc::signal(
                signal,
                on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
            );
        }
    }
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
