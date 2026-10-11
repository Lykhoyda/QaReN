use crate::commands::cleanup::{cleanup_process_group, Outcome};
use crate::exec::{CmdSpec, Runner};
use crate::runrecord::{
    capture_pid_identity, probe_pid_identity, PidLiveness, RecorderKind, RecorderResource,
    RunRecord,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

const START_WAIT_MS: u64 = 10_000;
const STOP_WAIT_MS: u64 = 30_000;
const POLL_MS: u64 = 250;
pub const MAX_VIDEO_BYTES: u64 = 100 * 1024 * 1024;
const FFMPEG_SECONDS: u64 = 900;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoStatus {
    Available,
    Unavailable(String),
    TooLarge,
}

impl std::fmt::Display for VideoStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VideoStatus::Available => f.write_str("available"),
            VideoStatus::Unavailable(reason) => write!(f, "unavailable({reason})"),
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
                .map(|r| VideoStatus::Unavailable(r.to_string()))
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
            Self::WithheldFill => Some("the plan contains a fill or type step"),
            Self::WithheldPrivacy => Some("screenshot privacy disallowed capture during the walk"),
            Self::Unknown => Some("video publication eligibility is missing or unknown"),
        }
    }
}

fn media_dir(run_dir: &Path) -> PathBuf {
    run_dir.join("media")
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

// ⑧: persisted before the spawn; any failure leaves the run going without video.
pub fn start(
    runner: &mut dyn Runner,
    record: &mut RunRecord,
    runs_root: &Path,
    udid: &str,
) -> Result<(), VideoStatus> {
    if let Some(reason) = runner.cancellation() {
        return Err(VideoStatus::Unavailable(reason));
    }
    let run_dir = RunRecord::run_dir(runs_root, &record.run_id);
    let unavailable = |why: &str| VideoStatus::Unavailable(why.to_string());
    std::fs::create_dir_all(media_dir(&run_dir)).map_err(|_| unavailable("media directory"))?;
    let raw = media_dir(&run_dir).join("raw.mov");
    let spec = record_spec(udid, &raw);
    record.resources.recorder = Some(RecorderResource {
        pid: None,
        birth: None,
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
            return Err(unavailable(&reason));
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
    let unavailable = |why: &str| VideoStatus::Unavailable(why.to_string());
    if !runner
        .run(&CmdSpec::new("which", "which", &["ffmpeg"], 10))
        .ok()
    {
        return unavailable("ffmpeg");
    }
    let media = media_dir(run_dir);
    let video = video_path(run_dir);
    let raw = media.join("raw.mov");
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

// No frame before admission (launcher, server picker, relaunch) may reach the uploaded copy.
pub fn publication_copy(
    runner: &mut dyn Runner,
    run_dir: &Path,
    admitted_offset_ms: Option<u64>,
    publication_interrupted: bool,
) -> VideoStatus {
    let out = published_video_path(run_dir);
    let _ = std::fs::remove_file(&out);
    if publication_interrupted {
        return VideoStatus::Unavailable("app continuity was interrupted after admission".into());
    }
    let Some(offset) = admitted_offset_ms else {
        return VideoStatus::Unavailable("no admitted app frame was recorded".into());
    };
    let start = format!("{}.{:03}", offset / 1000, offset % 1000);
    let source = video_path(run_dir).to_string_lossy().into_owned();
    if !ffmpeg_encode(runner, &["-ss", &start, "-i", &source], &out, None)
        || probe_duration_ms(runner, &out).is_none()
    {
        let _ = std::fs::remove_file(&out);
        return VideoStatus::Unavailable(
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

    fn temp_run_dir() -> PathBuf {
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
    fn an_ffprobe_failure_refuses_the_attachment() {
        let run_dir = temp_run_dir();
        write_raw(&run_dir, 10);
        let mut mock = MockRunner::new();
        mock.expect_run("which ffmpeg", CmdOutput::success("/opt/ffmpeg\n"));
        mock.expect_run("ffmpeg", CmdOutput::success(""));
        mock.expect_run("ffprobe", CmdOutput::failed(1, "moov atom not found"));
        assert!(matches!(
            finalize(&mut mock, &run_dir),
            VideoStatus::Unavailable(r) if r.contains("ffprobe")
        ));
    }

    #[test]
    fn missing_ffmpeg_is_unavailable() {
        let run_dir = temp_run_dir();
        let mut mock = MockRunner::new();
        mock.expect_run("which ffmpeg", CmdOutput::failed(1, ""));
        assert_eq!(
            finalize(&mut mock, &run_dir),
            VideoStatus::Unavailable("ffmpeg".into())
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
            publication_copy(&mut runner, &run_dir, Some(12_345), false),
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
        assert_eq!(runner.mock.remaining(), 0);
    }

    #[test]
    fn interrupted_publication_withholds_the_copy_even_with_admission() {
        let run_dir = temp_run_dir();
        std::fs::write(video_path(&run_dir), "complete").unwrap();
        std::fs::write(published_video_path(&run_dir), "stale").unwrap();
        let mut mock = MockRunner::new();
        assert!(matches!(
            publication_copy(&mut mock, &run_dir, Some(12_345), true),
            VideoStatus::Unavailable(_)
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
            publication_copy(&mut mock, &run_dir, None, false),
            VideoStatus::Unavailable(_)
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
            publication_copy(&mut runner, &run_dir, Some(90_000), false),
            VideoStatus::Unavailable(_)
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
            VideoStatus::Unavailable("ffmpeg".into()),
        ] {
            let json = serde_json::to_string(&status).unwrap();
            assert_eq!(serde_json::from_str::<VideoStatus>(&json).unwrap(), status);
        }
        assert_eq!(
            VideoStatus::Unavailable("ffmpeg".into()).to_string(),
            "unavailable(ffmpeg)"
        );
    }
}
