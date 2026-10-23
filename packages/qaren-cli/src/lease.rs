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
pub fn cleanup_command(run_id: &str, home: Option<&Path>) -> String {
    let env = home
        .map(|home| format!("HOME='{}' ", home.display()))
        .unwrap_or_default();
    if run_id.starts_with("native-ios-") {
        format!(
            "`{env}cargo run --manifest-path packages/qaren-cli/Cargo.toml --locked --example native-ios-suite -- recover --run-id {run_id}` from the repository root"
        )
    } else {
        format!("`{env}qaren cleanup {run_id}`")
    }
}

fn holder_records(home: &Path, run_id: &str) -> Option<PathBuf> {
    let mut parts = Path::new(run_id).components();
    if !home.is_absolute()
        || !matches!(parts.next(), Some(std::path::Component::Normal(_)))
        || parts.next().is_some()
    {
        return None;
    }
    let kind = if run_id.starts_with("native-ios-") {
        "native-suites"
    } else {
        "runs"
    };
    Some(home.join(".qaren").join(kind).join(run_id))
}

// No cleanup can ever run for a proven-dead holder whose records are gone, so only its owned lock is released.
fn release_orphan(lock_dir: &Path, held: &LockHolder, liveness: Option<PidLiveness>) -> bool {
    if !matches!(
        liveness,
        Some(PidLiveness::Dead | PidLiveness::AliveForeign)
    ) {
        return false;
    }
    let Some(records) = held
        .home
        .as_deref()
        .and_then(|home| holder_records(home, &held.run_id))
    else {
        return false;
    };
    if !matches!(std::fs::symlink_metadata(&records), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    {
        return false;
    }
    matches!(
        buildplan::release_lock(lock_dir, &held.holder, &held.run_id),
        ReleaseOutcome::Removed | ReleaseOutcome::Absent
    )
}

pub fn claim_reclaiming_orphan(
    runner: &mut dyn Runner,
    lock_root: &Path,
    name: &str,
    holder: &LockHolder,
    policy: LockPolicy,
) -> LockOutcome {
    let outcome = buildplan::claim_lock(runner, lock_root, name, holder, policy);
    let LockOutcome::Contended {
        holder: Some(held),
        liveness,
        ..
    } = &outcome
    else {
        return outcome;
    };
    if !release_orphan(&buildplan::lock_dir(lock_root, name), held, *liveness) {
        return outcome;
    }
    match buildplan::claim_lock(runner, lock_root, name, holder, policy) {
        LockOutcome::Claimed { .. } => LockOutcome::Claimed {
            adopted_stale: true,
        },
        other => other,
    }
}

pub fn holder_home(runner: &dyn Runner) -> Option<PathBuf> {
    runner
        .env_var("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
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
    let holder = LockHolder {
        holder: format!("qaren-{run_id}"),
        run_id: run_id.to_string(),
        identity,
        at: timefmt::iso8601_utc(now_ms),
        home: holder_home(runner),
    };
    let name = lock_name(platform, device_id);
    match claim_reclaiming_orphan(runner, lock_root, &name, &holder, LockPolicy::Strict) {
        LockOutcome::Claimed { .. } => Ok(Lease {
            run_id: run_id.to_string(),
            token,
            lock_dir: buildplan::lock_dir(lock_root, &name),
            holder: holder.holder,
        }),
        LockOutcome::Contended {
            holder: existing,
            liveness,
            detail,
        } => {
            let (described, next_action) = match &existing {
                Some(h) => (
                    format!(" (held for run {})", h.run_id),
                    format!(
                        "wait for run {} to finish, or clean it up with {}; a live holder is never stolen",
                        h.run_id,
                        cleanup_command(&h.run_id, h.home.as_deref())
                    ),
                ),
                None => (
                    String::new(),
                    "wait for the holding run to finish, or clean it up with `qaren cleanup <its-run-id>`; a live holder is never stolen".to_string(),
                ),
            };
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
        LockOutcome::Error(detail) => Err(Box::new(Busy {
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
