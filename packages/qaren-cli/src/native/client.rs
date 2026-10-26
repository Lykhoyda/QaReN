use crate::exec::{CmdSpec, PrivateOutput, Runner};
use crate::flow::interpret::{DriverError, DriverResult};
use serde_json::{json, Value};

// curl exits proving the request never left: bad invocation, bad URL, unresolved host, connect refused.
const UNSENT_EXITS: [i32; 4] = [2, 3, 6, 7];
const RUNNER_PROTOCOL_VERSION: u64 = 2;

// Whether a verb can change device state; a refusal without mutation evidence is only clean for a read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    Reads,
    Mutates,
}

// The runner endpoint the core child handed over; it lives in memory only and never in argv or logs.
pub struct RunnerClient {
    port: u16,
    capability: String,
    app_id: String,
    run_id: String,
    next_command: u64,
}

impl std::fmt::Debug for RunnerClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "RunnerClient {{ port: {}, capability: [withheld], app_id: {:?}, run_id: {:?} }}",
            self.port, self.app_id, self.run_id
        )
    }
}

impl RunnerClient {
    pub fn new(port: u16, capability: &str, app_id: &str, run_id: &str) -> RunnerClient {
        RunnerClient {
            port,
            capability: capability.to_string(),
            app_id: app_id.to_string(),
            run_id: run_id.to_string(),
            next_command: 0,
        }
    }

    // One POST /command; the whole request rides on curl's stdin so neither the capability
    // nor typed text reaches argv, and only the runner's reply comes back.
    pub fn command(
        &mut self,
        runner: &mut dyn Runner,
        verb: &str,
        effect: Effect,
        mut body: Value,
        window_ms: u64,
    ) -> DriverResult<Value> {
        self.next_command += 1;
        body["command"] = json!(verb);
        body["commandId"] = json!(format!("{}-{}", self.run_id, self.next_command));
        body["appBundleId"] = json!(self.app_id);
        let config = curl_config(self.port, &self.capability, &body.to_string(), window_ms);
        let spec = CmdSpec::new(
            "runner-command",
            "curl",
            &["-q", "--config", "-"],
            window_ms.div_ceil(1000) + 2,
        );
        classify(verb, effect, &runner.run_private(&spec, config.as_bytes()))
    }
}

// `-q` keeps ~/.curlrc out; noproxy keeps the capability on loopback.
fn curl_config(port: u16, capability: &str, body: &str, window_ms: u64) -> String {
    format!(
        "url = \"http://127.0.0.1:{port}/command\"\nrequest = \"POST\"\nnoproxy = \"*\"\nsilent\nmax-time = {}.{:03}\nheader = \"Content-Type: application/json\"\nheader = \"Authorization: Bearer {}\"\ndata = \"{}\"\n",
        window_ms / 1000,
        window_ms % 1000,
        quote(capability),
        quote(body)
    )
}

// Inside curl's double quotes only backslash and the quote itself are special.
fn quote(raw: &str) -> String {
    raw.replace('\\', "\\\\").replace('"', "\\\"")
}

// Runner messages are private diagnostics that may echo screen content; only codes leave here.
fn classify(verb: &str, effect: Effect, output: &PrivateOutput) -> DriverResult<Value> {
    let unknown = |why: &str| DriverError::Unknown(format!("{verb}: {why}"));
    if output.timed_out() {
        return Err(unknown("no reply within the window"));
    }
    match output.exit_code() {
        Some(0) => {}
        Some(code) if UNSENT_EXITS.contains(&code) => {
            return Err(DriverError::Unsent(format!("{verb}: curl exit {code}")))
        }
        Some(code) => return Err(unknown(&format!("curl exit {code}"))),
        None => return Err(unknown("curl ended by a signal")),
    }
    let reply: Value =
        serde_json::from_str(output.stdout()).map_err(|_| unknown("malformed reply"))?;
    if reply["v"].as_u64() != Some(RUNNER_PROTOCOL_VERSION) {
        return Err(unknown("incompatible runner protocol version"));
    }
    match reply["ok"].as_bool() {
        Some(true) if reply["data"].is_object() => return Ok(reply["data"].clone()),
        Some(true) => return Err(unknown("reply carries no data object")),
        Some(false) if reply["error"].is_object() => {}
        _ => return Err(unknown("malformed reply envelope")),
    }
    let error = &reply["error"];
    let code = error["code"]
        .as_str()
        .filter(|c| !c.is_empty())
        .unwrap_or("RUNNER_ERROR")
        .to_string();
    match (error.get("mutation").and_then(Value::as_str), effect) {
        (Some("none"), _) | (None, Effect::Reads) => Err(DriverError::Refused {
            code,
            message: String::new(),
        }),
        (None, Effect::Mutates) if code == "KEYBOARD_DISMISS_FAILED" => Err(DriverError::Refused {
            code,
            message: String::new(),
        }),
        (None, Effect::Mutates) => Err(unknown(&format!(
            "refused {code} without mutation evidence"
        ))),
        (Some(mutation), _) => Err(unknown(&format!("refused {code} with mutation {mutation}"))),
    }
}

// A usable reply that still refuses the step; the message is the engine's own, never the runner's.
pub fn refused(code: &str, message: &str) -> DriverError {
    DriverError::Refused {
        code: code.to_string(),
        message: message.to_string(),
    }
}

#[cfg(test)]
pub(crate) fn sent_body(config: &[u8]) -> Value {
    let text = std::str::from_utf8(config).unwrap();
    let line = text
        .lines()
        .find_map(|l| l.strip_prefix("data = \""))
        .expect("a data line");
    let quoted = line.strip_suffix('"').unwrap();
    let mut out = String::new();
    let mut chars = quoted.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            out.push(chars.next().unwrap());
        } else {
            out.push(c);
        }
    }
    serde_json::from_str(&out).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner};

    const SECRET: &str = "cap-SECRET-token";

    fn client() -> RunnerClient {
        RunnerClient::new(4711, SECRET, "com.x.app", "run-1")
    }

    fn ok(data: &str) -> CmdOutput {
        CmdOutput::success(&format!(r#"{{"ok":true,"data":{data},"v":2}}"#))
    }

    fn error(body: &str) -> CmdOutput {
        CmdOutput::success(&format!(r#"{{"ok":false,"error":{body},"v":2}}"#))
    }

    fn classify_one(output: CmdOutput, effect: Effect) -> DriverError {
        let mut runner = MockRunner::new();
        runner.expect_run("curl", output);
        client()
            .command(&mut runner, "tap", effect, json!({}), 1_000)
            .unwrap_err()
    }

    #[test]
    fn the_request_rides_on_stdin_and_argv_carries_no_secret() {
        let mut runner = MockRunner::new();
        runner.expect_run("curl", ok(r#"{"message":"typed"}"#));
        let mut client = client();
        let data = client
            .command(
                &mut runner,
                "type",
                Effect::Mutates,
                json!({"text": "hunter2 \"quoted\" back\\slash \u{8} é", "focused": true}),
                10_500,
            )
            .unwrap();
        assert_eq!(data["message"], "typed");
        let spec = &runner.calls[0];
        assert_eq!(spec.rendered(), "curl -q --config -");
        assert_eq!(spec.timeout_seconds, 13);
        assert!(!format!("{spec:?}").contains("SECRET"));
        let config = std::str::from_utf8(&runner.private_inputs[0]).unwrap();
        assert!(config.contains("url = \"http://127.0.0.1:4711/command\""));
        assert!(config.contains(&format!("header = \"Authorization: Bearer {SECRET}\"")));
        assert!(config.contains("noproxy = \"*\"") && config.contains("max-time = 10.500"));
        let body = sent_body(&runner.private_inputs[0]);
        assert_eq!(body["text"], "hunter2 \"quoted\" back\\slash \u{8} é");
        assert_eq!(body["command"], "type");
        assert_eq!(body["commandId"], "run-1-1");
        assert_eq!(body["appBundleId"], "com.x.app");
        assert_eq!(body["focused"], true);
        assert!(!format!("{client:?}").contains("SECRET"));
    }

    #[test]
    fn command_ids_increment_per_call() {
        let mut runner = MockRunner::new();
        runner.expect_run("curl", ok("{}"));
        runner.expect_run("curl", ok("{}"));
        let mut client = client();
        client
            .command(&mut runner, "tap", Effect::Mutates, json!({}), 1_000)
            .unwrap();
        client
            .command(&mut runner, "tap", Effect::Mutates, json!({}), 1_000)
            .unwrap();
        assert_eq!(sent_body(&runner.private_inputs[1])["commandId"], "run-1-2");
    }

    #[test]
    fn transport_failures_split_into_unsent_and_unknown() {
        assert!(matches!(
            classify_one(CmdOutput::failed(7, "connect refused"), Effect::Mutates),
            DriverError::Unsent(_)
        ));
        for output in [
            CmdOutput::failed(28, "timeout"),
            CmdOutput::failed(52, "empty reply"),
            CmdOutput {
                timed_out: true,
                ..CmdOutput::default()
            },
        ] {
            let summary = output.summary();
            assert!(
                matches!(
                    classify_one(output, Effect::Mutates),
                    DriverError::Unknown(_)
                ),
                "{summary}"
            );
        }
    }

    #[test]
    fn malformed_envelopes_are_never_clean() {
        for output in [
            CmdOutput::success("not json"),
            CmdOutput::success("{}"),
            CmdOutput::success("null"),
            CmdOutput::success(r#"{"ok":"false"}"#),
            CmdOutput::success(r#"{"ok":true}"#),
            CmdOutput::success(r#"{"ok":true,"data":"typed"}"#),
            CmdOutput::success(r#"{"ok":false}"#),
        ] {
            let text = output.stdout.clone();
            for effect in [Effect::Reads, Effect::Mutates] {
                assert!(
                    matches!(
                        classify_one(output.clone(), effect),
                        DriverError::Unknown(_)
                    ),
                    "{text} as {effect:?}"
                );
            }
        }
    }

    #[test]
    fn incompatible_protocol_replies_are_unknown() {
        for reply in [
            r#"{"ok":true,"data":{},"v":3}"#,
            r#"{"ok":false,"error":{"code":"KEYBOARD_DISMISS_FAILED"},"v":1}"#,
            r#"{"ok":true,"data":{}}"#,
        ] {
            assert!(matches!(
                classify_one(CmdOutput::success(reply), Effect::Mutates),
                DriverError::Unknown(why) if why.contains("protocol version")
            ));
        }
    }

    #[test]
    fn refusals_need_mutation_evidence_unless_the_verb_only_reads() {
        let none = error(r#"{"code":"KEYBOARD_DISMISS_FAILED","message":"m","mutation":"none"}"#);
        assert!(matches!(
            classify_one(none, Effect::Mutates),
            DriverError::Refused { code, message } if code == "KEYBOARD_DISMISS_FAILED" && message.is_empty()
        ));
        assert!(matches!(
            classify_one(error(r#"{"code":"KEYBOARD_DISMISS_FAILED","message":"m"}"#), Effect::Mutates),
            DriverError::Refused { code, .. } if code == "KEYBOARD_DISMISS_FAILED"
        ));
        let bare = error(r#"{"code":"INVALID_ARGUMENT","message":"m"}"#);
        assert!(matches!(
            classify_one(bare.clone(), Effect::Reads),
            DriverError::Refused { code, .. } if code == "INVALID_ARGUMENT"
        ));
        assert!(matches!(
            classify_one(bare, Effect::Mutates),
            DriverError::Unknown(why) if why.contains("without mutation evidence")
        ));
        let possible = error(r#"{"code":"RUNNER_TIMEOUT","message":"m","mutation":"possible"}"#);
        assert!(matches!(
            classify_one(possible, Effect::Reads),
            DriverError::Unknown(why) if why.contains("possible")
        ));
        let nameless = error(r#"{"message":"m","mutation":"none"}"#);
        assert!(matches!(
            classify_one(nameless, Effect::Mutates),
            DriverError::Refused { code, .. } if code == "RUNNER_ERROR"
        ));
    }

    #[test]
    fn runner_messages_and_the_capability_never_reach_errors() {
        let leaky = error(&format!(
            r#"{{"code":"TEXT_TARGET_FOCUS_FAILED","message":"field shows hunter2 and {SECRET}","mutation":"none"}}"#
        ));
        for effect in [Effect::Reads, Effect::Mutates] {
            let error = classify_one(leaky.clone(), effect);
            let shown = format!("{error} {error:?}");
            assert!(
                !shown.contains("hunter2") && !shown.contains("SECRET"),
                "{shown}"
            );
            assert!(shown.contains("TEXT_TARGET_FOCUS_FAILED"));
        }
    }
}
