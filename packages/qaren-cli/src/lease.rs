use crate::buildplan::{self, LockHolder, LockOutcome, LockPolicy, ReleaseOutcome};
use crate::candidate::sha256_hex;
use crate::exec::Runner;
use crate::failure::{Failure, FailureCode};
use crate::runrecord::{PidIdentity, PidLiveness};
use crate::scenario::Platform;
use crate::timefmt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// The device lease: one Strict lock per (platform, device) under the host lock
// root. The core child receives `<runId>:<token>` and echoes it in refusals.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lease {
    pub run_id: String,
    pub token: String,
    pub lock_dir: PathBuf,
    pub holder: String,
    #[serde(skip)]
    pub released_orphan: Option<String>,
}

impl Lease {
    pub fn wire(&self) -> String {
        format!("{}:{}", self.run_id, self.token)
    }
}

// Device ids can carry `:` or `/` (wireless adb serials); the lock name keeps a
// readable prefix and a hash so it stays one filesystem-safe component.
pub fn lock_name(platform: Platform, device_id: &str) -> String {
    let platform = match platform {
        Platform::Ios => "ios",
        Platform::Android => "android",
    };
    let safe: String = device_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .take(48)
        .collect();
    let digest = sha256_hex(device_id.as_bytes());
    format!("device-{platform}-{safe}-{}", &digest[..8])
}

fn fresh_token(fallback_seed: &str) -> String {
    let mut bytes = [0u8; 16];
    let read = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut bytes));
    match read {
        Ok(()) => bytes.iter().map(|b| format!("{b:02x}")).collect(),
        Err(_) => sha256_hex(fallback_seed.as_bytes())[..32].to_string(),
    }
}

// Native-suite runs keep their records outside the check runs root.
pub fn cleanup_command(run_id: &str, held: &LockHolder) -> String {
    let quoted = |path: &Path| format!("'{}'", path.display().to_string().replace('\'', "'\\''"));
    // An inherited QAREN_HOME would outrank HOME, so a HOME-only holder's command clears it.
    let env = match (&held.qaren_home, &held.home) {
        (Some(qaren_home), _) => format!("QAREN_HOME={} ", quoted(qaren_home)),
        (None, Some(home)) => format!("QAREN_HOME= HOME={} ", quoted(home)),
        (None, None) => String::new(),
    };
    if run_id.starts_with("native-ios-") {
        format!(
            "`{env}cargo run --manifest-path packages/qaren-cli/Cargo.toml --locked --example native-ios-suite -- recover --run-id {run_id}` from the repository root"
        )
    } else {
        let binary = if held.qaren_home.is_some() {
            match std::env::current_exe() {
                Ok(path) => quoted(&path),
                Err(_) => {
                    return "cleanup using an absolute path to this QAREN_HOME-aware qaren binary; its executable path could not be resolved".to_string();
                }
            }
        } else {
            "qaren".to_string()
        };
        format!("`{env}{binary} cleanup {run_id}`")
    }
}

fn holder_records(qaren_home: &Path, run_id: &str) -> Option<PathBuf> {
    let mut parts = Path::new(run_id).components();
    if !qaren_home.is_absolute()
        || !matches!(parts.next(), Some(std::path::Component::Normal(_)))
        || parts.next().is_some()
    {
        return None;
    }
    let (kind, record) = if run_id.starts_with("native-ios-") {
        ("native-suites", "suite.json")
    } else {
        ("runs", "run.json")
    };
    Some(qaren_home.join(kind).join(run_id).join(record))
}

// Judged by the record file: a run directory alone (claimed before the record, or re-created by an orphaned build) gives cleanup nothing to load.
pub fn records_gone(held: &LockHolder) -> bool {
    held.qaren_home
        .clone()
        .or_else(|| held.home.as_ref().map(|home| home.join(".qaren")))
        .and_then(|qaren_home| holder_records(&qaren_home, &held.run_id))
        .is_some_and(|records| {
            matches!(std::fs::symlink_metadata(records), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        })
}

// No cleanup can ever run for a proven-dead holder whose records are gone, so once its gated work group is gone too only its owned lock is released.
pub fn release_orphan(
    runner: &mut dyn Runner,
    lock_dir: &Path,
    held: &LockHolder,
    liveness: Option<PidLiveness>,
) -> bool {
    if !matches!(
        liveness,
        Some(PidLiveness::Dead | PidLiveness::AliveForeign)
    ) || !records_gone(held)
    {
        return false;
    }
    let pid_reused = liveness == Some(PidLiveness::AliveForeign);
    if held.group.is_some_and(|pgid| {
        !(pid_reused && held.identity.as_ref().is_some_and(|i| i.pid == pgid))
            && crate::adapters::metro::group_presence(runner, pgid)
                != crate::adapters::metro::GroupPresence::Absent
    }) {
        return false;
    }
    matches!(
        buildplan::release_lock(lock_dir, &held.holder, &held.run_id),
        ReleaseOutcome::Removed | ReleaseOutcome::Absent
    )
}

pub fn contended_advice(lock_dir: &Path, existing: Option<&LockHolder>) -> String {
    let Some(held) = existing else {
        return "wait for the holding run to finish, or clean it up with `qaren cleanup <its-run-id>`; a live or unproven holder is never taken".to_string();
    };
    if !records_gone(held) {
        return format!(
            "wait for run {} to finish, or clean it up with {}; a live or unproven holder is never taken",
            held.run_id,
            cleanup_command(&held.run_id, held)
        );
    }
    let work = held
        .group
        .map(|pgid| format!(" and `pgrep -g {pgid}` prints nothing"))
        .unwrap_or_default();
    format!(
        "run {} left no run record; once its process has exited{work}, re-run to release {}",
        held.run_id,
        lock_dir.display()
    )
}

// The second value names the orphaned run whose lock was released for this claim.
pub fn claim_reclaiming_orphan(
    runner: &mut dyn Runner,
    lock_root: &Path,
    name: &str,
    holder: &LockHolder,
    policy: LockPolicy,
) -> (LockOutcome, Option<String>) {
    let outcome = buildplan::claim_lock(runner, lock_root, name, holder, policy);
    let LockOutcome::Contended {
        holder: Some(held),
        liveness,
        ..
    } = &outcome
    else {
        return (outcome, None);
    };
    if !release_orphan(
        runner,
        &buildplan::lock_dir(lock_root, name),
        held,
        *liveness,
    ) {
        return (outcome, None);
    }
    let orphan = Some(held.run_id.clone());
    match buildplan::claim_lock(runner, lock_root, name, holder, policy) {
        LockOutcome::Claimed { .. } => (
            LockOutcome::Claimed {
                adopted_stale: true,
            },
            orphan,
        ),
        other => (other, orphan),
    }
}

pub fn orphan_note(lock_dir: &Path, run_id: &str) -> String {
    format!(
        "released {} left by run {run_id}: its process and work group are gone and it has no run record",
        lock_dir.display()
    )
}

// (HOME, QAREN_HOME) for a holder. Under QAREN_HOME no HOME is recorded, so a binary that only
// knows HOME/.qaren never takes the holder's records for gone.
pub fn holder_homes(runner: &dyn Runner) -> (Option<PathBuf>, Option<PathBuf>) {
    match runner
        .env_var_os("QAREN_HOME")
        .filter(|value| !value.is_empty())
    {
        Some(qaren_home) => (
            None,
            Some(PathBuf::from(qaren_home)).filter(|q| q.is_absolute()),
        ),
        None => (
            runner
                .env_var("HOME")
                .map(PathBuf::from)
                .filter(|home| home.is_absolute()),
            None,
        ),
    }
}

// An inherited group belongs to the caller and may outlive every run, so only a group this process leads gates orphan release.
fn led_group() -> Option<i32> {
    let pid = std::process::id() as i32;
    (unsafe { libc::getpgrp() } == pid).then_some(pid)
}

// A refused claim, with the holder and the liveness the claim already observed.
#[derive(Debug)]
pub struct Busy {
    pub failure: Failure,
    pub holder: Option<LockHolder>,
    pub liveness: Option<PidLiveness>,
}

pub fn acquire(
    runner: &mut dyn Runner,
    lock_root: &Path,
    platform: Platform,
    device_id: &str,
    run_id: &str,
    identity: Option<PidIdentity>,
) -> Result<Lease, Failure> {
    try_acquire(runner, lock_root, platform, device_id, run_id, identity)
        .map_err(|busy| busy.failure)
}

pub fn try_acquire(
    runner: &mut dyn Runner,
    lock_root: &Path,
    platform: Platform,
    device_id: &str,
    run_id: &str,
    identity: Option<PidIdentity>,
) -> Result<Lease, Box<Busy>> {
    let now_ms = runner.now_epoch_ms();
    let birth = identity
        .as_ref()
        .map(|i| i.started_at.clone())
        .unwrap_or_default();
    let token = fresh_token(&format!(
        "{run_id}\0{}\0{now_ms}\0{birth}",
        std::process::id()
    ));
    let (home, qaren_home) = holder_homes(runner);
    let holder = LockHolder {
        holder: format!("qaren-{run_id}"),
        run_id: run_id.to_string(),
        identity,
        at: timefmt::iso8601_utc(now_ms),
        home,
        qaren_home,
        group: led_group(),
    };
    let name = lock_name(platform, device_id);
    match claim_reclaiming_orphan(runner, lock_root, &name, &holder, LockPolicy::Strict) {
        (LockOutcome::Claimed { .. }, released_orphan) => Ok(Lease {
            run_id: run_id.to_string(),
            token,
            lock_dir: buildplan::lock_dir(lock_root, &name),
            holder: holder.holder,
            released_orphan,
        }),
        (
            LockOutcome::Contended {
                holder: existing,
                liveness,
                detail,
            },
            _,
        ) => {
            let described = existing
                .as_ref()
                .map(|h| format!(" (held for run {})", h.run_id))
                .unwrap_or_default();
            let next_action =
                contended_advice(&buildplan::lock_dir(lock_root, &name), existing.as_ref());
            Err(Box::new(Busy {
                failure: Failure::new(
                    "lease",
                    FailureCode::DeviceBusy,
                    format!("device {device_id} is leased elsewhere{described}: {detail}"),
                    next_action,
                ),
                holder: existing,
                liveness,
            }))
        }
        (LockOutcome::Error(detail), _) => Err(Box::new(Busy {
            failure: Failure::new(
                "lease",
                FailureCode::RunRecordUpdateFailed,
                format!("cannot operate the device lease lock: {detail}"),
                buildplan::LOCK_ROOT_ADVICE,
            ),
            holder: None,
            liveness: None,
        })),
    }
}

pub fn release(lease: &Lease) -> ReleaseOutcome {
    buildplan::release_lock(&lease.lock_dir, &lease.holder, &lease.run_id)
}

// Rollback before a run record exists: a lease that cannot be released has no record for
// `qaren cleanup` to find, so the failure itself must name the lock left behind.
pub fn release_or_annotate(lease: &Lease, mut failure: Failure) -> Failure {
    match release(lease) {
        ReleaseOutcome::Removed | ReleaseOutcome::Absent | ReleaseOutcome::Foreign(_) => failure,
        ReleaseOutcome::Refused(reason) | ReleaseOutcome::Unresolved(reason) => {
            failure.detail = crate::redact::OutputText::from_output(&format!(
                "{}; the device lease at {} could not be released: {reason}",
                failure.detail,
                lease.lock_dir.display()
            ));
            let lock_root = lease.lock_dir.parent().unwrap_or(&lease.lock_dir);
            failure.next_action = crate::redact::OutputText::from_output(&format!(
                "{}; then clear the leftover named above under {} once no qaren run holds it",
                failure.next_action,
                lock_root.display()
            ));
            failure
        }
    }
}
