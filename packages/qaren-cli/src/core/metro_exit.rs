use super::{CoreOutcome, Verdict};
use crate::exec::Runner;
use crate::failure::{AdmissionCause, AdmissionFacts, Failure, FailureCode};
use crate::runrecord::RunRecord;
use std::path::PathBuf;
use std::time::Duration;

// A launcher can outlive its server by a moment: up to three looks, a second apart, inside one deadline.
const LOOKS: u32 = 3;
const BETWEEN_LOOKS_MS: u64 = 1_000;
const DEADLINE_MS: u64 = 4_000;

// The Metro a run started, for one question after the core refused: is it gone?
// It is never signalled or collected here: cleanup owns the stop.
#[derive(Debug, Clone)]
pub struct RecordedMetro {
    launcher: i32,
    port: u16,
    log: PathBuf,
}

// What the looks found. `Unproven` keeps the last look's two answers, for the receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetroLook {
    Gone,
    Unproven {
        launcher_exited: bool,
        port_refused: bool,
    },
}

impl MetroLook {
    // Fixed words only.
    pub fn note(self) -> &'static str {
        match self {
            MetroLook::Gone => "gone",
            MetroLook::Unproven {
                launcher_exited: true,
                port_refused: true,
            } => "not proven: an answer came after the check's deadline",
            MetroLook::Unproven {
                launcher_exited: true,
                port_refused: false,
            } => "not proven: launcher exited, port did not refuse a connection",
            MetroLook::Unproven {
                launcher_exited: false,
                port_refused: true,
            } => "not proven: launcher not known to have exited, port refused a connection",
            MetroLook::Unproven {
                launcher_exited: false,
                port_refused: false,
            } => "not proven: launcher not known to have exited, port did not refuse a connection",
        }
    }
}

impl RecordedMetro {
    pub fn new(launcher: i32, port: u16, log: PathBuf) -> Self {
        Self {
            launcher,
            port,
            log,
        }
    }

    // None without a recorded Metro: nothing can then be asked about it.
    pub fn for_run(record: &RunRecord) -> Option<Self> {
        let metro = record.resources.metro.as_ref()?;
        Some(Self::new(metro.spawned.pid, metro.port, metro.log.clone()))
    }

    // Gone only on proof, in one look and before the deadline: the kernel says the launcher, this process's
    // own child, has exited, and the run's Metro port refuses a connection. Anything else is not proof.
    pub fn look(&self, runner: &mut dyn Runner) -> MetroLook {
        let deadline = runner.monotonic_ms().saturating_add(DEADLINE_MS);
        let mut last = MetroLook::Unproven {
            launcher_exited: false,
            port_refused: false,
        };
        for look in 0..LOOKS {
            if look > 0 {
                let left = deadline.saturating_sub(runner.monotonic_ms());
                if left <= BETWEEN_LOOKS_MS {
                    break;
                }
                runner.sleep(Duration::from_millis(BETWEEN_LOOKS_MS));
            }
            let launcher_exited = runner.child_exited(self.launcher);
            let port_refused = runner.loopback_refuses(self.port);
            last = MetroLook::Unproven {
                launcher_exited,
                port_refused,
            };
            // An answer that arrives after the deadline is not used.
            if runner.monotonic_ms() > deadline {
                break;
            }
            if launcher_exited && port_refused {
                return MetroLook::Gone;
            }
        }
        last
    }

    // Fixed words, the port and counts only, in the order things happened; the log is pointed at, never quoted.
    pub fn refusal(&self, facts: AdmissionFacts) -> Failure {
        let requests = crate::exec::log::read_bundle_requests(&self.log)
            .map_or("unknown".to_string(), |count| count.to_string());
        let builds = crate::exec::log::read_bundle_outcomes(&self.log).map_or(
            "unknown".to_string(),
            |(completed, failed)| format!("{completed} completed, {failed} failed"),
        );
        Failure::new(
            "attach",
            FailureCode::BundleLoadFailed,
            format!(
                "metro_exited: before admission the core's connection to Metro's target list on port {} was refused; QaReN then found its Metro gone (its launcher had exited and the port refused a connection); Metro's log for this port recorded bundle requests: {requests}; bundle builds: {builds}",
                self.port
            ),
            "",
        )
        .with_log(&self.log)
        .with_admission_recovery(AdmissionCause::MetroExited, Some(facts))
    }
}

// The core refused because its connection to Metro's target list was refused. That refusal is named a Metro
// exit only when it came from the core before admission, its facts carry no stronger finding, and the CLI
// now proves its own Metro gone. Everything else keeps its result. Returns what the looks found when Metro
// was looked at, for a receipt note.
pub fn name_metro_exit(
    runner: &mut dyn Runner,
    metro: Option<&RecordedMetro>,
    outcome: &mut CoreOutcome,
) -> Option<MetroLook> {
    let metro = metro?;
    if outcome.admitted
        || outcome.failure.is_some()
        || !matches!(&outcome.verdict, Verdict::Refused { code, .. } if code == "CDP_NOT_CONNECTED")
    {
        return None;
    }
    let facts = outcome
        .ledger
        .admission
        .clone()
        .filter(AdmissionFacts::metro_refused_connection)?;
    let found = metro.look(runner);
    if found != MetroLook::Gone {
        return Some(found);
    }
    let failure = metro.refusal(facts);
    let seen = format!("BUNDLE_LOAD_FAILED: {}", failure.detail);
    if let Some(recorded) = outcome.ledger.failure.as_mut() {
        recorded.seen = seen;
    }
    outcome.verdict = Verdict::Refused {
        code: "BUNDLE_LOAD_FAILED".to_string(),
        message: failure.detail.to_string(),
    };
    outcome.failure = Some(failure);
    Some(found)
}
