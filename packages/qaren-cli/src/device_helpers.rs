//! Android emulator helper processes that outlive their emulator or run hot. QaReN starts none
//! of them and, here, only reads the process list.
use crate::exec::{CmdSpec, Runner};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// `ps -o` columns: the doctor process list and the run-start scan read the same shape.
pub const PROCESS_COLUMNS: &str = "pid=,pcpu=,stat=,ucomm=,args=";
const FIXED_WORDS: usize = 3;
const HOT_CPU: f64 = 100.0;
// Bounds the scan when other processes name many folders: at most this many 2 s package reads.
const MAX_PACKAGE_READS: usize = 4;
// Only a regular file is read, so a FIFO or device named source.properties cannot block the read.
const PACKAGE_READ: &str = "test -f \"$1\" && exec head -c 4096 \"$1\"";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperName {
    Netsimd,
    CrashpadHandler,
}

impl HelperName {
    fn as_str(self) -> &'static str {
        match self {
            HelperName::Netsimd => "netsimd",
            HelperName::CrashpadHandler => "crashpad_handler",
        }
    }
}

/// What a receipt keeps of a finding: the executable name and pid, nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub name: HelperName,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub name: HelperName,
    pub pid: u32,
    pub cpu: f64,
    pub emulator_gone: bool,
}

/// What one listing found, and whether every line of it could be read.
#[derive(Debug, Clone, PartialEq)]
pub struct Scan {
    pub helpers: Vec<Finding>,
    pub complete: bool,
}

impl Finding {
    pub fn hot(&self) -> bool {
        self.cpu > HOT_CPU
    }

    pub fn stop_command(&self) -> String {
        format!("kill {}", self.pid)
    }

    pub fn note(&self) -> Note {
        Note {
            name: self.name,
            pid: self.pid,
        }
    }

    pub fn describe(&self) -> String {
        let mut causes = Vec::new();
        if self.emulator_gone {
            causes.push("its emulator is not running");
        }
        if self.hot() {
            causes.push("above 100% CPU");
        }
        format!(
            "{} (pid {}, {:.1}% CPU): {}",
            self.name.as_str(),
            self.pid,
            self.cpu,
            causes.join(", ")
        )
    }
}

/// One row of a `PROCESS_COLUMNS` listing.
pub struct Process<'a> {
    pub pid: u32,
    pub cpu: f64,
    pub stat: &'a str,
    pub ucomm: &'a str,
    pub args: &'a str,
}

impl Process<'_> {
    /// The AVD of a local Android emulator process (`qemu-system-*` with `-avd`).
    pub fn emulator_avd(&self) -> Option<&str> {
        if !self.ucomm.starts_with("qemu-system-") {
            return None;
        }
        let words: Vec<_> = self.args.split_whitespace().collect();
        Some(words.windows(2).find(|pair| pair[0] == "-avd")?[1])
    }

    // Running or starting, of any user and in any state; a look-alike name errs on the safe side.
    fn is_emulator(&self) -> bool {
        self.ucomm.starts_with("qemu-system-") || self.ucomm.starts_with("emulator")
    }

    /// The helper's name and the folder its executable sits in.
    fn helper(&self) -> Option<(HelperName, &str)> {
        // `ucomm` may be cut to 15 characters.
        let name = if self.ucomm == "netsimd" {
            HelperName::Netsimd
        } else if self.ucomm.starts_with("crashpad_handle") {
            HelperName::CrashpadHandler
        } else {
            return None;
        };
        if self.pid <= 1 || !self.args.starts_with('/') {
            return None;
        }
        // Cut at the first `/<name>` that ends a word: SDK paths may hold spaces or the name.
        let file = format!("/{}", name.as_str());
        let at = self
            .args
            .match_indices(&file)
            .map(|(at, _)| at)
            .find(|&at| {
                self.args[at + file.len()..]
                    .chars()
                    .next()
                    .is_none_or(char::is_whitespace)
            })?;
        Some((name, &self.args[..at]))
    }
}

pub struct ProcessList<'a> {
    pub rows: Vec<Process<'a>>,
    /// False when a line could not be read: it may hide an emulator.
    pub complete: bool,
}

/// Text after the first `skip` whitespace-separated columns, keeping spaces inside it.
fn after_columns(line: &str, skip: usize) -> &str {
    let mut rest = line.trim_start();
    for _ in 0..skip {
        rest = rest
            .split_once(char::is_whitespace)
            .map_or("", |(_, tail)| tail.trim_start());
    }
    rest
}

fn process(line: &str) -> Option<Process<'_>> {
    let words: Vec<_> = line.split_whitespace().take(FIXED_WORDS + 1).collect();
    if words.len() <= FIXED_WORDS {
        return None;
    }
    Some(Process {
        pid: words[0].parse().ok()?,
        cpu: words[1]
            .parse()
            .ok()
            .filter(|v: &f64| v.is_finite() && *v >= 0.0)?,
        stat: words[2],
        ucomm: words[FIXED_WORDS],
        args: after_columns(line, FIXED_WORDS + 1),
    })
}

/// Reads a `PROCESS_COLUMNS` listing; None when no line reads as a process.
pub fn parse(text: &str) -> Option<ProcessList<'_>> {
    let mut complete = true;
    let rows: Vec<_> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let row = process(line);
            complete &= row.is_some();
            row
        })
        .collect();
    (!rows.is_empty()).then_some(ProcessList { rows, complete })
}

// Other apps ship same-named programs: only the SDK's own emulator package holds the helpers.
fn emulator_package(runner: &mut dyn Runner, label: &str, folder: &str) -> bool {
    let path = format!("{folder}/source.properties");
    // The path is a positional argument, never shell text.
    let output = runner.run(
        &CmdSpec::new(
            label,
            "/bin/sh",
            &["-c", PACKAGE_READ, "sh", path.as_str()],
            2,
        )
        .cwd(Path::new("/"))
        .env("LC_ALL", "C"),
    );
    output.ok()
        && output
            .stdout
            .lines()
            .any(|line| line.trim() == "Pkg.Path=emulator")
}

/// Helpers in a `PROCESS_COLUMNS` listing whose emulator is gone or that run above 100% CPU.
/// Reads each candidate folder's package file once, under `label`. None when no line reads.
pub fn findings(runner: &mut dyn Runner, label: &str, text: &str) -> Option<Scan> {
    let list = parse(text)?;
    // Stated limit: one netsimd may serve several emulators, so no helper can be tied to its own;
    // while any emulator runs or starts, every helper counts as served.
    let emulator_gone = !list.rows.iter().any(Process::is_emulator);
    let mut packages: HashMap<&str, bool> = HashMap::new();
    let mut helpers = Vec::new();
    for row in &list.rows {
        let Some((name, folder)) = row.helper() else {
            continue;
        };
        let finding = Finding {
            name,
            pid: row.pid,
            cpu: row.cpu,
            emulator_gone,
        };
        if !(finding.emulator_gone || finding.hot()) {
            continue;
        }
        let proven = match packages.get(folder) {
            Some(proven) => *proven,
            // Folders past the cap stay unproven and are not named.
            None if packages.len() >= MAX_PACKAGE_READS => false,
            None => {
                let proven = emulator_package(runner, label, folder);
                packages.insert(folder, proven);
                proven
            }
        };
        if proven {
            helpers.push(finding);
        }
    }
    Some(Scan {
        helpers,
        complete: list.complete,
    })
}

/// One bounded process-list read at run start; an unavailable or unreadable list finds nothing.
pub fn scan(runner: &mut dyn Runner, os: &str) -> Scan {
    let nothing = Scan {
        helpers: Vec::new(),
        complete: true,
    };
    if !matches!(os, "macos" | "linux") {
        return nothing;
    }
    let output = runner.run(
        &CmdSpec::new("device-helpers", "ps", &["-axww", "-o", PROCESS_COLUMNS], 3)
            .cwd(Path::new("/"))
            .env("LC_ALL", "C"),
    );
    if !output.ok() {
        return nothing;
    }
    findings(runner, "device-helpers", &output.stdout).unwrap_or(nothing)
}

/// The report line for run-start findings, or None when there are none.
pub fn report_line(scan: &Scan) -> Option<String> {
    (!scan.helpers.is_empty()).then(|| {
        let each: Vec<_> = scan
            .helpers
            .iter()
            .map(|f| format!("{}; stop it with `{}`", f.describe(), f.stop_command()))
            .collect();
        let incomplete = if scan.complete {
            ""
        } else {
            " The process list had an unreadable line, so a running emulator may be hidden."
        };
        format!(
            "Android emulator helpers at start (QaReN did not start them): {}.{incomplete}",
            each.join("; ")
        )
    })
}

/// One `PROCESS_COLUMNS` line, for fixtures.
#[cfg(test)]
pub(crate) fn ps_line(pid: i64, cpu: &str, stat: &str, ucomm: &str, args: &str) -> String {
    format!("{pid:>6} {cpu:>5} {stat:<4} {ucomm} {args}\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner};

    const SDK: &str = "/Volumes/External SSD/Android/sdk/emulator";
    const PACKAGE: &str = "Pkg.Desc=Android Emulator\nPkg.Path=emulator\nPkg.Revision=37.2.13\n";

    fn netsimd(pid: i64, cpu: &str) -> String {
        ps_line(pid, cpu, "S", "netsimd", &format!("{SDK}/netsimd --flag"))
    }

    fn package(runner: &mut MockRunner, folder: &str, output: CmdOutput) {
        runner.expect_run(&format!("\" sh {folder}/source.properties"), output);
    }

    fn scan_text(runner: &mut MockRunner, text: &str) -> Option<Scan> {
        let scan = findings(runner, "device-helpers", text);
        assert_eq!(runner.remaining(), 0, "unread package answers");
        assert!(runner.calls.iter().all(|c| c.label == "device-helpers"
            && c.program == "/bin/sh"
            && c.args[..3] == ["-c", PACKAGE_READ, "sh"]
            && c.timeout_seconds == 2));
        scan
    }

    #[test]
    fn only_a_folder_holding_the_sdk_emulator_package_makes_a_helper() {
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let crash = ps_line(
            4243,
            "0.0",
            "S",
            "crashpad_handle",
            &format!("{SDK}/crashpad_handler --database=/x"),
        );
        let scan = scan_text(&mut runner, &format!("{}{crash}", netsimd(4242, "0.5"))).unwrap();
        assert!(scan.complete);
        let names: Vec<_> = scan.helpers.iter().map(|f| (f.name, f.pid)).collect();
        assert_eq!(
            names,
            vec![
                (HelperName::Netsimd, 4242),
                (HelperName::CrashpadHandler, 4243)
            ]
        );

        for answer in [
            CmdOutput::success("Pkg.Desc=Something else\nPkg.Path=platform-tools\n"),
            CmdOutput::failed(1, "No such file or directory"),
            CmdOutput {
                timed_out: true,
                ..Default::default()
            },
        ] {
            let mut runner = MockRunner::new();
            package(&mut runner, SDK, answer);
            let scan = scan_text(&mut runner, &netsimd(4242, "960.0")).unwrap();
            assert!(scan.helpers.is_empty());
        }
    }

    #[test]
    fn same_named_programs_of_other_apps_are_never_read_or_reported() {
        let text = [
            ps_line(4244, "0.0", "S", "crashpad_handle", "/Applications/Other App.app/Contents/Frameworks/crashpad_handler --database=/x/emulator/y"),
            ps_line(4245, "960.0", "S", "netsimd", "netsimd -s"),
            ps_line(4246, "960.0", "S", "vim", &format!("/usr/bin/vim {SDK}/netsimd")),
            ps_line(4247, "960.0", "S", "netsimd", &format!("{SDK}/netsimdx")),
            ps_line(0, "960.0", "S", "netsimd", &format!("{SDK}/netsimd")),
            ps_line(1, "960.0", "S", "netsimd", &format!("{SDK}/netsimd")),
        ]
        .concat();
        let mut runner = MockRunner::new();
        package(
            &mut runner,
            "/Applications/Other App.app/Contents/Frameworks",
            CmdOutput::failed(1, "No such file"),
        );
        let scan = scan_text(&mut runner, &text).unwrap();
        assert!(scan.complete);
        assert!(scan.helpers.is_empty());
    }

    #[test]
    fn an_sdk_path_holding_the_helper_name_or_a_space_is_recognised() {
        let folder = "/tmp/netsimd-repro/sdk/emulator";
        let mut runner = MockRunner::new();
        package(&mut runner, folder, CmdOutput::success(PACKAGE));
        let text = ps_line(
            4242,
            "0.0",
            "S",
            "netsimd",
            &format!("{folder}/netsimd --crashpad_handler"),
        );
        let scan = scan_text(&mut runner, &text).unwrap();
        assert_eq!(scan.helpers.len(), 1);
    }

    #[test]
    fn a_starting_emulator_or_any_users_emulator_serves_every_helper() {
        for alive in [
            ps_line(
                900,
                "40.0",
                "S",
                "qemu-system-aar",
                &format!("{SDK}/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel"),
            ),
            ps_line(900, "40.0", "Z", "qemu-system-x86", "(qemu-system-x86)"),
            ps_line(
                899,
                "0.1",
                "S",
                "emulator",
                &format!("{SDK}/emulator -avd Pixel"),
            ),
            ps_line(
                899,
                "0.1",
                "S",
                "emulator-headless",
                &format!("{SDK}/emulator-headless -avd Pixel"),
            ),
            ps_line(
                898,
                "0.1",
                "S",
                "qemu-system-aar",
                "/Users/other/sdk/emulator/qemu/qemu-system-aarch64 -avd Theirs",
            ),
        ] {
            let mut runner = MockRunner::new();
            let scan =
                scan_text(&mut runner, &format!("{alive}{}", netsimd(4242, "12.5"))).unwrap();
            assert!(scan.helpers.is_empty(), "{alive}");
        }
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let hot = format!(
            "{}{}",
            ps_line(899, "0.1", "S", "emulator", "/sdk/emulator/emulator"),
            netsimd(4242, "960.0")
        );
        let scan = scan_text(&mut runner, &hot).unwrap();
        assert_eq!(scan.helpers.len(), 1);
        assert!(!scan.helpers[0].emulator_gone && scan.helpers[0].hot());
    }

    #[test]
    fn an_unreadable_line_marks_the_list_incomplete_and_found_helpers_stay_listed() {
        for bad in [
            "   77  1.0 S\n".to_string(),
            ps_line(77, "NaN", "S", "x", "/x"),
            ps_line(77, "-1.0", "S", "x", "/x"),
            ps_line(77, "1.0", "S", "x", "/x").replace("77", "invalid"),
        ] {
            let mut runner = MockRunner::new();
            package(&mut runner, SDK, CmdOutput::success(PACKAGE));
            let scan = scan_text(&mut runner, &format!("{bad}{}", netsimd(4242, "0.5"))).unwrap();
            assert!(!scan.complete, "{bad}");
            assert_eq!(scan.helpers.len(), 1);
            assert!(report_line(&scan)
                .unwrap()
                .contains("a running emulator may be hidden"));
        }
        let valid = "   632   0.0 S distnoted /usr/sbin/distnoted agent\n";
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let scan = scan_text(&mut runner, &format!("{valid}{}", netsimd(4242, "0.5"))).unwrap();
        assert!(scan.complete);
        assert!(!report_line(&scan).unwrap().contains("may be hidden"));
        for text in ["", "\n", "   77  1.0 S\n"] {
            assert!(
                findings(&mut MockRunner::new(), "device-helpers", text).is_none(),
                "{text:?}"
            );
        }
    }

    #[test]
    fn one_package_read_per_folder_and_reporting_fields_are_kept() {
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let text = format!("{}{}", netsimd(4242, "960.0"), netsimd(4250, "0.0"));
        let scan = scan_text(&mut runner, &text).unwrap();
        assert_eq!(runner.calls.len(), 1);
        let first = &scan.helpers[0];
        assert_eq!(first.pid, 4242);
        assert!(first.emulator_gone && first.hot());
        assert_eq!(
            first.describe(),
            "netsimd (pid 4242, 960.0% CPU): its emulator is not running, above 100% CPU"
        );
        assert_eq!(first.stop_command(), "kill 4242");
    }

    #[test]
    fn package_reads_stop_at_the_cap_and_later_folders_are_not_named() {
        let mut runner = MockRunner::new();
        let mut text = String::new();
        for n in 0..6 {
            let folder = format!("/fake{n}/emulator");
            text.push_str(&ps_line(
                5000 + n,
                "0.0",
                "S",
                "netsimd",
                &format!("{folder}/netsimd"),
            ));
            if n < 4 {
                package(&mut runner, &folder, CmdOutput::success(PACKAGE));
            }
        }
        let scan = scan_text(&mut runner, &text).unwrap();
        assert_eq!(runner.calls.len(), 4);
        let pids: Vec<_> = scan.helpers.iter().map(|f| f.pid).collect();
        assert_eq!(pids, vec![5000, 5001, 5002, 5003]);
    }

    #[test]
    fn the_real_package_read_proves_a_regular_file_and_never_waits_on_a_fifo() {
        let root = std::env::temp_dir().join(format!("qaren-helper-pkg-{}", std::process::id()));
        let sdk = root.join("sdk $(touch shell-ran)/emulator");
        let fifo = root.join("fifo/emulator");
        std::fs::create_dir_all(&sdk).unwrap();
        std::fs::create_dir_all(&fifo).unwrap();
        std::fs::write(sdk.join("source.properties"), PACKAGE).unwrap();
        let fifo_file =
            std::ffi::CString::new(fifo.join("source.properties").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_file.as_ptr(), 0o600) }, 0);
        let mut runner = crate::exec::RealRunner::new();

        assert!(emulator_package(
            &mut runner,
            "device-helpers",
            sdk.to_str().unwrap()
        ));
        assert!(!root.join("shell-ran").exists() && !Path::new("/shell-ran").exists());
        let started = std::time::Instant::now();
        assert!(!emulator_package(
            &mut runner,
            "device-helpers",
            fifo.to_str().unwrap()
        ));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert!(!emulator_package(
            &mut runner,
            "device-helpers",
            root.join("missing").to_str().unwrap()
        ));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn healthy_helpers_and_unsupported_hosts_cost_no_package_read() {
        let mut runner = MockRunner::new();
        let alive = ps_line(
            900,
            "40.0",
            "S",
            "qemu-system-aar",
            "/sdk/emulator/qemu/qemu-system-aarch64 -avd Pixel",
        );
        assert!(
            scan_text(&mut runner, &format!("{alive}{}", netsimd(4242, "1.0")))
                .unwrap()
                .helpers
                .is_empty()
        );
        let mut runner = MockRunner::new();
        assert!(scan(&mut runner, "windows").helpers.is_empty());
        assert!(runner.calls.is_empty());
    }
}
