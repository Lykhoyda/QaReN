use crate::scenario::Platform;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashSet;

pub const PLAN_SCHEMA: &str = "rn-flow/1";
// Wire safeguards shared with core.rs; every semantic bound belongs to the compiler.
const MAX_PLAN_BYTES: usize = 4 * 1024 * 1024;
const MAX_STEPS: usize = 10_000;
const MAX_DEPTH: usize = 5;
const MAX_BUDGET_MS: u64 = 600_000;
const MAX_SWIPE_MS: u64 = 60_000;
const MAX_ERASE_CHARACTERS: u64 = 10_000;
const BASE_KEYS: [&str; 5] = ["id", "source", "domain", "optional", "budgetMs"];

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub action_id: String,
    pub app_id: String,
    pub platform: Platform,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub id: String,
    pub source: Source,
    pub domain: Domain,
    pub optional: bool,
    // 0 means one observation, never a poll.
    pub budget_ms: u64,
    pub op: Op,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub line: u64,
    #[serde(default)]
    pub file: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Domain {
    Native,
    ReactTree,
    Lifecycle,
}

impl Domain {
    pub fn as_str(self) -> &'static str {
        match self {
            Domain::Native => "native",
            Domain::ReactTree => "react-tree",
            Domain::Lifecycle => "lifecycle",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Key {
    Enter,
    Back,
}

// A value the run types or opens; Debug and rows withhold it.
#[derive(Clone, PartialEq, Eq)]
pub struct Private(pub String);

impl Private {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Private {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[withheld]")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Id(String),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selector {
    pub target: Target,
    pub index: Option<usize>,
}

impl Selector {
    pub fn describe(&self) -> String {
        let target = match &self.target {
            Target::Id(id) => format!("id {id:?}"),
            Target::Text(text) => format!("text {text:?}"),
        };
        match self.index {
            Some(index) => format!("{target} index {index}"),
            None => target,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Condition {
    Visible(Selector),
    NotVisible(Selector),
}

impl Condition {
    pub fn selector(&self) -> &Selector {
        match self {
            Condition::Visible(selector) | Condition::NotVisible(selector) => selector,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Press {
    Tap,
    DoubleTap,
    LongPress,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    LaunchApp {
        stop_app: bool,
        clear_state: bool,
    },
    Press(Press, Selector),
    AssertVisible(Selector),
    AssertNotVisible(Selector),
    ScrollUntilVisible {
        selector: Selector,
        direction: Direction,
    },
    InputText(Private),
    EraseText(u64),
    HideKeyboard,
    PressKey(Key),
    Swipe {
        direction: Direction,
        from: Option<Selector>,
        duration_ms: u64,
    },
    Back,
    Scroll,
    WaitForAnimationToEnd,
    StopApp,
    KillApp,
    ClearState,
    TakeScreenshot(String),
    OpenLink(Private),
    RunFlow {
        when: Condition,
        steps: Vec<Step>,
    },
}

impl Op {
    pub fn name(&self) -> &'static str {
        match self {
            Op::LaunchApp { .. } => "launchApp",
            Op::Press(Press::Tap, _) => "tapOn",
            Op::Press(Press::DoubleTap, _) => "doubleTapOn",
            Op::Press(Press::LongPress, _) => "longPressOn",
            Op::AssertVisible(_) => "assertVisible",
            Op::AssertNotVisible(_) => "assertNotVisible",
            Op::ScrollUntilVisible { .. } => "scrollUntilVisible",
            Op::InputText(_) => "inputText",
            Op::EraseText(_) => "eraseText",
            Op::HideKeyboard => "hideKeyboard",
            Op::PressKey(_) => "pressKey",
            Op::Swipe { .. } => "swipe",
            Op::Back => "back",
            Op::Scroll => "scroll",
            Op::WaitForAnimationToEnd => "waitForAnimationToEnd",
            Op::StopApp => "stopApp",
            Op::KillApp => "killApp",
            Op::ClearState => "clearState",
            Op::TakeScreenshot(_) => "takeScreenshot",
            Op::OpenLink(_) => "openLink",
            Op::RunFlow { .. } => "runFlow",
        }
    }

    // What a trace row may say about the step; typed text never appears.
    pub fn describe(&self) -> String {
        match self {
            Op::Press(_, selector)
            | Op::AssertVisible(selector)
            | Op::AssertNotVisible(selector)
            | Op::ScrollUntilVisible { selector, .. } => {
                format!("{} {}", self.name(), selector.describe())
            }
            Op::Swipe {
                direction,
                from: Some(from),
                ..
            } => format!("swipe {direction:?} from {}", from.describe()),
            Op::Swipe { direction, .. } => format!("swipe {direction:?}"),
            Op::EraseText(characters) => format!("eraseText {characters}"),
            Op::PressKey(key) => format!("pressKey {key:?}"),
            Op::TakeScreenshot(name) => format!("takeScreenshot {name:?}"),
            Op::RunFlow { when, .. } => {
                let (polarity, selector) = match when {
                    Condition::Visible(selector) => ("visible", selector),
                    Condition::NotVisible(selector) => ("notVisible", selector),
                };
                format!("runFlow when {polarity} {}", selector.describe())
            }
            _ => self.name().to_string(),
        }
    }

    fn supports_optional(&self) -> bool {
        matches!(
            self,
            Op::Press(..) | Op::AssertVisible(_) | Op::AssertNotVisible(_)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanError(pub String);

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PlanError {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawPlan {
    schema: String,
    action_id: String,
    app_id: String,
    platform: Platform,
    steps: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawBase {
    id: String,
    source: Source,
    domain: Domain,
    optional: bool,
    budget_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSelector {
    id: Option<String>,
    text: Option<String>,
    index: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawCondition {
    visible: Option<RawSelector>,
    not_visible: Option<RawSelector>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum RawOp {
    #[serde(rename_all = "camelCase")]
    LaunchApp {
        stop_app: bool,
        clear_state: bool,
    },
    TapOn {
        selector: RawSelector,
    },
    DoubleTapOn {
        selector: RawSelector,
    },
    LongPressOn {
        selector: RawSelector,
    },
    AssertVisible {
        selector: RawSelector,
    },
    AssertNotVisible {
        selector: RawSelector,
    },
    ScrollUntilVisible {
        selector: RawSelector,
        direction: Direction,
    },
    InputText {
        text: String,
    },
    EraseText {
        characters: u64,
    },
    #[serde(rename_all = "camelCase")]
    HideKeyboard {
        fallback_domain: Domain,
    },
    PressKey {
        key: Key,
    },
    #[serde(rename_all = "camelCase")]
    Swipe {
        direction: Direction,
        from: Option<RawSelector>,
        duration_ms: u64,
    },
    Back {},
    Scroll {},
    WaitForAnimationToEnd {},
    StopApp {},
    KillApp {},
    ClearState {},
    TakeScreenshot {
        name: String,
    },
    OpenLink {
        link: String,
    },
    RunFlow {
        when: RawCondition,
        steps: Vec<Value>,
    },
}

pub fn parse(text: &str) -> Result<Plan, PlanError> {
    if text.len() > MAX_PLAN_BYTES {
        return Err(PlanError(format!("plan exceeds {MAX_PLAN_BYTES} bytes")));
    }
    let document: Value =
        serde_json::from_str(text).map_err(|e| PlanError(format!("plan: {e}")))?;
    reject_nulls(&document, "plan")?;
    let raw: RawPlan =
        serde_json::from_value(document).map_err(|e| PlanError(format!("plan: {e}")))?;
    if raw.schema != PLAN_SCHEMA {
        return Err(PlanError(format!(
            "schema {:?} is not {PLAN_SCHEMA}",
            raw.schema
        )));
    }
    non_empty(&raw.action_id, "actionId")?;
    non_empty(&raw.app_id, "appId")?;
    let mut context = Context {
        platform: raw.platform,
        ids: HashSet::new(),
    };
    let steps = context.steps(raw.steps, 0)?;
    Ok(Plan {
        action_id: raw.action_id,
        app_id: raw.app_id,
        platform: raw.platform,
        steps,
    })
}

// The compiler's plan types have no nullable field, so a null is never "absent".
fn reject_nulls(value: &Value, path: &str) -> Result<(), PlanError> {
    match value {
        Value::Null => Err(PlanError(format!("{path} is null"))),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .try_for_each(|(i, item)| reject_nulls(item, &format!("{path}[{i}]"))),
        Value::Object(fields) => fields
            .iter()
            .try_for_each(|(key, field)| reject_nulls(field, &format!("{path}.{key}"))),
        _ => Ok(()),
    }
}

struct Context {
    platform: Platform,
    ids: HashSet<String>,
}

impl Context {
    fn steps(&mut self, raw: Vec<Value>, depth: usize) -> Result<Vec<Step>, PlanError> {
        if raw.is_empty() {
            return Err(PlanError("a step list is empty".into()));
        }
        if depth > MAX_DEPTH {
            return Err(PlanError(format!("runFlow nests past {MAX_DEPTH} levels")));
        }
        raw.into_iter()
            .map(|value| self.step(value, depth))
            .collect()
    }

    fn step(&mut self, value: Value, depth: usize) -> Result<Step, PlanError> {
        let Value::Object(mut fields) = value else {
            return Err(PlanError("a step is not an object".into()));
        };
        let mut base = Map::new();
        for key in BASE_KEYS {
            if let Some(field) = fields.remove(key) {
                base.insert(key.to_string(), field);
            }
        }
        let base: RawBase = serde_json::from_value(Value::Object(base))
            .map_err(|e| PlanError(format!("step: {e}")))?;
        let refuse = |why: String| PlanError(format!("step {}: {why}", base.id));
        non_empty(&base.id, "step id")?;
        if !self.ids.insert(base.id.clone()) {
            return Err(refuse("duplicate step id".into()));
        }
        if self.ids.len() > MAX_STEPS {
            return Err(PlanError(format!("plan exceeds {MAX_STEPS} steps")));
        }
        let raw: RawOp =
            serde_json::from_value(Value::Object(fields)).map_err(|e| refuse(e.to_string()))?;
        let op = self.op(raw, depth).map_err(|e| refuse(e.0))?;
        let one_observation = matches!(op, Op::RunFlow { .. });
        if one_observation != (base.budget_ms == 0) {
            return Err(refuse(if one_observation {
                "a runFlow condition is one observation: budgetMs must be 0".into()
            } else {
                "budgetMs must be positive".into()
            }));
        }
        if base.budget_ms > MAX_BUDGET_MS {
            return Err(refuse(format!("budgetMs exceeds {MAX_BUDGET_MS}")));
        }
        if base.source.line > u32::MAX as u64 {
            return Err(refuse("source line exceeds u32".into()));
        }
        if base.optional && !op.supports_optional() {
            return Err(refuse(format!(
                "{} cannot be optional; only taps and assertions can",
                op.name()
            )));
        }
        let expected = expected_domain(&op, self.platform);
        if base.domain != expected {
            return Err(refuse(format!(
                "{} runs in the {} domain on {:?}, not {}",
                op.name(),
                expected.as_str(),
                self.platform,
                base.domain.as_str()
            )));
        }
        Ok(Step {
            id: base.id,
            source: base.source,
            domain: base.domain,
            optional: base.optional,
            budget_ms: base.budget_ms,
            op,
        })
    }

    fn op(&mut self, raw: RawOp, depth: usize) -> Result<Op, PlanError> {
        Ok(match raw {
            RawOp::LaunchApp {
                stop_app,
                clear_state,
            } => Op::LaunchApp {
                stop_app,
                clear_state,
            },
            RawOp::TapOn { selector } => Op::Press(Press::Tap, selector_of(selector)?),
            RawOp::DoubleTapOn { selector } => Op::Press(Press::DoubleTap, selector_of(selector)?),
            RawOp::LongPressOn { selector } => Op::Press(Press::LongPress, selector_of(selector)?),
            RawOp::AssertVisible { selector } => Op::AssertVisible(selector_of(selector)?),
            RawOp::AssertNotVisible { selector } => Op::AssertNotVisible(selector_of(selector)?),
            RawOp::ScrollUntilVisible {
                selector,
                direction,
            } => Op::ScrollUntilVisible {
                selector: selector_of(selector)?,
                direction,
            },
            RawOp::InputText { text } => {
                non_empty(&text, "text")?;
                Op::InputText(Private(text))
            }
            RawOp::EraseText { characters } => {
                if characters > MAX_ERASE_CHARACTERS {
                    return Err(PlanError(format!(
                        "characters exceeds {MAX_ERASE_CHARACTERS}"
                    )));
                }
                Op::EraseText(characters)
            }
            RawOp::HideKeyboard {
                fallback_domain: Domain::ReactTree,
            } => Op::HideKeyboard,
            RawOp::HideKeyboard { .. } => {
                return Err(PlanError(
                    "hideKeyboard falls back to react-tree only".into(),
                ))
            }
            RawOp::PressKey { key } => Op::PressKey(key),
            RawOp::Swipe {
                direction,
                from,
                duration_ms,
            } => {
                if duration_ms > MAX_SWIPE_MS {
                    return Err(PlanError(format!("durationMs exceeds {MAX_SWIPE_MS}")));
                }
                Op::Swipe {
                    direction,
                    from: from.map(selector_of).transpose()?,
                    duration_ms,
                }
            }
            RawOp::Back {} => Op::Back,
            RawOp::Scroll {} => Op::Scroll,
            RawOp::WaitForAnimationToEnd {} => Op::WaitForAnimationToEnd,
            RawOp::StopApp {} => Op::StopApp,
            RawOp::KillApp {} => Op::KillApp,
            RawOp::ClearState {} => Op::ClearState,
            RawOp::TakeScreenshot { name } => {
                non_empty(&name, "name")?;
                Op::TakeScreenshot(name)
            }
            RawOp::OpenLink { link } => {
                non_empty(&link, "link")?;
                Op::OpenLink(Private(link))
            }
            RawOp::RunFlow { when, steps } => {
                let when = match (when.visible, when.not_visible) {
                    (Some(selector), None) => Condition::Visible(selector_of(selector)?),
                    (None, Some(selector)) => Condition::NotVisible(selector_of(selector)?),
                    _ => {
                        return Err(PlanError(
                            "runFlow.when needs exactly one of visible or notVisible".into(),
                        ))
                    }
                };
                Op::RunFlow {
                    when,
                    steps: self.steps(steps, depth + 1)?,
                }
            }
        })
    }
}

fn selector_of(raw: RawSelector) -> Result<Selector, PlanError> {
    let target = match (raw.id, raw.text) {
        (Some(id), None) => {
            non_empty(&id, "id")?;
            Target::Id(id)
        }
        (None, Some(text)) => {
            non_empty(&text, "text")?;
            Target::Text(text)
        }
        _ => {
            return Err(PlanError(
                "a selector needs exactly one of id or text".into(),
            ))
        }
    };
    let index = raw
        .index
        .map(|index| {
            u32::try_from(index)
                .map(|value| value as usize)
                .map_err(|_| PlanError(format!("index {index} exceeds u32")))
        })
        .transpose()?;
    Ok(Selector { target, index })
}

fn non_empty(value: &str, what: &str) -> Result<(), PlanError> {
    if value.is_empty() {
        return Err(PlanError(format!("{what} is empty")));
    }
    Ok(())
}

// The compiler's routing: exact-id presence reads on iOS are the React tree's, absence and
// everything indexed or textual is native, and only the steps a user cannot perform are lifecycle.
fn expected_domain(op: &Op, platform: Platform) -> Domain {
    let tree_read = |selector: &Selector| {
        platform == Platform::Ios
            && selector.index.is_none()
            && matches!(selector.target, Target::Id(_))
    };
    match op {
        Op::AssertVisible(selector)
        | Op::RunFlow {
            when: Condition::Visible(selector),
            ..
        } if tree_read(selector) => Domain::ReactTree,
        Op::LaunchApp {
            stop_app: false,
            clear_state: false,
        } => Domain::Native,
        Op::LaunchApp { .. } | Op::StopApp | Op::KillApp | Op::ClearState | Op::OpenLink(_) => {
            Domain::Lifecycle
        }
        _ => Domain::Native,
    }
}
