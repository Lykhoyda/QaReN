use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub mod log;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CmdSpec {
    #[serde(skip)]
    pub(crate) core_log: bool,
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unset: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub registry_auth_env: Vec<String>,
    pub timeout_seconds: u64,
}

impl CmdSpec {
    pub fn new(label: &str, program: &str, args: &[&str], timeout_seconds: u64) -> Self {
        CmdSpec {
            core_log: false,
            label: label.to_string(),
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: Vec::new(),
            unset: Vec::new(),
            registry_auth_env: Vec::new(),
            timeout_seconds,
        }
    }

    pub fn cwd(mut self, dir: &Path) -> Self {
        self.cwd = Some(dir.to_path_buf());
        self
    }

    pub fn env(mut self, key: &str, value: &str) -> Self {
        self.env.push((key.to_string(), value.to_string()));
        self
    }

    // Removed after `env`, so neither the spec nor the inherited environment can supply it.
    pub fn env_remove(mut self, key: &str) -> Self {
        self.unset.push(key.to_string());
        self
    }

    pub fn registry_auth_env(mut self, names: &[String]) -> Self {
        self.registry_auth_env = names.to_vec();
        self
    }

    fn withholds_registry_output(&self) -> bool {
        crate::redact::is_registry_child(&self.label) && !self.registry_auth_env.is_empty()
    }

    pub fn rendered(&self) -> String {
        let mut parts = vec![self.program.clone()];
        parts.extend(self.args.iter().cloned());
        parts.join(" ")
    }
}

#[derive(Debug, Clone, Default)]
pub struct CmdOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u64,
}

pub struct PrivateOutput(CmdOutput);

impl PrivateOutput {
    pub fn clean(&self) -> bool {
        self.0.ok() && self.0.stderr.is_empty()
    }

    pub fn stdout(&self) -> &str {
        &self.0.stdout
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.0.exit_code
    }

    pub fn timed_out(&self) -> bool {
        self.0.timed_out
    }

    pub fn summary(&self) -> String {
        format!(
            "exit={:?} timed_out={} [private output withheld]",
            self.0.exit_code, self.0.timed_out
        )
    }
}

impl std::fmt::Debug for PrivateOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.summary())
    }
}

impl CmdOutput {
    pub fn ok(&self) -> bool {
        !self.timed_out && self.exit_code == Some(0)
    }

    pub fn success(stdout: &str) -> Self {
        CmdOutput {
            exit_code: Some(0),
            stdout: stdout.to_string(),
            ..Default::default()
        }
    }

    pub fn failed(code: i32, stderr: &str) -> Self {
        CmdOutput {
            exit_code: Some(code),
            stderr: stderr.to_string(),
            ..Default::default()
        }
    }

    pub fn names_private_key(&self) -> bool {
        crate::redact::names_private_key(&self.stdout)
            || crate::redact::names_private_key(&self.stderr)
    }

    pub fn summary(&self) -> String {
        if crate::redact::input_namespace_present() {
            return "[private output withheld]".into();
        }
        if self.timed_out {
            return format!("timed out after {}ms", self.duration_ms);
        }
        let code = self
            .exit_code
            .map_or("signal".to_string(), |c| c.to_string());
        if self.names_private_key() {
            return format!("exit={code} {}", crate::redact::PRIVATE_KEY_WITHHELD);
        }
        let stderr = crate::redact::redact_secrets(&self.stderr);
        let stdout = crate::redact::redact_secrets(&self.stdout);
        let tail: String = stderr
            .lines()
            .chain(stdout.lines())
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        crate::redact::redact_secrets(&format!("exit={code} {tail}"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spawned {
    pub pid: i32,
    pub pgid: i32,
}

// Stdio protocol pipes and a redacted stderr log, in a dedicated process group.
pub struct PipedChild {
    pub pid: i32,
    pub stdin: Box<dyn Write + Send>,
    pub stdout: Box<dyn BufRead + Send>,
    pub handle: Box<dyn ChildHandle + Send>,
}

pub trait ChildHandle {
    // Some(code) once exited; a signal death reports -1.
    fn try_wait(&mut self) -> std::io::Result<Option<i32>>;
    fn kill_group(&mut self);
    // SIGTERM to the leader only, so it can close what it opened before the group is killed.
    fn terminate(&mut self);
}

struct RealChildHandle {
    child: std::process::Child,
    log: log::LogDrain,
    label: Option<String>,
    started: Instant,
    // Set before any later fallible step; a reaped pid may already name another process.
    reaped: bool,
}

impl RealChildHandle {
    fn finish_command(&mut self, ok: bool) {
        if let Some(label) = self.label.take() {
            crate::progress::finished(&label, ok);
            crate::events::cmd(
                &label,
                crate::events::Edge::End,
                Some(ok),
                Some(self.started.elapsed().as_millis() as u64),
            );
        }
    }
}

impl ChildHandle for RealChildHandle {
    fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        let exit = match self.child.try_wait() {
            Ok(status) => status.map(|s| s.code().unwrap_or(-1)),
            Err(e) => {
                self.reaped = true;
                self.finish_command(false);
                return Err(e);
            }
        };
        if exit.is_some() {
            self.reaped = true;
            let drained = self.log.flush();
            self.finish_command(exit == Some(0) && drained.is_ok());
            drained?;
        }
        Ok(exit)
    }

    fn kill_group(&mut self) {
        self.reaped = true;
        kill_group_and_reap(&mut self.child);
        let drained = self.log.flush();
        match self.child.try_wait() {
            Ok(Some(status)) => self.finish_command(status.success() && drained.is_ok()),
            Err(_) => self.finish_command(false),
            Ok(None) => {}
        }
    }

    // Signals only an unreaped child and never reaps here, so kill_group still precedes reaping.
    fn terminate(&mut self) {
        if !self.reaped {
            unsafe { libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM) };
        }
    }
}

pub trait Runner {
    fn env_var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
    fn env_var_os(&self, name: &str) -> Option<OsString> {
        self.env_var(name).map(OsString::from)
    }
    fn env_names(&self) -> Vec<String> {
        std::env::vars_os()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect()
    }
    fn run(&mut self, spec: &CmdSpec) -> CmdOutput {
        if let Some(reason) = self.cancellation() {
            return CmdOutput::failed(4, &reason);
        }
        self.execute(spec, true)
    }
    fn run_private(&mut self, spec: &CmdSpec, input: &[u8]) -> PrivateOutput {
        if let Some(reason) = self.cancellation() {
            return PrivateOutput(CmdOutput::failed(4, &reason));
        }
        self.execute_private(spec, input, true)
    }
    fn spawn_group(&mut self, spec: &CmdSpec, log_path: &Path) -> std::io::Result<Spawned> {
        if let Some(reason) = self.cancellation() {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, reason));
        }
        self.spawn_group_unchecked(spec, log_path)
    }
    fn spawn_piped(&mut self, spec: &CmdSpec, log_path: &Path) -> std::io::Result<PipedChild> {
        if let Some(reason) = self.cancellation() {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, reason));
        }
        self.spawn_piped_unchecked(spec, log_path)
    }
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput;
    fn execute_private(
        &mut self,
        _spec: &CmdSpec,
        _input: &[u8],
        _interruptible: bool,
    ) -> PrivateOutput {
        PrivateOutput(CmdOutput::failed(1, "private capture unsupported"))
    }
    fn spawn_group_unchecked(
        &mut self,
        spec: &CmdSpec,
        log_path: &Path,
    ) -> std::io::Result<Spawned>;
    // Err proves the command child was not spawned; post-spawn failures must retain its handle.
    fn spawn_piped_unchecked(
        &mut self,
        spec: &CmdSpec,
        stderr_log: &Path,
    ) -> std::io::Result<PipedChild>;
    fn sleep(&mut self, duration: Duration);
    fn now_epoch_ms(&self) -> u64;
    // Override with a monotonic source so deadlines survive wall-clock adjustments.
    fn monotonic_ms(&self) -> u64 {
        self.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64;
    // Why the run must stop now: a caught signal or a vanished caller.
    fn cancellation(&self) -> Option<String> {
        None
    }
    // Reaps an exited spawn_group child this process owns; never blocks or signals.
    fn try_reap(&mut self, _pid: i32) -> bool {
        false
    }
    fn adb_server_version(&self, port: u16) -> Result<u32, String> {
        crate::adapters::android::server_version(port)
    }
}

pub(crate) struct DeadlineRunner<'a> {
    pub(crate) inner: &'a mut dyn Runner,
    pub(crate) deadline_ms: u64,
}

impl DeadlineRunner<'_> {
    fn capped(&self, spec: &CmdSpec) -> Option<CmdSpec> {
        let remaining = self.deadline_ms.saturating_sub(self.inner.monotonic_ms());
        if remaining == 0 {
            return None;
        }
        let mut spec = spec.clone();
        spec.timeout_seconds = spec.timeout_seconds.min(remaining / 1000);
        Some(spec)
    }

    fn expired() -> CmdOutput {
        CmdOutput {
            timed_out: true,
            ..Default::default()
        }
    }
}

impl Runner for DeadlineRunner<'_> {
    fn env_var(&self, name: &str) -> Option<String> {
        self.inner.env_var(name)
    }
    fn env_var_os(&self, name: &str) -> Option<OsString> {
        self.inner.env_var_os(name)
    }
    fn env_names(&self) -> Vec<String> {
        self.inner.env_names()
    }
    // Non-interruptible commands are teardown and identity reads (CleanupRunner): an expired window must never block them.
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        if !interruptible {
            return self.inner.execute(spec, false);
        }
        match self.capped(spec) {
            Some(spec) => self.inner.execute(&spec, interruptible),
            None => Self::expired(),
        }
    }
    fn execute_private(
        &mut self,
        spec: &CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> PrivateOutput {
        if !interruptible {
            return self.inner.execute_private(spec, input, false);
        }
        match self.capped(spec) {
            Some(spec) => self.inner.execute_private(&spec, input, interruptible),
            None => PrivateOutput(Self::expired()),
        }
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        let spec = self.capped(spec).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::TimedOut, "build window expired")
        })?;
        self.inner.spawn_group_unchecked(&spec, log)
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        let spec = self.capped(spec).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::TimedOut, "build window expired")
        })?;
        self.inner.spawn_piped_unchecked(&spec, log)
    }
    fn sleep(&mut self, duration: Duration) {
        self.inner.sleep(duration)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.inner.now_epoch_ms()
    }
    fn monotonic_ms(&self) -> u64 {
        self.inner.monotonic_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.inner.commands_executed()
    }
    fn cancellation(&self) -> Option<String> {
        self.inner.cancellation()
    }
    fn try_reap(&mut self, pid: i32) -> bool {
        self.inner.try_reap(pid)
    }
    fn adb_server_version(&self, port: u16) -> Result<u32, String> {
        self.inner.adb_server_version(port)
    }
}

pub(crate) struct CleanupRunner<'a>(pub(crate) &'a mut dyn Runner);

impl Runner for CleanupRunner<'_> {
    fn env_var(&self, name: &str) -> Option<String> {
        self.0.env_var(name)
    }
    fn env_var_os(&self, name: &str) -> Option<OsString> {
        self.0.env_var_os(name)
    }
    fn execute(&mut self, spec: &CmdSpec, _interruptible: bool) -> CmdOutput {
        self.0.execute(spec, false)
    }
    fn execute_private(
        &mut self,
        spec: &CmdSpec,
        input: &[u8],
        _interruptible: bool,
    ) -> PrivateOutput {
        self.0.execute_private(spec, input, false)
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.0.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.0.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, duration: Duration) {
        self.0.sleep(duration);
    }
    fn now_epoch_ms(&self) -> u64 {
        self.0.now_epoch_ms()
    }
    fn monotonic_ms(&self) -> u64 {
        self.0.monotonic_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.0.commands_executed()
    }
    fn try_reap(&mut self, pid: i32) -> bool {
        self.0.try_reap(pid)
    }
    fn adb_server_version(&self, port: u16) -> Result<u32, String> {
        self.0.adb_server_version(port)
    }
}

pub struct RealRunner {
    executed: u64,
    started: Instant,
    log_executable: PathBuf,
    logs: Vec<log::LogDrain>,
    caller: Option<u32>,
    // Only the spawning process can reap a group leader; dropping the Child leaves a zombie.
    children: std::collections::HashMap<i32, (std::process::Child, String, Instant)>,
}

impl RealRunner {
    pub fn new() -> Self {
        Self::with_log_executable(std::env::current_exe().expect("qaren executable path"))
    }

    pub fn with_log_executable(executable: PathBuf) -> Self {
        RealRunner {
            executed: 0,
            started: Instant::now(),
            log_executable: executable,
            logs: Vec::new(),
            caller: None,
            children: std::collections::HashMap::new(),
        }
    }

    // Ties this run to the process that launched it; used by `check` only.
    pub fn watch_caller(&mut self) {
        self.caller = Some(std::os::unix::process::parent_id());
    }

    pub fn flush_logs(&mut self) -> std::io::Result<()> {
        for log in &mut self.logs {
            log.flush()?;
        }
        Ok(())
    }
}

impl Default for RealRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl Runner for RealRunner {
    fn env_var_os(&self, name: &str) -> Option<OsString> {
        std::env::var_os(name)
    }
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        self.executed += 1;
        let started = Instant::now();
        crate::progress::started(&spec.label, false);
        crate::events::cmd(&spec.label, crate::events::Edge::Start, None, None);
        let output = run_captured(spec, &started, None, || {
            if interruptible {
                self.cancellation()
            } else {
                None
            }
        })
        .unwrap_or_else(|e| io_failure(&started, format!("{}: {e}", spec.label)));
        let output = match self.flush_logs() {
            Ok(()) => output,
            Err(e) => io_failure(&started, format!("drain logs: {e}")),
        };
        crate::progress::finished(&spec.label, output.ok());
        crate::events::cmd(
            &spec.label,
            crate::events::Edge::End,
            Some(output.ok()),
            Some(started.elapsed().as_millis() as u64),
        );
        output
    }

    fn execute_private(
        &mut self,
        spec: &CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> PrivateOutput {
        self.executed += 1;
        let started = Instant::now();
        let output = run_captured(spec, &started, Some(input), || {
            if interruptible {
                self.cancellation()
            } else {
                None
            }
        })
        .unwrap_or_else(|_| CmdOutput::failed(1, "private capture failed"));
        if self.flush_logs().is_err() {
            return PrivateOutput(CmdOutput::failed(1, "log drain failed"));
        }
        PrivateOutput(output)
    }

    fn spawn_group_unchecked(
        &mut self,
        spec: &CmdSpec,
        log_path: &Path,
    ) -> std::io::Result<Spawned> {
        use std::os::unix::process::CommandExt;
        self.executed += 1;
        let started = Instant::now();
        crate::progress::started(&spec.label, true);
        crate::events::cmd(&spec.label, crate::events::Edge::Start, None, None);
        let result = (|| {
            let (drain, output, error) = log::LogDrain::spawn_paired(
                &self.log_executable,
                log_path,
                spec.withholds_registry_output(),
                spec.env
                    .iter()
                    .any(|(key, value)| key == "DEBUG" && value == log::METRO_REQUEST_LOG),
            )?;
            let mut cmd = Command::new(&spec.program);
            cmd.args(&spec.args)
                .stdin(Stdio::null())
                .stdout(Stdio::from(OwnedFd::from(output)))
                .stderr(Stdio::from(OwnedFd::from(error)))
                .process_group(0);
            if let Some(dir) = &spec.cwd {
                cmd.current_dir(dir);
            }
            for (k, v) in &spec.env {
                cmd.env(k, v);
            }
            for k in &spec.unset {
                cmd.env_remove(k);
            }
            if let Some(reason) = self.cancellation() {
                return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, reason));
            }
            crate::redact::scrub_secret_env(&mut cmd, &spec.label, &spec.registry_auth_env);
            let child = cmd.spawn()?;
            let pid = child.id() as i32;
            self.logs.push(drain);
            self.children
                .insert(pid, (child, spec.label.clone(), started));
            Ok(Spawned { pid, pgid: pid })
        })();
        if result.is_err() {
            crate::progress::finished(&spec.label, false);
            crate::events::cmd(
                &spec.label,
                crate::events::Edge::End,
                Some(false),
                Some(started.elapsed().as_millis() as u64),
            );
        }
        result
    }

    fn try_reap(&mut self, pid: i32) -> bool {
        let status = self
            .children
            .get_mut(&pid)
            .and_then(|(child, _, _)| child.try_wait().ok().flatten());
        if let Some(status) = status {
            let (_, label, started) = self.children.remove(&pid).expect("owned child");
            crate::progress::finished(&label, status.success());
            crate::events::cmd(
                &label,
                crate::events::Edge::End,
                Some(status.success()),
                Some(started.elapsed().as_millis() as u64),
            );
            return true;
        }
        false
    }

    fn spawn_piped_unchecked(
        &mut self,
        spec: &CmdSpec,
        stderr_log: &Path,
    ) -> std::io::Result<PipedChild> {
        use std::os::unix::process::CommandExt;
        self.executed += 1;
        let started = Instant::now();
        crate::progress::started(&spec.label, true);
        crate::events::cmd(&spec.label, crate::events::Edge::Start, None, None);
        let result = (|| {
            let withhold = spec.withholds_registry_output();
            let (log, stdout, stderr) = if withhold {
                let (log, stdout, stderr) =
                    log::LogDrain::spawn_paired(&self.log_executable, stderr_log, true, false)?;
                (log, Stdio::from(OwnedFd::from(stdout)), stderr)
            } else {
                let (log, stderr) =
                    log::LogDrain::spawn(&self.log_executable, stderr_log, false, spec.core_log)?;
                (log, Stdio::piped(), stderr)
            };
            let mut cmd = Command::new(&spec.program);
            cmd.args(&spec.args)
                .stdin(Stdio::piped())
                .stdout(stdout)
                .stderr(Stdio::from(OwnedFd::from(stderr)))
                .process_group(0);
            if let Some(dir) = &spec.cwd {
                cmd.current_dir(dir);
            }
            for (k, v) in &spec.env {
                cmd.env(k, v);
            }
            for k in &spec.unset {
                cmd.env_remove(k);
            }
            if let Some(reason) = self.cancellation() {
                return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, reason));
            }
            crate::redact::scrub_secret_env(&mut cmd, &spec.label, &spec.registry_auth_env);
            let mut child = cmd.spawn()?;
            let stdin = child.stdin.take().expect("stdin is piped");
            let stdout: Box<dyn BufRead + Send> = if withhold {
                Box::new(std::io::empty())
            } else {
                Box::new(BufReader::new(
                    child.stdout.take().expect("stdout is piped"),
                ))
            };
            Ok(PipedChild {
                pid: child.id() as i32,
                stdin: Box::new(stdin),
                stdout,
                handle: Box::new(RealChildHandle {
                    child,
                    log,
                    label: Some(spec.label.clone()),
                    started,
                    reaped: false,
                }),
            })
        })();
        if result.is_err() {
            crate::progress::finished(&spec.label, false);
            crate::events::cmd(
                &spec.label,
                crate::events::Edge::End,
                Some(false),
                Some(started.elapsed().as_millis() as u64),
            );
        }
        result
    }

    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }

    fn now_epoch_ms(&self) -> u64 {
        crate::timefmt::epoch_ms()
    }

    fn monotonic_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn commands_executed(&self) -> u64 {
        self.executed
    }

    fn cancellation(&self) -> Option<String> {
        let parent_now = std::os::unix::process::parent_id();
        crate::cancel::reason(
            crate::cancel::caught(),
            self.caller.unwrap_or(parent_now),
            parent_now,
        )
    }
}

const MAX_CAPTURE_BYTES: usize = 16 * 1024 * 1024;

fn capture_stream(stream: &mut UnixStream, output: &mut Vec<u8>) -> std::io::Result<()> {
    let mut buf = [0; 8192];
    for _ in 0..128 {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if output.len() + n > MAX_CAPTURE_BYTES {
                    return Err(std::io::Error::other("command output exceeded 16 MiB"));
                }
                output.extend_from_slice(&buf[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn run_captured(
    spec: &CmdSpec,
    started: &Instant,
    input: Option<&[u8]>,
    cancellation: impl Fn() -> Option<String>,
) -> std::io::Result<CmdOutput> {
    use std::os::unix::process::CommandExt;
    if input.is_some_and(|bytes| bytes.len() > MAX_CAPTURE_BYTES) {
        return Err(std::io::Error::other("command input exceeded 16 MiB"));
    }
    let (mut stdin, child_stdin) = if input.is_some() {
        let (writer, reader) = UnixStream::pair()?;
        writer.set_nonblocking(true)?;
        (Some(writer), Stdio::from(OwnedFd::from(reader)))
    } else {
        (None, Stdio::null())
    };
    let input = input.unwrap_or_default();
    let mut written = 0;
    let (mut stdout, out) = UnixStream::pair()?;
    let (mut stderr, err) = UnixStream::pair()?;
    stdout.set_nonblocking(true)?;
    stderr.set_nonblocking(true)?;
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(child_stdin)
        .stdout(Stdio::from(OwnedFd::from(out)))
        .stderr(Stdio::from(OwnedFd::from(err)))
        .process_group(0);
    if let Some(dir) = &spec.cwd {
        cmd.current_dir(dir);
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    for k in &spec.unset {
        cmd.env_remove(k);
    }
    if let Some(reason) = cancellation() {
        return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, reason));
    }
    crate::redact::scrub_secret_env(&mut cmd, &spec.label, &spec.registry_auth_env);
    let mut child = cmd.spawn()?;
    drop(cmd);
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut timed_out = false;
    let mut stopped = false;
    let result: std::io::Result<Option<i32>> = (|| loop {
        if let Some(reason) = cancellation() {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, reason));
        }
        if let Some(writer) = &mut stdin {
            if written < input.len() {
                match writer.write(&input[written..input.len().min(written + 8192)]) {
                    Ok(0) => return Err(std::io::Error::other("command stdin closed")),
                    Ok(n) => written += n,
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) => {}
                    Err(e) => return Err(e),
                }
            }
            if written == input.len() {
                stdin = None;
            }
        }
        let captured = out.len() + err.len();
        let status = child.try_wait()?;
        stopped = status.is_some();
        capture_stream(&mut stdout, &mut out)?;
        capture_stream(&mut stderr, &mut err)?;
        if let Some(status) = status {
            if written < input.len() {
                return Err(std::io::Error::other(
                    "command exited before input was delivered",
                ));
            }
            return Ok(status.code());
        }
        if started.elapsed() >= Duration::from_secs(spec.timeout_seconds) {
            timed_out = true;
            kill_group_and_reap(&mut child);
            stopped = true;
            capture_stream(&mut stdout, &mut out)?;
            capture_stream(&mut stderr, &mut err)?;
            return Ok(None);
        }
        if out.len() + err.len() == captured {
            std::thread::sleep(Duration::from_millis(1));
        } else {
            std::thread::yield_now();
        }
    })();
    if result.is_err() && !stopped {
        kill_group_and_reap(&mut child);
    }
    Ok(CmdOutput {
        exit_code: result?,
        stdout: if spec.withholds_registry_output() {
            String::new()
        } else {
            String::from_utf8_lossy(&out).into_owned()
        },
        stderr: if spec.withholds_registry_output() {
            "[private output withheld]".into()
        } else {
            String::from_utf8_lossy(&err).into_owned()
        },
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

// The child is its own group leader, so -pid addresses the whole group.
fn kill_group_and_reap(child: &mut std::process::Child) {
    let pid = child.id() as i32;
    let mut kill = Command::new("/bin/kill");
    kill.args(["-9", "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::redact::scrub_secret_env(&mut kill, "", &[]);
    let _ = kill.status();
    let _ = child.kill();
    let reap_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < reap_deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return,
        }
    }
}

fn io_failure(started: &Instant, detail: String) -> CmdOutput {
    CmdOutput {
        exit_code: None,
        stdout: String::new(),
        stderr: detail,
        timed_out: false,
        duration_ms: started.elapsed().as_millis() as u64,
    }
}

// What the scripted stdout does once its bytes are consumed: close, stay open until the
// group is killed (a member dying with the group), or stay open forever (a survivor).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldStdout {
    Close,
    UntilKill,
    Forever,
}

pub enum MockResult {
    Run(CmdOutput),
    Spawn(std::io::Result<Spawned>, Option<String>),
    // Scripted stdout for a piped child; `exit` None means it never exits on its own.
    SpawnPiped {
        pid: i32,
        stdout: String,
        exit: Option<i32>,
        hold: HoldStdout,
    },
}

struct HeldStdout {
    script: std::io::Cursor<Vec<u8>>,
    hold: HoldStdout,
    killed: Arc<Mutex<bool>>,
}

impl HeldStdout {
    fn exhausted(&self) -> bool {
        self.script.position() as usize >= self.script.get_ref().len()
    }

    // Blocks by the hold rule once the script is consumed; true means EOF.
    fn wait_for_eof(&self) -> bool {
        loop {
            match self.hold {
                HoldStdout::Close => return true,
                HoldStdout::UntilKill if *self.killed.lock().unwrap() => return true,
                _ => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    }
}

impl std::io::Read for HeldStdout {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.exhausted() && self.wait_for_eof() {
            return Ok(0);
        }
        self.script.read(buf)
    }
}

impl BufRead for HeldStdout {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        if self.exhausted() && self.wait_for_eof() {
            return Ok(&[]);
        }
        self.script.fill_buf()
    }

    fn consume(&mut self, amt: usize) {
        self.script.consume(amt)
    }
}

struct MockChildHandle {
    exit: Option<i32>,
    killed: Arc<Mutex<bool>>,
    terminated: Arc<Mutex<bool>>,
}

impl ChildHandle for MockChildHandle {
    // A child that already exited keeps its status; a kill only ends one still running.
    fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        if self.exit.is_some() {
            return Ok(self.exit);
        }
        if *self.killed.lock().unwrap() {
            return Ok(Some(-9));
        }
        Ok(None)
    }

    fn kill_group(&mut self) {
        *self.killed.lock().unwrap() = true;
    }

    // A scripted child honours SIGTERM by ending the way a kill does.
    fn terminate(&mut self) {
        *self.terminated.lock().unwrap() = true;
        *self.killed.lock().unwrap() = true;
    }
}

struct SharedWriter(Arc<Mutex<Vec<u8>>>);

impl Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub struct MockExpectation {
    pub program_hint: String,
    pub result: MockResult,
}

pub struct MockRunner {
    pub environment: std::collections::BTreeMap<String, String>,
    pub calls: Vec<CmdSpec>,
    pub spawned_logs: Vec<PathBuf>,
    // Everything written to each piped child's stdin, in spawn order.
    pub piped_stdin: Vec<Arc<Mutex<Vec<u8>>>>,
    pub piped_killed: Vec<Arc<Mutex<bool>>>,
    pub piped_terminated: Vec<Arc<Mutex<bool>>>,
    pub private_inputs: Vec<Vec<u8>>,
    // (command hint, reason): cancellation starts after a match; -p hints bind the full PID argument.
    pub cancel_after: Option<(String, String)>,
    // (clock ms, reason): cancellation starts once the scripted clock reaches the time.
    pub cancel_at_ms: Option<(u64, String)>,
    // (command substring, ms): the scripted clock advances while a matching command runs.
    pub advance_on: Option<(String, u64)>,
    // (port, version) of the adb servers the scripted host runs; the real probe never runs.
    pub adb_servers: Vec<(u16, u32)>,
    script: VecDeque<MockExpectation>,
    now_ms: u64,
}

impl MockRunner {
    pub fn new() -> Self {
        MockRunner {
            environment: Default::default(),
            calls: Vec::new(),
            spawned_logs: Vec::new(),
            piped_stdin: Vec::new(),
            piped_killed: Vec::new(),
            piped_terminated: Vec::new(),
            private_inputs: Vec::new(),
            cancel_after: None,
            cancel_at_ms: None,
            advance_on: None,
            adb_servers: Vec::new(),
            script: VecDeque::new(),
            now_ms: 1_770_000_000_000,
        }
    }

    pub fn expect_spawn_piped(
        &mut self,
        program_hint: &str,
        pid: i32,
        stdout: &str,
        exit: Option<i32>,
    ) {
        // A child that never exits on its own keeps its pipe open until it is killed.
        let hold = if exit.is_some() {
            HoldStdout::Close
        } else {
            HoldStdout::UntilKill
        };
        self.expect_spawn_piped_holding(program_hint, pid, stdout, exit, hold);
    }

    pub fn expect_spawn_piped_holding(
        &mut self,
        program_hint: &str,
        pid: i32,
        stdout: &str,
        exit: Option<i32>,
        hold: HoldStdout,
    ) {
        self.script.push_back(MockExpectation {
            program_hint: program_hint.to_string(),
            result: MockResult::SpawnPiped {
                pid,
                stdout: stdout.to_string(),
                exit,
                hold,
            },
        });
    }

    pub fn piped_stdin_text(&self, index: usize) -> String {
        String::from_utf8_lossy(&self.piped_stdin[index].lock().unwrap()).into_owned()
    }

    pub fn expect_run(&mut self, program_hint: &str, output: CmdOutput) {
        self.script.push_back(MockExpectation {
            program_hint: program_hint.to_string(),
            result: MockResult::Run(output),
        });
    }

    pub fn expect_spawn(&mut self, program_hint: &str, spawned: Spawned) {
        self.script.push_back(MockExpectation {
            program_hint: program_hint.to_string(),
            result: MockResult::Spawn(Ok(spawned), None),
        });
    }

    pub fn expect_spawn_failure(&mut self, program_hint: &str, message: &str) {
        self.script.push_back(MockExpectation {
            program_hint: program_hint.to_string(),
            result: MockResult::Spawn(Err(std::io::Error::other(message)), None),
        });
    }

    pub fn expect_spawn_with_log(
        &mut self,
        program_hint: &str,
        spawned: Spawned,
        log_content: &str,
    ) {
        self.script.push_back(MockExpectation {
            program_hint: program_hint.to_string(),
            result: MockResult::Spawn(Ok(spawned), Some(log_content.to_string())),
        });
    }

    pub fn remaining(&self) -> usize {
        self.script.len()
    }

    fn next_for(&mut self, spec: &CmdSpec) -> MockExpectation {
        let expectation = self
            .script
            .pop_front()
            .unwrap_or_else(|| panic!("unexpected command: {}", spec.rendered()));
        let hint = &expectation.program_hint;
        assert!(
            spec.rendered().contains(hint.as_str()),
            "expected command containing {hint:?}, got {:?}",
            spec.rendered()
        );
        expectation
    }
}

impl Default for MockRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl Runner for MockRunner {
    fn env_var(&self, name: &str) -> Option<String> {
        self.environment.get(name).cloned()
    }
    fn env_names(&self) -> Vec<String> {
        self.environment.keys().cloned().collect()
    }
    fn adb_server_version(&self, port: u16) -> Result<u32, String> {
        self.adb_servers
            .iter()
            .find(|(p, _)| *p == port)
            .map(|(_, version)| *version)
            .ok_or_else(|| "connection refused".to_string())
    }
    fn execute(&mut self, spec: &CmdSpec, _interruptible: bool) -> CmdOutput {
        self.calls.push(spec.clone());
        if let Some((hint, ms)) = &self.advance_on {
            if spec.rendered().contains(hint.as_str()) {
                self.now_ms += ms;
            }
        }
        match self.next_for(spec).result {
            MockResult::Run(output) => output,
            MockResult::Spawn(..) | MockResult::SpawnPiped { .. } => {
                panic!("expected run, script had spawn for {}", spec.rendered())
            }
        }
    }

    fn execute_private(
        &mut self,
        spec: &CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> PrivateOutput {
        self.private_inputs.push(input.to_vec());
        PrivateOutput(self.execute(spec, interruptible))
    }

    fn spawn_piped_unchecked(
        &mut self,
        spec: &CmdSpec,
        stderr_log: &Path,
    ) -> std::io::Result<PipedChild> {
        self.calls.push(spec.clone());
        self.spawned_logs.push(stderr_log.to_path_buf());
        match self.next_for(spec).result {
            MockResult::SpawnPiped {
                pid,
                stdout,
                exit,
                hold,
            } => {
                let stdin = Arc::new(Mutex::new(Vec::new()));
                let killed = Arc::new(Mutex::new(false));
                self.piped_stdin.push(stdin.clone());
                self.piped_killed.push(killed.clone());
                let terminated = Arc::new(Mutex::new(false));
                self.piped_terminated.push(terminated.clone());
                Ok(PipedChild {
                    pid,
                    stdin: Box::new(SharedWriter(stdin)),
                    stdout: Box::new(HeldStdout {
                        script: std::io::Cursor::new(stdout.into_bytes()),
                        hold,
                        killed: killed.clone(),
                    }),
                    handle: Box::new(MockChildHandle {
                        exit,
                        killed,
                        terminated,
                    }),
                })
            }
            _ => panic!(
                "expected spawn_piped, script had another shape for {}",
                spec.rendered()
            ),
        }
    }

    fn spawn_group_unchecked(
        &mut self,
        spec: &CmdSpec,
        log_path: &Path,
    ) -> std::io::Result<Spawned> {
        self.calls.push(spec.clone());
        self.spawned_logs.push(log_path.to_path_buf());
        match self.next_for(spec).result {
            MockResult::Spawn(result, log_content) => {
                if let Some(content) = log_content {
                    let _ = std::fs::write(log_path, content);
                }
                result
            }
            _ => panic!(
                "expected spawn, script had another shape for {}",
                spec.rendered()
            ),
        }
    }

    fn sleep(&mut self, duration: Duration) {
        self.now_ms += duration.as_millis() as u64;
    }

    fn now_epoch_ms(&self) -> u64 {
        self.now_ms
    }

    fn commands_executed(&self) -> u64 {
        self.calls.len() as u64
    }

    fn cancellation(&self) -> Option<String> {
        if let Some((at, reason)) = &self.cancel_at_ms {
            if self.now_ms >= *at {
                return Some(reason.clone());
            }
        }
        let (after, reason) = self.cancel_after.as_ref()?;
        self.calls
            .iter()
            .any(|call| {
                // A recorded owner probe may have a PID such as 900003 while
                // the scripted core is 9000. Keep non-PID hints unchanged, but
                // never turn a PID prefix into an early cancellation.
                if let Some(pid) = after
                    .strip_prefix("-p ")
                    .and_then(|tail| tail.split_whitespace().next())
                {
                    if !call
                        .args
                        .windows(2)
                        .any(|pair| pair[0] == "-p" && pair[1] == pid)
                    {
                        return false;
                    }
                }
                call.rendered().contains(after.as_str())
            })
            .then(|| reason.clone())
    }
}

#[cfg(test)]
mod deadline_tests {
    use super::*;

    #[test]
    fn admission_retry_child_stays_within_the_original_allowance() {
        let mut inner = RealRunner::new();
        let started = Instant::now();
        let deadline_ms = inner.monotonic_ms() + 30_000;
        let mut runner = DeadlineRunner {
            inner: &mut inner,
            deadline_ms,
        };
        let spec = CmdSpec::new("admission-probe", "sh", &["-c", "sleep 16"], 30);
        assert!(runner.run(&spec).ok());
        runner.sleep(Duration::from_millis(500));
        assert!(runner.run(&spec).timed_out);
        assert!(started.elapsed() < Duration::from_millis(30_200));
    }

    #[test]
    fn build_window_caps_fingerprint_and_all_spawn_paths() {
        let mut inner = MockRunner::new();
        inner
            .environment
            .insert("TOKEN_NAME".into(), "synthetic".into());
        inner.expect_run("fingerprint:generate", CmdOutput::success("{}"));
        inner.expect_run("private-probe", CmdOutput::success("private"));
        inner.expect_spawn(
            "group",
            Spawned {
                pid: 101,
                pgid: 101,
            },
        );
        inner.expect_spawn_piped("piped", 102, "", Some(0));
        let deadline_ms = inner.monotonic_ms() + 1000;
        let mut runner = DeadlineRunner {
            inner: &mut inner,
            deadline_ms,
        };
        assert_eq!(runner.env_var("TOKEN_NAME").as_deref(), Some("synthetic"));
        assert!(runner.env_names().contains(&"TOKEN_NAME".into()));
        assert!(runner
            .run(&CmdSpec::new(
                "fingerprint",
                "node",
                &["fingerprint:generate", "--platform", "ios"],
                120
            ))
            .ok());
        assert!(runner
            .run_private(&CmdSpec::new("private", "private-probe", &[], 20), b"input")
            .clean());
        runner
            .spawn_group(
                &CmdSpec::new("group", "group", &[], 60),
                Path::new("unused"),
            )
            .unwrap();
        runner
            .spawn_piped(
                &CmdSpec::new("piped", "piped", &[], 60),
                Path::new("unused"),
            )
            .unwrap();
        runner.sleep(Duration::from_secs(1));
        let spec = CmdSpec::new("expired", "must-not-start", &[], 60);
        assert!(runner.run(&spec).timed_out);
        assert!(runner.run_private(&spec, b"").timed_out());
        assert_eq!(
            runner
                .spawn_group(&spec, Path::new("unused"))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
        assert!(runner.spawn_piped(&spec, Path::new("unused")).is_err());
        assert_eq!(inner.calls.len(), 4);
        assert!(inner.calls.iter().all(|spec| spec.timeout_seconds == 1));
        assert_eq!(inner.remaining(), 0);
    }

    #[test]
    fn an_expired_build_window_never_blocks_build_teardown() {
        let mut inner = MockRunner::new();
        inner.expect_run("ps -A", CmdOutput::success("1 1 S\n5000 5000 S\n"));
        inner.expect_run("/bin/kill -TERM -- -5000", CmdOutput::success(""));
        let deadline_ms = inner.monotonic_ms();
        let mut runner = DeadlineRunner {
            inner: &mut inner,
            deadline_ms,
        };
        assert!(
            runner
                .run(&CmdSpec::new("productive", "must-not-start", &[], 60))
                .timed_out
        );
        let mut cleanup = CleanupRunner(&mut runner);
        let inventory = cleanup.run(&CmdSpec::new("ps-groups", "ps", &["-A"], 10));
        let kill = cleanup.run(&CmdSpec::new(
            "kill-group",
            "/bin/kill",
            &["-TERM", "--", "-5000"],
            10,
        ));
        assert!(inventory.ok() && kill.ok());
        assert_eq!(inner.calls.len(), 2);
        assert!(inner.calls.iter().all(|spec| spec.timeout_seconds == 10));
        assert_eq!(inner.remaining(), 0);
    }
}
