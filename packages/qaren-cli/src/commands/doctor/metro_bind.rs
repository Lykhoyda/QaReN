use super::Check;
use crate::adapters::metro::{self, BindClass, BindObservation, Listeners, StatusProbe};
use crate::exec::Runner;

const ID: &str = "metro-bind";

// A Metro the user started is not QaReN's to stop; the row names why it would not have worked.
pub(super) fn check(runner: &mut dyn Runner, port: Option<u16>) -> Check {
    let Some(port) = port else {
        return Check::skip(ID, "no configured candidate; no Metro port read");
    };
    let (seen, class) = metro::observe_bind(runner, port, None);
    row(port, &seen, class)
}

fn row(port: u16, seen: &BindObservation, class: BindClass) -> Check {
    let probes = [seen.v4, seen.v6];
    match class {
        BindClass::V4 => Check::pass(ID, format!("Metro on port {port} answers on 127.0.0.1")),
        BindClass::V6Only => Check::fail(
            ID,
            format!("Metro on port {port} answers on [::1] only; QaReN and the dev client use 127.0.0.1"),
            "stop that Metro; `qaren check` starts its own, which answers on 127.0.0.1",
        ),
        _ if seen.listeners == Listeners::Seen(Vec::new())
            && probes.iter().all(|p| *p == StatusProbe::Refused) =>
        {
            Check::skip(ID, format!("nothing listens on port {port}"))
        }
        _ if probes
            .iter()
            .any(|p| matches!(p, StatusProbe::OtherBody | StatusProbe::HttpError(_))) =>
        {
            Check::warn(
                ID,
                format!("port {port} is held by another service"),
                format!("free port {port} or set another metroPort in .qaren/config.yaml; a run refuses a port it does not own"),
            )
        }
        _ => Check::warn(
            ID,
            format!(
                "Metro on port {port} did not answer: listeners {}; 127.0.0.1 {}; [::1] {}",
                metro::listener_forms(&seen.listeners, port),
                said(seen.v4),
                said(seen.v6)
            ),
            "re-run qaren doctor once that Metro has started; lsof and curl must be installed for this check",
        ),
    }
}

fn said(probe: StatusProbe) -> String {
    match probe {
        StatusProbe::Running => "answered".into(),
        StatusProbe::OtherBody => "answered another body".into(),
        StatusProbe::HttpError(code) => format!("answered HTTP {code}"),
        StatusProbe::Empty => "gave an empty reply".into(),
        StatusProbe::Refused => "refused the connection".into(),
        StatusProbe::Timeout => "timed out".into(),
        StatusProbe::ProbeFailed => "could not be probed".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::doctor::Status;
    use crate::exec::{CmdOutput, MockRunner};

    fn listening(names: &[&str]) -> CmdOutput {
        let mut out =
            String::from("COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\n");
        for name in names {
            out.push_str(&format!(
                "node    6001 user   21u  IPv6 0x1d2e3f4a5b6c7d8e      0t0  TCP {name} (LISTEN)\n"
            ));
        }
        CmdOutput::success(&out)
    }

    fn curl(stdout: &str, exit: i32) -> CmdOutput {
        CmdOutput {
            stdout: stdout.into(),
            ..CmdOutput::failed(exit, "")
        }
    }

    fn refused() -> CmdOutput {
        curl("\n000", 7)
    }

    fn running() -> CmdOutput {
        CmdOutput::success("packager-status:running\n200")
    }

    fn row_for(script: &[(&str, CmdOutput)]) -> Check {
        let mut runner = MockRunner::new();
        for (hint, output) in script {
            runner.expect_run(hint, output.clone());
        }
        let row = check(&mut runner, Some(8081));
        assert_eq!(runner.remaining(), 0);
        assert_eq!(row.id, "metro-bind");
        row
    }

    const LISTEN: &str = "-nP -iTCP:8081";
    const V4: &str = "http://127.0.0.1:8081/status";
    const V6: &str = "http://[::1]:8081/status";

    // D1
    #[test]
    fn metro_answering_on_ipv4_passes() {
        let row = row_for(&[
            (LISTEN, listening(&["127.0.0.1:8081"])),
            (V4, running()),
            (V6, refused()),
        ]);
        assert_eq!(row.status, Status::Pass);
        assert_eq!(row.detail, "Metro on port 8081 answers on 127.0.0.1");
    }

    // D2
    #[test]
    fn metro_answering_only_on_ipv6_fails_with_the_fix() {
        let row = row_for(&[
            (LISTEN, listening(&["[::1]:8081"])),
            (V4, refused()),
            (V6, running()),
            (V4, refused()),
            (V4, curl("\n000", 28)),
            (LISTEN, listening(&["[::1]:8081"])),
        ]);
        assert_eq!(row.status, Status::Fail);
        assert_eq!(
            row.detail,
            "Metro on port 8081 answers on [::1] only; QaReN and the dev client use 127.0.0.1"
        );
        assert_eq!(
            row.fix.as_deref(),
            Some("stop that Metro; `qaren check` starts its own, which answers on 127.0.0.1")
        );
    }

    // D3: another service, and a listener that answers nothing usable yet.
    #[test]
    fn another_service_or_an_unanswered_listener_warns_with_what_was_seen() {
        let other = row_for(&[
            (LISTEN, listening(&["*:8081"])),
            (V4, CmdOutput::success("<html></html>\n200")),
            (V6, CmdOutput::success("not found\n404")),
        ]);
        assert_eq!(other.status, Status::Warn);
        assert_eq!(other.detail, "port 8081 is held by another service");
        let silent = row_for(&[
            (LISTEN, listening(&["127.0.0.1:8081", "192.168.0.2:8081"])),
            (V4, curl("\n000", 52)),
            (V6, refused()),
        ]);
        assert_eq!(silent.status, Status::Warn);
        assert_eq!(
            silent.detail,
            "Metro on port 8081 did not answer: listeners pid 6001 127.0.0.1:8081, pid 6001 other; 127.0.0.1 gave an empty reply; [::1] refused the connection"
        );
        assert!(!silent.detail.contains("192.168"));
    }

    // D4
    #[test]
    fn nothing_listening_skips() {
        let row = row_for(&[
            (LISTEN, CmdOutput::failed(1, "")),
            (V4, refused()),
            (V6, refused()),
        ]);
        assert_eq!(row.status, Status::Skip);
        assert_eq!(row.detail, "nothing listens on port 8081");
    }

    // D5: a failed read is never "nothing listens".
    #[test]
    fn a_failed_listener_or_status_read_warns_instead_of_skipping() {
        for (listen, v4) in [
            (CmdOutput::failed(127, "lsof: not found"), refused()),
            (
                CmdOutput {
                    timed_out: true,
                    exit_code: None,
                    ..CmdOutput::success("")
                },
                refused(),
            ),
            (
                CmdOutput::failed(1, ""),
                CmdOutput {
                    exit_code: None,
                    ..CmdOutput::failed(0, "No such file or directory")
                },
            ),
        ] {
            let row = row_for(&[(LISTEN, listen), (V4, v4), (V6, refused())]);
            assert_eq!(row.status, Status::Warn, "{row:?}");
            assert!(
                row.detail.starts_with("Metro on port 8081 did not answer"),
                "{row:?}"
            );
        }
    }

    #[test]
    fn without_a_configured_candidate_no_port_is_read() {
        let mut runner = MockRunner::new();
        let row = check(&mut runner, None);
        assert_eq!(row.status, Status::Skip);
        assert!(runner.calls.is_empty());
    }
}
