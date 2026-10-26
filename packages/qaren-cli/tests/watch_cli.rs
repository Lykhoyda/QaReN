use serde_json::{json, Value};
use std::path::Path;
use std::process::{Command, Output};

mod common;

#[cfg(unix)]
#[test]
fn tty_long_plan_fits_current_size_and_resizes() {
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::time::{Duration, Instant};

    let home = common::temp_repo();
    let dir = stream(&home, false);
    let mut events = std::fs::OpenOptions::new()
        .append(true)
        .open(dir.join("logs/events.jsonl"))
        .unwrap();
    for n in 2..=40 {
        writeln!(events, "{}", json!({"v":1,"seq":n+2,"at":n+2,"event":"row","payload":{"operationId":n,"line":n,"attempt":1,"kind":"action","resolvedBy":"exact","outcome":"pass"}})).unwrap();
    }
    let mut master = -1;
    let mut slave = -1;
    let mut size = libc::winsize {
        ws_row: 60,
        ws_col: 120,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        },
        0
    );
    let mut master = unsafe { std::fs::File::from_raw_fd(master) };
    let slave = unsafe { std::fs::File::from_raw_fd(slave) };
    assert_ne!(
        unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) },
        -1
    );
    let child = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .env("HOME", &home)
        .env("COLUMNS", "200")
        .env("LINES", "100")
        .env_remove("CI")
        .env_remove("NO_COLOR")
        .args(["watch", "check-watch"])
        .stdin(std::process::Stdio::null())
        .stdout(slave)
        .spawn()
        .unwrap();
    struct Viewer(std::process::Child);
    impl Drop for Viewer {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let _viewer = Viewer(child);
    for (width, height) in [(120, 60), (80, 24), (80, 20), (32, 24), (32, 18), (120, 60)] {
        let size = libc::winsize {
            ws_row: height,
            ws_col: width,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        assert_eq!(
            unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &size) },
            0
        );
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut bytes = Vec::new();
        let frame = loop {
            let mut buf = [0; 16384];
            match master.read(&mut buf) {
                Ok(n) => bytes.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                other => panic!("PTY read: {other:?}"),
            }
            let text = String::from_utf8_lossy(&bytes);
            let frames: Vec<_> = text.split("\x1b[H\x1b[2J").collect();
            // Skip the first frame, which may already have been drawn before resize.
            if frames.len() >= 4 {
                break frames[frames.len() - 2].replace('\r', "");
            }
            assert!(Instant::now() < deadline, "no complete redraw: {text}");
            std::thread::sleep(Duration::from_millis(20));
        };
        let lines: Vec<_> = frame.lines().collect();
        assert!(
            lines.len() < height as usize,
            "{width}x{height}: {} lines\n{frame}",
            lines.len()
        );
        assert!(
            lines
                .iter()
                .all(|line| line.chars().count() < width as usize),
            "wrapped frame: {frame}"
        );
        assert!(
            frame.contains("Preflight") && frame.contains("Cleanup"),
            "{frame}"
        );
        assert!(
            frame.contains("   40  action") || frame.contains("line 40 action"),
            "recent row missing: {frame}"
        );
        assert!(!frame.contains("private-canary"));
        if height < 60 {
            assert!(frame.contains("omitted"), "{frame}");
        }
    }
}

fn watch(home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_qaren"))
        .env("HOME", home)
        .env_remove("QAREN_PROGRESS")
        .args(["watch"])
        .args(args)
        .output()
        .unwrap()
}

#[cfg(unix)]
#[test]
fn tty_tiny_plain_ci_no_color_and_json_keep_their_output_contracts() {
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd};
    let home = common::temp_repo();
    stream(&home, true);
    for mode in ["tiny", "plain", "CI", "NO_COLOR", "json"] {
        let mut master = -1;
        let mut slave = -1;
        let mut size = libc::winsize {
            ws_row: if mode == "tiny" { 6 } else { 24 },
            ws_col: if mode == "tiny" { 12 } else { 80 },
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut size,
                )
            },
            0
        );
        let mut master = unsafe { std::fs::File::from_raw_fd(master) };
        let slave = unsafe { std::fs::File::from_raw_fd(slave) };
        assert_ne!(
            unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) },
            -1
        );
        let mut command = Command::new(env!("CARGO_BIN_EXE_qaren"));
        command
            .env("HOME", &home)
            .env_remove("CI")
            .env_remove("NO_COLOR")
            .args(["watch", "check-watch"])
            .stdin(std::process::Stdio::null())
            .stdout(slave);
        match mode {
            "plain" => {
                command.arg("--plain");
            }
            "json" => {
                command.arg("--json");
            }
            "CI" | "NO_COLOR" => {
                command.env(mode, "1");
            }
            _ => {}
        }
        let mut child = command.spawn().unwrap();
        let mut bytes = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let mut buf = [0; 16384];
            match master.read(&mut buf) {
                Ok(n) => bytes.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                other => panic!("PTY read: {other:?}"),
            }
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                let _ = master.read_to_end(&mut bytes);
                break;
            }
            if std::time::Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("{mode}: viewer did not exit");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        drop(command);
        let text = String::from_utf8(bytes).unwrap();
        assert!(
            !text.contains('\u{1b}') && !text.contains("private-canary"),
            "{mode}: {text}"
        );
        if mode == "json" {
            let value: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["state"], "finished");
            assert_eq!(text.lines().count(), 1);
        } else {
            assert_eq!(text.matches("VERDICT PASS").count(), 1, "{mode}: {text}");
            assert_eq!(text.matches("Preflight").count(), 1);
        }
    }
}

fn stream(home: &Path, end: bool) -> std::path::PathBuf {
    let dir = home.join(".qaren/runs/check-watch");
    std::fs::create_dir_all(dir.join("logs")).unwrap();
    let mut events = vec![
        json!({"v":1,"seq":1,"at":1,"event":"run","payload":{"runId":"check-watch","verb":"check","platform":"ios","ownerPid":1}}),
        json!({"v":1,"seq":2,"at":2,"event":"stage","payload":{"name":"preflight","state":"passed","ms":1}}),
        json!({"v":1,"seq":3,"at":3,"event":"row","payload":{"operationId":1,"line":1,"attempt":1,"kind":"action","resolvedBy":"exact","t":0,"outcome":"pass","text":"private-canary","selector":{"text":"private-canary"},"reason":"private-canary","screenshot":"private-canary"}}),
    ];
    if end {
        events.push(json!({"v":1,"seq":4,"at":4,"event":"end","payload":{"result":"pass","phase":"cleaned","timingsMs":{},"cleanup":{"core":"absent"},"expectedExit":0,"droppedEvents":0}}));
    }
    std::fs::write(
        dir.join("logs/events.jsonl"),
        events.iter().map(|e| format!("{e}\n")).collect::<String>(),
    )
    .unwrap();
    std::fs::write(dir.join("ledger.json"), "private-canary").unwrap();
    dir
}

#[test]
fn json_live_snapshot_is_immediate_and_ignores_private_fields_and_early_ledger() {
    let home = common::temp_repo();
    let dir = stream(&home, false);
    let before = std::fs::read(dir.join("logs/events.jsonl")).unwrap();
    let output = watch(&home, &["check-watch", "--json"]);
    assert!(output.status.success(), "{:?}", output);
    let text = String::from_utf8(output.stdout).unwrap();
    let state: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(state["state"], "live");
    assert_eq!(state["steps"][0]["line"], 1);
    assert!(!text.contains("private-canary"));
    assert_eq!(
        std::fs::read(dir.join("logs/events.jsonl")).unwrap(),
        before
    );
    assert!(!home.join(".qaren/locks").exists());
}

#[test]
fn non_tty_finished_output_has_no_escape_codes_and_returns_the_viewer_exit() {
    let home = common::temp_repo();
    stream(&home, true);
    let output = watch(&home, &["check-watch"]);
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("✓ Preflight"));
    assert!(text.contains("VERDICT PASS  (expected exit 0)"));
    assert!(!text.contains("private-canary") && !text.contains('\u{1b}'));
    let json = watch(&home, &["check-watch", "--json"]);
    assert!(json.status.success());
    let state: Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(state["state"], "finished");
}

#[test]
fn watch_usage_and_unavailable_telemetry_have_distinct_exits() {
    let home = common::temp_repo();
    for args in [
        vec![],
        vec!["check-watch", "--latest"],
        vec!["--plain"],
        vec!["check-watch", "--replay"],
        vec!["../outside"],
        vec!["check.watch"],
        vec!["check_watch"],
        vec!["check-watch", "--device", "any"],
    ] {
        assert_eq!(watch(&home, &args).status.code(), Some(2), "{args:?}");
    }
    assert_eq!(watch(&home, &["missing"]).status.code(), Some(1));
    std::fs::create_dir_all(home.join(".qaren/runs/check-old")).unwrap();
    assert_eq!(watch(&home, &["check-old"]).status.code(), Some(3));
}

#[test]
fn watch_refuses_symlinked_run_and_telemetry_files() {
    let home = common::temp_repo();
    let dir = stream(&home, true);
    std::os::unix::fs::symlink(&dir, home.join(".qaren/runs/check-link")).unwrap();
    assert_eq!(
        watch(&home, &["check-link", "--json"]).status.code(),
        Some(1)
    );
    let events = dir.join("logs/events.jsonl");
    std::fs::rename(&events, dir.join("events-saved")).unwrap();
    std::os::unix::fs::symlink(dir.join("events-saved"), &events).unwrap();
    assert_eq!(
        watch(&home, &["check-watch", "--json"]).status.code(),
        Some(3)
    );
}

#[test]
fn dead_owner_in_walking_phase_without_end_is_incomplete() {
    let home = common::temp_repo();
    let dir = stream(&home, false);
    let mut record = common::base_record(
        &home,
        &common::ios_scenario_yaml(8791),
        "check-watch",
        qaren::runrecord::Phase::Walking,
    );
    let mut owner = Command::new("/usr/bin/true").spawn().unwrap();
    let pid = owner.id();
    owner.wait().unwrap();
    record.prepare = Some(common::identity(pid as i32, "unmatched birth"));
    std::fs::write(dir.join("run.json"), serde_json::to_vec(&record).unwrap()).unwrap();
    let output = watch(&home, &["check-watch", "--json"]);
    assert!(output.status.success());
    let state: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(state["state"], "incomplete");
    assert!(state["end"].is_null());
    let output = watch(&home, &["check-watch", "--plain"]);
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout)
        .contains("ENDED WITHOUT FINAL EVENT (telemetry incomplete)"));
}

#[test]
fn latest_selects_the_run_record_and_ignores_non_run_directories() {
    let home = common::temp_repo();
    let dir = stream(&home, true);
    std::fs::write(dir.join("run.json"), "{}").unwrap();
    std::fs::create_dir_all(home.join(".qaren/runs/unrelated")).unwrap();
    let output = watch(&home, &["--latest", "--json"]);
    assert!(output.status.success());
    let state: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(state["runId"], "check-watch");
    assert_eq!(state["state"], "finished");
}

#[test]
fn plain_follows_live_append_and_exits_when_the_partial_end_line_completes() {
    use std::io::Write;
    use std::time::{Duration, Instant};
    let home = common::temp_repo();
    let dir = stream(&home, false);
    let output_path = home.join("watch-output");
    let mut viewer = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .env("HOME", &home)
        .args(["watch", "check-watch", "--plain"])
        .stdout(std::fs::File::create(&output_path).unwrap())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let text = std::fs::read_to_string(&output_path).unwrap();
        if text.contains("✓ Preflight") {
            break;
        }
        if Instant::now() > deadline {
            viewer.kill().unwrap();
            viewer.wait().unwrap();
            panic!("viewer did not print live progress");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(viewer.try_wait().unwrap().is_none());
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(dir.join("logs/events.jsonl"))
        .unwrap();
    let end = json!({"v":1,"seq":4,"at":4,"event":"end","payload":{"result":"pass","phase":"cleaned","expectedExit":0,"droppedEvents":0,"cleanup":{"core":"absent"}}}).to_string();
    file.write_all(end.as_bytes()).unwrap();
    file.flush().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        viewer.try_wait().unwrap().is_none(),
        "partial event must not finish the viewer"
    );
    file.write_all(b"\n").unwrap();
    file.flush().unwrap();
    loop {
        if let Some(status) = viewer.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        if Instant::now() > deadline {
            viewer.kill().unwrap();
            viewer.wait().unwrap();
            panic!("viewer did not finish after the end event");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let text = std::fs::read_to_string(output_path).unwrap();
    assert_eq!(text.matches("✓ Preflight").count(), 1);
    assert_eq!(text.matches("VERDICT PASS").count(), 1);
    assert!(!text.contains('\u{1b}') && !text.contains("private-canary"));
}
