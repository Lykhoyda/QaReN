use std::io::{self, Read, Write};
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const HELPER_ARG: &str = "--internal-redact-log";
// The helper also drains the child's stderr from fd 3 into the same log.
pub const WITHHOLD_ARG: &str = "--private-output-withheld";
pub const PAIRED_ARG: &str = "--stderr-fd3";
const KEY_CONTROL_ARG: &str = "--redaction-key-control";
const BUNDLE_REQUESTS_ARG: &str = "--bundle-requests";
// A command whose DEBUG names this namespace gets its bundle requests counted.
pub const METRO_REQUEST_LOG: &str = "Metro:Server";
const REQUEST_RECEIVED: &str = "Metro:Server Handling request: ";
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_LINE: usize = 64 * 1024;

pub(super) struct LogDrain {
    child: Child,
    control: UnixStream,
}

impl LogDrain {
    pub(super) fn spawn(
        executable: &Path,
        path: &Path,
        withhold: bool,
    ) -> io::Result<(Self, UnixStream)> {
        let (drain, output, _) = Self::start(executable, path, false, withhold, false)?;
        Ok((drain, output))
    }

    // One helper for both streams of a child, so a key mention on either withholds both.
    pub(super) fn spawn_paired(
        executable: &Path,
        path: &Path,
        withhold: bool,
        count_bundle_requests: bool,
    ) -> io::Result<(Self, UnixStream, UnixStream)> {
        let (drain, output, error) =
            Self::start(executable, path, true, withhold, count_bundle_requests)?;
        Ok((
            drain,
            output,
            error.expect("paired drain has a stderr input"),
        ))
    }

    fn start(
        executable: &Path,
        path: &Path,
        paired: bool,
        withhold: bool,
        count_bundle_requests: bool,
    ) -> io::Result<(Self, UnixStream, Option<UnixStream>)> {
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        // Withholding truncates this command's output away, which only a regular file allows.
        if !log.metadata()?.is_file() {
            return Err(io::Error::other("command log must be a regular file"));
        }
        let (input, output) = UnixStream::pair()?;
        let (control, child_control) = UnixStream::pair()?;
        control.set_read_timeout(Some(DRAIN_TIMEOUT))?;
        control.set_write_timeout(Some(DRAIN_TIMEOUT))?;
        let second = if paired {
            Some(UnixStream::pair()?)
        } else {
            None
        };
        // A separate group drains through target SIGKILL and survives a detached prepare.
        let key = serde_json::to_vec(&std::env::var("TYPESAFE_API_KEY").ok())
            .map_err(io::Error::other)?;
        let key_len = u32::try_from(key.len()).map_err(io::Error::other)?;
        let withheld = withhold || crate::redact::private_output_mode();
        let values = serde_json::to_vec(&if withheld {
            Vec::new()
        } else {
            crate::redact::log_redaction_values()
        })
        .map_err(io::Error::other)?;
        let values_len = u32::try_from(values.len()).map_err(io::Error::other)?;
        let mut command = Command::new(executable);
        command
            .arg(HELPER_ARG)
            .arg(KEY_CONTROL_ARG)
            .stdin(Stdio::from(OwnedFd::from(input)))
            .stdout(Stdio::from(OwnedFd::from(child_control)))
            .stderr(log)
            .process_group(0);
        if let Some((stderr_input, _)) = &second {
            let fd = stderr_input.as_raw_fd();
            command.arg(PAIRED_ARG);
            // SAFETY: only async-signal-safe dup2/fcntl run between fork and exec.
            unsafe {
                command.pre_exec(move || {
                    if fd == 3 {
                        if libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                            return Err(io::Error::last_os_error());
                        }
                    } else if libc::dup2(fd, 3) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        if withheld {
            command.arg(WITHHOLD_ARG);
        }
        if count_bundle_requests {
            command
                .arg(BUNDLE_REQUESTS_ARG)
                .arg(bundle_requests_path(path));
        }
        crate::redact::scrub_secret_env(&mut command, "", &[]);
        let child = command.spawn()?;
        let error = second.map(|(stderr_input, stderr_output)| {
            drop(stderr_input);
            stderr_output
        });
        let mut drain = Self { child, control };
        let initialized = drain
            .control
            .write_all(&key_len.to_be_bytes())
            .and_then(|_| drain.control.write_all(&key))
            .and_then(|_| drain.control.write_all(&values_len.to_be_bytes()))
            .and_then(|_| drain.control.write_all(&values))
            .and_then(|_| drain.flush());
        if let Err(failure) = initialized {
            drop(output);
            return Err(failure);
        }
        Ok((drain, output, error))
    }

    pub(super) fn flush(&mut self) -> io::Result<()> {
        let deadline = Instant::now() + DRAIN_TIMEOUT;
        if let Some(status) = self.child.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err(io::Error::other("log redactor failed"))
            };
        }
        let sent = self.control.write_all(&[1]);
        let mut ack = [0];
        if sent.is_ok() && self.control.read_exact(&mut ack).is_ok() && ack == [1] {
            return Ok(());
        }
        // EOF can race the checkpoint when the target just closed both streams.
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait()? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(io::Error::other("log redactor failed"))
                };
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "log redactor did not drain",
        ))
    }
}

impl Drop for LogDrain {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

pub fn bundle_requests_path(log: &Path) -> PathBuf {
    log.with_extension("bundle-requests")
}

pub fn read_bundle_requests(log: &Path) -> Option<u64> {
    std::fs::read_to_string(bundle_requests_path(log))
        .ok()?
        .trim()
        .parse()
        .ok()
}

// A value-free count, present only once Metro logged a request, so an absent file means unknown.
struct BundleRequests {
    path: PathBuf,
    count: Option<u64>,
}

impl BundleRequests {
    fn observe(&mut self, line: &[u8]) -> io::Result<()> {
        let line = String::from_utf8_lossy(line);
        let Some((_, request)) = line.split_once(REQUEST_RECEIVED) else {
            return Ok(());
        };
        let bundle = request
            .split_whitespace()
            .next()
            .is_some_and(|url| {
                let path = url.split('?').next().unwrap_or(url);
                let path = path.split("//&").next().unwrap_or(path);
                path.ends_with(".bundle")
            });
        let count = self.count.unwrap_or(0) + u64::from(bundle);
        if self.count == Some(count) {
            return Ok(());
        }
        let partial = self.path.with_extension("bundle-requests.partial");
        std::fs::write(&partial, format!("{count}\n"))?;
        std::fs::rename(&partial, &self.path)?;
        self.count = Some(count);
        Ok(())
    }
}

// The whole command's output is withheld once either stream names a private key.
struct Sink {
    file: std::fs::File,
    start: u64,
    withheld: bool,
    bundles: Option<BundleRequests>,
}

impl Sink {
    fn withhold(&mut self) -> io::Result<()> {
        self.withheld = true;
        self.file.set_len(self.start)?;
        self.file
            .write_all(crate::redact::PRIVATE_KEY_WITHHELD.as_bytes())?;
        self.file.write_all(b"\n")
    }

    fn line(&mut self, bytes: &[u8]) -> io::Result<()> {
        if let Some(bundles) = &mut self.bundles {
            // A count that may lag reads as no request, so a failed write retires the signal instead.
            if bundles.observe(bytes).is_err() {
                let _ = std::fs::remove_file(&bundles.path);
                self.bundles = None;
            }
        }
        if self.withheld {
            return Ok(());
        }
        self.file
            .write_all(crate::redact::redact_plain(&String::from_utf8_lossy(bytes)).as_bytes())
    }
}

#[derive(Default)]
struct Lines {
    pending: Vec<u8>,
    oversized: bool,
}

impl Lines {
    // Checked per byte, so a mention still waiting for its newline withholds before any checkpoint.
    fn write(&mut self, bytes: &[u8], sink: &mut Sink) -> io::Result<()> {
        for &byte in bytes {
            if sink.withheld && sink.bundles.is_none() {
                return Ok(());
            }
            self.pending.push(byte);
            if !sink.withheld
                && self.pending.len() >= 11
                && self.pending[self.pending.len() - 11..].eq_ignore_ascii_case(b"private key")
            {
                sink.withhold()?;
            }
            if self.pending.len() == MAX_LINE {
                if !std::mem::replace(&mut self.oversized, true) {
                    sink.line(b"[oversized log line withheld]\n")?;
                }
                self.pending.drain(..MAX_LINE - 10);
            }
            if byte == b'\n' || byte == b'\r' {
                self.finish(sink)?;
            }
        }
        Ok(())
    }

    fn finish(&mut self, sink: &mut Sink) -> io::Result<()> {
        let pending = std::mem::take(&mut self.pending);
        if std::mem::take(&mut self.oversized) {
            return Ok(());
        }
        sink.line(&pending)
    }
}

fn read_framed(control: &mut UnixStream) -> io::Result<Vec<u8>> {
    let mut length = [0; 4];
    control.read_exact(&mut length)?;
    let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
    control.read_exact(&mut bytes)?;
    Ok(bytes)
}

pub fn run_helper(paired: bool) -> io::Result<()> {
    let mut control = UnixStream::from(std::io::stdout().as_fd().try_clone_to_owned()?);
    let (key, values) = if std::env::args().any(|arg| arg == KEY_CONTROL_ARG) {
        let key = serde_json::from_slice::<Option<String>>(&read_framed(&mut control)?)
            .map_err(io::Error::other)?;
        let values = serde_json::from_slice::<Vec<String>>(&read_framed(&mut control)?)
            .map_err(io::Error::other)?;
        (key, values)
    } else {
        (std::env::var("TYPESAFE_API_KEY").ok(), Vec::new())
    };
    let scope = std::sync::Arc::new(crate::redact::InputValues::from_values(values));
    crate::redact::with_input_scope(scope, || drain(paired, control, key))
}

fn drain(paired: bool, mut control: UnixStream, key: Option<String>) -> io::Result<()> {
    if key.as_ref().is_some_and(|key| key.contains(['\r', '\n'])) {
        return Err(io::Error::other(
            "cannot stream-redact a multiline configured key",
        ));
    }
    crate::redact::set_redaction_key(key);
    let mut inputs = vec![UnixStream::from(
        std::io::stdin().as_fd().try_clone_to_owned()?,
    )];
    if paired {
        // SAFETY: the paired drain's parent installs the child's stderr pipe as fd 3.
        inputs.push(UnixStream::from(unsafe { OwnedFd::from_raw_fd(3) }));
    }
    let mut streams: Vec<(UnixStream, Lines, bool)> = inputs
        .into_iter()
        .map(|input| (input, Lines::default(), false))
        .collect();
    for (input, _, _) in &streams {
        input.set_nonblocking(true)?;
    }
    control.set_nonblocking(true)?;
    let file = std::fs::File::from(std::io::stderr().as_fd().try_clone_to_owned()?);
    let args: Vec<String> = std::env::args().collect();
    let bundles = args
        .iter()
        .position(|arg| arg == BUNDLE_REQUESTS_ARG)
        .and_then(|at| args.get(at + 1))
        .map(|path| BundleRequests {
            path: PathBuf::from(path),
            count: None,
        });
    let mut log = Sink {
        start: file.metadata()?.len(),
        file,
        withheld: false,
        bundles,
    };
    if std::env::args().any(|arg| arg == WITHHOLD_ARG) {
        log.withheld = true;
        log.file.write_all(b"[private output withheld]\n")?;
    }
    let mut buf = [0; 8192];
    let mut checkpoint = false;
    loop {
        if !checkpoint {
            match control.read(&mut buf[..1]) {
                Ok(1) => checkpoint = true,
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) if e.kind() == io::ErrorKind::ConnectionReset => {}
                Err(e) => return Err(e),
            }
        }
        let mut progress = false;
        for _ in 0..128 {
            let mut read_any = false;
            for (input, lines, eof) in streams.iter_mut().filter(|(_, _, eof)| !*eof) {
                match input.read(&mut buf) {
                    Ok(0) => {
                        *eof = true;
                        lines.finish(&mut log)?;
                    }
                    Ok(n) => {
                        lines.write(&buf[..n], &mut log)?;
                        read_any = true;
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => read_any = true,
                    Err(e) => return Err(e),
                }
            }
            progress |= read_any;
            if !read_any {
                break;
            }
        }
        let done = streams.iter().all(|(_, _, eof)| *eof);
        // A checkpoint covers this bounded prefix, not eventual producer silence.
        if checkpoint {
            if let Err(e) = control.write_all(&[1]) {
                if !matches!(
                    e.kind(),
                    io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
                ) {
                    return Err(e);
                }
            }
            checkpoint = false;
        }
        if done {
            return Ok(());
        }
        if progress {
            std::thread::yield_now();
        } else {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
