use crate::exec::{CmdOutput, CmdSpec};
use std::path::Path;

pub const VOLUME_PROBE_SECONDS: u64 = 5;
pub const ROOTS_HELPER_ARG: &str = "--internal-watchman-volume-roots";

#[derive(serde::Serialize, serde::Deserialize)]
pub struct RootCounts {
    pub matching: usize,
    pub unknown: usize,
}

pub fn root_counts(candidate: &Path, roots: &[String]) -> RootCounts {
    use std::os::unix::fs::MetadataExt;
    let volume = std::fs::metadata(candidate).map(|m| m.dev()).ok();
    let mut counts = RootCounts {
        matching: 0,
        unknown: usize::from(volume.is_none()),
    };
    for root in roots {
        match std::fs::metadata(root).map(|m| m.dev()).ok().zip(volume) {
            Some((root_volume, candidate_volume)) => {
                counts.matching += usize::from(root_volume == candidate_volume)
            }
            None => counts.unknown += 1,
        }
    }
    counts
}

pub fn roots_spec(candidate: &Path, roots: &[String]) -> Option<CmdSpec> {
    let exe = std::env::current_exe().ok()?;
    let json = serde_json::to_string(roots).ok()?;
    Some(CmdSpec::new(
        "watchman-volume-roots",
        &exe.to_string_lossy(),
        &[ROOTS_HELPER_ARG, &candidate.to_string_lossy(), &json],
        5,
    ))
}

pub fn watch_project_spec(project_root: &Path) -> CmdSpec {
    CmdSpec::new(
        "watchman-volume-probe",
        "watchman",
        &[
            "--no-spawn",
            "--no-local",
            "--output-encoding=json",
            "watch-project",
            &project_root.to_string_lossy(),
        ],
        VOLUME_PROBE_SECONDS,
    )
    .cwd(Path::new("/"))
}

pub use crate::manifest::VolumeProbe;

impl VolumeProbe {
    pub fn from_output(output: &CmdOutput) -> Self {
        if output.timed_out {
            return Self::TimedOut;
        }
        let json = serde_json::from_str::<serde_json::Value>(&output.stdout).ok();
        if json.as_ref().is_some_and(|j| j.get("error").is_some()) {
            return Self::Rejected;
        }
        if output.ok()
            && json.as_ref().is_some_and(|j| {
                j.get("watch")
                    .and_then(|w| w.as_str())
                    .is_some_and(|w| Path::new(w).is_absolute())
            })
        {
            Self::Ready
        } else {
            Self::Unavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_probes_are_bounded_and_distinguish_timeout_rejection_and_unavailability() {
        let spec = watch_project_spec(Path::new("/candidate/project"));
        assert_eq!(spec.timeout_seconds, 5);
        assert_eq!(
            spec.args,
            [
                "--no-spawn",
                "--no-local",
                "--output-encoding=json",
                "watch-project",
                "/candidate/project"
            ]
        );
        for (output, expected) in [
            (
                CmdOutput::success(r#"{"watch":"/candidate"}"#),
                VolumeProbe::Ready,
            ),
            (
                CmdOutput {
                    timed_out: true,
                    ..Default::default()
                },
                VolumeProbe::TimedOut,
            ),
            (
                CmdOutput::success(r#"{"error":"private error"}"#),
                VolumeProbe::Rejected,
            ),
            (
                CmdOutput::failed(127, "not installed"),
                VolumeProbe::Unavailable,
            ),
            (CmdOutput::success("invalid"), VolumeProbe::Unavailable),
        ] {
            assert_eq!(VolumeProbe::from_output(&output), expected);
        }
    }
}
