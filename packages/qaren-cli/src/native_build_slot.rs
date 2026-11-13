use crate::buildplan::{release_lock, ReleaseOutcome};
use crate::runrecord::{BuildSlotResource, BuildSlotWork, RunRecord};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

pub(crate) struct GradleCompletion {
    slot: BuildSlotResource,
    run_id: String,
    log: PathBuf,
    offset: u64,
    line: Vec<u8>,
    oversized: bool,
    completed: bool,
}

impl GradleCompletion {
    pub(crate) fn for_run(record: &RunRecord) -> Option<Self> {
        let slot = record.resources.build_slot.as_ref()?;
        let BuildSlotWork::Metro { pgid } = slot.work else {
            return None;
        };
        let metro = record.resources.metro.as_ref()?;
        if pgid != metro.spawned.pgid {
            return None;
        }
        Some(Self {
            slot: slot.clone(),
            run_id: record.run_id.clone(),
            log: metro.log.clone(),
            offset: 0,
            line: Vec::new(),
            oversized: false,
            completed: false,
        })
    }

    pub(crate) fn poll(&mut self) -> Result<bool, String> {
        if !self.completed {
            let Ok(mut file) = std::fs::File::open(&self.log) else {
                return Ok(false);
            };
            file.seek(SeekFrom::Start(self.offset))
                .map_err(|e| e.to_string())?;
            let observed_len = file.metadata().map_err(|e| e.to_string())?.len();
            let mut buf = [0u8; 8192];
            // Appended output waits for the next observation.
            while self.offset < observed_len {
                let remaining = (observed_len - self.offset).min(buf.len() as u64) as usize;
                let n = file
                    .read(&mut buf[..remaining])
                    .map_err(|e| e.to_string())?;
                self.offset += n as u64;
                if n == 0 {
                    break;
                }
                for &byte in &buf[..n] {
                    if byte == b'\n' {
                        if !self.oversized && gradle_end_line(&self.line) {
                            self.completed = true;
                        }
                        self.line.clear();
                        self.oversized = false;
                    } else if self.line.len() < 256 {
                        self.line.push(byte);
                    } else {
                        self.oversized = true;
                    }
                }
                if self.completed {
                    break;
                }
            }
        }
        if !self.completed {
            return Ok(false);
        }
        match release_lock(
            &self.slot.lock.lock_dir,
            &self.slot.lock.holder,
            &self.run_id,
        ) {
            ReleaseOutcome::Removed | ReleaseOutcome::Absent | ReleaseOutcome::Foreign(_) => {
                Ok(true)
            }
            ReleaseOutcome::Refused(detail) | ReleaseOutcome::Unresolved(detail) => Err(detail),
        }
    }
}

fn gradle_end_line(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_ok_and(|line| {
        ["BUILD SUCCESSFUL in ", "BUILD FAILED in "]
            .iter()
            .any(|prefix| {
                line.strip_prefix(prefix)
                    .is_some_and(|duration| !duration.trim().is_empty())
            })
    })
}
