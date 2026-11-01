use super::Check;
use crate::exec::{CmdSpec, Runner};
use std::path::Path;

const FIX: &str = "verify the candidate volume is mounted and responsive; inspect watchman health before coordinating a watchman reset with other sessions, then re-run doctor";

pub(super) fn checks(runner: &mut dyn Runner, app_root: Option<&Path>) -> Vec<Check> {
    let mut rows = inventory_checks(runner, app_root);
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

fn inventory_checks(runner: &mut dyn Runner, app_root: Option<&Path>) -> Vec<Check> {
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
    let Some(roots) = roots.filter(|roots| {
        roots.len() <= 256
            && roots
                .iter()
                .all(|r| r.as_str().is_some_and(|s| Path::new(s).is_absolute()))
    }) else {
        return vec![
            Check::warn("watchman-health", "watchman is unavailable, unresponsive within 5 s, or returned an invalid watch list; Metro may use its fallback watcher", FIX),
            Check::skip("watchman-volume-roots", "watch roots on the candidate volume are unknown"),
        ];
    };
    let health = if json.as_ref().is_some_and(|j| j.get("warning").is_some()) {
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
    };
    let Some(app_root) = app_root else {
        return vec![
            health,
            Check::skip(
                "watchman-volume-roots",
                "no configured candidate; volume roots are not inspected",
            ),
        ];
    };
    let roots: Vec<String> = roots
        .iter()
        .map(|r| r.as_str().expect("validated").to_string())
        .collect();
    let counts = crate::adapters::watchman::roots_spec(app_root, &roots).and_then(|spec| {
        let output = runner.run(&spec);
        output
            .ok()
            .then(|| {
                serde_json::from_str::<crate::adapters::watchman::RootCounts>(&output.stdout).ok()
            })
            .flatten()
    });
    let Some(crate::adapters::watchman::RootCounts { matching, unknown }) = counts else {
        return vec![
            health,
            Check::warn(
                "watchman-volume-roots",
                "candidate volume roots are unknown; metadata probe failed or exceeded 5 s",
                FIX,
            ),
        ];
    };
    let detail = format!("watch roots on candidate volume: {matching}; inaccessible or unclassified roots: {unknown}");
    let roots = if unknown > 0 {
        Check::warn("watchman-volume-roots", detail, FIX)
    } else {
        Check::pass("watchman-volume-roots", detail)
    };
    vec![health, roots]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner};

    #[test]
    fn no_candidate_establishes_no_watch_and_stalled_metadata_is_bounded() {
        let mut runner = MockRunner::new();
        runner.expect_run("watch-list", CmdOutput::success(r#"{"roots":["/"]}"#));
        let rows = checks(&mut runner, None);
        assert_eq!(runner.calls.len(), 1);
        assert_eq!(rows[1].status, super::super::Status::Skip);
        assert_eq!(rows[2].status, super::super::Status::Skip);
        let mut runner = MockRunner::new();
        runner.expect_run("watch-list", CmdOutput::success(r#"{"roots":["/"]}"#));
        runner.expect_run(
            crate::adapters::watchman::ROOTS_HELPER_ARG,
            CmdOutput {
                timed_out: true,
                ..Default::default()
            },
        );
        let rows = inventory_checks(&mut runner, Some(Path::new("/")));
        assert_eq!(rows[1].status, super::super::Status::Warn);
        assert_eq!(runner.calls[1].timeout_seconds, 5);
        let counts = crate::adapters::watchman::root_counts(
            Path::new("/"),
            &["/".into(), "/missing-synthetic-watch-root".into()],
        );
        assert_eq!(counts.matching, 1);
        assert_eq!(counts.unknown, 1);
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
        assert_eq!(rows[2].status, super::super::Status::Fail);
        assert!(rows[2].fix.as_ref().unwrap().contains("fseventsd"));
        assert!(rows[2].fix.as_ref().unwrap().contains("Privacy & Security"));
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
            runner.expect_run(
                crate::adapters::watchman::ROOTS_HELPER_ARG,
                CmdOutput::success(r#"{"matching":0,"unknown":0}"#),
            );
            runner.expect_run("watch-project", output);
            let rows = checks(&mut runner, Some(Path::new("/")));
            assert_eq!(rows[2].status, status);
            assert!(!format!("{rows:?}").contains("private error"));
        }
    }

    #[test]
    fn watches_are_counted_without_exposing_paths_or_starting_the_service() {
        let mut runner = MockRunner::new();
        runner.expect_run("watch-list", CmdOutput::success(r#"{"roots":["/"]}"#));
        runner.expect_run(
            crate::adapters::watchman::ROOTS_HELPER_ARG,
            CmdOutput::success(r#"{"matching":1,"unknown":0}"#),
        );
        let rows = inventory_checks(&mut runner, Some(Path::new("/")));
        assert!(rows
            .iter()
            .all(|row| row.status == super::super::Status::Pass));
        assert!(rows[1].detail.contains("candidate volume: 1"));
        assert!(runner.calls[0].args.contains(&"--no-spawn".into()));
        assert!(runner.calls[0].args.contains(&"--no-local".into()));
        assert_eq!(runner.calls[0].timeout_seconds, 5);
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
            let valid_roots = output.stdout.contains("\"warning\"");
            runner.expect_run("watch-list", output);
            if valid_roots {
                runner.expect_run(
                    crate::adapters::watchman::ROOTS_HELPER_ARG,
                    CmdOutput::success(r#"{"matching":0,"unknown":0}"#),
                );
            }
            let rows = inventory_checks(&mut runner, Some(Path::new("/")));
            assert_eq!(rows[0].status, super::super::Status::Warn);
            assert!(!format!("{rows:?}").contains("private diagnostic"));
        }
        let mut runner = MockRunner::new();
        runner.expect_run(
            "watch-list",
            CmdOutput::success(r#"{"roots":["/missing-synthetic-qaren-root"]}"#),
        );
        runner.expect_run(
            crate::adapters::watchman::ROOTS_HELPER_ARG,
            CmdOutput::success(r#"{"matching":0,"unknown":1}"#),
        );
        let rows = inventory_checks(&mut runner, Some(Path::new("/")));
        assert_eq!(rows[1].status, super::super::Status::Warn);
        assert!(!format!("{rows:?}").contains("missing-synthetic"));
    }
}
