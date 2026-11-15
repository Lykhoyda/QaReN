use super::IosBuildRunner;
use qaren::exec::{CmdOutput, CmdSpec, PipedChild, PrivateOutput, Runner, Spawned};
use std::path::Path;
use std::time::Duration;

pub struct HostRunner {
    pub inner: IosBuildRunner,
    pub calls: Vec<CmdSpec>,
    pub end_load: f64,
    pub malformed: bool,
    pub timeout: bool,
    pub low_end_memory: bool,
    // (macOS pressure level, free KiB) for each sample after the start; the last one repeats.
    // Level 0 fails the sysctl probe and 0 KiB fails the vm_stat probe.
    pub memory: Vec<(u8, u64)>,
    pub os: Option<&'static str>,
    pub runs_root: Option<std::path::PathBuf>,
    // The scripted clock at each sample.
    pub sampled_at: Vec<u64>,
    probes: usize,
}

impl HostRunner {
    pub fn new(inner: IosBuildRunner) -> Self {
        Self {
            inner,
            calls: Vec::new(),
            end_load: 12.0,
            malformed: false,
            timeout: false,
            low_end_memory: false,
            memory: Vec::new(),
            os: None,
            runs_root: None,
            sampled_at: Vec::new(),
            probes: 0,
        }
    }

    pub fn samples(&self) -> usize {
        self.calls
            .iter()
            .filter(|c| c.label == "host-sample")
            .count()
            / 2
    }
}

impl Runner for HostRunner {
    fn env_var(&self, name: &str) -> Option<String> {
        self.inner.env_var(name)
    }
    fn env_names(&self) -> Vec<String> {
        self.inner.env_names()
    }
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        self.calls.push(spec.clone());
        if spec.label != "host-sample" {
            return self.inner.execute(spec, interruptible);
        }
        if let Some(observe) = &mut self.inner.observe {
            observe(spec);
        }
        if let Some(Ok(dir)) = self.runs_root.as_ref().map(std::fs::read_dir) {
            for run in dir.filter_map(|e| e.ok()) {
                let id = run.file_name().to_string_lossy().into_owned();
                if let Ok(record) =
                    qaren::runrecord::RunRecord::load(self.runs_root.as_ref().unwrap(), &id)
                {
                    assert!(
                        record.resources.build_lock.as_ref().is_none_or(|lock| {
                            qaren::buildplan::read_holder(&lock.lock_dir)
                                .is_none_or(|held| held.run_id != id)
                        }),
                        "host sampled while {id} holds the build lock"
                    );
                }
            }
        }
        if self.probes % 2 == 0 {
            self.sampled_at.push(self.inner.now_epoch_ms());
        }
        let index = self.probes / 2;
        let at_end = index >= 1;
        let load = if at_end { self.end_load } else { 1.0 };
        let scripted = (at_end && !self.memory.is_empty())
            .then(|| self.memory[(index - 1).min(self.memory.len() - 1)]);
        let level = scripted.map_or(1, |(level, _)| level);
        let free_kib = scripted.map_or(
            if at_end && self.low_end_memory {
                2 * 1024 * 1024
            } else {
                8 * 1024 * 1024
            },
            |(_, kib)| kib,
        );
        self.probes += 1;
        if self.timeout {
            return CmdOutput {
                timed_out: true,
                ..Default::default()
            };
        }
        let probe_fails = match spec.program.as_str() {
            "sysctl" => level == 0,
            "vm_stat" => free_kib == 0,
            _ => false,
        };
        if self.malformed || probe_fails {
            return CmdOutput::success("/private/probe-canary process-canary NaN garbage");
        }
        let text = match spec.program.as_str() {
            "vm_stat" => format!("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: {}.\nPages inactive: 0.\nPages speculative: 0.\nPages occupied by compressor: 0.\n/private/probe-canary process-canary\n", free_kib / 16),
            "sysctl" => format!("hw.logicalcpu: 8\nvm.loadavg: {{ {load} 2.0 3.0 }}\nkern.memorystatus_vm_pressure_level: {level}\nhw.memsize: 25769803776\nvm.swapusage: total = 2048.00M used = 1024.00M free = 1024.00M (encrypted)\n"),
            "cat" if spec.args[0] == "/proc/meminfo" => format!("MemTotal: 25165824 kB\nMemFree: {free_kib} kB\nMemAvailable: {free_kib} kB\nSwapTotal: 2097152 kB\nSwapFree: 1048576 kB\n/private/probe-canary process-canary\n"),
            "cat" => format!("{load} 2.0 3.0 1/100 123\ncpu 1 0 1 98 0 0 0 0\n{}", (0..8).map(|i| format!("cpu{i} 1 0 1 98 0 0 0 0\n")).collect::<String>()),
            _ => panic!("unexpected host probe {}", spec.rendered()),
        };
        CmdOutput::success(&text)
    }
    fn execute_private(
        &mut self,
        spec: &CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> PrivateOutput {
        self.calls.push(spec.clone());
        self.inner.execute_private(spec, input, interruptible)
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, path: &Path) -> std::io::Result<Spawned> {
        self.calls.push(spec.clone());
        self.inner.spawn_group_unchecked(spec, path)
    }
    fn spawn_piped_unchecked(
        &mut self,
        spec: &CmdSpec,
        path: &Path,
    ) -> std::io::Result<PipedChild> {
        self.calls.push(spec.clone());
        self.inner.spawn_piped_unchecked(spec, path)
    }
    fn sleep(&mut self, duration: Duration) {
        self.inner.sleep(duration)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.inner.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.inner.commands_executed() + self.probes as u64
    }
    fn host_os(&self) -> &'static str {
        self.os.unwrap_or(std::env::consts::OS)
    }
    fn cancellation(&self) -> Option<String> {
        self.inner.cancellation()
    }
    fn try_reap(&mut self, pid: i32) -> bool {
        self.inner.try_reap(pid)
    }
}
