// How long passing native compiles took on this machine, per platform and app: the next limit learns from it.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SCHEMA: &str = "qaren-build-timings/1";
const KEPT: usize = 5;
const CEILING_S: u64 = 7200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sample {
    pub work_s: u64,
    pub at: String,
}

#[derive(Serialize, Deserialize)]
struct Record {
    schema: String,
    samples: Vec<Sample>,
}

// The compile limit of one run: never below the configured value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limit {
    pub limit_s: u64,
    pub configured_s: u64,
    pub samples: usize,
    // Why the record could not be used, when a file was there.
    pub unreadable: Option<String>,
}

impl Limit {
    pub fn learned(&self) -> bool {
        self.limit_s > self.configured_s
    }
}

// None when the app id cannot be a plain file name.
pub fn path(runs_root: &Path, platform: &str, app_id: &str) -> Option<PathBuf> {
    let plain =
        !app_id.is_empty() && !app_id.starts_with('.') && !app_id.contains(['/', '\\', '\0']);
    plain.then(|| {
        runs_root
            .join("build-timings")
            .join(platform)
            .join(format!("{app_id}.json"))
    })
}

// The larger of the configured value and 1.5 times the longest kept sample, at most 7200 s.
pub fn learned_limit(configured_s: u64, samples: &[Sample]) -> u64 {
    let longest = samples.iter().map(|s| s.work_s).max().unwrap_or(0);
    configured_s.max(longest.saturating_mul(3).div_ceil(2).min(CEILING_S))
}

// A missing file is no record; an unreadable one or another schema is no record with a reason.
pub fn read(path: &Path) -> Result<Vec<Sample>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("unreadable: {}", e.kind())),
    };
    match serde_json::from_str::<Record>(&text) {
        Ok(record) if record.schema == SCHEMA => Ok(record.samples),
        Ok(_) => Err("another schema".into()),
        Err(_) => Err("not a build timings record".into()),
    }
}

pub fn limit(path: Option<&Path>, configured_s: u64) -> Limit {
    let read = path.map_or(Ok(Vec::new()), read);
    let samples = read.as_deref().unwrap_or_default();
    Limit {
        limit_s: learned_limit(configured_s, samples),
        configured_s,
        samples: samples.len(),
        unreadable: read.err(),
    }
}

// Adds one sample, keeps the last five and replaces the file whole; returns the kept samples.
pub fn append(path: &Path, sample: Sample) -> Result<Vec<Sample>, (Vec<Sample>, String)> {
    let mut samples = read(path).unwrap_or_default();
    samples.push(sample);
    let excess = samples.len().saturating_sub(KEPT);
    samples.drain(..excess);
    match write(path, &samples) {
        Ok(()) => Ok(samples),
        Err(e) => Err((samples, e.kind().to_string())),
    }
}

// Written like the pool's records: a private temporary file beside it, synced, renamed over it.
fn write(path: &Path, samples: &[Sample]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let dir = path.parent().expect("a record lives in a folder");
    let name = path
        .file_name()
        .expect("a record has a name")
        .to_string_lossy();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    // A writer's own temporary name, so two runs finishing together never share one.
    let tmp = dir.join(format!(".{name}.{}.{nanos}.tmp", std::process::id()));
    let record = Record {
        schema: SCHEMA.into(),
        samples: samples.to_vec(),
    };
    let result = std::fs::create_dir_all(dir)
        .and_then(|_| {
            std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&tmp)
        })
        .and_then(|mut file| {
            file.write_all(serde_json::to_string(&record)?.as_bytes())?;
            file.sync_all()
        })
        .and_then(|_| std::fs::rename(&tmp, path))
        .and_then(|_| std::fs::File::open(dir)?.sync_all());
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(work_s: u64) -> Sample {
        Sample {
            work_s,
            at: "2026-11-15T00:00:00Z".into(),
        }
    }

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("qaren-build-timings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn l1_six_builds_keep_the_last_five() {
        let root = temp("keep");
        let file = path(&root, "ios", "com.example.app").unwrap();
        let first = append(&file, sample(10)).unwrap();
        assert_eq!(first, vec![sample(10)]);
        for work_s in 11..=15 {
            append(&file, sample(work_s)).unwrap();
        }
        let kept = read(&file).unwrap();
        assert_eq!(
            kept.iter().map(|s| s.work_s).collect::<Vec<_>>(),
            [11, 12, 13, 14, 15]
        );
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(
            text.starts_with("{\"schema\":\"qaren-build-timings/1\",\"samples\":[{\"work_s\":11,")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn l2_the_limit_is_the_larger_of_configured_and_one_and_a_half_times_the_longest() {
        assert_eq!(learned_limit(2400, &[]), 2400);
        assert_eq!(learned_limit(2400, &[sample(3000), sample(100)]), 4500);
        assert_eq!(learned_limit(2400, &[sample(1001)]), 2400);
        assert_eq!(learned_limit(30, &[sample(21)]), 32);
        assert_eq!(learned_limit(2400, &[sample(6000)]), 7200);
        assert_eq!(learned_limit(7200, &[sample(10)]), 7200);
        // A slow sample stops counting once five newer builds replaced it.
        let root = temp("replace");
        let file = path(&root, "ios", "com.example.app").unwrap();
        append(&file, sample(3000)).unwrap();
        for _ in 0..5 {
            append(&file, sample(100)).unwrap();
        }
        assert_eq!(limit(Some(&file), 2400).limit_s, 2400);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn l5_a_corrupt_or_foreign_record_or_unwritable_root_falls_back_to_the_configured_limit() {
        let root = temp("corrupt");
        let file = path(&root, "android", "com.example.app").unwrap();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "{half").unwrap();
        let limit_now = limit(Some(&file), 2400);
        assert_eq!((limit_now.limit_s, limit_now.samples), (2400, 0));
        assert_eq!(
            limit_now.unreadable.as_deref(),
            Some("not a build timings record")
        );
        std::fs::write(
            &file,
            "{\"schema\":\"other/1\",\"samples\":[{\"work_s\":9000,\"at\":\"x\"}]}",
        )
        .unwrap();
        assert_eq!(
            limit(Some(&file), 2400).unreadable.as_deref(),
            Some("another schema")
        );
        assert_eq!(limit(Some(&file), 2400).limit_s, 2400);
        // A root that is a file: the write fails, the samples are still returned for the forecast.
        let blocked = temp("blocked");
        std::fs::write(&blocked, "not a folder").unwrap();
        let unwritable = path(&blocked, "ios", "com.example.app").unwrap();
        let (kept, _) = append(&unwritable, sample(3000)).unwrap_err();
        assert_eq!(kept, vec![sample(3000)]);
        assert_eq!(limit(None, 2400).limit_s, 2400);
        assert!(path(&root, "ios", "../escape").is_none());
        std::fs::remove_file(blocked).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn l5_two_writers_at_once_leave_one_whole_record() {
        let root = temp("race");
        let file = path(&root, "ios", "com.example.app").unwrap();
        std::thread::scope(|scope| {
            for work_s in [3000, 4000] {
                let file = &file;
                scope.spawn(move || {
                    for _ in 0..20 {
                        let _ = append(file, sample(work_s));
                    }
                });
            }
        });
        let kept = read(&file).expect("the record is always whole");
        assert!(!kept.is_empty() && kept.len() <= 5);
        assert!(kept.iter().all(|s| s.work_s == 3000 || s.work_s == 4000));
        std::fs::remove_dir_all(root).unwrap();
    }
}
