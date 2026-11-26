use qaren::commands::prepare::android_launch_counts;
use qaren::failure::{AdmissionCause, AdmissionFacts};

const MAX: u64 = 9_007_199_254_740_991;

#[test]
fn android_launch_counts_pass_only_complete_counts_the_core_accepts() {
    assert_eq!(
        android_launch_counts(Some(3), Some((5, 7))),
        Some((3, (5, 7)))
    );
    assert_eq!(android_launch_counts(None, Some((5, 7))), None);
    assert_eq!(android_launch_counts(Some(3), None), None);
    assert_eq!(android_launch_counts(None, None), None);
    assert_eq!(
        android_launch_counts(Some(MAX), Some((MAX, MAX))),
        Some((MAX, (MAX, MAX)))
    );
    assert_eq!(android_launch_counts(Some(MAX + 1), Some((5, 7))), None);
    assert_eq!(android_launch_counts(Some(3), Some((MAX + 1, 7))), None);
    assert_eq!(android_launch_counts(Some(3), Some((5, MAX + 1))), None);
}

fn facts(
    inner: &str,
    liveness: &str,
    last_started: &str,
    request: Option<&str>,
    built: Option<&str>,
) -> AdmissionFacts {
    let mut value = serde_json::json!({
        "attempt": 3, "lastStarted": last_started, "lastCompleted": "retry_wait", "inner": inner,
        "relaunches": 0, "relaunchFailed": false, "liveness": liveness,
        "bundleRequest": request, "bundleBuilt": built,
        "elapsedMs": 121500, "remainingMs": 1078500, "budgetMs": 1200000
    });
    if inner == "non_dev_bundle" {
        for (key, count) in [
            ("targetsTotal", 1),
            ("devTrue", 0),
            ("devFalse", 1),
            ("devUndefined", 0),
            ("devUnknown", 0),
        ] {
            value[key] = count.into();
        }
    }
    let facts: AdmissionFacts = serde_json::from_value(value).unwrap();
    assert!(facts.valid());
    facts
}

// One refusal as "inner liveness lastStarted bundleRequest bundleBuilt", with "-" for an absent field.
fn row(text: &str) -> AdmissionFacts {
    let field: Vec<&str> = text.split(' ').collect();
    let optional = |at: usize| Some(field[at]).filter(|value| *value != "-");
    facts(field[0], field[1], field[2], optional(3), optional(4))
}

#[test]
fn android_refusals_map_to_a_cause_and_next_action_by_end_state() {
    use AdmissionCause as C;
    let mut rows = vec![
        ("non_dev_bundle alive attach - -", C::NonDevBundle),
        ("non_dev_bundle dead attach - -", C::NonDevBundle),
        (
            "target_readiness_timeout dead attach - -",
            C::AppProcessDead,
        ),
        (
            "react_readiness_timeout dead bundle_ready - -",
            C::AppProcessDead,
        ),
        // E1: no bundle request and a dead process; the process decides.
        (
            "target_list_empty dead attach not_received -",
            C::AppProcessDead,
        ),
        (
            "no_dev_target_unknown alive attach - -",
            C::NoDevTargetUnknown,
        ),
        (
            "dev_runtime_unproven alive attach received completed",
            C::DevRuntimeUnproven,
        ),
        (
            "react_readiness_timeout alive bundle_ready - -",
            C::ReactReadinessTimeout,
        ),
        (
            "cdp_probe_timeout alive open - -",
            C::AttachBudgetAfterConnect,
        ),
        (
            "cdp_probe_timeout not_probed foreign_driver - -",
            C::AttachBudgetAfterConnect,
        ),
        (
            "cdp_request_timeout alive prove - -",
            C::AttachBudgetAfterConnect,
        ),
        (
            "target_readiness_timeout probe_failed attach not_received -",
            C::BundleNotRequested,
        ),
        (
            "target_other_device not_probed attach not_received -",
            C::BundleNotRequested,
        ),
        (
            "target_selection_platform_not_found alive attach - -",
            C::AttachUnexplained,
        ),
        (
            "target_list_attempt_timeout not_probed attach not_received -",
            C::AttachUnexplained,
        ),
        (
            "target_list_attempt_timeout dead attach - -",
            C::AppProcessDead,
        ),
        // E9: another bundle's pages end the admission; it is not a target wait's timeout.
        (
            "bundle_readiness_timeout alive attach received none",
            C::AttachUnexplained,
        ),
        ("cdp_target_closed alive attach - -", C::AttachUnexplained),
        ("untyped alive attach - -", C::AttachUnexplained),
        // F6: a listing, a lost socket, then empty waits to the registered deadline.
        ("target_list_empty alive attach - -", C::NoAttachableTarget),
        // F3: the walk end with a request and no build, then two stalled connects after a listing.
        (
            "target_readiness_timeout not_probed attach received none",
            C::BundleNotBuilt,
        ),
        (
            "target_readiness_timeout not_probed attach - -",
            C::NoAttachableTarget,
        ),
        (
            "target_readiness_timeout alive attach - -",
            C::NoAttachableTarget,
        ),
    ]
    .into_iter()
    .map(|(text, cause)| (text.to_string(), cause))
    .collect::<Vec<_>>();
    for class in [
        "target_readiness_timeout",
        "target_list_empty",
        "target_other_device",
    ] {
        for (counts, cause) in [
            ("not_received -", C::BundleNotRequested),
            ("received none", C::BundleNotBuilt),
            ("received failed", C::BundleNotBuilt),
            ("received completed", C::NoAttachableTarget),
            ("received unknown", C::NoAttachableTarget),
            ("received -", C::NoAttachableTarget),
            ("unknown -", C::NoAttachableTarget),
        ] {
            rows.push((format!("{class} alive attach {counts}"), cause));
        }
    }
    for (text, expected) in rows {
        assert_eq!(
            AdmissionCause::from_facts(&row(&text), true),
            Some(expected),
            "{text}"
        );
    }
    let off = |text: &str| AdmissionCause::from_facts(&row(text), false);
    assert_eq!(off("target_list_empty dead attach - -"), None);
    assert_eq!(off("non_dev_bundle dead attach - -"), Some(C::NonDevBundle));
}

#[test]
fn each_new_android_cause_states_what_was_read() {
    use AdmissionCause as C;
    for (cause, cause_name, action, instruction) in [
        (
            C::AppProcessDead,
            "app_process_dead",
            "inspect_app_crash",
            "The app's process was not running when the attach was refused. Read the device's crash log for the app, then re-run once.",
        ),
        (
            C::AttachBudgetAfterConnect,
            "attach_budget_after_connect",
            "retry_attach_once",
            "The debugger was attached and React was ready; a deadline ended in a later step. Re-run once; if it repeats and the walk budget was not spent, raise `deadlines.attach_seconds`.",
        ),
        (
            C::BundleNotRequested,
            "bundle_not_requested",
            "retry_launch_once",
            "At the count check, Metro had recorded no bundle request on this port since the launch, and no wait had returned a debugger target. If the device shows the dev client's own launcher, re-run once; if it repeats, check that the device reaches Metro.",
        ),
        (
            C::BundleNotBuilt,
            "bundle_not_built",
            "inspect_metro_bundle",
            "A bundle request and no completed build had been recorded on this Metro port since the launch, and no wait had returned a debugger target. Read `logs/metro.log` in the run folder; fix a failed build, or re-run once.",
        ),
        (
            C::NoAttachableTarget,
            "no_attachable_target",
            "inspect_app_screen",
            "The attach ended without a usable debugger connection to the app. Look at the device for an error screen or a system dialog, then re-run once.",
        ),
        (
            C::AttachUnexplained,
            "attach_unexplained",
            "inspect_admission_evidence",
            "The attach was refused for the recorded class. Read the admission facts and `logs/core.log`, then re-run once.",
        ),
    ] {
        let (_, token, text) = cause.action();
        assert_eq!(token, action, "{cause_name}");
        assert_eq!(text, instruction, "{cause_name}");
        assert!(
            !text.replace("not running", "").contains("running"),
            "{cause_name}"
        );
        let recovery = qaren::failure::AdmissionRecovery::new(cause, None);
        assert_eq!(recovery.ladder.len(), 5);
        assert_eq!(recovery.next_rung, Some(1));
        let serialized = serde_json::to_value(&recovery).unwrap();
        assert_eq!(serialized["action"], action);
        assert_eq!(serialized["cause"], cause_name);
    }
}

// One refusal after the restart decision: "liveness bundleRequest relaunches relaunchFailed relaunchBlocked", "-" for absent.
fn restart_row(text: &str) -> AdmissionFacts {
    let field: Vec<&str> = text.split(' ').collect();
    let mut value = serde_json::json!({
        "attempt": 4, "lastStarted": "attach", "lastCompleted": "relaunch",
        "inner": "target_readiness_timeout", "liveness": field[0],
        "relaunches": field[2].parse::<u64>().unwrap(), "relaunchFailed": field[3] == "true",
        "elapsedMs": 181500, "remainingMs": 1018500, "budgetMs": 1200000
    });
    if field[1] != "-" {
        value["bundleRequest"] = field[1].into();
    }
    if field[4] != "-" {
        value["relaunchBlocked"] = field[4].into();
    }
    let facts: AdmissionFacts = serde_json::from_value(value).unwrap();
    assert!(facts.valid());
    facts
}

#[test]
fn android_restart_outcomes_map_to_their_own_causes() {
    use AdmissionCause as C;
    for (text, cause, action) in [
        (
            "alive not_received 0 false driver_busy",
            C::AppRestartBlockedByDriver,
            "wait_for_other_driver",
        ),
        (
            "dead - 0 false device_unreadable",
            C::AppRestartBlockedUnreadable,
            "check_device_connection",
        ),
        (
            "probe_failed - 0 false device_unreadable",
            C::AppRestartBlockedUnreadable,
            "check_device_connection",
        ),
        (
            "dead not_received 1 true -",
            C::AppRestartFailed,
            "check_device_connection",
        ),
        (
            "not_probed not_received 1 true -",
            C::AppRestartFailed,
            "check_device_connection",
        ),
        (
            "dead received 1 false -",
            C::AppProcessDeadAfterRestart,
            "inspect_app_crash",
        ),
        (
            "alive not_received 1 false -",
            C::BundleNotRequestedAfterRestart,
            "check_metro_reachable",
        ),
        (
            "dead not_received 0 false -",
            C::AppProcessDead,
            "inspect_app_crash",
        ),
        (
            "alive not_received 0 false -",
            C::BundleNotRequested,
            "retry_launch_once",
        ),
    ] {
        let facts = restart_row(text);
        assert_eq!(
            AdmissionCause::from_facts(&facts, true),
            Some(cause),
            "{text}"
        );
        assert_eq!(cause.action().1, action, "{text}");
        assert_eq!(
            AdmissionCause::from_facts(&facts, false),
            None,
            "iOS unchanged: {text}"
        );
        let recovery = qaren::failure::AdmissionRecovery::new(cause, Some(facts));
        assert_eq!(recovery.ladder.len(), 5, "{text}");
        assert_eq!(recovery.next_rung, Some(1), "{text}");
        let json = serde_json::to_value(&recovery).unwrap();
        assert_eq!(json["cause"], serde_json::to_value(cause).unwrap());
    }
    // non_dev_bundle still decides first.
    let mut facts = restart_row("dead - 1 true driver_busy");
    facts.inner = "non_dev_bundle".into();
    facts.targets_total = Some(1);
    facts.dev_false = Some(1);
    facts.dev_true = Some(0);
    facts.dev_undefined = Some(0);
    facts.dev_unknown = Some(0);
    assert_eq!(
        AdmissionCause::from_facts(&facts, true),
        Some(C::NonDevBundle)
    );
    // An unknown blocked word is not valid facts.
    let bad: Result<AdmissionFacts, _> = serde_json::from_value(serde_json::json!({
        "attempt": 1, "lastStarted": "attach", "lastCompleted": "none", "inner": "target_list_empty",
        "relaunches": 0, "relaunchFailed": false, "relaunchBlocked": "busy", "liveness": "alive",
        "elapsedMs": 1, "remainingMs": 1, "budgetMs": 2
    }));
    assert!(!bad.unwrap().valid());
}
