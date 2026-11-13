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
            probes: 0,
        }
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
        let at_end = self.probes >= 2;
        let load = if at_end { self.end_load } else { 1.0 };
        let free_kib = if at_end && self.low_end_memory {
            2 * 1024 * 1024
        } else {
            8 * 1024 * 1024
        };
        self.probes += 1;
        if self.timeout {
            return CmdOutput {
                timed_out: true,
                ..Default::default()
            };
        }
        if self.malformed {
            return CmdOutput::success("/private/probe-canary process-canary NaN garbage");
        }
        let text = match spec.program.as_str() {
            "vm_stat" => format!("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: {}.\nPages inactive: 0.\nPages speculative: 0.\nPages occupied by compressor: 0.\n/private/probe-canary process-canary\n", free_kib / 16),
            "sysctl" => format!("hw.logicalcpu: 8\nvm.loadavg: {{ {load} 2.0 3.0 }}\nkern.memorystatus_vm_pressure_level: 1\nhw.memsize: 25769803776\nvm.swapusage: total = 2048.00M used = 1024.00M free = 1024.00M (encrypted)\n"),
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
    fn cancellation(&self) -> Option<String> {
        self.inner.cancellation()
    }
    fn try_reap(&mut self, pid: i32) -> bool {
        self.inner.try_reap(pid)
    }
}
