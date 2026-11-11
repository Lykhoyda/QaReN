use crate::adapters::android;
use crate::commands::cleanup::{cleanup_process_group, Outcome};
use crate::exec::{CmdSpec, Runner};
use crate::runrecord::{
    capture_pid_identity, probe_pid_identity, PidLiveness, RecorderKind, RecorderResource,
    RunRecord,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

mod continuity;
pub use continuity::{detect_continuity, VideoStall};

const START_WAIT_MS: u64 = 10_000;
const STOP_WAIT_MS: u64 = 30_000;
const POLL_MS: u64 = 250;
pub const MAX_VIDEO_BYTES: u64 = 100 * 1024 * 1024;
const FFMPEG_SECONDS: u64 = 900;

// Closed recording/publication findings; legacy detail text is retained independently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoReason {
    NotRecorded,
    RecorderFailed,
    FfmpegMissing,
    EncodeFailed,
    NoPlayableDuration,
    Cancelled,
    RuntimeInputWithheld,
    Interrupted,
    NoAdmittedFrame,
    NoWindow,
    TrimFailed,
    AndroidUnsupported,
    PublishedCopyMissing,
    Other,
}

impl VideoReason {
    fn from_detail(detail: &str) -> Self {
        match detail {
            "the calling process exited"
            | "received SIGTERM"
            | "received SIGINT"
            | "received SIGHUP" => Self::Cancelled,
            _ if detail.starts_with("received signal ") && detail[16..].parse::<i32>().is_ok() => {
                Self::Cancelled
            }
            "no capture was written" => Self::NotRecorded,
            "ffmpeg" => Self::FfmpegMissing,
            "encode failed" => Self::EncodeFailed,
            "ffprobe found no playable duration" => Self::NoPlayableDuration,
            "runtime inputs withhold recording" => Self::RuntimeInputWithheld,
            "app continuity was interrupted after admission" => Self::Interrupted,
            "no admitted app frame was recorded" => Self::NoAdmittedFrame,
            "no positive publication window was recorded" => Self::NoWindow,
            "the admitted part of the recording could not be prepared" => Self::TrimFailed,
            "Android API <34 stops screen recording at 180 s" => Self::AndroidUnsupported,
            "published recording is unavailable" => Self::PublishedCopyMissing,
            "media directory"
            | "run record not persisted"
            | "recorder did not spawn"
            | "recorder identity was not persisted"
            | "could not clear recorder device file"
            | "the recorder did not stop cleanly" => Self::RecorderFailed,
            _ if detail.starts_with("recording did not start within ")
                || detail.starts_with("recorder did not start (stop: ")
                || detail.starts_with("recorder identity was not persisted (stop: ") =>
            {
                Self::RecorderFailed
            }
            _ => Self::Other,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRecorded => "not-recorded",
            Self::RecorderFailed => "recorder-failed",
            Self::FfmpegMissing => "ffmpeg-missing",
            Self::EncodeFailed => "encode-failed",
            Self::NoPlayableDuration => "no-playable-duration",
            Self::Cancelled => "cancelled",
            Self::RuntimeInputWithheld => "runtime-input-withheld",
            Self::Interrupted => "interrupted",
            Self::NoAdmittedFrame => "no-admitted-frame",
            Self::NoWindow => "no-window",
            Self::TrimFailed => "trim-failed",
            Self::AndroidUnsupported => "android-unsupported",
            Self::PublishedCopyMissing => "published-copy-missing",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoStatus {
    Available,
    Unavailable { code: VideoReason, detail: String },
    TooLarge,
}

impl VideoStatus {
    pub fn unavailable(detail: String) -> Self {
        Self::Unavailable {
            code: VideoReason::from_detail(&detail),
            detail,
        }
    }

    pub fn reason(&self) -> Option<VideoReason> {
        match self {
            Self::Unavailable { code, .. } => Some(*code),
            Self::Available | Self::TooLarge => None,
        }
    }
}

impl std::fmt::Display for VideoStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VideoStatus::Available => f.write_str("available"),
            VideoStatus::Unavailable { detail: reason, .. } => write!(f, "unavailable({reason})"),
            VideoStatus::TooLarge => f.write_str("too-large"),
        }
    }
}

impl std::str::FromStr for VideoStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "available" => Ok(VideoStatus::Available),
            "too-large" => Ok(VideoStatus::TooLarge),
            other => other
                .strip_prefix("unavailable(")
                .and_then(|r| r.strip_suffix(')'))
                .map(|r| VideoStatus::unavailable(r.to_string()))
                .ok_or_else(|| format!("unknown video status {other}")),
        }
    }
}

impl Serialize for VideoStatus {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for VideoStatus {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

pub fn video_next_step(status: &VideoStatus) -> Option<&'static str> {
    match status {
        VideoStatus::Available => None,
        VideoStatus::TooLarge => {
            Some("shorten or split the plan; an encoded video file may not exceed 100 MB")
        }
        VideoStatus::Unavailable { detail: reason, .. } if reason == "ffmpeg" || reason.starts_with("ffprobe") => {
            Some("install ffmpeg and ffprobe, then rerun with --record; the raw capture is kept in media/")
        }
        VideoStatus::Unavailable { detail: reason, .. } if reason == "runtime inputs withhold recording" => {
            Some("runs with runtime inputs are recorded only when the app config declares video: non-strict and private output mode is off")
        }
        VideoStatus::Unavailable { detail: reason, .. } if reason.starts_with("Android API <34") => {
            Some("use an emulator with API 34 or later to record")
        }
        VideoStatus::Unavailable { .. } => Some("rerun with --record; the run's verdict is not affected"),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoPublication {
    Eligible,
    WithheldFill,
    WithheldPrivacy,
    #[default]
    #[serde(other)]
    Unknown,
}

impl VideoPublication {
    pub fn withholding_reason(&self) -> Option<&'static str> {
        match self {
            Self::Eligible => None,
            Self::WithheldFill => {
                Some("the plan has a fill or type step, or a login replay typed into a field")
            }
            Self::WithheldPrivacy => Some("screenshot privacy disallowed capture during the walk"),
            Self::Unknown => Some("video publication eligibility is missing or unknown"),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoPolicy {
    Strict,
    NonStrict,
    #[default]
    Undeclared,
    #[serde(other)]
    Unknown,
}

impl VideoPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Strict => "strict",
            Self::NonStrict => "non-strict",
            Self::Undeclared => "undeclared",
            Self::Unknown => "unknown",
        }
    }

    pub fn publication(
        self,
        strict: &VideoPublication,
        non_strict: Option<&NonStrictPublication>,
    ) -> VideoPublication {
        if self == Self::Unknown || *strict == VideoPublication::Unknown {
            return VideoPublication::Unknown;
        }
        if self != Self::NonStrict {
            return strict.clone();
        }
        match non_strict {
            Some(NonStrictPublication::Eligible) => VideoPublication::Eligible,
            Some(NonStrictPublication::WithheldSecret) => VideoPublication::WithheldPrivacy,
            None => VideoPublication::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NonStrictPublication {
    Eligible,
    WithheldSecret,
}

fn media_dir(run_dir: &Path) -> PathBuf {
    run_dir.join("media")
}

pub(crate) fn raw_capture(media: &Path) -> PathBuf {
    let mp4 = media.join("raw.mp4");
    if mp4.exists() {
        mp4
    } else {
        media.join("raw.mov")
    }
}

pub fn video_path(run_dir: &Path) -> PathBuf {
    media_dir(run_dir).join("video.mp4")
}

// Only this trimmed copy is uploaded; video.mp4 retains the complete local recording.
pub fn published_video_path(run_dir: &Path) -> PathBuf {
    media_dir(run_dir).join("video-published.mp4")
}

fn segment_log(run_dir: &Path) -> PathBuf {
    run_dir.join("logs").join("recorder.log")
}

fn now_ms(runner: &dyn Runner) -> u64 {
    runner.monotonic_ms()
}

fn record_spec(udid: &str, raw: &Path) -> CmdSpec {
    CmdSpec::new(
        "simctl-record-video",
        "xcrun",
        &[
            "simctl",
            "io",
            udid,
            "recordVideo",
            "--codec",
            "h264",
            "--force",
            &raw.to_string_lossy(),
        ],
        0,
    )
}

pub enum RecordTarget<'a> {
    Ios(&'a str),
    Android {
        adb: &'a Path,
        port: u16,
        serial: &'a str,
    },
}

// ⑧: persisted before the spawn; any failure leaves the run going without video.
pub fn start(
    runner: &mut dyn Runner,
    record: &mut RunRecord,
    runs_root: &Path,
    target: RecordTarget<'_>,
) -> Result<(), VideoStatus> {
    let udid = match target {
        RecordTarget::Ios(udid) => udid,
        RecordTarget::Android { adb, port, serial } => {
            return start_android(runner, record, runs_root, adb, port, serial)
        }
    };
    if let Some(reason) = runner.cancellation() {
        return Err(VideoStatus::Unavailable {
            code: VideoReason::Cancelled,
            detail: reason,
        });
    }
    let run_dir = RunRecord::run_dir(runs_root, &record.run_id);
    let unavailable = |why: &str| VideoStatus::unavailable(why.to_string());
    std::fs::create_dir_all(media_dir(&run_dir)).map_err(|_| unavailable("media directory"))?;
    let raw = media_dir(&run_dir).join("raw.mov");
    let spec = record_spec(udid, &raw);
    record.resources.recorder = Some(RecorderResource {
        pid: None,
        birth: None,
        pulled_sha256: None,
        kind: RecorderKind::IosSimulator,
        device: udid.to_string(),
        output: raw,
    });
    if record.save(runs_root).is_err() {
        record.resources.recorder = None;
        return Err(unavailable("run record not persisted"));
    }
    let log = segment_log(&run_dir);
    let spawned = match runner.spawn_group(&spec, &log) {
        Ok(spawned) => spawned,
        Err(_) => {
            record.resources.recorder = None;
            let _ = record.save(runs_root);
            return Err(unavailable("recorder did not spawn"));
        }
    };
    let birth = capture_pid_identity(runner, spawned.pid);
    let proven = birth.is_some();
    if let Some(recorder) = record.resources.recorder.as_mut() {
        recorder.pid = Some(spawned.pid);
        recorder.birth = birth;
    }
    if !proven || record.save(runs_root).is_err() {
        if cleanup_process_group(
            runner,
            record
                .resources
                .recorder
                .as_ref()
                .and_then(|r| r.birth.as_ref()),
            spawned.pgid,
            None,
        )
        .clean()
        {
            record.resources.recorder = None;
        }
        let _ = record.save(runs_root);
        return Err(unavailable("recorder identity was not persisted"));
    }
    let deadline = now_ms(runner) + START_WAIT_MS;
    loop {
        if let Some(reason) = runner.cancellation() {
            stop(runner, record, runs_root);
            return Err(VideoStatus::Unavailable {
                code: VideoReason::Cancelled,
                detail: reason,
            });
        }
        if std::fs::read_to_string(&log).is_ok_and(|l| l.contains("Recording started")) {
            return Ok(());
        }
        if now_ms(runner) >= deadline {
            break;
        }
        runner.sleep(Duration::from_millis(POLL_MS));
    }
    let outcome = stop(runner, record, runs_root);
    Err(unavailable(&format!(
        "recording did not start within {}s (stop: {})",
        START_WAIT_MS / 1000,
        outcome.render()
    )))
}

fn start_android(
    runner: &mut dyn Runner,
    record: &mut RunRecord,
    runs_root: &Path,
    adb: &Path,
    port: u16,
    serial: &str,
) -> Result<(), VideoStatus> {
    let unavailable = |why: &str| VideoStatus::unavailable(why.to_string());
    if let Some(reason) = runner.cancellation() {
        return Err(VideoStatus::Unavailable {
            code: VideoReason::Cancelled,
            detail: reason,
        });
    }
    let run_dir = RunRecord::run_dir(runs_root, &record.run_id);
    std::fs::create_dir_all(media_dir(&run_dir)).map_err(|_| unavailable("media directory"))?;
    let output = PathBuf::from(format!("/data/local/tmp/qaren-{}.mp4", record.run_id));
    if !runner
        .run(&android::rm_spec(adb, port, serial, &output))
        .ok()
    {
        return Err(unavailable("could not clear recorder device file"));
    }
    record.resources.recorder = Some(RecorderResource {
        pid: None,
        birth: None,
        pulled_sha256: None,
        kind: RecorderKind::AndroidEmulator,
        device: serial.into(),
        output: output.clone(),
    });
    if record.save(runs_root).is_err() {
        record.resources.recorder = None;
        return Err(unavailable("run record not persisted"));
    }
    let spawned = match runner.spawn_group(
        &android::screenrecord_spec(adb, port, serial, &output),
        &segment_log(&run_dir),
    ) {
        Ok(spawned) => spawned,
        Err(_) => {
            let resource = record.resources.recorder.take();
            if record.save(runs_root).is_err() {
                record.resources.recorder = resource;
            }
            return Err(unavailable("recorder did not spawn"));
        }
    };
    let birth = capture_pid_identity(runner, spawned.pid);
    let proven = birth.is_some();
    if let Some(recorder) = record.resources.recorder.as_mut() {
        recorder.pid = Some(spawned.pid);
        recorder.birth = birth;
    }
    if !proven || record.save(runs_root).is_err() {
        let outcome = stop(runner, record, runs_root);
        return Err(unavailable(&format!(
            "recorder identity was not persisted (stop: {})",
            outcome.render()
        )));
    }
    let deadline = now_ms(runner) + START_WAIT_MS;
    loop {
        if let Some(reason) = runner.cancellation() {
            stop(runner, record, runs_root);
            return Err(VideoStatus::Unavailable {
                code: VideoReason::Cancelled,
                detail: reason,
            });
        }
        if runner
            .run(&android::device_pgrep_spec(adb, port, serial, &output))
            .ok()
        {
            return Ok(());
        }
        if now_ms(runner) >= deadline {
            break;
        }
        runner.sleep(Duration::from_millis(POLL_MS));
    }
    let outcome = stop(runner, record, runs_root);
    Err(unavailable(&format!(
        "recorder did not start (stop: {})",
        outcome.render()
    )))
}

fn stop_android(
    runner: &mut dyn Runner,
    record: &mut RunRecord,
    runs_root: &Path,
    recorder: &RecorderResource,
) -> Outcome {
    if !record.holds_device_lease() {
        return Outcome::Refused("the device lease is not held by this run".into());
    }
    let Some((adb, serial, port)) = record.resources.adb_endpoint() else {
        return Outcome::Unresolved("recorder adb endpoint is missing".into());
    };
    if serial != recorder.device {
        return Outcome::Unresolved("recorder device differs from the run's adb endpoint".into());
    }
    if let Err(reason) = android::borrowed_server_compatible(runner, &adb, port) {
        return Outcome::Unresolved(reason);
    }
    let interrupted = runner.run(&android::device_pkill_spec(
        &adb,
        port,
        &serial,
        "INT",
        &recorder.output,
    ));
    if interrupted.timed_out || !matches!(interrupted.exit_code, Some(0 | 1)) {
        return Outcome::Unresolved("recorder INT failed".into());
    }
    let gone = match wait_android_gone(runner, &adb, port, &serial, &recorder.output) {
        Ok(gone) => gone,
        Err(reason) => return Outcome::Unresolved(reason),
    };
    if !gone {
        record.push_history(crate::timefmt::iso8601_utc(runner.now_epoch_ms()), "Android recorder exceeded INT stop budget; KILL fallback required (media finalized abnormally)");
        if record.save(runs_root).is_err() {
            return Outcome::Unresolved("recorder KILL fallback was not persisted".into());
        }
        let killed = runner.run(&android::device_pkill_spec(
            &adb,
            port,
            &serial,
            "KILL",
            &recorder.output,
        ));
        if killed.timed_out || !matches!(killed.exit_code, Some(0 | 1)) {
            return Outcome::Unresolved("recorder KILL failed".into());
        }
        match wait_android_gone(runner, &adb, port, &serial, &recorder.output) {
            Ok(true) => {}
            Ok(false) => return Outcome::Unresolved("device recorder remains after KILL".into()),
            Err(reason) => return Outcome::Unresolved(reason),
        }
    }
    if let Some(pid) = recorder.pid {
        let outcome = cleanup_process_group(runner, recorder.birth.as_ref(), pid, None);
        if !outcome.clean() {
            return outcome;
        }
    }
    let raw = media_dir(&RunRecord::run_dir(runs_root, &record.run_id)).join("raw.mp4");
    if std::fs::create_dir_all(raw.parent().unwrap()).is_err() {
        return Outcome::Unresolved("recorder media directory unavailable".into());
    }
    let pulled = recorder
        .pulled_sha256
        .as_ref()
        .is_some_and(|expected| capture_sha256(&raw).is_ok_and(|actual| actual == *expected));
    if !pulled {
        if !runner
            .run(&android::pull_spec(
                &adb,
                port,
                &serial,
                &recorder.output,
                &raw,
            ))
            .ok()
        {
            return Outcome::Unresolved(format!(
                "pull failed; media kept on device at {}",
                recorder.output.display()
            ));
        }
        let Ok(digest) = capture_sha256(&raw) else {
            return Outcome::Unresolved(
                "pulled recorder media is unreadable; media kept on device".into(),
            );
        };
        record.resources.recorder.as_mut().unwrap().pulled_sha256 = Some(digest);
        if record.save(runs_root).is_err() {
            record.resources.recorder = Some(recorder.clone());
            return Outcome::Unresolved(
                "recorder pull evidence was not persisted; media kept on device".into(),
            );
        }
    }
    if !runner
        .run(&android::rm_spec(&adb, port, &serial, &recorder.output))
        .ok()
    {
        return Outcome::Unresolved(format!(
            "device rm failed; media kept on device at {}",
            recorder.output.display()
        ));
    }
    let resource = record.resources.recorder.take();
    if record.save(runs_root).is_err() {
        record.resources.recorder = resource;
        return Outcome::Unresolved("recorder retirement was not persisted".into());
    }
    Outcome::Removed
}

// Stream unbounded recordings rather than loading the entire video into memory.
fn capture_sha256(raw: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(raw)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    file.sync_all()?;
    Ok(format!("{:x}", digest.finalize()))
}

fn wait_android_gone(
    runner: &mut dyn Runner,
    adb: &Path,
    port: u16,
    serial: &str,
    output: &Path,
) -> Result<bool, String> {
    let deadline = now_ms(runner) + STOP_WAIT_MS;
    loop {
        let probe = runner.run(&android::device_pgrep_spec(adb, port, serial, output));
        match (probe.timed_out, probe.exit_code) {
            (false, Some(1)) => return Ok(true),
            (false, Some(0)) => {}
            _ => return Err("recorder stop pgrep failed; device state unknown".into()),
        }
        if now_ms(runner) >= deadline {
            return Ok(false);
        }
        runner.sleep(Duration::from_millis(POLL_MS));
    }
}

fn wait_gone(runner: &mut dyn Runner, birth: &crate::runrecord::PidIdentity, budget_ms: u64) {
    let deadline = now_ms(runner) + budget_ms;
    loop {
        if matches!(
            probe_pid_identity(runner, birth),
            PidLiveness::Dead | PidLiveness::AliveForeign
        ) {
            return;
        }
        if now_ms(runner) >= deadline {
            return;
        }
        runner.sleep(Duration::from_millis(POLL_MS));
    }
}

// ⑫: SIGINT so the container is finalized; the group is killed only if it will not exit.
pub fn stop(runner: &mut dyn Runner, record: &mut RunRecord, runs_root: &Path) -> Outcome {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    let Some(recorder) = record.resources.recorder.clone() else {
        return Outcome::Absent;
    };
    if recorder.kind == RecorderKind::AndroidEmulator {
        return stop_android(runner, record, runs_root, &recorder);
    }
    let Some(pid) = recorder.pid else {
        return Outcome::Unresolved("recorder spawn identity is unproven".into());
    };
    if recorder.birth.as_ref().is_some_and(|birth| {
        birth.pid == pid && probe_pid_identity(runner, birth) == PidLiveness::AliveMatching
    }) {
        runner.run(&CmdSpec::new(
            "recorder-interrupt",
            "/bin/kill",
            &["-INT", &pid.to_string()],
            10,
        ));
    }
    if let Some(birth) = recorder.birth.as_ref() {
        wait_gone(runner, birth, STOP_WAIT_MS);
    }
    let outcome = match cleanup_process_group(runner, recorder.birth.as_ref(), pid, None) {
        Outcome::Absent => Outcome::Removed,
        other => other,
    };
    if outcome.clean() {
        record.resources.recorder = None;
        let _ = record.save(runs_root);
    }
    outcome
}

fn ffmpeg_encode(
    runner: &mut dyn Runner,
    input: &[&str],
    out: &Path,
    bitrate: Option<u64>,
) -> bool {
    let mut args: Vec<String> = vec!["-y".into(), "-v".into(), "error".into()];
    args.extend(input.iter().map(|a| a.to_string()));
    args.extend(
        [
            "-c:v",
            "libx264",
            "-r",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
        ]
        .map(String::from),
    );
    if let Some(bps) = bitrate {
        args.extend(["-b:v".to_string(), bps.to_string()]);
    }
    args.push(out.to_string_lossy().into_owned());
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    runner
        .run(&CmdSpec::new(
            "ffmpeg-encode",
            "ffmpeg",
            &args,
            FFMPEG_SECONDS,
        ))
        .ok()
}

fn probe_duration_ms(runner: &mut dyn Runner, video: &Path) -> Option<u64> {
    let output = runner.run(&CmdSpec::new(
        "ffprobe-duration",
        "ffprobe",
        &[
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &video.to_string_lossy(),
        ],
        60,
    ));
    let seconds: f64 = output.ok().then(|| output.stdout.trim().parse().ok())??;
    (seconds > 0.0).then_some((seconds * 1000.0) as u64)
}

fn size_of(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

pub fn finalize(runner: &mut dyn Runner, run_dir: &Path) -> VideoStatus {
    let unavailable = |why: &str| VideoStatus::unavailable(why.to_string());
    if !runner
        .run(&CmdSpec::new("which", "which", &["ffmpeg"], 10))
        .ok()
    {
        return unavailable("ffmpeg");
    }
    let media = media_dir(run_dir);
    let video = video_path(run_dir);
    let raw = raw_capture(&media);
    if size_of(&raw) == 0 {
        return unavailable("no capture was written");
    }
    let input = ["-i".to_string(), raw.to_string_lossy().into_owned()];
    let input: Vec<&str> = input.iter().map(String::as_str).collect();
    if !ffmpeg_encode(runner, &input, &video, None) {
        return unavailable("encode failed");
    }
    let Some(duration_ms) = probe_duration_ms(runner, &video) else {
        return unavailable("ffprobe found no playable duration");
    };
    if size_of(&video) <= MAX_VIDEO_BYTES {
        return VideoStatus::Available;
    }
    // One re-encode sized to fit, with headroom for the container.
    let bitrate = MAX_VIDEO_BYTES * 8 * 9 / 10 * 1000 / duration_ms.max(1);
    let smaller = media.join("video-small.mp4");
    let source = video.to_string_lossy().into_owned();
    if ffmpeg_encode(runner, &["-i", &source], &smaller, Some(bitrate))
        && probe_duration_ms(runner, &smaller).is_some()
        && size_of(&smaller) <= MAX_VIDEO_BYTES
        && std::fs::rename(&smaller, &video).is_ok()
    {
        return VideoStatus::Available;
    }
    let _ = std::fs::remove_file(&smaller);
    VideoStatus::TooLarge
}

// No frame before admission (launcher, server picker, relaunch) or after the last row (runner teardown) may reach the uploaded copy.
pub fn publication_copy(
    runner: &mut dyn Runner,
    run_dir: &Path,
    start_offset_ms: Option<u64>,
    end_offset_ms: Option<u64>,
    publication_interrupted: bool,
) -> VideoStatus {
    let out = published_video_path(run_dir);
    let _ = std::fs::remove_file(&out);
    if publication_interrupted {
        return VideoStatus::unavailable("app continuity was interrupted after admission".into());
    }
    let Some(offset) = start_offset_ms else {
        return VideoStatus::unavailable("no admitted app frame was recorded".into());
    };
    let Some(duration) = end_offset_ms
        .and_then(|end| end.checked_sub(offset))
        .filter(|duration| *duration > 0)
    else {
        return VideoStatus::unavailable("no positive publication window was recorded".into());
    };
    let start = format!("{}.{:03}", offset / 1000, offset % 1000);
    let source = video_path(run_dir).to_string_lossy().into_owned();
    let input = [
        "-ss".to_string(),
        start,
        "-i".to_string(),
        source,
        "-t".to_string(),
        format!("{}.{:03}", duration / 1000, duration % 1000),
    ];
    let input: Vec<&str> = input.iter().map(String::as_str).collect();
    if !ffmpeg_encode(runner, &input, &out, None) || probe_duration_ms(runner, &out).is_none() {
        let _ = std::fs::remove_file(&out);
        return VideoStatus::unavailable(
            "the admitted part of the recording could not be prepared".into(),
        );
    }
    if size_of(&out) > MAX_VIDEO_BYTES {
        let _ = std::fs::remove_file(&out);
        return VideoStatus::TooLarge;
    }
    VideoStatus::Available
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner, Spawned};
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    pub(super) fn temp_run_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qaren-record-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(media_dir(&dir)).unwrap();
        dir
    }

    fn write_raw(run_dir: &Path, bytes: usize) {
        std::fs::write(media_dir(run_dir).join("raw.mov"), vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn unavailable_details_keep_the_legacy_wire_form_and_closed_reason() {
        for (detail, code) in [
            ("no capture was written", VideoReason::NotRecorded),
            ("recorder did not spawn", VideoReason::RecorderFailed),
            (
                "recording did not start within 10s (stop: clean)",
                VideoReason::RecorderFailed,
            ),
            ("ffmpeg", VideoReason::FfmpegMissing),
            ("encode failed", VideoReason::EncodeFailed),
            (
                "ffprobe found no playable duration",
                VideoReason::NoPlayableDuration,
            ),
            ("received SIGTERM", VideoReason::Cancelled),
            (
                "runtime inputs withhold recording",
                VideoReason::RuntimeInputWithheld,
            ),
            (
                "app continuity was interrupted after admission",
                VideoReason::Interrupted,
            ),
            (
                "no admitted app frame was recorded",
                VideoReason::NoAdmittedFrame,
            ),
            (
                "no positive publication window was recorded",
                VideoReason::NoWindow,
            ),
            (
                "the admitted part of the recording could not be prepared",
                VideoReason::TrimFailed,
            ),
            (
                "Android API <34 stops screen recording at 180 s",
                VideoReason::AndroidUnsupported,
            ),
            (
                "published recording is unavailable",
                VideoReason::PublishedCopyMissing,
            ),
            ("legacy arbitrary (explanation)", VideoReason::Other),
        ] {
            let text = format!("unavailable({detail})");
            let status: VideoStatus = text.parse().unwrap();
            assert_eq!(status.reason(), Some(code));
            assert_eq!(status.to_string(), text);
            assert_eq!(
                serde_json::from_value::<VideoStatus>(serde_json::json!(text)).unwrap(),
                status
            );
            assert_eq!(serde_json::to_value(code).unwrap(), code.as_str());
        }
    }

    #[test]
    fn unknown_strict_always_withholds_even_with_non_strict_permission() {
        assert_eq!(
            VideoPolicy::NonStrict.publication(
                &VideoPublication::Unknown,
                Some(&NonStrictPublication::Eligible)
            ),
            VideoPublication::Unknown
        );
    }

    #[test]
    fn an_ffprobe_failure_refuses_the_attachment() {
        let run_dir = temp_run_dir();
        write_raw(&run_dir, 10);
        let mut mock = MockRunner::new();
        mock.expect_run("which ffmpeg", CmdOutput::success("/opt/ffmpeg\n"));
        mock.expect_run("ffmpeg", CmdOutput::success(""));
        mock.expect_run("ffprobe", CmdOutput::failed(1, "moov atom not found"));
        assert!(matches!(
            finalize(&mut mock, &run_dir),
            VideoStatus::Unavailable { detail: r, .. } if r.contains("ffprobe")
        ));
    }

    #[test]
    fn finalize_accepts_android_raw_mp4() {
        let run_dir = temp_run_dir();
        let raw = run_dir.join("media/raw.mp4");
        std::fs::write(&raw, "android recording").unwrap();
        let mut runner = SizedEncodes {
            mock: MockRunner::new(),
            sizes: vec![10],
        };
        runner
            .mock
            .expect_run("which ffmpeg", CmdOutput::success("/opt/ffmpeg"));
        runner.mock.expect_run("ffmpeg", CmdOutput::success(""));
        runner
            .mock
            .expect_run("ffprobe", CmdOutput::success("240.0"));
        assert_eq!(finalize(&mut runner, &run_dir), VideoStatus::Available);
        assert!(runner.mock.calls[1]
            .args
            .contains(&raw.to_string_lossy().into_owned()));
        assert_eq!(runner.mock.remaining(), 0);
        std::fs::remove_dir_all(run_dir).unwrap();
    }

    #[test]
    fn each_missing_video_names_its_next_step() {
        let unavailable = |reason: &str| VideoStatus::unavailable(reason.into());
        assert_eq!(video_next_step(&VideoStatus::Available), None);
        assert_eq!(
            video_next_step(&VideoStatus::TooLarge),
            Some("shorten or split the plan; an encoded video file may not exceed 100 MB")
        );
        for reason in ["ffmpeg", "ffprobe found no playable duration"] {
            assert_eq!(
                video_next_step(&unavailable(reason)),
                Some("install ffmpeg and ffprobe, then rerun with --record; the raw capture is kept in media/")
            );
        }
        assert_eq!(
            video_next_step(&unavailable("runtime inputs withhold recording")),
            Some("runs with runtime inputs are recorded only when the app config declares video: non-strict and private output mode is off")
        );
        assert_eq!(
            video_next_step(&unavailable(
                "Android API <34 stops screen recording at 180 s"
            )),
            Some("use an emulator with API 34 or later to record")
        );
        assert_eq!(
            video_next_step(&unavailable("recorder did not spawn")),
            Some("rerun with --record; the run's verdict is not affected")
        );
    }

    #[test]
    fn missing_ffmpeg_is_unavailable() {
        let run_dir = temp_run_dir();
        let mut mock = MockRunner::new();
        mock.expect_run("which ffmpeg", CmdOutput::failed(1, ""));
        assert_eq!(
            finalize(&mut mock, &run_dir),
            VideoStatus::unavailable("ffmpeg".into())
        );
    }

    // A runner whose encodes write files of scripted sizes.
    struct SizedEncodes {
        mock: MockRunner,
        sizes: Vec<u64>,
    }

    impl Runner for SizedEncodes {
        fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
            if spec.label == "ffmpeg-encode" {
                let out = PathBuf::from(spec.args.last().unwrap());
                let file = std::fs::File::create(&out).unwrap();
                file.set_len(self.sizes.remove(0)).unwrap();
            }
            self.mock.execute(spec, interruptible)
        }
        fn spawn_group_unchecked(
            &mut self,
            spec: &CmdSpec,
            log: &Path,
        ) -> std::io::Result<Spawned> {
            self.mock.spawn_group_unchecked(spec, log)
        }
        fn spawn_piped_unchecked(
            &mut self,
            spec: &CmdSpec,
            log: &Path,
        ) -> std::io::Result<crate::exec::PipedChild> {
            self.mock.spawn_piped_unchecked(spec, log)
        }
        fn sleep(&mut self, d: Duration) {
            self.mock.sleep(d)
        }
        fn now_epoch_ms(&self) -> u64 {
            self.mock.now_epoch_ms()
        }
        fn commands_executed(&self) -> u64 {
            self.mock.commands_executed()
        }
    }

    #[test]
    fn the_published_copy_starts_at_admission_and_the_local_recording_stays_complete() {
        let run_dir = temp_run_dir();
        std::fs::write(video_path(&run_dir), "complete").unwrap();
        let mut runner = SizedEncodes {
            mock: MockRunner::new(),
            sizes: vec![10],
        };
        runner.mock.expect_run("ffmpeg", CmdOutput::success(""));
        runner
            .mock
            .expect_run("ffprobe", CmdOutput::success("20.0\n"));
        assert_eq!(
            publication_copy(&mut runner, &run_dir, Some(12_345), Some(32_345), false),
            VideoStatus::Available
        );
        let args = &runner.mock.calls[0].args;
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[ss + 1], "12.345");
        assert_eq!(args[ss + 2], "-i");
        assert_eq!(args[ss + 3], video_path(&run_dir).to_string_lossy());
        assert_eq!(
            args.last().unwrap(),
            &published_video_path(&run_dir)
                .to_string_lossy()
                .into_owned()
        );
        assert!(published_video_path(&run_dir).is_file());
        assert_eq!(
            std::fs::read_to_string(video_path(&run_dir)).unwrap(),
            "complete"
        );
        let t = args.iter().position(|a| a == "-t").unwrap();
        assert_eq!(args[t + 1], "20.000");
        assert_eq!(runner.mock.remaining(), 0);
    }

    #[test]
    fn without_a_positive_window_no_copy_is_published() {
        for end in [None, Some(12_000), Some(12_345)] {
            let run_dir = temp_run_dir();
            std::fs::write(video_path(&run_dir), "complete").unwrap();
            std::fs::write(published_video_path(&run_dir), "stale").unwrap();
            let mut runner = MockRunner::new();
            assert_eq!(
                publication_copy(&mut runner, &run_dir, Some(12_345), end, false),
                VideoStatus::unavailable("no positive publication window was recorded".into()),
                "end: {end:?}"
            );
            assert!(runner.calls.is_empty());
            assert!(!published_video_path(&run_dir).exists());
            assert_eq!(
                std::fs::read_to_string(video_path(&run_dir)).unwrap(),
                "complete"
            );
            std::fs::remove_dir_all(run_dir).unwrap();
        }
    }

    #[test]
    fn the_published_copy_ends_at_the_last_row() {
        let run_dir = temp_run_dir();
        std::fs::write(video_path(&run_dir), "complete").unwrap();
        let mut runner = SizedEncodes {
            mock: MockRunner::new(),
            sizes: vec![10],
        };
        runner.mock.expect_run("ffmpeg", CmdOutput::success(""));
        runner
            .mock
            .expect_run("ffprobe", CmdOutput::success("7.0\n"));
        assert_eq!(
            publication_copy(&mut runner, &run_dir, Some(12_345), Some(20_000), false),
            VideoStatus::Available
        );
        let args = &runner.mock.calls[0].args;
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(args[i - 1], "12.345");
        assert_eq!(args[i + 1], video_path(&run_dir).to_string_lossy());
        assert_eq!(args[i + 2], "-t");
        assert_eq!(args[i + 3], "7.655");
        assert_eq!(runner.mock.remaining(), 0);
    }

    #[test]
    fn interrupted_publication_withholds_the_copy_even_with_admission() {
        let run_dir = temp_run_dir();
        std::fs::write(video_path(&run_dir), "complete").unwrap();
        std::fs::write(published_video_path(&run_dir), "stale").unwrap();
        let mut mock = MockRunner::new();
        assert!(matches!(
            publication_copy(&mut mock, &run_dir, Some(12_345), None, true),
            VideoStatus::Unavailable { .. }
        ));
        assert!(mock.calls.is_empty());
        assert!(!published_video_path(&run_dir).exists());
        assert_eq!(
            std::fs::read_to_string(video_path(&run_dir)).unwrap(),
            "complete"
        );
    }

    #[test]
    fn without_an_admission_time_nothing_is_publishable() {
        let run_dir = temp_run_dir();
        std::fs::write(video_path(&run_dir), "complete").unwrap();
        std::fs::write(published_video_path(&run_dir), "stale").unwrap();
        let mut mock = MockRunner::new();
        assert!(matches!(
            publication_copy(&mut mock, &run_dir, None, None, false),
            VideoStatus::Unavailable { .. }
        ));
        assert!(mock.calls.is_empty());
        assert!(!published_video_path(&run_dir).exists());
        assert!(video_path(&run_dir).is_file());
    }

    #[test]
    fn a_failed_trim_leaves_no_published_copy() {
        let run_dir = temp_run_dir();
        std::fs::write(video_path(&run_dir), "complete").unwrap();
        let mut runner = SizedEncodes {
            mock: MockRunner::new(),
            sizes: vec![10],
        };
        runner.mock.expect_run("ffmpeg", CmdOutput::success(""));
        runner
            .mock
            .expect_run("ffprobe", CmdOutput::failed(1, "no duration"));
        assert!(matches!(
            publication_copy(&mut runner, &run_dir, Some(90_000), Some(100_000), false),
            VideoStatus::Unavailable { .. }
        ));
        assert!(!published_video_path(&run_dir).exists());
    }

    #[test]
    fn over_the_limit_after_one_reencode_is_too_large() {
        let run_dir = temp_run_dir();
        write_raw(&run_dir, 10);
        let mut runner = SizedEncodes {
            mock: MockRunner::new(),
            sizes: vec![MAX_VIDEO_BYTES + 1, MAX_VIDEO_BYTES + 1],
        };
        runner
            .mock
            .expect_run("which ffmpeg", CmdOutput::success("/opt/ffmpeg\n"));
        runner.mock.expect_run("ffmpeg", CmdOutput::success(""));
        runner
            .mock
            .expect_run("ffprobe", CmdOutput::success("60.0\n"));
        runner.mock.expect_run("ffmpeg", CmdOutput::success(""));
        runner
            .mock
            .expect_run("ffprobe", CmdOutput::success("60.0\n"));
        assert_eq!(finalize(&mut runner, &run_dir), VideoStatus::TooLarge);
        let reencode = &runner.mock.calls[3];
        assert!(reencode.args.contains(&"-b:v".to_string()));
        assert_eq!(runner.mock.remaining(), 0);
    }

    #[test]
    fn a_fitting_capture_is_available_with_the_reviewer_encoding() {
        let run_dir = temp_run_dir();
        write_raw(&run_dir, 10);
        let mut runner = SizedEncodes {
            mock: MockRunner::new(),
            sizes: vec![1024],
        };
        runner
            .mock
            .expect_run("which ffmpeg", CmdOutput::success("/opt/ffmpeg\n"));
        runner.mock.expect_run("ffmpeg", CmdOutput::success(""));
        runner
            .mock
            .expect_run("ffprobe", CmdOutput::success("12.5\n"));
        assert_eq!(finalize(&mut runner, &run_dir), VideoStatus::Available);
        let encode = &runner.mock.calls[1].args;
        for arg in ["libx264", "30", "yuv420p", "+faststart"] {
            assert!(encode.contains(&arg.to_string()), "{arg}: {encode:?}");
        }
    }

    #[test]
    fn video_status_round_trips_as_a_string() {
        for status in [
            VideoStatus::Available,
            VideoStatus::TooLarge,
            VideoStatus::unavailable("ffmpeg".into()),
        ] {
            let json = serde_json::to_string(&status).unwrap();
            assert_eq!(serde_json::from_str::<VideoStatus>(&json).unwrap(), status);
        }
        assert_eq!(
            VideoStatus::unavailable("ffmpeg".into()).to_string(),
            "unavailable(ffmpeg)"
        );
    }
}
