use crate::exec::Runner;
use crate::flow::interpret::{Capture, DriverResult, NativeDriver};
use crate::flow::plan::{Key, Press};
use crate::flow::resolve::Snapshot;
use crate::native::client::{refused, Effect, RunnerClient};
use serde_json::json;

const LONG_PRESS_MS: u64 = 1_000;
// The XCUIKeyboardKey.delete character the runner types.
const BACKSPACE: char = '\u{8}';
// Each backspace costs three bytes on the quoted wire; this keeps the request far inside the
// 16 MiB private-input ceiling instead of allocating first and failing later.
const MAX_ERASE: u64 = 1_000_000;

// The iOS runner over POST /command: verbs from its CommandType enum, coordinates in points.
#[derive(Debug)]
pub struct IosDriver {
    client: RunnerClient,
}

impl IosDriver {
    pub fn new(client: RunnerClient) -> IosDriver {
        IosDriver { client }
    }

    fn focused_type(
        &mut self,
        runner: &mut dyn Runner,
        text: &str,
        window_ms: u64,
    ) -> DriverResult<()> {
        self.mutate(
            runner,
            "type",
            json!({"text": text, "focused": true}),
            window_ms,
        )
    }

    fn mutate(
        &mut self,
        runner: &mut dyn Runner,
        verb: &str,
        body: serde_json::Value,
        window_ms: u64,
    ) -> DriverResult<()> {
        self.client
            .command(runner, verb, Effect::Mutates, body, window_ms)
            .map(|_| ())
    }
}

impl NativeDriver for IosDriver {
    fn snapshot(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<Snapshot> {
        let data = self
            .client
            .command(runner, "snapshot", Effect::Reads, json!({}), window_ms)?;
        Snapshot::from_data(&data).map_err(|why| refused("SNAPSHOT_UNUSABLE", &why))
    }

    fn press(
        &mut self,
        runner: &mut dyn Runner,
        press: Press,
        x: f64,
        y: f64,
        window_ms: u64,
    ) -> DriverResult<()> {
        let (verb, body) = match press {
            Press::Tap => ("tap", json!({"x": x, "y": y})),
            Press::DoubleTap => (
                "tapSeries",
                json!({"x": x, "y": y, "count": 1, "doubleTap": true}),
            ),
            Press::LongPress => (
                "longPress",
                json!({"x": x, "y": y, "durationMs": LONG_PRESS_MS}),
            ),
        };
        self.mutate(runner, verb, body, window_ms)
    }

    fn type_text(
        &mut self,
        runner: &mut dyn Runner,
        text: &str,
        window_ms: u64,
    ) -> DriverResult<()> {
        self.focused_type(runner, text, window_ms)
    }

    fn erase(
        &mut self,
        runner: &mut dyn Runner,
        characters: u64,
        window_ms: u64,
    ) -> DriverResult<()> {
        if characters > MAX_ERASE {
            return Err(refused(
                "REQUEST_TOO_LARGE",
                &format!("eraseText {characters} exceeds the {MAX_ERASE}-character wire limit"),
            ));
        }
        let deletes: String = std::iter::repeat_n(BACKSPACE, characters as usize).collect();
        self.focused_type(runner, &deletes, window_ms)
    }

    fn press_key(&mut self, runner: &mut dyn Runner, key: Key, window_ms: u64) -> DriverResult<()> {
        match key {
            Key::Enter => self.focused_type(runner, "\n", window_ms),
            Key::Back => self.back(runner, window_ms),
        }
    }

    fn drag(
        &mut self,
        runner: &mut dyn Runner,
        from: (f64, f64),
        to: (f64, f64),
        duration_ms: u64,
        window_ms: u64,
    ) -> DriverResult<()> {
        let body =
            json!({"x": from.0, "y": from.1, "x2": to.0, "y2": to.1, "durationMs": duration_ms});
        self.mutate(runner, "drag", body, window_ms)
    }

    fn back(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<()> {
        self.mutate(runner, "back", json!({}), window_ms)
    }

    fn keyboard_dismiss(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<()> {
        self.mutate(runner, "keyboardDismiss", json!({}), window_ms)
    }

    fn is_settled(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<bool> {
        let data = self.client.command(
            runner,
            "isScreenStatic",
            Effect::Reads,
            json!({}),
            window_ms,
        )?;
        data["static"].as_bool().ok_or_else(|| {
            refused(
                "MALFORMED_REPLY",
                "isScreenStatic answered without `static`",
            )
        })
    }

    fn screenshot(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<Capture> {
        let data =
            self.client
                .command(runner, "screenshot", Effect::Reads, json!({}), window_ms)?;
        match data["message"].as_str() {
            Some(path) if !path.is_empty() => Ok(Capture::RunnerPath(path.to_string())),
            _ => Err(refused(
                "MALFORMED_REPLY",
                "screenshot answered without a path",
            )),
        }
    }
}

#[cfg(test)]
pub(crate) fn data(value: serde_json::Value) -> crate::exec::CmdOutput {
    crate::exec::CmdOutput::success(&json!({"ok": true, "data": value, "v": 2}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::MockRunner;
    use crate::flow::interpret::DriverError;
    use crate::native::client::sent_body;
    use serde_json::Value;

    fn driver() -> IosDriver {
        IosDriver::new(RunnerClient::new(4711, "cap", "com.x", "run"))
    }

    fn body(runner: &MockRunner, i: usize) -> Value {
        sent_body(&runner.private_inputs[i])
    }

    #[test]
    fn presses_map_to_the_runner_verbs() {
        let mut runner = MockRunner::new();
        for _ in 0..3 {
            runner.expect_run("curl", data(json!({"message": "ok"})));
        }
        let mut driver = driver();
        driver
            .press(&mut runner, Press::Tap, 10.5, 20.0, 1_000)
            .unwrap();
        driver
            .press(&mut runner, Press::DoubleTap, 10.0, 20.0, 1_000)
            .unwrap();
        driver
            .press(&mut runner, Press::LongPress, 10.0, 20.0, 1_000)
            .unwrap();
        let tap = body(&runner, 0);
        assert_eq!(
            (tap["command"].as_str(), tap["x"].as_f64()),
            (Some("tap"), Some(10.5))
        );
        let double = body(&runner, 1);
        assert_eq!(double["command"], "tapSeries");
        assert_eq!(
            (double["count"].as_u64(), double["doubleTap"].as_bool()),
            (Some(1), Some(true))
        );
        let long = body(&runner, 2);
        assert_eq!(
            (long["command"].as_str(), long["durationMs"].as_u64()),
            (Some("longPress"), Some(1_000))
        );
    }

    #[test]
    fn typing_erasing_and_enter_go_to_the_first_responder() {
        let mut runner = MockRunner::new();
        for _ in 0..4 {
            runner.expect_run("curl", data(json!({"message": "typed"})));
        }
        let mut driver = driver();
        driver.type_text(&mut runner, "hello", 1_000).unwrap();
        driver.erase(&mut runner, 3, 1_000).unwrap();
        driver.press_key(&mut runner, Key::Enter, 1_000).unwrap();
        driver.erase(&mut runner, 10_001, 1_000).unwrap();
        let typed = body(&runner, 0);
        assert_eq!(
            (
                typed["command"].as_str(),
                typed["text"].as_str(),
                typed["focused"].as_bool()
            ),
            (Some("type"), Some("hello"), Some(true))
        );
        assert_eq!(body(&runner, 1)["text"], "\u{8}\u{8}\u{8}");
        assert_eq!(body(&runner, 2)["text"], "\n");
        assert_eq!(
            body(&runner, 3)["text"].as_str().unwrap().chars().count(),
            10_001
        );
        assert!(matches!(
            driver.erase(&mut runner, MAX_ERASE + 1, 1_000),
            Err(DriverError::Refused { code, .. }) if code == "REQUEST_TOO_LARGE"
        ));
        assert_eq!(
            runner.private_inputs.len(),
            4,
            "the oversized erase was never sent"
        );
    }

    #[test]
    fn snapshots_reads_and_screenshots_decode_their_replies() {
        let mut runner = MockRunner::new();
        runner.expect_run(
            "curl",
            data(json!({"nodes": [{"index": 0, "type": "Application", "rect": {"x": 0, "y": 0, "width": 390, "height": 844}}], "truncated": true})),
        );
        runner.expect_run("curl", data(json!({"nodes": []})));
        runner.expect_run("curl", data(json!({"static": false})));
        runner.expect_run("curl", data(json!({"message": "tmp/screenshot-1.png"})));
        runner.expect_run("curl", data(json!({"message": ""})));
        let mut driver = driver();
        let snapshot = driver.snapshot(&mut runner, 1_000).unwrap();
        assert!(snapshot.truncated && snapshot.nodes.len() == 1);
        assert!(matches!(
            driver.snapshot(&mut runner, 1_000),
            Err(DriverError::Refused { code, .. }) if code == "SNAPSHOT_UNUSABLE"
        ));
        assert_eq!(driver.is_settled(&mut runner, 1_000), Ok(false));
        assert_eq!(
            driver.screenshot(&mut runner, 1_000),
            Ok(Capture::RunnerPath("tmp/screenshot-1.png".into()))
        );
        assert!(driver.screenshot(&mut runner, 1_000).is_err());
        assert_eq!(body(&runner, 2)["command"], "isScreenStatic");
    }

    #[test]
    fn drags_back_and_keyboard_dismissal_carry_the_ios_shapes() {
        let mut runner = MockRunner::new();
        for _ in 0..3 {
            runner.expect_run("curl", data(json!({"message": "ok"})));
        }
        let mut driver = driver();
        driver
            .drag(&mut runner, (1.0, 2.0), (3.0, 4.0), 250, 1_000)
            .unwrap();
        driver.back(&mut runner, 1_000).unwrap();
        driver.keyboard_dismiss(&mut runner, 1_000).unwrap();
        let drag = body(&runner, 0);
        assert_eq!(drag["command"], "drag");
        assert_eq!(
            (
                drag["x"].as_f64(),
                drag["y"].as_f64(),
                drag["x2"].as_f64(),
                drag["y2"].as_f64(),
                drag["durationMs"].as_u64()
            ),
            (Some(1.0), Some(2.0), Some(3.0), Some(4.0), Some(250))
        );
        assert_eq!(body(&runner, 1)["command"], "back");
        assert_eq!(body(&runner, 2)["command"], "keyboardDismiss");
    }
}
