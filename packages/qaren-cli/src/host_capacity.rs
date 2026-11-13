use crate::exec::{CmdOutput, CmdSpec, Runner};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

const GIB: u64 = 1024 * 1024 * 1024;
pub const LANE_HEADROOM: u64 = 4 * GIB;

pub struct Memory {
    pub free: u64,
    pub available: u64,
    pub compressed: Option<u64>,
    pub pressure: Option<bool>,
}

impl Memory {
    pub fn lanes(&self) -> u64 {
        self.available / LANE_HEADROOM
    }

    pub fn constrained(&self) -> bool {
        self.pressure == Some(true) || self.lanes() == 0
    }
}

pub struct Cpu {
    pub load: [f64; 3],
    pub cores: usize,
    pub idle: f64,
}

impl Cpu {
    pub fn constrained(&self) -> bool {
        self.load[0] >= self.cores as f64 || self.idle < 10.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Pressure {
    Normal,
    Warning,
    Critical,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Sample {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_1m: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cores: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressure: Option<Pressure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swap_used_bytes: Option<u64>,
    #[serde(skip)]
    load: Option<[f64; 3]>,
    #[serde(skip)]
    compressed: Option<u64>,
    #[serde(skip)]
    counters: Option<(u64, u64)>,
}

impl Sample {
    pub fn constrained(&self) -> bool {
        self.load_1m
            .zip(self.cores)
            .is_some_and(|(load, cores)| load >= cores as f64)
            || matches!(self.pressure, Some(Pressure::Warning | Pressure::Critical))
            || self
                .available_bytes
                .is_some_and(|bytes| bytes < LANE_HEADROOM)
    }

    pub fn summary(&self) -> String {
        let gib = |bytes: Option<u64>| {
            bytes.map_or("unavailable".into(), |b| {
                format!("{:.1} GiB", b as f64 / GIB as f64)
            })
        };
        if self.load_1m.is_none()
            && self.cores.is_none()
            && self.free_bytes.is_none()
            && self.available_bytes.is_none()
            && self.pressure.is_none()
            && self.swap_used_bytes.is_none()
        {
            return "unavailable".into();
        }
        let load = self
            .load_1m
            .map_or("unavailable".into(), |v| format!("{v:.1}"));
        let cores = self.cores.map_or("unavailable".into(), |v| v.to_string());
        let pressure = match self.pressure {
            Some(Pressure::Normal) => "normal",
            Some(Pressure::Warning) => "warning",
            Some(Pressure::Critical) => "critical",
            None => "unavailable",
        };
        format!(
            "load {load} on {cores} cores, {} free, {} available, pressure {pressure}, swap {}",
            gib(self.free_bytes),
            gib(self.available_bytes),
            gib(self.swap_used_bytes)
        )
    }

    fn memory(&self) -> Option<Memory> {
        Some(Memory {
            free: self.free_bytes?,
            available: self.available_bytes?,
            compressed: self.compressed,
            pressure: self.pressure.map(|p| p != Pressure::Normal),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSamples {
    pub start: Sample,
    pub end: Sample,
}

impl RunSamples {
    pub fn report_line(&self) -> String {
        format!(
            "Host at start: {}. At end: {}.",
            self.start.summary(),
            self.end.summary()
        )
    }
}

fn probe(runner: &mut dyn Runner, program: &str, args: &[&str]) -> CmdOutput {
    runner.run(
        &CmdSpec::new("host-sample", program, args, 3)
            .cwd(Path::new("/"))
            .env("LC_ALL", "C"),
    )
}

fn successful(output: &CmdOutput) -> Option<&str> {
    output.ok().then_some(output.stdout.as_str())
}

fn field(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        (name == key)
            .then(|| {
                value
                    .split_whitespace()
                    .next()?
                    .trim_end_matches('.')
                    .parse()
                    .ok()
            })
            .flatten()
    })
}

fn loads(text: &str) -> Option<[f64; 3]> {
    let mut values = text.split_whitespace().filter(|s| *s != "{" && *s != "}");
    let mut load = [0.0; 3];
    for value in &mut load {
        *value = values
            .next()?
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite() && *v >= 0.0)?;
    }
    Some(load)
}

fn counters(text: &str) -> Option<(u64, u64)> {
    let values = text
        .lines()
        .find_map(|l| l.strip_prefix("cpu "))?
        .split_whitespace()
        .take(8)
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if values.len() < 4 {
        return None;
    }
    Some((
        values.iter().try_fold(0u64, |sum, v| sum.checked_add(*v))?,
        values[3],
    ))
}

fn cores(text: &str) -> Option<usize> {
    let count = text
        .lines()
        .filter(|l| {
            l.split_whitespace()
                .next()
                .and_then(|name| name.strip_prefix("cpu"))
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
        })
        .count();
    (count > 0).then_some(count)
}

fn swap_bytes(text: &str) -> Option<u64> {
    let value = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .windows(3)
        .find_map(|w| (w[0] == "used" && w[1] == "=").then_some(w[2]))?;
    let (number, factor) = [
        ("K", 1024.0),
        ("M", (1024 * 1024) as f64),
        ("G", GIB as f64),
        ("B", 1.0),
    ]
    .into_iter()
    .find_map(|(unit, factor)| value.strip_suffix(unit).map(|number| (number, factor)))?;
    let bytes = number.parse::<f64>().ok()? * factor;
    (bytes.is_finite() && bytes >= 0.0 && bytes < u64::MAX as f64).then_some(bytes as u64)
}

pub fn sample(runner: &mut dyn Runner, os: &str) -> Sample {
    let mut sample = Sample::default();
    match os {
        "macos" => {
            let vm = probe(runner, "vm_stat", &[]);
            let sys = probe(
                runner,
                "sysctl",
                &[
                    "hw.logicalcpu",
                    "vm.loadavg",
                    "kern.memorystatus_vm_pressure_level",
                    "hw.memsize",
                    "vm.swapusage",
                ],
            );
            if let Some(sys) = successful(&sys) {
                sample.load = sys
                    .lines()
                    .find_map(|l| l.strip_prefix("vm.loadavg:"))
                    .and_then(loads);
                sample.cores = field(sys, "hw.logicalcpu")
                    .and_then(|v| usize::try_from(v).ok())
                    .filter(|c| *c > 0);
                sample.total_bytes = field(sys, "hw.memsize").filter(|v| *v > 0);
                sample.pressure = match field(sys, "kern.memorystatus_vm_pressure_level") {
                    Some(1) => Some(Pressure::Normal),
                    Some(2) => Some(Pressure::Warning),
                    Some(4) => Some(Pressure::Critical),
                    _ => None,
                };
                sample.swap_used_bytes = sys
                    .lines()
                    .find_map(|l| l.strip_prefix("vm.swapusage:"))
                    .and_then(swap_bytes);
            }
            if let Some(vm) = successful(&vm) {
                let page = vm
                    .lines()
                    .next()
                    .and_then(|s| s.split("page size of ").nth(1))
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse::<u64>().ok())
                    .filter(|p| *p > 0);
                if let Some(page) = page {
                    sample.free_bytes = field(vm, "Pages free").and_then(|v| v.checked_mul(page));
                    sample.available_bytes = field(vm, "Pages speculative")
                        .zip(field(vm, "Pages inactive"))
                        .and_then(|(a, b)| a.checked_add(b))
                        .and_then(|v| v.checked_mul(page))
                        .zip(sample.free_bytes)
                        .and_then(|(a, b)| a.checked_add(b));
                    sample.compressed =
                        field(vm, "Pages occupied by compressor").and_then(|v| v.checked_mul(page));
                }
            }
        }
        "linux" => {
            let mem = probe(runner, "cat", &["/proc/meminfo"]);
            let cpu = probe(runner, "cat", &["/proc/loadavg", "/proc/stat"]);
            if let Some(mem) = successful(&mem) {
                let bytes = |key| field(mem, key).and_then(|v| v.checked_mul(1024));
                sample.total_bytes = bytes("MemTotal").filter(|v| *v > 0);
                sample.free_bytes = bytes("MemFree")
                    .filter(|free| sample.total_bytes.is_none_or(|total| *free <= total));
                sample.available_bytes = bytes("MemAvailable")
                    .filter(|available| sample.total_bytes.is_none_or(|total| *available <= total));
                sample.pressure =
                    sample
                        .available_bytes
                        .zip(sample.total_bytes)
                        .map(|(available, total)| {
                            if available < total / 10 {
                                Pressure::Warning
                            } else {
                                Pressure::Normal
                            }
                        });
                sample.swap_used_bytes = bytes("SwapTotal")
                    .zip(bytes("SwapFree"))
                    .and_then(|(total, free)| total.checked_sub(free));
            }
            if let Some(cpu) = successful(&cpu) {
                sample.load = cpu.lines().next().and_then(loads);
                sample.cores = cores(cpu);
                sample.counters = counters(cpu);
            }
        }
        _ => {}
    }
    sample.load_1m = sample.load.map(|load| load[0]);
    sample
}

pub fn doctor_capacity(
    runner: &mut dyn Runner,
    os: &str,
    sample: &Sample,
) -> (Option<Memory>, Option<Cpu>) {
    let cpu = match os {
        "macos" => {
            let top = runner.run(
                &CmdSpec::new("doctor-host", "top", &["-l", "2", "-s", "1", "-n", "0"], 5)
                    .cwd(Path::new("/"))
                    .env("LC_ALL", "C"),
            );
            successful(&top).and_then(|top| {
                let line = top.lines().rfind(|l| l.starts_with("CPU usage:"))?;
                let idle = line
                    .split(',')
                    .find_map(|s| s.trim().strip_suffix("% idle"))?
                    .parse::<f64>()
                    .ok()
                    .filter(|i| i.is_finite() && (0.0..=100.0).contains(i))?;
                Some(Cpu {
                    load: sample.load?,
                    cores: sample.cores?,
                    idle,
                })
            })
        }
        "linux" => {
            runner.sleep(Duration::from_secs(1));
            let after = runner.run(
                &CmdSpec::new("doctor-host", "cat", &["/proc/stat"], 3)
                    .cwd(Path::new("/"))
                    .env("LC_ALL", "C"),
            );
            successful(&after).and_then(|after| {
                let (total1, idle1) = sample.counters?;
                let (total2, idle2) = counters(after)?;
                let total = total2.checked_sub(total1).filter(|t| *t > 0)?;
                let idle =
                    idle2.checked_sub(idle1).filter(|i| *i <= total)? as f64 * 100.0 / total as f64;
                Some(Cpu {
                    load: sample.load?,
                    cores: cores(after)?,
                    idle,
                })
            })
        }
        _ => None,
    };
    let memory = sample
        .memory()
        .filter(|_| os != "linux" || sample.total_bytes.is_some());
    (memory, cpu)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::MockRunner;

    const VM: &str = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 65536.\nPages speculative: 65536.\nPages inactive: 131072.\nPages occupied by compressor: 1.\n";
    const SYS: &str = "hw.logicalcpu: 8\nvm.loadavg: { 1.0 2.0 3.0 }\nhw.memsize: 25769803776\nkern.memorystatus_vm_pressure_level: 4\nvm.swapusage: total = 2048.00M used = 1024.00M free = 1024.00M (encrypted)\n";

    #[test]
    fn mac_samples_preserve_pressure_levels_and_memory_size_without_idle_probe() {
        for (level, pressure) in [
            (1, Pressure::Normal),
            (2, Pressure::Warning),
            (4, Pressure::Critical),
        ] {
            let mut runner = MockRunner::new();
            runner.expect_run("vm_stat", CmdOutput::success(VM));
            runner.expect_run(
                "sysctl",
                CmdOutput::success(&SYS.replace("level: 4", &format!("level: {level}"))),
            );
            let before = runner.now_epoch_ms();
            let sample = sample(&mut runner, "macos");
            assert_eq!(sample.pressure, Some(pressure));
            assert_eq!(sample.free_bytes, Some(GIB));
            assert_eq!(sample.available_bytes, Some(4 * GIB));
            assert_eq!(sample.total_bytes, Some(24 * GIB));
            assert_eq!(sample.swap_used_bytes, Some(GIB));
            assert_eq!(sample.cores, Some(8));
            assert_eq!(sample.load_1m, Some(1.0));
            assert_eq!(sample.constrained(), pressure != Pressure::Normal);
            assert_eq!(runner.now_epoch_ms(), before);
            assert_eq!(runner.calls.len(), 2);
            assert!(runner.calls.iter().all(|c| c.timeout_seconds == 3
                && c.cwd.as_deref() == Some(Path::new("/"))
                && c.env == vec![("LC_ALL".into(), "C".into())]));
        }
    }

    #[test]
    fn linux_reads_swap_and_cpu_count_in_two_commands_without_sleep() {
        let mut runner = MockRunner::new();
        runner.expect_run("cat /proc/meminfo", CmdOutput::success("MemTotal: 8388608 kB\nMemFree: 1048576 kB\nMemAvailable: 4194304 kB\nSwapTotal: 2097152 kB\nSwapFree: 524288 kB\n"));
        runner.expect_run(
            "cat /proc/loadavg /proc/stat",
            CmdOutput::success("0.1 0.2 0.3 1/100 1\ncpu 100 0 0 100 0 0 0 0\ncpu0 1\ncpu1 1\n"),
        );
        let before = runner.now_epoch_ms();
        let sample = sample(&mut runner, "linux");
        assert_eq!(sample.swap_used_bytes, Some(GIB + GIB / 2));
        assert_eq!(sample.free_bytes, Some(GIB));
        assert_eq!(sample.available_bytes, Some(4 * GIB));
        assert_eq!(sample.total_bytes, Some(8 * GIB));
        assert_eq!(sample.cores, Some(2));
        assert_eq!(sample.pressure, Some(Pressure::Normal));
        assert_eq!(sample.load_1m, Some(0.1));
        assert_eq!(runner.calls.len(), 2);
        assert_eq!(runner.now_epoch_ms(), before);
    }

    #[test]
    fn one_failed_probe_does_not_erase_other_host_facts() {
        let mut runner = MockRunner::new();
        runner.expect_run("vm_stat", CmdOutput::failed(1, "private-path-canary"));
        runner.expect_run("sysctl", CmdOutput::success(SYS));
        let sample = sample(&mut runner, "macos");
        let json = serde_json::to_value(&sample).unwrap();
        assert!(json.get("free_bytes").is_none());
        assert!(json.get("available_bytes").is_none());
        assert_eq!(json["load_1m"], 1.0);
        assert_eq!(json["swap_used_bytes"], GIB);
        assert!(!json.to_string().contains("canary"));
        assert!(sample.summary().contains("unavailable free"));
    }

    #[test]
    fn malformed_fields_never_become_zero_and_valid_zero_swap_is_kept() {
        for text in [
            "used = -1M",
            "used = NaNM",
            "used = infM",
            "used = 1e99M",
            "used = 1X",
            "used = café",
        ] {
            assert_eq!(swap_bytes(text), None, "{text}");
        }
        assert_eq!(swap_bytes("used = 0.00M"), Some(0));
        assert_eq!(swap_bytes("used = 1.5G"), Some(GIB + GIB / 2));
        assert!(loads("NaN 0 0").is_none());
        assert!(loads("-1 0 0").is_none());
        let mut runner = MockRunner::new();
        runner.expect_run(
            "vm_stat",
            CmdOutput::success(&VM.replace("65536.", "18446744073709551615.")),
        );
        runner.expect_run(
            "sysctl",
            CmdOutput::success(
                &SYS.replace("hw.logicalcpu: 8", "hw.logicalcpu: 0")
                    .replace("level: 4", "level: 9")
                    .replace("used = 1024.00M", "used = NaNM"),
            ),
        );
        let json = serde_json::to_value(sample(&mut runner, "macos")).unwrap();
        for key in [
            "free_bytes",
            "available_bytes",
            "cores",
            "pressure",
            "swap_used_bytes",
        ] {
            assert!(json.get(key).is_none(), "{json}");
        }
    }

    #[test]
    fn linux_inconsistent_memory_and_swap_are_absent() {
        let mut runner = MockRunner::new();
        runner.expect_run("cat /proc/meminfo", CmdOutput::success("MemTotal: 1024 kB\nMemFree: 2048 kB\nMemAvailable: 2048 kB\nSwapTotal: 0 kB\nSwapFree: 1 kB\n"));
        runner.expect_run("cat /proc/loadavg", CmdOutput::failed(1, "unavailable"));
        let json = serde_json::to_value(sample(&mut runner, "linux")).unwrap();
        assert_eq!(json, serde_json::json!({ "total_bytes": 1024 * 1024 }));
    }

    #[test]
    fn sample_memory_and_load_thresholds_do_not_need_all_other_fields() {
        let mut sample = Sample::default();
        assert!(!sample.constrained());
        sample.available_bytes = Some(LANE_HEADROOM - 1);
        assert!(sample.constrained());
        sample.available_bytes = Some(LANE_HEADROOM);
        assert!(!sample.constrained());
        sample.load_1m = Some(8.0);
        assert!(!sample.constrained());
        sample.cores = Some(8);
        assert!(sample.constrained());
    }

    #[test]
    fn unsupported_hosts_have_no_probes() {
        let mut runner = MockRunner::new();
        assert_eq!(
            serde_json::to_value(sample(&mut runner, "unsupported")).unwrap(),
            serde_json::json!({})
        );
        assert!(runner.calls.is_empty());
    }

    #[test]
    fn each_lane_needs_its_full_headroom() {
        let mut memory = Memory {
            free: 0,
            available: LANE_HEADROOM - 1,
            compressed: None,
            pressure: Some(false),
        };
        assert_eq!(memory.lanes(), 0);
        assert!(memory.constrained());
        memory.available = LANE_HEADROOM;
        assert_eq!(memory.lanes(), 1);
        assert!(!memory.constrained());
        memory.pressure = Some(true);
        assert!(memory.constrained());
    }

    #[test]
    fn load_or_low_idle_warns_at_the_documented_boundaries() {
        let mut cpu = Cpu {
            load: [7.99, 20.0, 20.0],
            cores: 8,
            idle: 10.0,
        };
        assert!(!cpu.constrained());
        cpu.load[0] = 8.0;
        assert!(cpu.constrained());
        cpu.load[0] = 0.0;
        cpu.idle = 9.99;
        assert!(cpu.constrained());
    }
}
