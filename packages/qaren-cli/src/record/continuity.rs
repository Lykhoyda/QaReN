use super::{probe_duration_ms, published_video_path, VideoPublication, FFMPEG_SECONDS};
use crate::core::Ledger;
use crate::exec::{CmdSpec, Runner};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

const FREEZE_NOISE: &str = "-60dB";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoStall {
    pub duration_ms: u64,
    pub first_line: u64,
    pub last_line: u64,
}

impl VideoStall {
    pub fn receipt(&self) -> String {
        format!(
            "suspected-stall {} over lines {}–{}",
            self.duration_ms, self.first_line, self.last_line
        )
    }

    pub fn sentence(&self) -> String {
        let seconds = format!("{}.{:03}", self.duration_ms / 1000, self.duration_ms % 1000);
        let seconds = seconds.trim_end_matches('0').trim_end_matches('.');
        format!(
            "The recording shows no change for {seconds} s during steps {}–{} while the step screenshots do; those screenshots carry the evidence.",
            self.first_line, self.last_line
        )
    }
}

fn seconds_ms(raw: &str) -> Option<u64> {
    let seconds: f64 = raw.trim().parse().ok()?;
    (seconds.is_finite() && seconds >= 0.0 && seconds < u64::MAX as f64 / 1000.0)
        .then(|| (seconds * 1000.0).round() as u64)
}

fn frozen_intervals(log: &str, duration_ms: u64) -> Option<Vec<(u64, u64)>> {
    let mut intervals = Vec::new();
    let mut pending = None;
    let mut last_end = 0;
    for line in log.lines() {
        if let Some((_, value)) = line.split_once("lavfi.freezedetect.freeze_start: ") {
            let start = seconds_ms(value)?;
            if pending.is_some() || start < last_end || start >= duration_ms {
                return None;
            }
            pending = Some(start);
        } else if let Some((_, value)) = line.split_once("lavfi.freezedetect.freeze_end: ") {
            let end = seconds_ms(value)?;
            let start = pending.take()?;
            if end <= start || end > duration_ms {
                return None;
            }
            intervals.push((start, end));
            last_end = end;
        }
    }
    if let Some(start) = pending {
        intervals.push((start, duration_ms));
    }
    Some(intervals)
}

fn screenshot_path(run_dir: &Path, relative: &str) -> Option<PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute()
        || !path.components().all(|c| matches!(c, Component::Normal(_)))
        || !path
            .extension()
            .is_some_and(|e| e == "png" || e == "jpg" || e == "jpeg")
    {
        return None;
    }
    let root = run_dir.canonicalize().ok()?;
    let shot = root.join(path).canonicalize().ok()?;
    (shot.starts_with(root) && shot.is_file()).then_some(shot)
}

fn video_dimensions(runner: &mut dyn Runner, video: &Path) -> Option<(u32, u32)> {
    let output = runner.run(&CmdSpec::new(
        "ffprobe-video-dimensions",
        "ffprobe",
        &[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
            &video.to_string_lossy(),
        ],
        30,
    ));
    let (width, height) = output
        .ok()
        .then(|| output.stdout.trim().split_once('x'))??;
    let dimensions = (width.parse().ok()?, height.parse().ok()?);
    (dimensions.0 > 0 && dimensions.1 > 0).then_some(dimensions)
}

fn pixels_differ(
    runner: &mut dyn Runner,
    first: &Path,
    second: &Path,
    dimensions: (u32, u32),
) -> Option<bool> {
    let (width, height) = dimensions;
    // Two still frames one second apart reuse the video's freeze threshold.
    let filter = format!(
        "[0:v]scale={width}:{height},format=yuv420p,setsar=1[a];[1:v]scale={width}:{height},format=yuv420p,setsar=1[b];[a][b]concat=n=2:v=1:a=0,setpts=N/TB,freezedetect=noise={FREEZE_NOISE}:duration=0.5[out]"
    );
    let output = runner.run(&CmdSpec::new(
        "ffmpeg-screenshot-pixels",
        "ffmpeg",
        &[
            "-hide_banner",
            "-nostats",
            "-v",
            "info",
            "-i",
            &first.to_string_lossy(),
            "-i",
            &second.to_string_lossy(),
            "-filter_complex",
            &filter,
            "-map",
            "[out]",
            "-fps_mode",
            "passthrough",
            "-frames:v",
            "2",
            "-an",
            "-progress",
            "pipe:1",
            "-f",
            "null",
            "-",
        ],
        30,
    ));
    if !output.ok()
        || output
            .stdout
            .lines()
            .filter_map(|line| line.strip_prefix("frame="))
            .next_back()?
            != "2"
        || output.stdout.lines().last()? != "progress=end"
    {
        return None;
    }
    match frozen_intervals(&output.stderr, 2000)?.as_slice() {
        [(0, 1000)] => Some(true),
        [(0, 2000)] => Some(false),
        _ => None,
    }
}

fn plan_screenshot(row: &crate::core::Row, ledger: &Ledger) -> bool {
    row.line > 0 && row.screenshot.is_some() && ledger.blocks.iter().any(|b| b.key == row.block)
}

pub fn detect_continuity(
    runner: &mut dyn Runner,
    run_dir: &Path,
    ledger: &Ledger,
    recording_from_ms: u64,
    recording_ready_ms: u64,
    publication_offset_ms: u64,
    row_origin_ms: u64,
) -> Vec<VideoStall> {
    let strict = ledger.video_publication.clone().unwrap_or_default();
    if ledger
        .video_policy
        .publication(&strict, ledger.non_strict_publication.as_ref())
        != VideoPublication::Eligible
        || ledger
            .media_withheld
            .as_ref()
            .is_some_and(|m| m.screenshots.is_some())
        || ledger.steps.iter().any(|r| r.screenshot_withheld.is_some())
    {
        return Vec::new();
    }
    let mut shots = ledger
        .steps
        .iter()
        .filter(|row| plan_screenshot(row, ledger));
    if shots.next().is_none() || shots.next().is_none() {
        return Vec::new();
    }
    detect(
        runner,
        run_dir,
        ledger,
        recording_from_ms,
        recording_ready_ms,
        publication_offset_ms,
        row_origin_ms,
    )
    .unwrap_or_default()
}

fn detect(
    runner: &mut dyn Runner,
    run_dir: &Path,
    ledger: &Ledger,
    recording_from_ms: u64,
    recording_ready_ms: u64,
    publication_offset_ms: u64,
    row_origin_ms: u64,
) -> Option<Vec<VideoStall>> {
    if recording_ready_ms < recording_from_ms {
        return None;
    }
    let video = published_video_path(run_dir);
    let duration = probe_duration_ms(runner, &video)?;
    let output = runner.run(&CmdSpec::new(
        "ffmpeg-video-continuity",
        "ffmpeg",
        &[
            "-hide_banner",
            "-nostats",
            "-v",
            "info",
            "-i",
            &video.to_string_lossy(),
            "-vf",
            &format!("freezedetect=noise={FREEZE_NOISE}:duration=2"),
            "-an",
            "-f",
            "null",
            "-",
        ],
        FFMPEG_SECONDS,
    ));
    if !output.ok() {
        return None;
    }
    let intervals = frozen_intervals(&output.stderr, duration)?;
    let publication_from = recording_from_ms.checked_add(publication_offset_ms)?;
    let publication_ready = recording_ready_ms.checked_add(publication_offset_ms)?;
    let mut dimensions = None;
    let mut stalls = Vec::new();
    for (start, end) in intervals {
        // Require containment for every recorder start between spawn and readiness.
        let start_wall = publication_ready.checked_add(start)?;
        let end_wall = publication_from.checked_add(end)?;
        let rows: Vec<_> = ledger
            .steps
            .iter()
            .filter(|row| {
                plan_screenshot(row, ledger)
                    && row_origin_ms
                        .checked_add(row.t)
                        .is_some_and(|at| at >= start_wall && at < end_wall)
            })
            .collect();
        if rows.len() < 2 {
            continue;
        }
        let size = match dimensions {
            Some(size) => size,
            None => {
                let size = video_dimensions(runner, &video)?;
                dimensions = Some(size);
                size
            }
        };
        let first = screenshot_path(run_dir, rows[0].screenshot.as_deref()?)?;
        let mut different = false;
        for row in &rows[1..] {
            let shot = screenshot_path(run_dir, row.screenshot.as_deref()?)?;
            if shot != first && pixels_differ(runner, &first, &shot, size)? {
                different = true;
                break;
            }
        }
        if different {
            stalls.push(VideoStall {
                duration_ms: end - start,
                first_line: rows.iter().map(|row| row.line).min()?,
                last_line: rows.iter().map(|row| row.line).max()?,
            });
        }
    }
    Some(stalls)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner};

    const FREEZE: &str = "[freezedetect @ 0x123] lavfi.freezedetect.freeze_start: 2.5\n[freezedetect @ 0x123] lavfi.freezedetect.freeze_duration: 8\n[freezedetect @ 0x123] lavfi.freezedetect.freeze_end: 10.5\n";

    fn fixture() -> (PathBuf, Ledger) {
        let dir = super::super::tests::temp_run_dir();
        std::fs::create_dir_all(dir.join("screenshots")).unwrap();
        for name in ["a", "b"] {
            std::fs::write(dir.join(format!("screenshots/{name}.png")), "fixture").unwrap();
        }
        let ledger = serde_json::from_value(serde_json::json!({
            "verdict":"PASS", "path":"walk", "videoPublication":"eligible", "blocks":[{"key":"plan","outcome":"pass","source":"discovered"}],
            "steps":[
                {"block":"plan","line":7,"attempt":1,"kind":"step","resolvedBy":"exact",
                 "t":6500,"outcome":"pass","screenshot":"screenshots/a.png"},
                {"block":"plan","line":8,"attempt":1,"kind":"step","resolvedBy":"exact",
                 "t":9000,"outcome":"pass","screenshot":"screenshots/b.png"}
            ],
            "jev":{"calls":0,"medianMs":0},"llmTurns":0,"escapes":0,"recoveries":0
        }))
        .unwrap();
        (dir, ledger)
    }

    fn comparison(runner: &mut MockRunner, different: bool) {
        runner.expect_run("ffprobe", CmdOutput::success("16x16"));
        runner.expect_run(
            "filter_complex",
            CmdOutput {
                stderr: if different {
                    "lavfi.freezedetect.freeze_start: 0\nlavfi.freezedetect.freeze_end: 1\n".into()
                } else {
                    "lavfi.freezedetect.freeze_start: 0\n".into()
                },
                ..CmdOutput::success("frame=2\nprogress=end\n")
            },
        );
    }

    fn detector(log: &str) -> MockRunner {
        let mut runner = MockRunner::new();
        runner.expect_run("ffprobe", CmdOutput::success("12.0"));
        runner.expect_run(
            "freezedetect",
            CmdOutput {
                stderr: log.into(),
                ..CmdOutput::success("")
            },
        );
        runner
    }

    #[test]
    fn differing_pixels_during_a_freeze_produce_a_numeric_receipt_and_sentence() {
        let (dir, ledger) = fixture();
        let mut runner = detector(FREEZE);
        comparison(&mut runner, true);
        let stalls =
            detect_continuity(&mut runner, &dir, &ledger, 100_000, 100_000, 5_000, 101_000);
        assert_eq!(
            stalls,
            vec![VideoStall {
                duration_ms: 8000,
                first_line: 7,
                last_line: 8
            }]
        );
        assert_eq!(stalls[0].receipt(), "suspected-stall 8000 over lines 7–8");
        assert_eq!(stalls[0].sentence(), "The recording shows no change for 8 s during steps 7–8 while the step screenshots do; those screenshots carry the evidence.");
        assert!(runner.calls.iter().any(|s| s
            .args
            .contains(&published_video_path(&dir).to_string_lossy().into_owned())));
        assert_eq!(runner.remaining(), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn matching_pixels_do_not_imply_a_recorder_stall() {
        let (dir, ledger) = fixture();
        let mut runner = detector(FREEZE);
        comparison(&mut runner, false);
        assert!(
            detect_continuity(&mut runner, &dir, &ledger, 100_000, 100_000, 5_000, 101_000)
                .is_empty()
        );
        assert_eq!(runner.remaining(), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn trim_and_row_origins_both_map_to_wall_time() {
        let (dir, ledger) = fixture();
        for (recording, offset, origin) in [(100_000, 15_000, 101_000), (100_000, 5_000, 120_000)] {
            let mut runner = detector(FREEZE);
            assert!(detect_continuity(
                &mut runner,
                &dir,
                &ledger,
                recording,
                recording,
                offset,
                origin
            )
            .is_empty());
            assert_eq!(runner.remaining(), 0);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn startup_uncertainty_excludes_a_previous_step_at_the_freeze_edge() {
        let (dir, ledger) = fixture();
        let mut runner = detector(FREEZE);
        assert!(
            detect_continuity(&mut runner, &dir, &ledger, 100_000, 101_000, 5_000, 101_000)
                .is_empty()
        );
        assert_eq!(runner.remaining(), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changing_retry_screenshots_on_one_plan_line_are_still_evidence() {
        let (dir, mut ledger) = fixture();
        ledger.steps[1].line = 7;
        ledger.steps[1].attempt = 2;
        let mut runner = detector(FREEZE);
        comparison(&mut runner, true);
        let stalls =
            detect_continuity(&mut runner, &dir, &ledger, 100_000, 100_000, 5_000, 101_000);
        assert_eq!(stalls[0].receipt(), "suspected-stall 8000 over lines 7–7");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_open_freeze_ends_at_the_probed_eof() {
        assert_eq!(
            frozen_intervals("lavfi.freezedetect.freeze_start: 2.5\n", 12_000),
            Some(vec![(2500, 12_000)])
        );
        let (dir, ledger) = fixture();
        let mut runner = detector("lavfi.freezedetect.freeze_start: 2.5\n");
        comparison(&mut runner, true);
        assert_eq!(
            detect_continuity(&mut runner, &dir, &ledger, 100_000, 100_000, 5_000, 101_000)[0]
                .duration_ms,
            9500
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_or_malformed_detection_omits_the_note() {
        let (dir, ledger) = fixture();
        for output in [
            CmdOutput::failed(1, "filter unavailable"),
            CmdOutput {
                timed_out: true,
                ..CmdOutput::success("")
            },
            CmdOutput {
                stderr: "lavfi.freezedetect.freeze_start: NaN".into(),
                ..CmdOutput::success("")
            },
        ] {
            let mut runner = MockRunner::new();
            runner.expect_run("ffprobe", CmdOutput::success("12.0"));
            runner.expect_run("freezedetect", output);
            assert!(detect_continuity(
                &mut runner,
                &dir,
                &ledger,
                100_000,
                100_000,
                5_000,
                101_000
            )
            .is_empty());
            assert_eq!(runner.remaining(), 0);
        }
        let mut runner = detector(FREEZE);
        runner.expect_run("ffprobe", CmdOutput::success("16x16"));
        runner.expect_run("filter_complex", CmdOutput::failed(1, "invalid image"));
        assert!(
            detect_continuity(&mut runner, &dir, &ledger, 100_000, 100_000, 5_000, 101_000)
                .is_empty()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn withheld_screenshots_or_video_and_missing_shots_are_not_examined() {
        let (dir, ledger) = fixture();
        for variant in 0..4 {
            let mut ledger = ledger.clone();
            match variant {
                0 => {
                    ledger.steps[0].screenshot_withheld =
                        Some(crate::core::WithholdCause::RuntimeInput)
                }
                1 => ledger.video_publication = Some(VideoPublication::WithheldPrivacy),
                2 => {
                    ledger.steps[0].block = "login".into();
                    ledger.steps[1].block = "login".into();
                }
                _ => ledger
                    .steps
                    .iter_mut()
                    .for_each(|row| row.screenshot = None),
            }
            let mut runner = MockRunner::new();
            assert!(detect_continuity(
                &mut runner,
                &dir,
                &ledger,
                100_000,
                100_000,
                5_000,
                101_000
            )
            .is_empty());
            assert!(runner.calls.is_empty());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_intervals_and_escaped_screenshots_fail_closed() {
        for log in [
            "lavfi.freezedetect.freeze_end: 3",
            "lavfi.freezedetect.freeze_start: -1",
            "lavfi.freezedetect.freeze_start: 4\nlavfi.freezedetect.freeze_end: 3",
            "lavfi.freezedetect.freeze_start: 1\nlavfi.freezedetect.freeze_end: 13",
        ] {
            assert!(frozen_intervals(log, 12_000).is_none());
        }
        let (dir, _) = fixture();
        for path in ["../a.png", "/tmp/a.png", "screenshots/a.txt"] {
            assert!(screenshot_path(&dir, path).is_none());
        }
        std::os::unix::fs::symlink(std::env::temp_dir(), dir.join("escape")).unwrap();
        assert!(screenshot_path(&dir, "escape/a.png").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[ignore = "requires ffmpeg and ffprobe on PATH"]
    fn real_frozen_video_and_decoded_screenshot_pixels() {
        let (dir, ledger) = fixture();
        let generate = |args: &[&str], output: &Path| {
            let result = std::process::Command::new("ffmpeg")
                .args(["-y", "-v", "error"])
                .args(args)
                .arg(output)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        };
        generate(
            &[
                "-f",
                "lavfi",
                "-i",
                "color=black:s=640x480:r=30:d=12",
                "-c:v",
                "libx264",
            ],
            &published_video_path(&dir),
        );
        let first = dir.join("screenshots/a.png");
        let second = dir.join("screenshots/b.png");
        generate(
            &[
                "-f",
                "lavfi",
                "-i",
                "color=black:s=640x480",
                "-frames:v",
                "1",
                "-compression_level",
                "0",
            ],
            &first,
        );
        generate(
            &[
                "-f",
                "lavfi",
                "-i",
                "color=white:s=640x480",
                "-frames:v",
                "1",
            ],
            &second,
        );
        let mut runner = crate::exec::RealRunner::new();
        let stalls =
            detect_continuity(&mut runner, &dir, &ledger, 100_000, 100_000, 5_000, 101_000);
        assert_eq!(
            stalls,
            vec![VideoStall {
                duration_ms: 12_000,
                first_line: 7,
                last_line: 8
            }]
        );
        generate(
            &[
                "-f",
                "lavfi",
                "-i",
                "color=black:s=640x480",
                "-frames:v",
                "1",
                "-compression_level",
                "9",
            ],
            &second,
        );
        assert_ne!(
            std::fs::read(first).unwrap(),
            std::fs::read(second).unwrap()
        );
        assert!(
            detect_continuity(&mut runner, &dir, &ledger, 100_000, 100_000, 5_000, 101_000)
                .is_empty()
        );
        generate(&["-f", "lavfi", "-i", "color=black:s=640x480:r=30:d=12,drawbox=x=0:y=0:w=2:h=2:color=white:t=fill:enable='gte(t,4)'", "-c:v", "libx264"], &published_video_path(&dir));
        generate(
            &[
                "-f",
                "lavfi",
                "-i",
                "color=black:s=640x480,drawbox=x=0:y=0:w=2:h=2:color=white:t=fill",
                "-frames:v",
                "1",
            ],
            &dir.join("screenshots/b.png"),
        );
        assert!(
            detect_continuity(&mut runner, &dir, &ledger, 100_000, 100_000, 5_000, 101_000)
                .is_empty()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
