use std::io::{IsTerminal, Write};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::core::Row;

const QUICK: Duration = Duration::from_secs(1);
const SPINNER: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ponytail: one process-wide reporter; `check` is the only verb that enables it.
static PROGRESS: OnceLock<Mutex<Progress>> = OnceLock::new();

pub struct Progress {
    live: bool,
    closed: bool,
    tick: usize,
    active: Vec<(String, Instant)>,
    out: Box<dyn Write + Send>,
}

impl Progress {
    pub fn new(live: bool, out: Box<dyn Write + Send>) -> Self {
        Progress {
            live,
            closed: false,
            tick: 0,
            active: Vec::new(),
            out,
        }
    }

    pub fn started(&mut self, label: &str, background: bool, now: Instant) {
        if self.closed {
            return;
        }
        self.active.push((label.to_string(), now));
        if background && !self.live {
            self.commit(&format!("▸ {label}"));
        }
        self.redraw(now);
    }

    pub fn finished(&mut self, label: &str, ok: bool, now: Instant) {
        if self.closed {
            return;
        }
        let Some(i) = self.active.iter().rposition(|(l, _)| l == label) else {
            return;
        };
        let (_, began) = self.active.remove(i);
        let took = now.saturating_duration_since(began);
        // Sub-second probes exit non-zero by design (e.g. no listener); real failures reach the receipt.
        if took >= QUICK {
            let glyph = if ok { '✓' } else { '✗' };
            self.commit(&format!("{glyph} {label}  {}", elapsed(took)));
        }
        self.redraw(now);
    }

    pub fn row(&mut self, row: &Row, now: Instant) {
        if self.closed || row.line == 0 {
            return;
        }
        let glyph = match row.outcome.as_str() {
            "pass" => '✓',
            "fail" => '✗',
            _ => '↻',
        };
        let retry = if row.attempt > 1 {
            format!(" attempt {}", row.attempt)
        } else {
            String::new()
        };
        // Streamed rows are value-free; plan text stays out of live progress.
        self.commit(&format!(
            "  {glyph} {:>3}  ({}{retry})",
            row.line, row.resolved_by
        ));
        self.redraw(now);
    }

    pub fn close(&mut self) {
        if self.live && !self.closed {
            let _ = write!(self.out, "\r\x1b[2K");
            let _ = self.out.flush();
        }
        self.closed = true;
    }

    fn commit(&mut self, line: &str) {
        let clear = if self.live { "\r\x1b[2K" } else { "" };
        let _ = writeln!(self.out, "{clear}{line}");
        let _ = self.out.flush();
    }

    fn redraw(&mut self, now: Instant) {
        if !self.live || self.closed {
            return;
        }
        let spin = SPINNER[self.tick % SPINNER.len()];
        let line = match self.active.last() {
            Some((label, began)) => format!(
                "{spin} {label}  {}",
                elapsed(now.saturating_duration_since(*began))
            ),
            None => String::new(),
        };
        let _ = write!(self.out, "\r\x1b[2K{line}");
        let _ = self.out.flush();
    }
}

fn elapsed(d: Duration) -> String {
    let s = d.as_secs();
    if s < 60 {
        format!("{:.1}s", d.as_secs_f64())
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

fn with(f: impl FnOnce(&mut Progress)) {
    if let Some(p) = PROGRESS.get() {
        if let Ok(mut p) = p.lock() {
            f(&mut p);
        }
    }
}

// QAREN_PROGRESS=off disables it; =plain forces line output even on a terminal.
pub fn enable() {
    let mode = std::env::var("QAREN_PROGRESS").unwrap_or_default();
    if mode == "off" {
        return;
    }
    let live = mode != "plain" && std::io::stderr().is_terminal();
    if PROGRESS
        .set(Mutex::new(Progress::new(live, Box::new(std::io::stderr()))))
        .is_err()
        || !live
    {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(120));
        let mut closed = false;
        with(|p| {
            closed = p.closed;
            p.tick += 1;
            p.redraw(Instant::now());
        });
        if closed {
            break;
        }
    });
}

pub fn started(label: &str, background: bool) {
    with(|p| p.started(label, background, Instant::now()));
}

pub fn finished(label: &str, ok: bool) {
    with(|p| p.finished(label, ok, Instant::now()));
}

pub fn row(row: &Row) {
    with(|p| p.row(row, Instant::now()));
}

pub fn watch_hint(run_id: &str) {
    with(|p| p.commit(&format!("▸ watch live: qaren watch {run_id}")));
}

pub fn close() {
    with(Progress::close);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    #[derive(Clone, Default)]
    struct Sink(Arc<StdMutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn row(line: u64, outcome: &str, text: &str) -> Row {
        Row {
            block: "b".into(),
            operation_id: line,
            line,
            attempt: 1,
            kind: "step".into(),
            resolved_by: "exact".into(),
            r#ref: None,
            screenshot: None,
            t: 0,
            outcome: outcome.into(),
            text: Some(text.into()),
            reason: None,
            timing: None,
            selector: None,
            kept: None,
            case_normalized: None,
            dialog: None,
        }
    }

    #[test]
    fn plain_mode_reports_slow_commands_background_starts_and_plan_rows() {
        let sink = Sink::default();
        let mut p = Progress::new(false, Box::new(sink.clone()));
        let t0 = Instant::now();
        p.started("simctl-list", false, t0);
        p.finished("simctl-list", true, t0 + Duration::from_millis(80));
        p.started("pnpm-install", false, t0);
        p.finished("pnpm-install", true, t0 + Duration::from_secs(64));
        p.started("xcodebuild-ios", true, t0);
        p.started("ps-scan", false, t0);
        p.finished("ps-scan", false, t0 + Duration::from_millis(10));
        p.finished("xcodebuild-ios", false, t0 + Duration::from_secs(5));
        p.row(&row(0, "pass", "startup"), t0);
        p.row(&row(9, "pass", "Wait for \"Welcome\""), t0);
        p.close();
        p.row(&row(10, "fail", "after close"), t0);
        let out = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        assert_eq!(
            out,
            "✓ pnpm-install  1:04\n\
             ▸ xcodebuild-ios\n\
             ✗ xcodebuild-ios  5.0s\n  \
             ✓   9  (exact)\n"
        );
    }

    #[test]
    fn streamed_row_text_never_reaches_the_terminal() {
        let sink = Sink::default();
        let mut p = Progress::new(false, Box::new(sink.clone()));
        let text = "Fill \"pin\" with \"hunter-canary-77\"\n✓ forged\u{1b}[2J";
        p.row(&row(4, "pass", text), Instant::now());
        let out = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        assert_eq!(out, "  ✓   4  (exact)\n");
    }
}
