use super::{Check, Status};
use crate::adapters::ios;
use crate::exec::{CmdOutput, CmdSpec, Runner};
use crate::host_capacity::{Cpu, Memory};
use std::path::Path;
use std::time::Duration;

const GIB: f64 = (1024 * 1024 * 1024) as f64;
const SERVICE_FIX: &str = "ask the device owner to shut down the affected simulator, then re-run doctor; restarting CoreSimulatorService stops every simulator on this machine";
pub(super) const SIMCTL_FIX: &str =
    "run `sudo xcodebuild -runFirstLaunch` or update Xcode, then re-run doctor";

fn probe(runner: &mut dyn Runner, program: &str, args: &[&str], seconds: u64) -> CmdOutput {
    runner.run(
        &CmdSpec::new("doctor-host", program, args, seconds)
            .cwd(Path::new("/"))
            .env("LC_ALL", "C"),
    )
}

pub(super) fn checks(runner: &mut dyn Runner, os: &str) -> Vec<Check> {
    if !matches!(os, "macos" | "linux") {
        return vec![Check::skip(
            "host-memory",
            "host probes support macOS and Linux",
        )];
    }
    let processes = probe(runner, "ps", &["-axww", "-o", "stat=,args="], 3);
    let android = processes.ok().then(|| android_emulators(&processes.stdout));
    let (service, sims) = if os == "macos" {
        simulator_service(runner, &processes)
    } else {
        (
            Check::skip("simulator-service", "iOS simulators require macOS"),
            Some(Vec::new()),
        )
    };
    let devices = device_row(sims.as_deref(), android.as_deref());
    let (memory, cpu) = if os == "macos" {
        macos(runner)
    } else {
        linux(runner)
    };
    vec![service, devices, memory_row(memory, os), cpu_row(cpu)]
}

fn simulator_service(
    runner: &mut dyn Runner,
    processes: &CmdOutput,
) -> (Check, Option<Vec<String>>) {
    let mut spec = ios::list_devices_spec();
    spec.timeout_seconds = 5;
    spec.cwd = Some(Path::new("/").to_path_buf());
    spec = spec.env("LC_ALL", "C");
    let output = runner.run(&spec);
    if output.ok() {
        if let Some(devices) = simulator_devices(&output.stdout) {
            return (
                Check::pass(
                    "simulator-service",
                    "simctl list devices responded within 5s",
                ),
                Some(devices),
            );
        }
    }
    let stuck = if processes.ok() {
        stuck_simulators(&processes.stdout)
    } else {
        Vec::new()
    };
    let evidence = if stuck.is_empty() {
        "affected device unknown; no attributable uninterruptible launchd_sim observed".to_string()
    } else {
        format!(
            "uninterruptible launchd_sim observed for simulator(s): {}",
            stuck.join(", ")
        )
    };
    let detail = if output.timed_out {
        format!("simctl list devices did not respond within 5s; {evidence}")
    } else if output.ok() {
        format!("simctl list devices returned an unreadable inventory; {evidence}")
    } else {
        format!(
            "simctl list devices failed ({}); {evidence}",
            output.summary()
        )
    };
    let status = if output.timed_out && !stuck.is_empty() {
        Status::Fail
    } else {
        Status::Warn
    };
    let fix = if output.timed_out || !stuck.is_empty() {
        SERVICE_FIX
    } else {
        SIMCTL_FIX
    };
    (
        Check::problem("simulator-service", status, detail, fix),
        None,
    )
}

fn simulator_devices(text: &str) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let mut devices = Vec::new();
    for list in value.get("devices")?.as_object()?.values() {
        for device in list.as_array()? {
            if device.get("state")?.as_str()? == "Booted" {
                devices.push(format!(
                    "{} ({})",
                    device.get("name")?.as_str()?,
                    device.get("udid")?.as_str()?
                ));
            }
        }
    }
    Some(devices)
}

fn android_emulators(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            let words: Vec<_> = line.split_whitespace().collect();
            let executable = Path::new(*words.get(1)?).file_name()?.to_str()?;
            if !executable.starts_with("qemu-system-") {
                return None;
            }
            let avd = words.windows(2).find(|pair| pair[0] == "-avd")?[1];
            Some(avd.to_string())
        })
        .collect()
}

fn stuck_simulators(text: &str) -> Vec<String> {
    let mut devices = Vec::new();
    for line in text.lines() {
        let mut words = line.split_whitespace();
        let Some(state) = words.next() else { continue };
        if !state.starts_with('U') || !line.contains("/launchd_sim ") {
            continue;
        }
        for path in line.split_whitespace() {
            if let Some(udid) = path
                .split("/CoreSimulator/Devices/")
                .nth(1)
                .and_then(|rest| rest.split('/').next())
                .and_then(ios::canonical_udid)
            {
                if !devices.contains(&udid) {
                    devices.push(udid);
                }
            }
        }
    }
    devices
}

fn device_row(sims: Option<&[String]>, android: Option<&[String]>) -> Check {
    let describe = |devices: Option<&[String]>| {
        devices.map_or("unknown".into(), |d| {
            format!("{} [{}]", d.len(), d.join(", "))
        })
    };
    let detail = format!(
        "booted simulators: {}; running Android emulators: {} (includes starting emulators)",
        describe(sims),
        describe(android)
    );
    if sims.is_none() || android.is_none() {
        Check::warn("host-devices", detail, "restore the unavailable inventory probe and re-run doctor before choosing concurrent lanes")
    } else {
        Check::pass("host-devices", detail)
    }
}

fn memory_row(memory: Option<Memory>, os: &str) -> Check {
    let Some(memory) = memory else {
        return Check::warn("host-memory", "memory probe unavailable or malformed; lane capacity unknown", "inspect host memory in Activity Monitor (macOS) or free -h (Linux), then re-run doctor");
    };
    let pressure = match memory.pressure {
        Some(true) => "elevated",
        Some(false) => "normal",
        None => "unknown",
    };
    let basis = if os == "macos" {
        "free + speculative + inactive"
    } else {
        "MemAvailable"
    };
    let compressed = memory.compressed.map_or(String::new(), |bytes| {
        format!(", {:.1} GiB compressed", bytes as f64 / GIB)
    });
    let capacity = memory.lanes();
    let detail = format!("{:.1} GiB free, {:.1} GiB headroom ({basis}){compressed}; memory pressure {pressure}; headroom for {capacity} more concurrent lane(s) beyond those booted (2 GiB host reserve + 4 GiB per lane)", memory.free as f64 / GIB, memory.available as f64 / GIB);
    if memory.constrained() || memory.pressure.is_none() {
        Check::warn("host-memory", detail, "use fewer concurrent lanes and close unneeded apps; re-run doctor after pressure returns to normal; coordinate borrowed devices with their owners")
    } else {
        Check::pass("host-memory", detail)
    }
}

fn cpu_row(cpu: Option<Cpu>) -> Check {
    let Some(cpu) = cpu else {
        return Check::warn(
            "host-load",
            "load or CPU idle probe unavailable or malformed",
            "inspect host CPU usage, reduce concurrent lanes, then re-run doctor",
        );
    };
    let detail = format!(
        "load averages {:.2}, {:.2}, {:.2}; {} logical CPUs; {:.1}% CPU idle",
        cpu.load[0], cpu.load[1], cpu.load[2], cpu.cores, cpu.idle
    );
    if cpu.constrained() {
        Check::warn("host-load", format!("{detail}; readiness deadlines may expire"), "run fewer concurrent lanes and wait for builds or other CPU-heavy work to finish before retrying")
    } else {
        Check::pass("host-load", detail)
    }
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

fn macos(runner: &mut dyn Runner) -> (Option<Memory>, Option<Cpu>) {
    let vm = probe(runner, "vm_stat", &[], 3);
    let sys = probe(
        runner,
        "sysctl",
        &[
            "hw.logicalcpu",
            "vm.loadavg",
            "kern.memorystatus_vm_pressure_level",
        ],
        3,
    );
    let top = probe(runner, "top", &["-l", "2", "-s", "1", "-n", "0"], 5);
    let memory = successful(&vm).and_then(|vm| {
        let page = vm
            .lines()
            .next()?
            .split("page size of ")
            .nth(1)?
            .split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()
            .filter(|p| *p > 0)?;
        let free = field(vm, "Pages free")?.checked_mul(page)?;
        let available = field(vm, "Pages speculative")?
            .checked_add(field(vm, "Pages inactive")?)?
            .checked_mul(page)?
            .checked_add(free)?;
        let pressure =
            successful(&sys).and_then(|s| match field(s, "kern.memorystatus_vm_pressure_level")? {
                1 => Some(false),
                2 | 4 => Some(true),
                _ => None,
            });
        Some(Memory {
            free,
            available,
            compressed: field(vm, "Pages occupied by compressor").and_then(|v| v.checked_mul(page)),
            pressure,
        })
    });
    let cpu = successful(&sys)
        .zip(successful(&top))
        .and_then(|(sys, top)| {
            let load = loads(sys.lines().find_map(|l| l.strip_prefix("vm.loadavg:"))?)?;
            let cores = usize::try_from(field(sys, "hw.logicalcpu")?)
                .ok()
                .filter(|c| *c > 0)?;
            let line = top.lines().filter(|l| l.starts_with("CPU usage:")).last()?;
            let idle = line
                .split(',')
                .find_map(|s| s.trim().strip_suffix("% idle"))?
                .parse::<f64>()
                .ok()
                .filter(|i| i.is_finite() && (0.0..=100.0).contains(i))?;
            Some(Cpu { load, cores, idle })
        });
    (memory, cpu)
}

fn linux(runner: &mut dyn Runner) -> (Option<Memory>, Option<Cpu>) {
    let mem = probe(runner, "cat", &["/proc/meminfo"], 3);
    let load = probe(runner, "cat", &["/proc/loadavg"], 3);
    let before = probe(runner, "cat", &["/proc/stat"], 3);
    runner.sleep(Duration::from_secs(1));
    let after = probe(runner, "cat", &["/proc/stat"], 3);
    let memory = successful(&mem).and_then(|mem| {
        let free = field(mem, "MemFree")?.checked_mul(1024)?;
        let available = field(mem, "MemAvailable")?.checked_mul(1024)?;
        let total = field(mem, "MemTotal")?.checked_mul(1024)?;
        if free > total || available > total || total == 0 {
            return None;
        }
        Some(Memory {
            free,
            available,
            compressed: None,
            pressure: Some(available < total / 10),
        })
    });
    let cpu = successful(&before)
        .zip(successful(&after))
        .zip(successful(&load))
        .and_then(|((before, after), load)| {
            let counters = |text: &str| -> Option<(u64, u64)> {
                let values = text
                    .lines()
                    .next()?
                    .strip_prefix("cpu ")?
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
            };
            let (total1, idle1) = counters(before)?;
            let (total2, idle2) = counters(after)?;
            let total = total2.checked_sub(total1).filter(|t| *t > 0)?;
            let idle =
                idle2.checked_sub(idle1).filter(|i| *i <= total)? as f64 * 100.0 / total as f64;
            let cores = after
                .lines()
                .filter(|l| {
                    l.strip_prefix("cpu")
                        .is_some_and(|s| s.starts_with(|c: char| c.is_ascii_digit()))
                })
                .count();
            if cores == 0 {
                return None;
            }
            Some(Cpu {
                load: loads(load)?,
                cores,
                idle,
            })
        });
    (memory, cpu)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::MockRunner;

    const UDID: &str = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const VM: &str = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 655360.\nPages inactive: 0.\nPages speculative: 0.\nPages occupied by compressor: 786432.\n";
    const SYS: &str =
        "hw.logicalcpu: 8\nvm.loadavg: { 1.0 2.0 3.0 }\nkern.memorystatus_vm_pressure_level: 1\n";

    fn row<'a>(rows: &'a [Check], id: &str) -> &'a Check {
        rows.iter().find(|r| r.id == id).unwrap()
    }

    fn script_mac(
        runner: &mut MockRunner,
        processes: &str,
        inventory: CmdOutput,
        vm: &str,
        sys: &str,
        top: &str,
    ) {
        runner.expect_run("ps -axww -o stat=,args=", CmdOutput::success(processes));
        runner.expect_run("simctl list devices -j", inventory);
        runner.expect_run("vm_stat", CmdOutput::success(vm));
        runner.expect_run("sysctl", CmdOutput::success(sys));
        runner.expect_run("top -l 2 -s 1 -n 0", CmdOutput::success(top));
    }

    fn inventory() -> CmdOutput {
        CmdOutput::success(&format!(
            r#"{{"devices":{{"ios":[{{"name":"iPhone","udid":"{UDID}","state":"Booted"}},{{"name":"other","udid":"other","state":"Shutdown"}}]}}}}"#
        ))
    }

    #[test]
    fn mac_reports_both_platforms_and_uses_the_second_idle_sample() {
        let mut runner = MockRunner::new();
        script_mac(&mut runner, "S /sdk/qemu-system-aarch64 -avd Pixel\nS /sdk/emulator -avd Pixel\nS /usr/bin/qemu-system-x86_64 -drive server.img\n", inventory(), VM, SYS, "CPU usage: 90% user, 5% sys, 5% idle\nCPU usage: 2% user, 3% sys, 95% idle\n");
        let rows = checks(&mut runner, "macos");
        assert!(rows.iter().all(|r| r.status == Status::Pass), "{rows:?}");
        assert!(row(&rows, "host-devices")
            .detail
            .contains("booted simulators: 1 [iPhone"));
        assert!(row(&rows, "host-devices")
            .detail
            .contains("Android emulators: 1 [Pixel]"));
        let memory = &row(&rows, "host-memory").detail;
        assert!(memory.contains("12.0 GiB compressed"));
        assert!(memory.contains("headroom for 2 more concurrent lane(s)"));
        assert!(row(&rows, "host-load").detail.contains("95.0% CPU idle"));
        assert_eq!(runner.remaining(), 0);
        assert!(runner
            .calls
            .iter()
            .all(|s| (1..=5).contains(&s.timeout_seconds)));
        assert!(runner
            .calls
            .iter()
            .all(|s| s.cwd.as_deref() == Some(Path::new("/"))));
    }

    #[test]
    fn field_memory_and_load_conditions_warn_without_failing() {
        let mut runner = MockRunner::new();
        script_mac(
            &mut runner,
            "S /sdk/qemu-system-aarch64 -avd Pixel\n",
            inventory(),
            &VM.replace("655360", "11072"),
            &SYS.replace("1.0 2.0 3.0", "94.0 100.0 120.0")
                .replace("level: 1", "level: 2"),
            "CPU usage: 96% user, 2% sys, 2% idle\n",
        );
        let rows = checks(&mut runner, "macos");
        assert_eq!(row(&rows, "host-memory").status, Status::Warn);
        assert!(row(&rows, "host-memory")
            .detail
            .contains("pressure elevated"));
        assert!(row(&rows, "host-memory")
            .detail
            .contains("headroom for 0 more concurrent lane(s)"));
        assert_eq!(row(&rows, "host-load").status, Status::Warn);
        assert!(row(&rows, "host-load")
            .detail
            .contains("readiness deadlines may expire"));
        assert!(!rows.iter().any(|r| r.status == Status::Fail));
    }

    #[test]
    fn only_timeout_with_attributable_uninterruptible_simulator_evidence_fails() {
        for (state, expected) in [("U", Status::Fail), ("S", Status::Warn)] {
            let mut runner = MockRunner::new();
            script_mac(&mut runner, &format!("{state} /runtime/launchd_sim /Users/example/Library/Developer/CoreSimulator/Devices/{UDID}/data\n"), CmdOutput { timed_out: true, ..Default::default() }, VM, SYS, "CPU usage: 2% user, 3% sys, 95% idle\n");
            let rows = checks(&mut runner, "macos");
            let service = row(&rows, "simulator-service");
            assert_eq!(service.status, expected);
            assert!(service.detail.contains("within 5s"));
            assert_eq!(service.detail.contains(UDID), expected == Status::Fail);
            assert!(service
                .fix
                .as_deref()
                .unwrap()
                .contains("stops every simulator"));
            assert_eq!(row(&rows, "host-devices").status, Status::Warn);
            assert_eq!(row(&rows, "host-memory").status, Status::Pass);
            assert!(runner.calls.iter().all(|c| !c
                .args
                .iter()
                .any(|a| ["shutdown", "boot", "erase", "kill"].contains(&a.as_str()))));
        }
    }

    #[test]
    fn a_failing_simctl_without_a_timeout_names_its_error_and_the_xcode_fix() {
        let mut runner = MockRunner::new();
        script_mac(
            &mut runner,
            "",
            CmdOutput::failed(1, "CoreSimulator is out of date"),
            VM,
            SYS,
            "CPU usage: 2% user, 3% sys, 95% idle\n",
        );
        let rows = checks(&mut runner, "macos");
        let service = row(&rows, "simulator-service");
        assert_eq!(service.status, Status::Warn);
        assert!(service.detail.contains("CoreSimulator is out of date"));
        assert_eq!(service.fix.as_deref(), Some(SIMCTL_FIX));
    }

    #[test]
    fn inactive_pages_count_as_headroom_on_a_mac_at_normal_pressure() {
        let mut runner = MockRunner::new();
        script_mac(
            &mut runner,
            "",
            inventory(),
            "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 9868.\nPages active: 549432.\nPages inactive: 531155.\nPages speculative: 6261.\nPages purgeable: 132.\n",
            SYS,
            "CPU usage: 2% user, 3% sys, 95% idle\n",
        );
        let rows = checks(&mut runner, "macos");
        let memory = row(&rows, "host-memory");
        assert_eq!(memory.status, Status::Pass, "{memory:?}");
        assert!(memory
            .detail
            .contains("8.4 GiB headroom (free + speculative + inactive)"));
        assert!(memory
            .detail
            .contains("headroom for 1 more concurrent lane(s)"));
    }

    #[test]
    fn failed_or_malformed_probes_never_manufacture_a_pass() {
        let mut runner = MockRunner::new();
        runner.expect_run("ps", CmdOutput::failed(1, "private process arguments"));
        runner.expect_run("simctl", CmdOutput::success("{}"));
        runner.expect_run("vm_stat", CmdOutput::success("invalid"));
        runner.expect_run("sysctl", CmdOutput::failed(1, "missing"));
        runner.expect_run("top", CmdOutput::success("invalid"));
        let rows = checks(&mut runner, "macos");
        assert!(rows.iter().all(|r| r.status == Status::Warn));
        assert!(!format!("{rows:?}").contains("private process arguments"));
        assert!(row(&rows, "host-devices").detail.contains("unknown"));
    }

    fn script_linux(runner: &mut MockRunner, mem: &str, after: &str) {
        runner.expect_run(
            "ps",
            CmdOutput::success("S /sdk/qemu-system-x86_64 -avd Pixel\n"),
        );
        runner.expect_run("cat /proc/meminfo", CmdOutput::success(mem));
        runner.expect_run(
            "cat /proc/loadavg",
            CmdOutput::success("0.1 0.2 0.3 1/100 1\n"),
        );
        runner.expect_run(
            "cat /proc/stat",
            CmdOutput::success("cpu  100 0 0 100 0 0 0 0 99 0\ncpu0 1\ncpu1 1\n"),
        );
        runner.expect_run("cat /proc/stat", CmdOutput::success(after));
    }

    #[test]
    fn linux_counts_android_and_samples_idle_without_double_counting_guest_time() {
        let mut runner = MockRunner::new();
        script_linux(
            &mut runner,
            "MemTotal: 16777216 kB\nMemFree: 1048576 kB\nMemAvailable: 8388608 kB\n",
            "cpu  110 0 0 190 0 0 0 0 109 0\ncpu0 1\ncpu1 1\n",
        );
        let rows = checks(&mut runner, "linux");
        assert_eq!(row(&rows, "simulator-service").status, Status::Skip);
        assert_eq!(row(&rows, "host-memory").status, Status::Pass);
        assert!(row(&rows, "host-memory")
            .detail
            .contains("8.0 GiB headroom (MemAvailable)"));
        assert!(row(&rows, "host-load").detail.contains("90.0% CPU idle"));
        assert!(!runner
            .calls
            .iter()
            .any(|c| ["xcrun", "adb"].contains(&c.program.as_str())));
        assert_eq!(runner.remaining(), 0);
    }

    #[test]
    fn linux_missing_memavailable_and_reversed_cpu_counters_warn() {
        let mut runner = MockRunner::new();
        script_linux(
            &mut runner,
            "MemTotal: 16777216 kB\nMemFree: 1048576 kB\n",
            "cpu  1 0 0 1\ncpu0 1\n",
        );
        let rows = checks(&mut runner, "linux");
        assert_eq!(row(&rows, "host-memory").status, Status::Warn);
        assert_eq!(row(&rows, "host-load").status, Status::Warn);
        assert!(loads("NaN 0 0").is_none());
        assert!(loads("-1 0 0").is_none());
    }
}
