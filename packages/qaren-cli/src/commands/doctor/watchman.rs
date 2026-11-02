use super::Check;
use crate::exec::{CmdSpec, Runner};
use std::path::Path;

const FIX: &str = "verify the candidate volume is mounted and responsive; inspect watchman health before coordinating a watchman reset with other sessions, then re-run doctor";

pub(super) fn checks(runner: &mut dyn Runner, app_root: Option<&Path>) -> Vec<Check> {
    let mut rows = vec![health(runner)];
    let Some(app_root) = app_root else {
        rows.push(Check::skip(
            "watchman-volume-probe",
            "no configured candidate; no watch is established",
        ));
        return rows;
    };
    let output = runner.run(&crate::adapters::watchman::watch_project_spec(app_root));
    use crate::adapters::watchman::VolumeProbe;
    rows.push(match VolumeProbe::from_output(&output) {
        VolumeProbe::Ready => Check::pass("watchman-volume-probe", "watchman watch-project answered for the candidate directory within 5 s"),
        VolumeProbe::TimedOut => Check::fail("watchman-volume-probe", "watchman watch-project did not answer for the candidate volume within 5 s", crate::failure::WATCHMAN_VOLUME_FIX),
        VolumeProbe::Rejected => Check::fail("watchman-volume-probe", "watchman rejected watch-project for the candidate directory; raw output withheld", crate::failure::WATCHMAN_VOLUME_FIX),
        VolumeProbe::Unavailable => Check::warn("watchman-volume-probe", "watchman volume admission is unknown; the service is unavailable or its response is invalid", "check watchman-health and the candidate volume, then re-run doctor; Metro may use its fallback watcher when watchman is unavailable"),
    });
    rows
}

fn health(runner: &mut dyn Runner) -> Check {
    let output = runner.run(
        &CmdSpec::new(
            "watchman-health",
            "watchman",
            &[
                "--no-spawn",
                "--no-local",
                "--output-encoding=json",
                "watch-list",
            ],
            5,
        )
        .cwd(Path::new("/")),
    );
    let json = output
        .ok()
        .then(|| serde_json::from_str::<serde_json::Value>(&output.stdout).ok())
        .flatten();
    let roots = json
        .as_ref()
        .filter(|j| j.get("error").is_none())
        .and_then(|j| j.get("roots")?.as_array());
    let Some(_) = roots.filter(|roots| {
        roots.len() <= 256
            && roots
                .iter()
                .all(|r| r.as_str().is_some_and(|s| Path::new(s).is_absolute()))
    }) else {
        return Check::warn("watchman-health", "watchman is unavailable, unresponsive within 5 s, or returned an invalid watch list; Metro may use its fallback watcher", FIX);
    };
    if json.as_ref().is_some_and(|j| j.get("warning").is_some()) {
        Check::warn(
            "watchman-health",
            "watchman answered with a warning; raw output withheld",
            FIX,
        )
    } else {
        Check::pass(
            "watchman-health",
            "watchman answered its read-only watch-list probe within 5 s",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner};

    #[test]
    fn no_candidate_establishes_no_watch() {
        let mut runner = MockRunner::new();
        runner.expect_run("watch-list", CmdOutput::success(r#"{"roots":["/"]}"#));
        let rows = checks(&mut runner, None);
        assert_eq!(runner.calls.len(), 1);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].status, super::super::Status::Skip);
    }

    #[test]
    fn a_stalled_volume_is_a_failure_even_when_watch_list_does_not_answer() {
        let mut runner = MockRunner::new();
        runner.expect_run(
            "watch-list",
            CmdOutput {
                timed_out: true,
                ..Default::default()
            },
        );
        runner.expect_run(
            "watch-project",
            CmdOutput {
                timed_out: true,
                ..Default::default()
            },
        );
        let rows = checks(&mut runner, Some(Path::new("/candidate/project")));
        assert_eq!(rows[1].status, super::super::Status::Fail);
        assert!(rows[1].fix.as_ref().unwrap().contains("fseventsd"));
        assert!(rows[1].fix.as_ref().unwrap().contains("Privacy & Security"));
        assert_eq!(runner.remaining(), 0);
    }

    #[test]
    fn the_volume_row_distinguishes_admission_from_rejection_and_unavailability() {
        use super::super::Status;
        for (output, status) in [
            (CmdOutput::success(r#"{"watch":"/"}"#), Status::Pass),
            (
                CmdOutput::success(r#"{"error":"private error"}"#),
                Status::Fail,
            ),
            (CmdOutput::failed(127, "private error"), Status::Warn),
        ] {
            let mut runner = MockRunner::new();
            runner.expect_run("watch-list", CmdOutput::success(r#"{"roots":[]}"#));
            runner.expect_run("watch-project", output);
            let rows = checks(&mut runner, Some(Path::new("/")));
            assert_eq!(rows[1].status, status);
            assert!(!format!("{rows:?}").contains("private error"));
        }
    }

    #[test]
    fn health_probe_is_bounded_and_does_not_start_the_service() {
        let mut runner = MockRunner::new();
        runner.expect_run(
            "watch-list",
            CmdOutput::success(r#"{"roots":["/private-watch"]}"#),
        );
        let row = health(&mut runner);
        assert_eq!(row.status, super::super::Status::Pass);
        assert!(!format!("{row:?}").contains("private-watch"));
        assert!(runner.calls[0].args.contains(&"--no-spawn".into()));
        assert!(runner.calls[0].args.contains(&"--no-local".into()));
        assert_eq!(runner.calls[0].timeout_seconds, 5);
        assert_eq!(runner.calls.len(), 1);
    }

    #[test]
    fn unavailable_malformed_and_warning_responses_do_not_claim_health() {
        for output in [
            CmdOutput {
                timed_out: true,
                ..Default::default()
            },
            CmdOutput::failed(1, "private diagnostic"),
            CmdOutput::success(r#"{"error":"private diagnostic","roots":[]}"#),
            CmdOutput::success(r#"{"roots":[3]}"#),
            CmdOutput::success(r#"{"roots":[],"warning":"private diagnostic"}"#),
        ] {
            let mut runner = MockRunner::new();
            runner.expect_run("watch-list", output);
            let row = health(&mut runner);
            assert_eq!(row.status, super::super::Status::Warn);
            assert!(!format!("{row:?}").contains("private diagnostic"));
            assert_eq!(runner.calls.len(), 1);
        }
    }
}
