use crate::exec::{CmdOutput, CmdSpec, PrivateOutput};
use std::path::{Path, PathBuf};

pub const VOLUME_PROBE_SECONDS: u64 = 5;
pub const SYNC_MS: u64 = 4000;

pub fn clock_sync_spec(sync_ms: u64) -> CmdSpec {
    CmdSpec::new(
        "watchman-clock-sync",
        "watchman",
        &["--no-spawn", "--no-local", "--output-encoding=json", "-j"],
        sync_ms / 1000 + 1,
    )
    .cwd(Path::new("/"))
}

pub fn clock_sync_input(watch_root: &Path, sync_ms: u64) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!([
        "clock", watch_root, { "sync_timeout": sync_ms }
    ]))
    .expect("watch root is JSON serializable")
}

pub fn watch_root(output: &CmdOutput) -> Option<PathBuf> {
    let json: serde_json::Value = serde_json::from_str(&output.stdout).ok()?;
    let root = Path::new(json.get("watch")?.as_str()?);
    root.is_absolute().then(|| root.to_path_buf())
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
        if output.ok() && watch_root(output).is_some() {
            Self::Ready
        } else {
            Self::Unavailable
        }
    }

    pub fn from_sync_output(output: &PrivateOutput) -> Self {
        if output.timed_out() {
            return Self::SyncUnavailable;
        }
        let json = serde_json::from_str::<serde_json::Value>(output.stdout()).ok();
        if let Some(error) = json.as_ref().and_then(|j| j.get("error")) {
            return if error
                .as_str()
                .is_some_and(|error| error.contains("timed out waiting for cookie file"))
            {
                Self::Stalled
            } else {
                Self::SyncRejected
            };
        }
        if output.exit_code() == Some(0)
            && json
                .as_ref()
                .is_some_and(|j| j.get("clock").is_some_and(|c| c.is_string()))
        {
            Self::Ready
        } else {
            Self::SyncUnavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_sync_uses_bounded_private_json_input_and_the_resolved_root() {
        let spec = clock_sync_spec(4000);
        assert_eq!(spec.program, "watchman");
        assert_eq!(spec.timeout_seconds, 5);
        assert_eq!(spec.cwd, Some(PathBuf::from("/")));
        assert_eq!(
            spec.args,
            ["--no-spawn", "--no-local", "--output-encoding=json", "-j"]
        );
        let root = Path::new(r#"/candidate/quote"and\backslash"#);
        let input: serde_json::Value =
            serde_json::from_slice(&clock_sync_input(root, 4000)).unwrap();
        assert_eq!(
            input,
            serde_json::json!(["clock", r#"/candidate/quote"and\backslash"#, {"sync_timeout": 4000}])
        );
        assert_eq!(
            watch_root(&CmdOutput::success(r#"{"watch":"/resolved"}"#)),
            Some(PathBuf::from("/resolved"))
        );
    }

    #[test]
    fn sync_classification_withholds_raw_output_and_separates_cookie_timeouts() {
        use crate::exec::{MockRunner, Runner};
        for (output, expected) in [
            (
                CmdOutput::success(r#"{"clock":"c:1:2:3:4"}"#),
                VolumeProbe::Ready,
            ),
            (
                CmdOutput::success(
                    r#"{"error":"private-root: timed out waiting for cookie file to be observed by watcher within 4000 milliseconds"}"#,
                ),
                VolumeProbe::Stalled,
            ),
            (
                CmdOutput::success(r#"{"error":"other"}"#),
                VolumeProbe::SyncRejected,
            ),
            (
                CmdOutput {
                    timed_out: true,
                    ..Default::default()
                },
                VolumeProbe::SyncUnavailable,
            ),
            (
                CmdOutput::failed(1, "private-error"),
                VolumeProbe::SyncUnavailable,
            ),
            (
                CmdOutput {
                    exit_code: Some(1),
                    ..CmdOutput::success(r#"{"clock":"c:1"}"#)
                },
                VolumeProbe::SyncUnavailable,
            ),
            (CmdOutput::success("invalid"), VolumeProbe::SyncUnavailable),
        ] {
            let mut runner = MockRunner::new();
            runner.expect_run("watchman", output);
            let input = clock_sync_input(Path::new("/resolved"), 4000);
            let output = runner.run_private(&clock_sync_spec(4000), &input);
            assert_eq!(VolumeProbe::from_sync_output(&output), expected);
            assert_eq!(runner.private_inputs, [input]);
        }
    }

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
