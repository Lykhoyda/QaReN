//! Android emulator helper processes that outlive their emulator or run hot. QaReN starts none
//! of them and, here, only reads the process list.
use crate::exec::{CmdSpec, Runner};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// `ps -o` columns: the doctor process list and the run-start scan read the same shape.
pub const PROCESS_COLUMNS: &str = "stat=,ucomm=,pid=,ppid=,pcpu=,args=";
const HOT_CPU: f64 = 100.0;

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
    pub ppid: u32,
    pub cpu: f64,
    pub emulator_gone: bool,
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

/// The AVD of a local Android emulator process line (`qemu-system-*` with `-avd`).
pub fn emulator_avd(line: &str) -> Option<&str> {
    let words: Vec<_> = line.split_whitespace().collect();
    if !words.get(1)?.starts_with("qemu-system-") {
        return None;
    }
    Some(words.windows(2).find(|pair| pair[0] == "-avd")?[1])
}

/// Text after the first `skip` whitespace-separated columns, keeping spaces inside it.
fn after_columns(line: &str, skip: usize) -> Option<&str> {
    let mut rest = line.trim_start();
    for _ in 0..skip {
        rest = rest.split_once(char::is_whitespace)?.1.trim_start();
    }
    Some(rest)
}

fn helper_name(ucomm: &str, args: &str) -> Option<HelperName> {
    // `ucomm` may be cut to 15 characters.
    let name = if ucomm == "netsimd" {
        HelperName::Netsimd
    } else if ucomm.starts_with("crashpad_handle") {
        HelperName::CrashpadHandler
    } else {
        return None;
    };
    // Other apps ship same-named programs: only the SDK's emulator folder itself holds the helper.
    let (folder, rest) = args.split_once(name.as_str())?;
    (folder.ends_with("/emulator/") && rest.chars().next().is_none_or(char::is_whitespace))
        .then_some(name)
}

struct Row<'a> {
    ucomm: &'a str,
    pid: u32,
    ppid: u32,
    cpu: f64,
    args: &'a str,
}

fn row(line: &str) -> Option<Row<'_>> {
    let words: Vec<_> = line.split_whitespace().take(5).collect();
    let [_, ucomm, pid, ppid, cpu] = words[..] else {
        return None;
    };
    Some(Row {
        ucomm,
        pid: pid.parse().ok()?,
        ppid: ppid.parse().ok()?,
        cpu: cpu
            .parse()
            .ok()
            .filter(|v: &f64| v.is_finite() && *v >= 0.0)?,
        args: after_columns(line, 5).filter(|args| !args.is_empty())?,
    })
}

/// Helpers in a `PROCESS_COLUMNS` listing whose emulator is gone or that run above 100% CPU;
/// None when no line of the listing reads as a process.
pub fn findings(text: &str) -> Option<Vec<Finding>> {
    let rows: Vec<_> = text.lines().filter_map(row).collect();
    if rows.is_empty() {
        return None;
    }
    // shortcut: any running emulator counts as every helper's own; match each helper to its emulator before the stop step relies on it.
    let emulator_gone = !text.lines().any(|line| emulator_avd(line).is_some());
    Some(
        rows.into_iter()
            .filter_map(|row| {
                let finding = Finding {
                    name: helper_name(row.ucomm, row.args)?,
                    pid: row.pid,
                    ppid: row.ppid,
                    cpu: row.cpu,
                    emulator_gone,
                };
                (finding.emulator_gone || finding.hot()).then_some(finding)
            })
            .collect(),
    )
}

/// One bounded process-list read at run start; an unreadable list finds nothing.
pub fn scan(runner: &mut dyn Runner, os: &str) -> Vec<Finding> {
    if !matches!(os, "macos" | "linux") {
        return Vec::new();
    }
    let output = runner.run(
        &CmdSpec::new("device-helpers", "ps", &["-axww", "-o", PROCESS_COLUMNS], 3)
            .cwd(Path::new("/"))
            .env("LC_ALL", "C"),
    );
    output
        .ok()
        .then(|| findings(&output.stdout))
        .flatten()
        .unwrap_or_default()
}

/// The report line for run-start findings, or None when there are none.
pub fn report_line(found: &[Finding]) -> Option<String> {
    (!found.is_empty()).then(|| {
        let each: Vec<_> = found
            .iter()
            .map(|f| format!("{}; stop it with `{}`", f.describe(), f.stop_command()))
            .collect();
        format!(
            "Android emulator helpers at start (QaReN did not start them): {}.",
            each.join("; ")
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listings_without_a_readable_process_are_unreadable_not_clean() {
        for text in [
            "",
            "S netsimd /sdk/emulator/netsimd\n",
            "S netsimd x 1 9.0 /sdk/emulator/netsimd\n",
            "S netsimd 4242 1 NaN /sdk/emulator/netsimd\n",
            "S netsimd 4242 1 -1.0 /sdk/emulator/netsimd\n",
            "S netsimd 4242 1 9.0\n",
        ] {
            assert_eq!(findings(text), None, "{text:?}");
        }
    }

    #[test]
    fn only_the_helper_executable_in_the_emulator_folder_counts() {
        for text in [
            "S crashpad_handle 4243 1 0.0 /sdk/emulator/other --crashpad_handler\n",
            "S crashpad_handle 4243 1 0.0 /sdk/emulator/crashpad_handlerx\n",
            "S netsimd 4243 1 0.0 /sdk/notemulator/netsimd\n",
        ] {
            assert_eq!(findings(text), Some(Vec::new()), "{text}");
        }
    }

    #[test]
    fn a_hot_helper_without_its_emulator_carries_both_facts() {
        let found = findings("  S   netsimd    4242     1  960.0 /sdk/emulator/netsimd\n").unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].emulator_gone && found[0].hot());
        assert_eq!(found[0].ppid, 1);
        assert_eq!(
            found[0].describe(),
            "netsimd (pid 4242, 960.0% CPU): its emulator is not running, above 100% CPU"
        );
        assert_eq!(found[0].stop_command(), "kill 4242");
    }

    #[test]
    fn unsupported_hosts_do_not_read_the_process_list() {
        let mut runner = crate::exec::MockRunner::new();
        assert!(scan(&mut runner, "windows").is_empty());
        assert!(runner.calls.is_empty());
    }
}
