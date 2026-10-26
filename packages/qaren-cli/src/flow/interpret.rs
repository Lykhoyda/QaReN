use crate::exec::Runner;
use crate::flow::plan::{Key, Press};
use crate::flow::resolve::Snapshot;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriverError {
    // The request never reached the runner, so a mutation failed cleanly.
    Unsent(String),
    // Sent, but nothing proved the outcome: a timeout, a malformed reply, or a refusal without proof that nothing mutated.
    Unknown(String),
    // The runner answered ok:false and proved it did not mutate; the message is the engine's own text.
    Refused { code: String, message: String },
}

impl std::fmt::Display for DriverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DriverError::Unsent(why) => write!(f, "not sent: {why}"),
            DriverError::Unknown(why) => write!(f, "outcome unknown: {why}"),
            DriverError::Refused { code, message } if message.is_empty() => f.write_str(code),
            DriverError::Refused { code, message } => write!(f, "{code}: {message}"),
        }
    }
}

pub type DriverResult<T> = Result<T, DriverError>;

// What a runner hands back for a screenshot; the run owner materialises it later.
#[derive(Clone, PartialEq, Eq)]
pub enum Capture {
    PngBase64(String),
    RunnerPath(String),
}

impl std::fmt::Debug for Capture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Capture::PngBase64(png) => write!(f, "PngBase64({} bytes)", png.len()),
            Capture::RunnerPath(_) => f.write_str("RunnerPath([withheld])"),
        }
    }
}

// Every call takes the runner it reaches the device through and the transport window it may use.
pub trait NativeDriver {
    fn snapshot(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<Snapshot>;
    fn press(
        &mut self,
        runner: &mut dyn Runner,
        press: Press,
        x: f64,
        y: f64,
        window_ms: u64,
    ) -> DriverResult<()>;
    fn type_text(
        &mut self,
        runner: &mut dyn Runner,
        text: &str,
        window_ms: u64,
    ) -> DriverResult<()>;
    fn erase(
        &mut self,
        runner: &mut dyn Runner,
        characters: u64,
        window_ms: u64,
    ) -> DriverResult<()>;
    fn press_key(&mut self, runner: &mut dyn Runner, key: Key, window_ms: u64) -> DriverResult<()>;
    fn drag(
        &mut self,
        runner: &mut dyn Runner,
        from: (f64, f64),
        to: (f64, f64),
        duration_ms: u64,
        window_ms: u64,
    ) -> DriverResult<()>;
    fn back(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<()>;
    fn keyboard_dismiss(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<()>;
    fn is_settled(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<bool>;
    fn screenshot(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<Capture>;
}
