use crate::exec::{CmdSpec, Runner};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::time::Instant;

pub const HELPER_ARG: &str = "--internal-volume-sample";
pub const SLOW_VOLUME_FIX: &str = "candidate on a slow volume: expect the manifest and builds to be slow; move the project to a faster or internal disk, then re-run once";

#[derive(Serialize, Deserialize)]
struct Sample {
    files: u64,
    elapsed_ms: u64,
}

#[derive(Default)]
pub(crate) struct Assessment {
    pub slow: bool,
    pub summary: String,
}

pub(crate) fn assess(runner: &mut dyn Runner, root: &Path, deadline_ms: u64) -> Assessment {
    let mut result = Assessment {
        summary: "sample=unknown".into(),
        ..Default::default()
    };
    let Ok(exe) = std::env::current_exe() else {
        return result;
    };
    let remaining = deadline_ms.saturating_sub(runner.monotonic_ms()) / 1000;
    if remaining == 0 {
        return result;
    }
    let output = runner.run(&CmdSpec::new(
        "candidate-volume-sample",
        &exe.to_string_lossy(),
        &[HELPER_ARG, &root.to_string_lossy()],
        remaining.min(5),
    ));
    let sample = output
        .ok()
        .then(|| serde_json::from_str::<Sample>(&output.stdout).ok())
        .flatten();
    let sampled = sample.as_ref().filter(|s| (16..=32).contains(&s.files));
    result.slow = sample.as_ref().is_some_and(|s| {
        s.elapsed_ms >= 4000 || (sampled.is_some() && s.elapsed_ms >= s.files * 50)
    });
    result.summary = format!(
        "sample_files={}; sample_elapsed_ms={}; sample={}",
        sample.as_ref().map_or(0, |s| s.files),
        sample.as_ref().map_or(0, |s| s.elapsed_ms),
        if sampled.is_some() || result.slow {
            "measured"
        } else {
            "unknown"
        },
    );
    result
}

pub fn run_helper(root: &Path) -> u8 {
    match sample(root) {
        Ok(sample) => {
            println!("{}", serde_json::to_string(&sample).expect("sample JSON"));
            0
        }
        Err(_) => 1,
    }
}

fn sample(root: &Path) -> std::io::Result<Sample> {
    let started = Instant::now();
    let root_device = root.metadata()?.dev();
    let mut queue = VecDeque::from([root.to_path_buf()]);
    let mut files = 0;
    let mut entries = 0;
    let mut buffer = [0_u8; 4096];
    while let Some(dir) = queue.pop_front() {
        if started.elapsed().as_secs() >= 4 {
            break;
        }
        let Ok(children) = std::fs::read_dir(dir) else {
            continue;
        };
        for child in children.take(256).flatten() {
            entries += 1;
            if entries > 1024 || files == 32 || started.elapsed().as_secs() >= 4 {
                return Ok(Sample {
                    files,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                });
            }
            let Ok(kind) = child.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if queue.len() < 128
                    && !matches!(child.file_name().to_str(), Some(".git" | ".qaren"))
                    && child
                        .path()
                        .metadata()
                        .is_ok_and(|m| m.dev() == root_device)
                {
                    queue.push_back(child.path());
                }
            } else if kind.is_file() {
                let Ok(mut file) = OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                    .open(child.path())
                else {
                    continue;
                };
                let Ok(metadata) = file.metadata() else {
                    continue;
                };
                if metadata.dev() != root_device
                    || !metadata.is_file()
                    || metadata.len() == 0
                    || metadata.len() > 65_536
                {
                    continue;
                }
                #[cfg(target_os = "macos")]
                {
                    use std::os::fd::AsRawFd;
                    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_NOCACHE, 1) } != 0 {
                        continue;
                    }
                }
                if file.read(&mut buffer).is_ok_and(|bytes| bytes > 0) {
                    files += 1;
                }
            }
        }
    }
    Ok(Sample {
        files,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner};

    #[test]
    fn slow_complete_or_partial_samples_warn_without_exposing_output() {
        for (sample, slow) in [
            (r#"{"files":32,"elapsed_ms":1800}"#, true),
            (r#"{"files":3,"elapsed_ms":4000}"#, true),
            (r#"{"files":32,"elapsed_ms":1}"#, false),
            (r#"{"files":1,"elapsed_ms":2000}"#, false),
            ("invalid-private-output", false),
        ] {
            let mut runner = MockRunner::new();
            runner.expect_run(HELPER_ARG, CmdOutput::success(sample));
            let assessment = assess(&mut runner, Path::new("/candidate/app"), u64::MAX);
            assert_eq!(assessment.slow, slow);
            assert!(!assessment.summary.contains("private"));
            assert!(!assessment.summary.contains("/candidate"));
            assert!(runner.calls.iter().all(|spec| spec.timeout_seconds <= 5));
            assert_eq!(runner.remaining(), 0);
        }
    }

    #[test]
    fn a_small_sample_or_a_spent_budget_does_not_claim_a_fast_volume() {
        let mut runner = MockRunner::new();
        let now = runner.monotonic_ms();
        assert!(assess(&mut runner, Path::new("/candidate"), now)
            .summary
            .contains("unknown"));
        assert!(runner.calls.is_empty());
        let root = std::env::temp_dir().join(format!("qaren-volume-sample-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for i in 0..40 {
            std::fs::write(root.join(i.to_string()), b"synthetic").unwrap();
        }
        std::os::unix::fs::symlink("/does-not-exist", root.join("link")).unwrap();
        assert_eq!(sample(&root).unwrap().files, 32);
        std::fs::remove_dir_all(root).unwrap();
    }
}
