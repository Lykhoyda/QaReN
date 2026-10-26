use crate::exec::Runner;
use crate::flow::interpret::{Capture, DriverError, DriverResult, NativeDriver};
use crate::flow::plan::{Key, Press};
use crate::flow::resolve::Snapshot;
use crate::native::client::{refused, Effect, RunnerClient};
use serde_json::{json, Value};

const LONG_PRESS_MS: u64 = 1_000;
const WINDOW_PROBE_MS: u64 = 500;
// ponytail: no double-tap, counted-erase, key or IME-aware dismissal verb yet, so those steps
// refuse until slice 6 adds `tap` count, `erase` characters and `pressKey` key, and binds `type`
// to the resolved target (`snapshotIdentifier`, `snapshotElementType`, bounds), not the focus.
const UNSUPPORTED: &str = "UNSUPPORTED_COMMAND";

// The Android runner over POST /command: flat UiAutomator snapshots, booleans that must be true.
#[derive(Debug)]
pub struct AndroidDriver {
    client: RunnerClient,
}

impl AndroidDriver {
    pub fn new(client: RunnerClient) -> AndroidDriver {
        AndroidDriver { client }
    }

    // A successful envelope still carries the gesture's own verdict; a false flag can follow a
    // partially injected gesture, so it proves nothing about the device.
    fn actuated(
        &mut self,
        runner: &mut dyn Runner,
        verb: &str,
        body: Value,
        flag: &str,
        window_ms: u64,
    ) -> DriverResult<()> {
        let data = self
            .client
            .command(runner, verb, Effect::Mutates, body, window_ms)?;
        match data[flag].as_bool() {
            Some(true) => Ok(()),
            _ => Err(DriverError::Unknown(format!(
                "{verb} did not confirm {flag}"
            ))),
        }
    }
}

impl NativeDriver for AndroidDriver {
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
        match press {
            Press::Tap => {
                self.actuated(runner, "tap", json!({"x": x, "y": y}), "tapped", window_ms)
            }
            Press::LongPress => self.actuated(
                runner,
                "longPress",
                json!({"x": x, "y": y, "durationMs": LONG_PRESS_MS}),
                "pressed",
                window_ms,
            ),
            Press::DoubleTap => Err(refused(
                UNSUPPORTED,
                "doubleTapOn: the Android runner has no double-tap verb",
            )),
        }
    }

    // The runner binds the focused input itself; an unverified set-text outcome is not a success.
    fn type_text(
        &mut self,
        runner: &mut dyn Runner,
        text: &str,
        window_ms: u64,
    ) -> DriverResult<()> {
        let data = self.client.command(
            runner,
            "type",
            Effect::Mutates,
            json!({"text": text}),
            window_ms,
        )?;
        match (data["typed"].as_bool(), data["setTextOutcome"].as_str()) {
            (Some(true), Some(outcome)) if outcome != "unverified" => Ok(()),
            (Some(true), Some(outcome)) => Err(DriverError::Unknown(format!(
                "type reported setTextOutcome {outcome}"
            ))),
            _ => Err(DriverError::Unknown(
                "type did not confirm typed and setTextOutcome".into(),
            )),
        }
    }

    fn erase(
        &mut self,
        _runner: &mut dyn Runner,
        characters: u64,
        _window_ms: u64,
    ) -> DriverResult<()> {
        Err(refused(
            UNSUPPORTED,
            &format!("eraseText {characters}: the Android runner has no counted erase verb"),
        ))
    }

    fn press_key(&mut self, runner: &mut dyn Runner, key: Key, window_ms: u64) -> DriverResult<()> {
        match key {
            Key::Back => self.back(runner, window_ms),
            Key::Enter => Err(refused(
                UNSUPPORTED,
                "pressKey Enter: the Android runner has no key verb",
            )),
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
            json!({"x1": from.0, "y1": from.1, "x2": to.0, "y2": to.1, "durationMs": duration_ms});
        self.actuated(runner, "drag", body, "dragged", window_ms)
    }

    fn back(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<()> {
        self.actuated(runner, "back", json!({}), "pressed", window_ms)
    }

    fn keyboard_dismiss(&mut self, _runner: &mut dyn Runner, _window_ms: u64) -> DriverResult<()> {
        Err(refused(
            UNSUPPORTED,
            "hideKeyboard: the Android runner cannot prove the keyboard state before pressing Back",
        ))
    }

    fn is_settled(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<bool> {
        let data = self.client.command(
            runner,
            "isWindowUpdating",
            Effect::Reads,
            json!({"timeoutMs": WINDOW_PROBE_MS.min(window_ms)}),
            window_ms,
        )?;
        data["updating"]
            .as_bool()
            .map(|updating| !updating)
            .ok_or_else(|| {
                refused(
                    "MALFORMED_REPLY",
                    "isWindowUpdating answered without `updating`",
                )
            })
    }

    fn screenshot(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<Capture> {
        let data =
            self.client
                .command(runner, "screenshot", Effect::Reads, json!({}), window_ms)?;
        match data["pngBase64"].as_str() {
            Some(png) if !png.is_empty() => Ok(Capture::PngBase64(png.to_string())),
            _ => Err(refused(
                "MALFORMED_REPLY",
                "screenshot answered without pngBase64",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::MockRunner;
    use crate::native::client::sent_body;
    use crate::native::ios::data;

    fn driver() -> AndroidDriver {
        AndroidDriver::new(RunnerClient::new(4711, "cap", "com.x", "run"))
    }

    fn body(runner: &MockRunner, i: usize) -> Value {
        sent_body(&runner.private_inputs[i])
    }

    #[test]
    fn a_gesture_is_only_clean_when_the_runner_confirms_it() {
        let mut runner = MockRunner::new();
        runner.expect_run("curl", data(json!({"tapped": true})));
        runner.expect_run("curl", data(json!({"tapped": false})));
        runner.expect_run("curl", data(json!({"message": "tap"})));
        runner.expect_run("curl", data(json!({"dragged": true})));
        runner.expect_run("curl", data(json!({"pressed": true})));
        runner.expect_run("curl", data(json!({"pressed": false})));
        let mut driver = driver();
        driver
            .press(&mut runner, Press::Tap, 1.0, 2.0, 1_000)
            .unwrap();
        for _ in 0..2 {
            assert!(matches!(
                driver.press(&mut runner, Press::Tap, 1.0, 2.0, 1_000),
                Err(DriverError::Unknown(why)) if why.contains("tapped")
            ));
        }
        driver
            .drag(&mut runner, (1.0, 2.0), (3.0, 4.0), 300, 1_000)
            .unwrap();
        driver.back(&mut runner, 1_000).unwrap();
        assert!(matches!(
            driver.press(&mut runner, Press::LongPress, 1.0, 2.0, 1_000),
            Err(DriverError::Unknown(_))
        ));
        let drag = body(&runner, 3);
        assert_eq!(
            (
                drag["command"].as_str(),
                drag["x1"].as_f64(),
                drag["y2"].as_f64(),
                drag["durationMs"].as_u64()
            ),
            (Some("drag"), Some(1.0), Some(4.0), Some(300))
        );
        assert_eq!(body(&runner, 5)["command"], "longPress");
    }

    #[test]
    fn unsupported_verbs_refuse_without_a_dispatch() {
        let mut runner = MockRunner::new();
        let mut driver = driver();
        let unsupported = |result: DriverResult<()>| matches!(result, Err(DriverError::Refused { code, .. }) if code == UNSUPPORTED);
        assert!(unsupported(driver.press(
            &mut runner,
            Press::DoubleTap,
            1.0,
            2.0,
            1_000
        )));
        assert!(unsupported(driver.erase(&mut runner, 5, 1_000)));
        assert!(unsupported(driver.press_key(
            &mut runner,
            Key::Enter,
            1_000
        )));
        assert!(unsupported(driver.keyboard_dismiss(&mut runner, 1_000)));
        assert!(runner.calls.is_empty());
    }

    #[test]
    fn typing_trusts_only_a_verified_set_text_outcome() {
        let mut runner = MockRunner::new();
        runner.expect_run("curl", data(json!({"typed": true, "method": "setText", "setTextOutcome": "verified", "focusTap": "skipped-exact-focused", "inputResolution": "focused"})));
        runner.expect_run(
            "curl",
            data(json!({"typed": true, "method": "setText", "setTextOutcome": "unverified"})),
        );
        runner.expect_run("curl", data(json!({"message": "typed"})));
        let mut driver = driver();
        driver.type_text(&mut runner, "hello", 1_000).unwrap();
        assert!(matches!(
            driver.type_text(&mut runner, "hello", 1_000),
            Err(DriverError::Unknown(why)) if why.contains("unverified")
        ));
        assert!(matches!(
            driver.type_text(&mut runner, "hello", 1_000),
            Err(DriverError::Unknown(_))
        ));
        let typed = body(&runner, 0);
        assert_eq!(
            (typed["command"].as_str(), typed["text"].as_str()),
            (Some("type"), Some("hello"))
        );
        assert!(typed.get("focused").is_none() && typed.get("exactIdentifier").is_none());
    }

    #[test]
    fn settling_screenshots_and_snapshots_use_the_android_shapes() {
        let mut runner = MockRunner::new();
        runner.expect_run("curl", data(json!({"updating": true})));
        runner.expect_run("curl", data(json!({"pngBase64": "iVBORw0KGgo="})));
        runner.expect_run(
            "curl",
            data(json!({"nodes": [{"index": 0, "type": "android.widget.FrameLayout", "label": "", "identifier": "", "rect": {"x": 0, "y": 0, "width": 1080, "height": 2400}}]})),
        );
        let mut driver = driver();
        assert_eq!(driver.is_settled(&mut runner, 1_000), Ok(false));
        assert_eq!(
            driver.screenshot(&mut runner, 1_000),
            Ok(Capture::PngBase64("iVBORw0KGgo=".into()))
        );
        let snapshot = driver.snapshot(&mut runner, 1_000).unwrap();
        assert_eq!(snapshot.nodes[0].parent, None);
        let probe = body(&runner, 0);
        assert_eq!(
            (probe["command"].as_str(), probe["timeoutMs"].as_u64()),
            (Some("isWindowUpdating"), Some(500))
        );
    }

    #[test]
    fn settle_probe_never_outlasts_the_supplied_window() {
        let mut runner = MockRunner::new();
        runner.expect_run("curl", data(json!({"updating": false})));
        let mut driver = driver();
        assert_eq!(driver.is_settled(&mut runner, 1), Ok(true));
        assert_eq!(body(&runner, 0)["timeoutMs"], 1);
    }
}
