use crate::exec::{CmdOutput, CmdSpec, Runner};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const GROUP_OK: &str = "qaren-pnpm-group-ok\n";
pub const PROBE_ATTEMPTS: usize = 3;
pub const GROUP_FIX: &str = "select a pnpm version whose exec preserves process groups (Corepack's pnpm@11.5.2 JavaScript launcher is supported); for a bootstrap shim, put its matching installed pnpm executable first on this command's PATH, then re-run qaren doctor and qaren check";

pub fn source(runner: &dyn Runner) -> Option<(PathBuf, PathBuf)> {
    let path = runner.env_var("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let entry = dir.join("pnpm");
        let meta = std::fs::metadata(&entry).ok()?;
        if !meta.is_file() || meta.permissions().mode() & 0o111 == 0 {
            return None;
        }
        let resolved = std::fs::canonicalize(&entry).ok()?;
        Some((entry, resolved))
    })
}

pub fn source_detail(runner: &dyn Runner) -> String {
    match source(runner) {
        Some((entry, resolved)) => {
            format!(
                "pnpm at {} resolves to {}",
                entry.display(),
                resolved.display()
            )
        }
        None => "pnpm source could not be resolved on PATH".to_string(),
    }
}

pub fn group_probe_spec(project_root: &Path) -> CmdSpec {
    // No server starts: the probe exits even when a bootstrapper creates another group.
    const SCRIPT: &str = r#"QAREN_PNPM_LAUNCH_GROUP=$$
export QAREN_PNPM_LAUNCH_GROUP
exec pnpm --silent exec /bin/sh -c 'group=$(/bin/ps -o pgid= -p "$$") || exit 1
[ "$group" -eq "$QAREN_PNPM_LAUNCH_GROUP" ] || exit 1
printf "qaren-pnpm-group-ok\n"'"#;
    CmdSpec::new("pnpm-group-probe", "/bin/sh", &["-c", SCRIPT], 30)
        .cwd(project_root)
        .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupOutcome {
    Proved,
    // The probe finished without proving the group: GROUP_FIX applies.
    Unproven,
    // Every attempt ran out of time, or the run was cancelled: nothing was judged.
    TimedOut,
}

pub struct ProbeAttempt {
    pub output: CmdOutput,
    pub timeout_seconds: u64,
}

// `attempts` is never empty: the first attempt always runs.
pub struct GroupProof {
    pub outcome: GroupOutcome,
    pub attempts: Vec<ProbeAttempt>,
    pub elapsed_ms: u64,
}

// A busy host can starve the probe past its bound, so a timeout is retried with a doubled bound and a
// short pause; bounds and pauses are clipped to the budget, and a retry needs at least one second left.
pub fn prove_group(
    runner: &mut dyn Runner,
    spec: &CmdSpec,
    max_attempts: usize,
    budget_seconds: u64,
) -> GroupProof {
    let started = runner.monotonic_ms();
    let deadline = started + budget_seconds * 1000;
    let mut attempts = Vec::new();
    for n in 0..max_attempts.max(1) {
        let remaining = deadline.saturating_sub(runner.monotonic_ms());
        if n > 0 && (remaining < 1000 || runner.cancellation().is_some()) {
            break;
        }
        let mut bounded = spec.clone();
        bounded.timeout_seconds = (spec.timeout_seconds << n).min(remaining / 1000).max(1);
        let output = runner.run(&bounded);
        let finished = !output.timed_out;
        let proved = output.ok() && output.stdout == GROUP_OK;
        attempts.push(ProbeAttempt {
            output,
            timeout_seconds: bounded.timeout_seconds,
        });
        if finished {
            return GroupProof {
                outcome: if proved {
                    GroupOutcome::Proved
                } else {
                    GroupOutcome::Unproven
                },
                attempts,
                elapsed_ms: runner.monotonic_ms().saturating_sub(started),
            };
        }
        let remaining = deadline.saturating_sub(runner.monotonic_ms());
        if n + 1 < max_attempts && remaining >= 1000 && runner.cancellation().is_none() {
            runner.sleep(Duration::from_millis(
                (1000u64 << n).min(5000).min(remaining),
            ));
        }
    }
    GroupProof {
        outcome: GroupOutcome::TimedOut,
        attempts,
        elapsed_ms: runner.monotonic_ms().saturating_sub(started),
    }
}
