use qaren::adapters::ios::{self, InventoryRead, InventoryReadLast};
use qaren::exec::{CmdOutput, MockRunner, Runner};
use qaren::failure::{Failure, FailureCode};
use std::time::Duration;

const UDID: &str = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
const RUNTIME: &str = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
const DEVICE_TYPE: &str = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";

fn inventory(state: &str) -> String {
    serde_json::json!({"devices": {RUNTIME: [{"udid": UDID, "name": "selected", "state": state, "isAvailable": true, "deviceTypeIdentifier": DEVICE_TYPE}]}}).to_string()
}

fn running(runner: &dyn Runner) -> Result<(), Failure> {
    runner
        .cancellation()
        .map_or(Ok(()), |reason| Err(Failure::cancelled("device", &reason)))
}

fn timeout() -> CmdOutput {
    CmdOutput {
        timed_out: true,
        duration_ms: 10_000,
        ..Default::default()
    }
}

#[test]
fn slow_or_partial_inventory_retries_and_proves_the_same_booted_target() {
    for first in [timeout(), CmdOutput::success("{\"devices\":")] {
        let mut runner = MockRunner::new();
        runner.advance_on = Some(("simctl list".into(), 1200));
        runner.expect_run("simctl list", first);
        runner.expect_run("simctl list", CmdOutput::success(&inventory("Booted")));
        let deadline = runner.monotonic_ms() + 40_000;
        let result =
            ios::read_inventory(&mut runner, InventoryRead::device(deadline, &mut running))
                .unwrap();
        assert_eq!(result.attempts, 2);
        assert_eq!(result.latency_ms, 4400);
        assert_eq!(
            ios::parse_selected_sim_value(&result.value, UDID)
                .unwrap()
                .state,
            ios::SimState::Booted
        );
        assert_eq!(runner.remaining(), 0);
        assert!(runner.calls.iter().all(|spec| spec.timeout_seconds == 10));
    }
}

#[test]
fn exhausted_inventory_has_bounded_attempts_safe_facts_and_a_refusal() {
    let mut runner = MockRunner::new();
    runner.advance_on = Some(("simctl list".into(), 10_000));
    for _ in 0..3 {
        runner.expect_run("simctl list", timeout());
    }
    let deadline = runner.monotonic_ms() + 40_000;
    let error = ios::read_inventory(&mut runner, InventoryRead::device(deadline, &mut running))
        .unwrap_err();
    assert_eq!(error.attempts, 3);
    assert_eq!(error.latency_ms, 34_000);
    assert_eq!(error.detail(), "simctl list did not answer usably in 3 attempts over 34.0 s (last: timed out after 10.0 s)");
    let failure = error.into_failure("device", FailureCode::SimulatorInventoryUnavailable);
    assert!(failure.code.is_refusal());
    assert_eq!(
        serde_json::to_value(failure.code).unwrap(),
        "SIMULATOR_INVENTORY_UNAVAILABLE"
    );
    assert!(failure.next_action.contains("qaren doctor"));
    assert_eq!(runner.calls.len(), 3);
}

#[test]
fn inventory_shape_stderr_and_size_are_transport_validity_not_target_state() {
    let base = "{\"devices\":{}}";
    let below_limit = format!("{base}{}", " ".repeat(1024 * 1024 - 1 - base.len()));
    let at_limit = format!("{below_limit} ");
    for (output, usable) in [
        (CmdOutput::success(&below_limit), true),
        (CmdOutput::success(&at_limit), false),
        (CmdOutput::success("{}"), false),
        (CmdOutput::success("[]"), false),
        (CmdOutput::success("{\"devices\":[]}"), false),
        (CmdOutput::success("{\"devices\":"), false),
        (
            CmdOutput {
                stderr: "private-warning-value".into(),
                ..CmdOutput::success(base)
            },
            false,
        ),
        (CmdOutput::failed(1, "private-error-value"), false),
    ] {
        let mut runner = MockRunner::new();
        runner.expect_run("simctl list", output);
        let result = ios::read_inventory(
            &mut runner,
            InventoryRead {
                attempts: 1,
                per_read_timeout: Duration::from_secs(5),
                pause: Duration::ZERO,
                deadline_ms: None,
                cwd: None,
                env: vec![],
                between: &mut running,
            },
        );
        assert_eq!(result.is_ok(), usable);
        if let Err(error) = result {
            assert!(!error.detail().contains("private-"));
        }
        assert_eq!(runner.calls.len(), 1);
    }
}

#[test]
fn deadline_spent_in_pause_prevents_another_read_and_caps_timeout() {
    let mut runner = MockRunner::new();
    runner.advance_on = Some(("simctl list".into(), 500));
    runner.expect_run("simctl list", timeout());
    let deadline = runner.monotonic_ms() + 2500;
    let error = ios::read_inventory(&mut runner, InventoryRead::device(deadline, &mut running))
        .unwrap_err();
    assert!(matches!(error.last, InventoryReadLast::DeadlineSpent));
    assert_eq!(error.attempts, 1);
    // Stops at once: a 2 s pause would leave less than the 1 s a read needs.
    assert_eq!(error.latency_ms, 500);
    assert_eq!(runner.calls[0].timeout_seconds, 2);
    assert_eq!(runner.calls.len(), 1);
}

#[test]
fn cancellation_during_the_final_read_wins_over_success_and_exhaustion() {
    for output in [timeout(), CmdOutput::success(&inventory("Booted"))] {
        let mut runner = MockRunner::new();
        runner.cancel_after = Some(("simctl list".into(), "received SIGTERM".into()));
        runner.advance_on = Some(("simctl list".into(), 5000));
        runner.expect_run("simctl list", output);
        let deadline = runner.monotonic_ms() + 5000;
        let error = ios::read_inventory(
            &mut runner,
            InventoryRead {
                attempts: 1,
                per_read_timeout: Duration::from_secs(5),
                pause: Duration::ZERO,
                deadline_ms: Some(deadline),
                cwd: None,
                env: vec![],
                between: &mut running,
            },
        )
        .unwrap_err();
        assert_eq!(
            error
                .into_failure("device", FailureCode::SimulatorInventoryUnavailable)
                .code,
            FailureCode::RunCancelled
        );
        assert_eq!(runner.calls.len(), 1);
    }
}

#[test]
fn unreadable_inventory_before_shutdown_is_a_refusal_without_mutation() {
    let mut runner = MockRunner::new();
    for _ in 0..3 {
        runner.expect_run("simctl list", timeout());
    }
    let deadline = runner.monotonic_ms() + 40_000;
    let ios::SelectedSimShutdown::InventoryUnavailable(error) = ios::shutdown_selected_sim_until(
        &mut runner,
        UDID,
        DEVICE_TYPE,
        RUNTIME,
        deadline,
        &mut running,
    ) else {
        panic!("expected unavailable inventory");
    };
    assert_eq!(
        error
            .into_failure("boot_device", FailureCode::SimulatorInventoryUnavailable)
            .code,
        FailureCode::SimulatorInventoryUnavailable
    );
    assert_eq!(runner.calls.len(), 3);
    assert!(runner.calls.iter().all(|spec| spec.label == "simctl-list"));
}

#[test]
fn unreadable_inventory_after_shutdown_keeps_the_readback_unresolved() {
    let mut runner = MockRunner::new();
    runner.expect_run("simctl list", CmdOutput::success(&inventory("Booted")));
    runner.expect_run("simctl shutdown", CmdOutput::success(""));
    for _ in 0..3 {
        runner.expect_run("simctl list", timeout());
    }
    let deadline = runner.monotonic_ms() + 40_000;
    assert!(matches!(
        ios::shutdown_selected_sim_until(
            &mut runner,
            UDID,
            DEVICE_TYPE,
            RUNTIME,
            deadline,
            &mut running
        ),
        ios::SelectedSimShutdown::ReadbackInvalid
    ));
    assert_eq!(runner.calls.len(), 5);
    assert_eq!(runner.remaining(), 0);
}

#[test]
fn a_slow_shutdown_that_spends_the_budget_still_reads_back_with_its_own_budget() {
    let mut runner = MockRunner::new();
    runner.advance_on = Some(("simctl shutdown".into(), 40_000));
    runner.expect_run("simctl list", CmdOutput::success(&inventory("Booted")));
    runner.expect_run("simctl shutdown", CmdOutput::success(""));
    runner.expect_run("simctl list", CmdOutput::success(&inventory("Shutdown")));
    let deadline = runner.monotonic_ms() + 40_000;
    assert!(matches!(
        ios::shutdown_selected_sim_until(
            &mut runner,
            UDID,
            DEVICE_TYPE,
            RUNTIME,
            deadline,
            &mut running
        ),
        ios::SelectedSimShutdown::ShutDown
    ));
    assert_eq!(runner.calls.last().unwrap().timeout_seconds, 10);
    assert_eq!(runner.remaining(), 0);
}
