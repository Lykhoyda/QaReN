use qaren::flow::plan::{self, Condition, Domain, Op, Press, Target};
use qaren::scenario::Platform;
use std::path::PathBuf;

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../qaren-core/test/fixtures/rn-flow-1/plans")
}

fn golden(name: &str) -> String {
    std::fs::read_to_string(golden_dir().join(name)).unwrap()
}

#[test]
fn every_golden_plan_the_compiler_emits_parses() {
    let mut parsed = 0;
    for entry in std::fs::read_dir(golden_dir()).unwrap() {
        let path = entry.unwrap().path();
        let text = std::fs::read_to_string(&path).unwrap();
        let plan = plan::parse(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert!(!plan.steps.is_empty(), "{}", path.display());
        parsed += 1;
    }
    assert_eq!(parsed, 26, "13 Test App actions on two platforms");
}

#[test]
fn a_golden_plan_keeps_its_domains_selectors_and_budgets() {
    let plan = plan::parse(&golden("qa-replay-nested.ios.json")).unwrap();
    assert_eq!(plan.action_id, "qa-replay-nested");
    assert_eq!(plan.platform, Platform::Ios);
    let first = &plan.steps[0];
    assert_eq!((first.id.as_str(), first.source.line), ("s1", 16));
    assert_eq!(first.domain, Domain::ReactTree);
    assert_eq!(first.budget_ms, 17_000);
    match &first.op {
        Op::AssertVisible(selector) => {
            assert_eq!(
                selector.target,
                Target::Id("qa-replay-ambiguity-fixture".into())
            );
            assert_eq!(selector.index, None);
        }
        other => panic!("unexpected {other:?}"),
    }
    assert!(matches!(&plan.steps[1].op, Op::Press(Press::Tap, _)));
    assert_eq!(plan.steps[1].domain, Domain::Native);
}

#[test]
fn a_lifecycle_launch_and_a_swipe_keep_their_fields() {
    let plan = plan::parse(&golden("mark-all-done.ios.json")).unwrap();
    assert_eq!(plan.steps[0].domain, Domain::Lifecycle);
    assert!(matches!(
        plan.steps[0].op,
        Op::LaunchApp {
            stop_app: true,
            clear_state: false
        }
    ));
    let plan = plan::parse(&golden("open-task-detail-sheet.ios.json")).unwrap();
    let swipe = plan
        .steps
        .iter()
        .find(|step| matches!(step.op, Op::Swipe { .. }))
        .unwrap();
    assert_eq!(swipe.budget_ms, 17_400);
    match &swipe.op {
        Op::Swipe {
            direction,
            from,
            duration_ms,
        } => {
            assert_eq!(*direction, plan::Direction::Down);
            assert_eq!(*duration_ms, 400);
            assert_eq!(
                from.as_ref().unwrap().target,
                Target::Id("task-sheet-handle".into())
            );
        }
        other => panic!("unexpected {other:?}"),
    }
    let erase = plan
        .steps
        .iter()
        .find(|step| matches!(step.op, Op::EraseText(_)))
        .unwrap();
    assert!(matches!(erase.op, Op::EraseText(14)));
}

#[test]
fn a_conditional_run_flow_holds_its_sub_steps() {
    let found = std::fs::read_dir(golden_dir())
        .unwrap()
        .map(|entry| plan::parse(&std::fs::read_to_string(entry.unwrap().path()).unwrap()).unwrap())
        .flat_map(|plan| plan.steps)
        .find_map(|step| match step.op {
            Op::RunFlow { when, steps } => Some((step.budget_ms, when, steps)),
            _ => None,
        })
        .expect("the corpus has a conditional runFlow");
    assert_eq!(found.0, 0, "a condition is one observation");
    assert!(matches!(
        found.1,
        Condition::Visible(_) | Condition::NotVisible(_)
    ));
    assert!(!found.2.is_empty());
}

fn with_step(step: &str) -> String {
    format!(
        r#"{{"schema":"rn-flow/1","actionId":"a","appId":"com.x","platform":"ios","steps":[{step}]}}"#
    )
}

fn ios_step(domain: &str, budget: u64, op: &str) -> String {
    format!(
        r#"{{"id":"s1","source":{{"line":3}},"domain":"{domain}","optional":false,"budgetMs":{budget},{op}}}"#
    )
}

const TAP: &str = r#"{"id":"s1","source":{"line":3},"domain":"native","optional":false,"budgetMs":17000,"op":"tapOn","selector":{"text":"Go"}}"#;

#[test]
fn a_well_formed_step_parses() {
    let plan = plan::parse(&with_step(TAP)).unwrap();
    assert_eq!(plan.steps.len(), 1);
}

#[test]
fn bounded_plan_values_are_admitted() {
    let budget = TAP.replace("17000", "600000");
    assert!(plan::parse(&with_step(&budget)).is_ok());
    let erase = ios_step("native", 10_000, r#""op":"eraseText","characters":0"#);
    assert!(plan::parse(&with_step(&erase)).is_ok(), "zero characters");
    let far = TAP.replace(r#"{"text":"Go"}"#, r#"{"text":"Go","index":4294967295}"#);
    assert!(plan::parse(&with_step(&far)).is_ok());
    let blank = TAP.replace(r#"{"text":"Go"}"#, r#"{"text":"   "}"#);
    assert!(
        plan::parse(&with_step(&blank)).is_ok(),
        "whitespace text is the resolver's concern"
    );
}

#[test]
fn numeric_values_outside_wire_bounds_refuse() {
    let cases = [
        TAP.replace("17000", "600001"),
        TAP.replace(r#""line":3"#, r#""line":4294967296"#),
        TAP.replace(r#"{"text":"Go"}"#, r#"{"text":"Go","index":4294967296}"#),
        ios_step("native", 10_000, r#""op":"eraseText","characters":10001"#),
        ios_step(
            "native",
            10_000,
            r#""op":"swipe","direction":"UP","durationMs":60001"#,
        ),
    ];
    for step in cases {
        assert!(plan::parse(&with_step(&step)).is_err(), "{step}");
    }
}

#[test]
fn refuses_what_the_contract_does_not_define() {
    let cases = [
        (
            "unknown step field",
            TAP.replace(r#""op":"tapOn""#, r#""op":"tapOn","retry":true"#),
        ),
        (
            "field of another op",
            TAP.replace(r#""op":"tapOn""#, r#""op":"tapOn","text":"x""#),
        ),
        ("unknown op", TAP.replace("tapOn", "travel")),
        ("mixed selector", TAP.replace(r#"{"text":"Go"}"#, r#"{"text":"Go","id":"go"}"#)),
        ("empty selector", TAP.replace(r#"{"text":"Go"}"#, "{}")),
        ("mutation off native", TAP.replace(r#""native""#, r#""react-tree""#)),
        ("unknown domain", TAP.replace(r#""native""#, r#""cdp""#)),
        ("zero budget on a lookup", TAP.replace("17000", "0")),
        ("negative budget", TAP.replace("17000", "-1")),
        ("fractional budget", TAP.replace("17000", "17000.5")),
        ("null index", TAP.replace(r#"{"text":"Go"}"#, r#"{"text":"Go","index":null}"#)),
        ("null id beside text", TAP.replace(r#"{"text":"Go"}"#, r#"{"text":"Go","id":null}"#)),
        ("null source file", TAP.replace(r#"{"line":3}"#, r#"{"line":3,"file":null}"#)),
        ("empty text", TAP.replace(r#"{"text":"Go"}"#, r#"{"text":""}"#)),
        (
            "optional on a typing step",
            ios_step("native", 10_000, r#""op":"inputText","text":"x""#)
                .replace(r#""optional":false"#, r#""optional":true"#),
        ),
        (
            "exact-id presence read off the React tree on iOS",
            ios_step("native", 17_000, r#""op":"assertVisible","selector":{"id":"x"}"#),
        ),
        (
            "indexed id read on the React tree",
            ios_step(
                "react-tree",
                17_000,
                r#""op":"assertVisible","selector":{"id":"x","index":0}"#,
            ),
        ),
        (
            "text read on the React tree",
            ios_step("react-tree", 17_000, r#""op":"assertVisible","selector":{"text":"x"}"#),
        ),
        (
            "absence read on the React tree",
            ios_step("react-tree", 7_000, r#""op":"assertNotVisible","selector":{"id":"x"}"#),
        ),
        (
            "lifecycle launch in the native domain",
            ios_step(
                "native",
                15_000,
                r#""op":"launchApp","stopApp":true,"clearState":false"#,
            ),
        ),
        (
            "foreground launch in the lifecycle domain",
            ios_step(
                "lifecycle",
                15_000,
                r#""op":"launchApp","stopApp":false,"clearState":false"#,
            ),
        ),
        (
            "runFlow with a polling budget",
            ios_step(
                "native",
                7_000,
                &format!(r#""op":"runFlow","when":{{"visible":{{"text":"Skip"}}}},"steps":[{TAP}]"#)
                    .replace(r#""id":"s1""#, r#""id":"s2""#),
            ),
        ),
        (
            "runFlow condition with both polarities",
            ios_step(
                "native",
                0,
                &format!(
                    r#""op":"runFlow","when":{{"visible":{{"text":"Skip"}},"notVisible":{{"text":"Skip"}}}},"steps":[{TAP}]"#
                )
                .replace(r#""id":"s1""#, r#""id":"s2""#),
            ),
        ),
        (
            "runFlow with an empty body",
            ios_step(
                "native",
                0,
                r#""op":"runFlow","when":{"visible":{"text":"Skip"}},"steps":[]"#,
            ),
        ),
        (
            "hideKeyboard with another fallback",
            ios_step("native", 10_000, r#""op":"hideKeyboard","fallbackDomain":"native""#),
        ),
    ];
    for (name, step) in cases {
        assert!(
            plan::parse(&with_step(&step)).is_err(),
            "{name} must refuse"
        );
    }
    let wrong_schema = with_step(TAP).replace("rn-flow/1", "rn-flow/2");
    assert!(plan::parse(&wrong_schema).is_err());
    let duplicate = with_step(&format!("{TAP},{TAP}"));
    assert!(plan::parse(&duplicate).is_err(), "step ids are unique");
    let android_tree = with_step(&ios_step(
        "react-tree",
        17_000,
        r#""op":"assertVisible","selector":{"id":"x"}"#,
    ))
    .replace(r#""ios""#, r#""android""#);
    assert!(
        plan::parse(&android_tree).is_err(),
        "react-tree is iOS only"
    );
    let unknown_header = with_step(TAP).replace(r#""appId""#, r#""bundle":"b","appId""#);
    assert!(
        plan::parse(&unknown_header).is_err(),
        "plan header is strict"
    );
}

#[test]
fn a_refusal_names_the_step() {
    let zero = TAP.replace("17000", "0");
    let error = plan::parse(&with_step(&zero)).unwrap_err().to_string();
    assert!(error.contains("s1"), "{error}");
    assert!(error.contains("budgetMs"), "{error}");
}

#[test]
fn typed_text_and_links_are_withheld_from_debug_output() {
    let plan = plan::parse(&with_step(&format!(
        "{},{}",
        ios_step("native", 10_000, r#""op":"inputText","text":"hunter2""#),
        ios_step(
            "lifecycle",
            15_000,
            r#""op":"openLink","link":"app://x?token=TOKEN-42""#
        )
        .replace(r#""id":"s1""#, r#""id":"s2""#)
    )))
    .unwrap();
    let shown = format!("{plan:?}");
    assert!(
        !shown.contains("hunter2") && !shown.contains("TOKEN-42"),
        "{shown}"
    );
    assert!(matches!(&plan.steps[0].op, Op::InputText(text) if text.as_str() == "hunter2"));
    assert_eq!(plan.steps[0].op.describe(), "inputText");
}
