use super::*;

fn event(seq: u64, state: &str, holder: Value, lock: Value) -> Input {
    parse_event(&json!({"v":1,"seq":seq,"at":seq * 5000,"event":"stage","payload":{
        "name":"build_lock_wait","state":state,"code":if state == "failed" {"RUN_CANCELLED"} else {"holder_alive"},
        "holder":holder,"lock":lock,"ms":125000,"holdMs":540000,
        "home":"private-canary","pid":9876
    }}).to_string()).unwrap()
}

#[test]
fn w1_queue_reaches_terminal_plain_and_json() {
    let mut state = State::default();
    state.fold(event(
        1,
        "running",
        json!("check-holder"),
        json!("native-build-slot"),
    ));
    let rendered = frame(&state, 140, 40).join("\n");
    for expected in [
        "Build queue",
        "waiting",
        "check-holder",
        "native-build-slot",
        "2m05s",
        "9 min",
    ] {
        assert!(
            rendered.contains(expected),
            "missing {expected}: {rendered}"
        );
    }
    let lines = plain(&state, &mut Default::default()).join("\n");
    assert!(lines.contains("waiting for run check-holder"), "{lines}");
    let snap = snapshot(&state);
    let queue = snap["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "build_lock_wait")
        .unwrap();
    assert_eq!(queue["ms"], 125000);
    assert_eq!(queue["holdMs"], 540000);
    assert_eq!(queue["holder"], "check-holder");
    assert_eq!(queue["lock"], "native-build-slot");
    assert!(!snap.to_string().contains("private-canary"));
}

#[test]
fn w2_queue_plain_tracks_transitions_and_each_completed_wait() {
    let mut state = State::default();
    let mut printed = Default::default();
    for (seq, holder, lock, count) in [
        (1, "check-a", "native-build-ios", 1),
        (2, "check-a", "native-build-ios", 0),
        (3, "check-b", "native-build-ios", 1),
        (4, "check-a", "native-build-ios", 1),
    ] {
        state.fold(event(seq, "running", json!(holder), json!(lock)));
        assert_eq!(
            plain(&state, &mut printed)
                .iter()
                .filter(|s| s.contains("waiting for run"))
                .count(),
            count
        );
    }
    for (seq, lock) in [(5, "native-build-ios"), (7, "native-build-slot")] {
        if seq == 7 {
            state.fold(event(6, "running", json!("check-a"), json!(lock)));
            assert!(plain(&state, &mut printed)
                .join("\n")
                .contains("waiting for run"));
        }
        state.fold(event(seq, "passed", json!("check-a"), json!(lock)));
        let lines = plain(&state, &mut printed).join("\n");
        assert!(lines.contains("waited 2m05s"), "{lines}");
        assert!(plain(&state, &mut printed).is_empty());
    }
}

#[test]
fn w3_queue_rejects_untrusted_fields() {
    for holder in [
        json!("../private-canary"),
        json!("a".repeat(65)),
        json!(123),
    ] {
        let mut state = State::default();
        state.fold(event(1, "running", holder, json!("/private-canary")));
        let snap = snapshot(&state).to_string();
        assert!(!snap.contains("private-canary"));
        assert!(frame(&state, 140, 40).join("\n").contains("holder unknown"));
    }
    let mut state = State::default();
    state.fold(
        parse_event(
            &json!({"v":1,"seq":1,"at":0,"event":"stage","payload":{
                "name":"build_lock_wait","state":"running","ms":1.5,"holdMs":-1
            }})
            .to_string(),
        )
        .unwrap(),
    );
    let snap = snapshot(&state);
    let queue = snap["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "build_lock_wait")
        .unwrap();
    assert!(queue.get("ms").is_none());
    assert!(queue.get("holdMs").is_none());
}

#[test]
fn w4_unobserved_queue_does_not_change_output() {
    let state = State::default();
    assert_eq!(snapshot(&state)["stages"].as_array().unwrap().len(), 11);
    assert!(!frame(&state, 140, 40).join("\n").contains("Build queue"));
    assert!(!plain(&state, &mut Default::default())
        .join("\n")
        .contains("Build queue"));
}

#[test]
fn w6_queue_failure_uses_its_actual_code() {
    let mut state = State::default();
    state.fold(event(
        1,
        "failed",
        json!("check-a"),
        json!("native-build-slot"),
    ));
    for rendered in [
        frame(&state, 140, 40).join("\n"),
        plain(&state, &mut Default::default()).join("\n"),
    ] {
        assert!(rendered.contains("RUN_CANCELLED after 2m05s"), "{rendered}");
    }
}

#[test]
fn queue_plain_replays_batched_transitions_in_order() {
    for final_state in ["running", "passed", "failed"] {
        for batch_size in [1, 2, 8] {
            let mut state = State::default();
            let mut printed = PlainState::default();
            let mut lines = Vec::new();
            let events = [
                ("running", "check-a", "native-build-ios"),
                ("running", "check-a", "native-build-ios"),
                ("running", "check-b", "native-build-ios"),
                ("running", "check-a", "native-build-ios"),
                ("passed", "check-a", "native-build-ios"),
                ("running", "check-a", "native-build-ios"),
                ("running", "check-a", "native-build-slot"),
                (final_state, "check-b", "native-build-slot"),
            ];
            for batch in events
                .iter()
                .enumerate()
                .collect::<Vec<_>>()
                .chunks(batch_size)
            {
                for &(index, &(status, holder, lock)) in batch {
                    state.fold(event(index as u64 + 1, status, json!(holder), json!(lock)));
                }
                lines.extend(plain(&state, &mut printed));
                assert!(plain(&state, &mut printed).is_empty());
            }
            let queue: Vec<_> = lines
                .iter()
                .filter(|line| line.contains("Build queue"))
                .map(String::as_str)
                .collect();
            let last = match final_state {
                "running" => "Build queue: waiting for run check-b (native-build-slot, held 9 min)",
                "passed" => "✓ Build queue  waited 2m05s",
                _ => "✗ Build queue  RUN_CANCELLED after 2m05s",
            };
            assert_eq!(
                queue,
                [
                    "Build queue: waiting for run check-a (native-build-ios, held 9 min)",
                    "Build queue: waiting for run check-b (native-build-ios, held 9 min)",
                    "Build queue: waiting for run check-a (native-build-ios, held 9 min)",
                    "✓ Build queue  waited 2m05s",
                    "Build queue: waiting for run check-a (native-build-ios, held 9 min)",
                    "Build queue: waiting for run check-a (native-build-slot, held 9 min)",
                    last,
                ],
                "{final_state}, batch size {batch_size}"
            );
        }
    }
}
