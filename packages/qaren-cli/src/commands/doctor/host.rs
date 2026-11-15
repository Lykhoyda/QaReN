use super::{Check, Status};
use crate::adapters::ios;
use crate::device_helpers;
use crate::exec::{CmdOutput, CmdSpec, Runner};
use crate::host_capacity::{self, Cpu, Memory};
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
    let processes = probe(
        runner,
        "ps",
        &["-axww", "-o", device_helpers::PROCESS_COLUMNS],
        3,
    );
    let list = processes
        .ok()
        .then(|| device_helpers::parse(&processes.stdout))
        .flatten();
    let android = list.as_ref().map(android_emulators);
    let helpers = helper_row(runner, &processes);
    let (service, sims) = if os == "macos" {
        simulator_service(runner, list.as_ref())
    } else {
        (
            Check::skip("simulator-service", "iOS simulators require macOS"),
            Some(Vec::new()),
        )
    };
    let devices = device_row(sims.as_deref(), android.as_deref());
    let sample = host_capacity::sample(runner, os);
    let (memory, cpu) = host_capacity::doctor_capacity(runner, os, &sample);
    vec![
        service,
        devices,
        helpers,
        memory_row(memory, os),
        cpu_row(cpu),
    ]
}

const HELPER_LIMIT: &str = "while any emulator runs or starts, every helper counts as served by it";

fn helper_row(runner: &mut dyn Runner, processes: &CmdOutput) -> Check {
    let scan = processes
        .ok()
        .then(|| device_helpers::findings(runner, "doctor-host", &processes.stdout))
        .flatten();
    let Some(scan) = scan else {
        return Check::warn(
            "device-helpers",
            "process list unavailable or unreadable; emulator helper processes unknown",
            "restore the process list probe and re-run doctor",
        );
    };
    let mut detail: Vec<_> = scan.helpers.iter().map(|f| f.describe()).collect();
    if !scan.complete {
        detail
            .push("process list incomplete: an unreadable line may hide a running emulator".into());
    }
    if detail.is_empty() {
        return Check::pass(
            "device-helpers",
            format!("no Android emulator helper left behind or above 100% CPU; {HELPER_LIMIT}"),
        );
    }
    let commands: Vec<_> = scan
        .helpers
        .iter()
        .map(|f| format!("`{}`", f.stop_command()))
        .collect();
    let fix = if commands.is_empty() {
        "re-run doctor once the process list reads in full".to_string()
    } else {
        format!(
            "QaReN did not start these and stops nothing; stop each one: {}",
            commands.join(", ")
        )
    };
    Check::warn(
        "device-helpers",
        format!("{}; {HELPER_LIMIT}", detail.join("; ")),
        fix,
    )
}

fn simulator_service(
    runner: &mut dyn Runner,
    processes: Option<&device_helpers::ProcessList>,
) -> (Check, Option<Vec<String>>) {
    let inventory = ios::read_inventory(
        runner,
        ios::InventoryRead {
            attempts: 1,
            per_read_timeout: Duration::from_secs(5),
            pause: Duration::ZERO,
            deadline_ms: None,
            cwd: Some(Path::new("/").to_path_buf()),
            env: vec![("LC_ALL".into(), "C".into())],
            between: &mut |_| Ok(()),
        },
    );
    let latency_ms = match &inventory {
        Ok(inventory) => inventory.latency_ms,
        Err(unavailable) => unavailable.latency_ms,
    };
    let unavailable = match inventory {
        Ok(inventory) => {
            if let Some(devices) = simulator_devices(&inventory.value) {
                return (
                    Check::pass(
                        "simulator-service",
                        format!(
                            "simctl list devices responded within 5s; latency {} ms",
                            inventory.latency_ms
                        ),
                    ),
                    Some(devices),
                );
            }
            None
        }
        Err(unavailable) => Some(unavailable),
    };
    if let Some(ios::InventoryUnavailable {
        last: ios::InventoryReadLast::Failed { summary, .. },
        ..
    }) = &unavailable
    {
        return (
            Check::fail(
                "simulator-service",
                format!("simctl list devices failed ({summary}); inventory unavailable; latency {latency_ms} ms"),
                SIMCTL_FIX,
            ),
            None,
        );
    }
    let timed_out = unavailable.as_ref().is_some_and(|unavailable| {
        matches!(unavailable.last, ios::InventoryReadLast::TimedOut { .. })
    });
    let stuck = processes.map_or_else(Vec::new, stuck_simulators);
    let evidence = if stuck.is_empty() {
        "affected device unknown; no attributable uninterruptible launchd_sim observed".to_string()
    } else {
        format!(
            "uninterruptible launchd_sim observed for simulator(s): {}",
            stuck.join(", ")
        )
    };
    let detail = if timed_out {
        format!(
            "simctl list devices did not respond within 5s; latency {latency_ms} ms; {evidence}"
        )
    } else {
        format!("simctl list devices returned an unreadable inventory; latency {latency_ms} ms; {evidence}")
    };
    let status = if timed_out && !stuck.is_empty() {
        Status::Fail
    } else {
        Status::Warn
    };
    let fix = if timed_out || !stuck.is_empty() {
        SERVICE_FIX
    } else {
        SIMCTL_FIX
    };
    (
        Check::problem("simulator-service", status, detail, fix),
        None,
    )
}

fn simulator_devices(value: &serde_json::Value) -> Option<Vec<String>> {
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

fn android_emulators(list: &device_helpers::ProcessList) -> Vec<String> {
    list.rows
        .iter()
        .filter_map(|row| Some(row.emulator_avd()?.to_string()))
        .collect()
}

fn stuck_simulators(list: &device_helpers::ProcessList) -> Vec<String> {
    let mut devices = Vec::new();
    for row in &list.rows {
        if !row.stat.starts_with('U') || row.ucomm != "launchd_sim" {
            continue;
        }
        for path in row.args.split_whitespace() {
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
    let detail = format!("{:.1} GiB free, {:.1} GiB headroom ({basis}){compressed}; memory pressure {pressure}; headroom for {capacity} more concurrent lane(s) beyond those booted (4 GiB per lane: simulator, app and Metro share)", memory.free as f64 / GIB, memory.available as f64 / GIB);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_helpers::ps_line as ps;
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
        runner.expect_run(
            "ps -axww -o pid=,ppid=,uid=,pcpu=,stat=,lstart=,ucomm=,args=",
            CmdOutput::success(processes),
        );
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
    fn inventory_read_has_doctors_budget_context_and_measured_latency() {
        let mut runner = MockRunner::new();
        runner.advance_on = Some(("simctl list".into(), 1200));
        runner.expect_run("simctl list", inventory());
        let (service, devices) = simulator_service(&mut runner, None);
        assert_eq!(service.status, Status::Pass);
        assert!(service.detail.contains("latency 1200 ms"));
        assert_eq!(devices.unwrap(), vec![format!("iPhone ({UDID})")]);
        assert_eq!(runner.calls.len(), 1);
        assert_eq!(runner.calls[0].timeout_seconds, 5);
        assert_eq!(runner.calls[0].cwd.as_deref(), Some(Path::new("/")));
        assert_eq!(runner.calls[0].env, vec![("LC_ALL".into(), "C".into())]);
    }

    #[test]
    fn failed_inventory_diagnoses_keep_measured_latency() {
        for (output, status, fix, diagnosis) in [
            (
                CmdOutput::failed(1, "CoreSimulator is out of date"),
                Status::Fail,
                SIMCTL_FIX,
                "failed",
            ),
            (
                CmdOutput {
                    timed_out: true,
                    ..Default::default()
                },
                Status::Warn,
                SERVICE_FIX,
                "did not respond",
            ),
            (
                CmdOutput::success("{}"),
                Status::Warn,
                SIMCTL_FIX,
                "unreadable inventory",
            ),
            (
                CmdOutput::success(r#"{"devices":{"runtime":null}}"#),
                Status::Warn,
                SIMCTL_FIX,
                "unreadable inventory",
            ),
            (
                CmdOutput::success(r#"{"devices":{"runtime":[{}]}}"#),
                Status::Warn,
                SIMCTL_FIX,
                "unreadable inventory",
            ),
        ] {
            let mut runner = MockRunner::new();
            runner.advance_on = Some(("simctl list".into(), 4321));
            runner.expect_run("simctl list", output);
            let (service, devices) = simulator_service(&mut runner, None);
            assert_eq!(service.status, status);
            assert_eq!(service.fix.as_deref(), Some(fix));
            assert!(service.detail.contains(diagnosis));
            assert!(service.detail.contains("latency 4321 ms"));
            assert!(devices.is_none());
            assert_eq!(runner.calls.len(), 1);
        }
    }

    #[test]
    fn unreadable_inventory_including_stderr_and_size_uses_the_xcode_fix() {
        for output in [
            CmdOutput::success("{}"),
            CmdOutput::success("{\"devices\":[]}"),
            CmdOutput::success(&" ".repeat(1024 * 1024)),
            CmdOutput {
                stderr: "warning-canary".into(),
                ..inventory()
            },
        ] {
            let mut runner = MockRunner::new();
            runner.expect_run("simctl list", output);
            let (service, devices) = simulator_service(&mut runner, None);
            assert_eq!(service.status, Status::Warn);
            assert!(service.detail.contains("unreadable inventory"));
            assert!(!service.detail.contains("warning-canary"));
            assert_eq!(service.fix.as_deref(), Some(SIMCTL_FIX));
            assert!(devices.is_none());
            assert_eq!(runner.calls.len(), 1);
        }
    }

    #[test]
    fn unreadable_inventory_with_a_stuck_simulator_keeps_the_service_fix() {
        let mut runner = MockRunner::new();
        runner.expect_run("simctl list", CmdOutput::success("{}"));
        let text = ps(77, 1, "0.0", "U", "launchd_sim", &format!("/runtime/launchd_sim /Users/example/Library/Developer/CoreSimulator/Devices/{UDID}/data"));
        let processes = device_helpers::parse(&text);
        let (service, _) = simulator_service(&mut runner, processes.as_ref());
        assert_eq!(service.status, Status::Warn);
        assert!(service.detail.contains("unreadable inventory"));
        assert_eq!(service.fix.as_deref(), Some(SERVICE_FIX));
    }

    #[test]
    fn mac_reports_both_platforms_and_uses_the_second_idle_sample() {
        let mut runner = MockRunner::new();
        let processes = [
            ps(
                900,
                1,
                "40.0",
                "S",
                "qemu-system-aar",
                "/sdk/qemu-system-aarch64 -avd Pixel",
            ),
            ps(899, 1, "0.1", "S", "emulator", "/sdk/emulator -avd Pixel"),
            ps(
                901,
                1,
                "0.0",
                "S",
                "qemu-system-x86",
                "/usr/bin/qemu-system-x86_64 -drive server.img",
            ),
        ]
        .concat();
        script_mac(
            &mut runner,
            &processes,
            inventory(),
            VM,
            SYS,
            "CPU usage: 90% user, 5% sys, 5% idle\nCPU usage: 2% user, 3% sys, 95% idle\n",
        );
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

    const IDLE: &str = "CPU usage: 2% user, 3% sys, 95% idle\n";
    const SDK: &str = "/Volumes/External SSD/Android/sdk/emulator";
    const PACKAGE: &str = "Pkg.Desc=Android Emulator\nPkg.Path=emulator\n";

    fn emulator() -> String {
        ps(
            900,
            1,
            "40.0",
            "S",
            "qemu-system-aar",
            &format!("{SDK}/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel"),
        )
    }

    fn helper(pid: i64, ppid: i64, cpu: &str, ucomm: &str, file: &str) -> String {
        ps(
            pid,
            ppid,
            cpu,
            "S",
            ucomm,
            &format!("{SDK}/{file} --token=private-canary"),
        )
    }

    // Doctor's process list, then one package-file answer per folder read, then the other probes.
    fn helper_row(processes: &str, packages: &[(&str, CmdOutput)]) -> Check {
        let mut runner = MockRunner::new();
        runner.expect_run("ps -axww", CmdOutput::success(processes));
        for (folder, answer) in packages {
            runner.expect_run(
                &format!("head -c 4096 {folder}/source.properties"),
                answer.clone(),
            );
        }
        runner.expect_run("simctl list devices -j", inventory());
        runner.expect_run("vm_stat", CmdOutput::success(VM));
        runner.expect_run("sysctl", CmdOutput::success(SYS));
        runner.expect_run("top -l 2 -s 1 -n 0", CmdOutput::success(IDLE));
        let rows = checks(&mut runner, "macos");
        assert_eq!(runner.remaining(), 0);
        assert!(runner.calls.iter().all(|c| c.program != "kill"));
        assert!(runner
            .calls
            .iter()
            .filter(|c| c.program == "head")
            .all(|c| c.label == "doctor-host" && c.timeout_seconds == 2));
        row(&rows, "device-helpers").clone()
    }

    #[test]
    fn e1_helpers_without_their_emulator_warn_and_are_named_with_their_stop_command() {
        let processes = [
            helper(4242, 1, "0.5", "netsimd", "netsimd"),
            helper(4243, 1, "0.0", "crashpad_handler", "crashpad_handler"),
            ps(
                4245,
                1,
                "0.0",
                "S",
                "vim",
                &format!("/usr/bin/vim {SDK}/netsimd"),
            ),
        ]
        .concat();
        let check = helper_row(&processes, &[(SDK, CmdOutput::success(PACKAGE))]);
        assert_eq!(check.status, Status::Warn, "{check:?}");
        assert!(
            check.detail.contains("netsimd (pid 4242, 0.5% CPU)"),
            "{}",
            check.detail
        );
        assert!(check
            .detail
            .contains("crashpad_handler (pid 4243, 0.0% CPU)"));
        assert!(check.detail.contains("emulator is not running"));
        assert!(check.detail.contains("every helper counts as served"));
        let fix = check.fix.unwrap();
        assert!(
            fix.contains("kill 4242") && fix.contains("kill 4243"),
            "{fix}"
        );
        for text in [&check.detail, &fix] {
            assert!(!text.contains("4245"), "{text}");
            assert!(!text.contains("Volumes") && !text.contains("private-canary"));
        }
    }

    #[test]
    fn same_named_processes_outside_the_emulator_package_are_not_reported() {
        let other = "/Applications/Other App.app/Contents/Frameworks";
        let processes = [
            ps(
                4244,
                1,
                "0.0",
                "S",
                "crashpad_handle",
                &format!("{other}/crashpad_handler --database=/x/emulator/y"),
            ),
            ps(4247, 1, "960.0", "S", "netsimd", "/opt/tools/netsimd"),
            ps(4248, 1, "960.0", "S", "netsimd", "netsimd -s"),
        ]
        .concat();
        let check = helper_row(
            &processes,
            &[
                (other, CmdOutput::failed(1, "No such file or directory")),
                (
                    "/opt/tools",
                    CmdOutput::success("Pkg.Path=platform-tools\n"),
                ),
            ],
        );
        assert_eq!(check.status, Status::Pass, "{check:?}");
        assert!(check.detail.contains("every helper counts as served"));
    }

    #[test]
    fn e2_helpers_beside_their_running_emulator_at_low_cpu_pass() {
        let processes = [
            emulator(),
            helper(4242, 900, "12.5", "netsimd", "netsimd"),
            helper(4243, 900, "0.1", "crashpad_handle", "crashpad_handler"),
        ]
        .concat();
        let check = helper_row(&processes, &[]);
        assert_eq!(check.status, Status::Pass, "{check:?}");
        assert!(check.fix.is_none());
    }

    #[test]
    fn e3_a_helper_of_a_running_emulator_above_100_percent_cpu_warns() {
        let processes = [
            emulator(),
            helper(4242, 900, "960.0", "netsimd", "netsimd"),
            helper(4246, 900, "100.0", "netsimd", "netsimd"),
        ]
        .concat();
        let check = helper_row(&processes, &[(SDK, CmdOutput::success(PACKAGE))]);
        assert_eq!(check.status, Status::Warn, "{check:?}");
        assert!(
            check.detail.contains("netsimd (pid 4242, 960.0% CPU)"),
            "{}",
            check.detail
        );
        assert!(check.detail.contains("above 100% CPU"));
        assert!(!check.detail.contains("emulator is not running"));
        assert!(!check.detail.contains("4246"), "{}", check.detail);
        assert!(check.fix.unwrap().contains("kill 4242"));
    }

    #[test]
    fn an_incomplete_process_list_warns_even_without_a_helper() {
        let processes = format!("{}   77     1   501  1.0 S\n", emulator());
        let check = helper_row(&processes, &[]);
        assert_eq!(check.status, Status::Warn, "{check:?}");
        assert!(check.detail.contains("process list incomplete"));
        assert!(check.fix.unwrap().contains("re-run doctor"));
    }

    #[test]
    fn emulator_inventory_handles_sdk_paths_with_spaces() {
        for executable in ["qemu-system-aarch64", "qemu-system-aar"] {
            let mut runner = MockRunner::new();
            let processes = [
                ps(
                    900,
                    1,
                    "40.0",
                    "S",
                    executable,
                    &format!("{SDK}/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel"),
                ),
                ps(
                    899,
                    1,
                    "0.1",
                    "S",
                    "emulator",
                    &format!("{SDK}/emulator -avd Pixel"),
                ),
                ps(
                    901,
                    1,
                    "0.0",
                    "S",
                    "qemu-system-x86",
                    "/usr/bin/qemu-system-x86_64 -drive server.img",
                ),
                ps(
                    902,
                    1,
                    "0.0",
                    "S",
                    "sh",
                    "/bin/sh -c /sdk/qemu-system-aarch64 -avd Other",
                ),
            ]
            .concat();
            script_mac(&mut runner, &processes, inventory(), VM, SYS, IDLE);
            let rows = checks(&mut runner, "macos");
            let devices = row(&rows, "host-devices");
            assert_eq!(devices.status, Status::Pass);
            assert!(
                devices.detail.contains("Android emulators: 1 [Pixel]"),
                "{}",
                devices.detail
            );
            assert_eq!(runner.remaining(), 0);
        }
    }

    #[test]
    fn field_memory_and_load_conditions_warn_without_failing() {
        let mut runner = MockRunner::new();
        script_mac(
            &mut runner,
            &ps(
                900,
                1,
                "40.0",
                "S",
                "qemu-system-aar",
                "/sdk/qemu-system-aarch64 -avd Pixel",
            ),
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
        for (state, process_name, argv0, expected) in [
            ("U", "launchd_sim", "launchd_sim", Status::Fail),
            ("U", "launchd_sim", "/runtime/launchd_sim", Status::Fail),
            ("S", "launchd_sim", "launchd_sim", Status::Warn),
            ("U", "sh", "/runtime/launchd_sim", Status::Warn),
        ] {
            let mut runner = MockRunner::new();
            let processes = ps(
                77,
                1,
                "0.0",
                state,
                process_name,
                &format!(
                    "{argv0} /Users/example/Library/Developer/CoreSimulator/Devices/{UDID}/data"
                ),
            );
            script_mac(
                &mut runner,
                &processes,
                CmdOutput {
                    timed_out: true,
                    ..Default::default()
                },
                VM,
                SYS,
                IDLE,
            );
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
        for processes in [
            String::new(),
            ps(77, 1, "0.0", "U", "launchd_sim", &format!("/runtime/launchd_sim /Users/example/Library/Developer/CoreSimulator/Devices/{UDID}/data")),
        ] {
            let mut runner = MockRunner::new();
            script_mac(
                &mut runner,
                &processes,
                CmdOutput::failed(1, "CoreSimulator is out of date"),
                VM,
                SYS,
                "CPU usage: 2% user, 3% sys, 95% idle\n",
            );
            let rows = checks(&mut runner, "macos");
            let service = row(&rows, "simulator-service");
            assert_eq!(service.status, Status::Fail);
            assert!(service.detail.contains("CoreSimulator is out of date"));
            assert_eq!(service.fix.as_deref(), Some(SIMCTL_FIX));
            assert_eq!(row(&rows, "host-devices").status, Status::Warn);
        }
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
            .contains("headroom for 2 more concurrent lane(s)"));
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
            CmdOutput::success(&ps(
                900,
                1,
                "40.0",
                "S",
                "qemu-system-x86",
                "/sdk/qemu-system-x86_64 -avd Pixel",
            )),
        );
        runner.expect_run("cat /proc/meminfo", CmdOutput::success(mem));
        runner.expect_run(
            "cat /proc/loadavg",
            CmdOutput::success(
                "0.1 0.2 0.3 1/100 1\ncpu  100 0 0 100 0 0 0 0 99 0\ncpu0 1\ncpu1 1\n",
            ),
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
    }
}
