use crate::exec::Runner;
use crate::redact::OutputText;
use crate::runrecord::{probe_pid_identity, PidIdentity, PidLiveness};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const CACHE_SCHEMA: &str = "qaren-native-cache/2";
pub const PREWARM_SCHEMA: &str = "qaren-deps-prewarm/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    AppBundle,
    Apk,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedArtifact {
    pub path: PathBuf,
    pub sha256: String,
    pub kind: ArtifactKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeCacheState {
    pub schema: String,
    pub platform: String,
    pub app_id: String,
    pub worktree_root: PathBuf,
    pub fingerprint: String,
    pub built_at: String,
    pub candidate_sha: String,
    pub lockfile_sha256: String,
    #[serde(default)]
    pub generated_native_dirs: Vec<String>,
    #[serde(default)]
    pub fingerprint_parts: BTreeMap<String, String>,
}

// The machine store's record for one fingerprint; written once, never rewritten.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreRecord {
    #[serde(flatten)]
    pub artifact: CachedArtifact,
    pub built_at: String,
    pub candidate_sha: String,
}

pub const STORE_RECORD: &str = "artifact.json";

pub fn store_dir(store_root: &Path, platform: &str, app_id: &str, fingerprint: &str) -> PathBuf {
    debug_assert!(fingerprint
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == ':'));
    store_root
        .join(platform)
        .join(app_id)
        .join(fingerprint.replace(':', "-"))
}

// A record whose artifact is outside its own fingerprint directory is not this entry's build.
pub fn load_store_record(dir: &Path) -> Result<Option<StoreRecord>, String> {
    let path = dir.join(STORE_RECORD);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let record: StoreRecord = serde_json::from_str(&raw)
        .map_err(|e| format!("{} does not parse: {e}", path.display()))?;
    let contained = record.artifact.path.starts_with(dir)
        && record
            .artifact
            .path
            .components()
            .all(|c| c != std::path::Component::ParentDir);
    if !contained {
        return Err(format!(
            "{} names an artifact outside its entry",
            path.display()
        ));
    }
    Ok(Some(record))
}

// Create-new via hard link: readers never see a partial record and a second writer loses.
pub fn publish_store_record(dir: &Path, record: &StoreRecord) -> std::io::Result<bool> {
    let tmp = dir.join(format!(
        ".{STORE_RECORD}.{}.{}",
        std::process::id(),
        crate::timefmt::epoch_ms()
    ));
    let body = serde_json::to_string_pretty(record)
        .map_err(|e| std::io::Error::other(format!("serialize: {e}")))?;
    std::fs::write(&tmp, body)?;
    let linked = std::fs::hard_link(&tmp, dir.join(STORE_RECORD));
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepsPrewarm {
    pub schema: String,
    pub worktree_root: PathBuf,
    pub project_root: PathBuf,
    pub lockfile_sha256: String,
    pub at: String,
}

pub fn cache_dir(worktree_root: &Path) -> PathBuf {
    worktree_root.join(".qaren").join("native-cache")
}

pub fn state_path(worktree_root: &Path, platform: &str, app_id: &str) -> PathBuf {
    // Both components are grammar-validated upstream (platform from the enum,
    // app_id as dot-separated [A-Za-z0-9_-] segments), so neither can carry a
    // path separator or `..`.
    debug_assert!(platform.chars().all(|c| c.is_ascii_lowercase()));
    debug_assert!(!app_id.contains('/') && !app_id.contains(".."));
    cache_dir(worktree_root).join(format!("{platform}-{app_id}.json"))
}

pub fn prewarm_path(worktree_root: &Path) -> PathBuf {
    cache_dir(worktree_root).join("deps-prewarm.json")
}

#[derive(Debug, Clone)]
pub enum StateStatus {
    Missing,
    Invalid(String),
    Loaded(Box<NativeCacheState>),
}

pub fn load_state(worktree_root: &Path, platform: &str, app_id: &str) -> StateStatus {
    let path = state_path(worktree_root, platform, app_id);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return StateStatus::Missing,
        Err(e) => return StateStatus::Invalid(format!("cannot read {}: {e}", path.display())),
    };
    match serde_json::from_str::<NativeCacheState>(&raw) {
        Ok(state) if state.schema == CACHE_SCHEMA => StateStatus::Loaded(Box::new(state)),
        Ok(state) => StateStatus::Invalid(format!(
            "{} carries schema {:?}, expected {CACHE_SCHEMA}",
            path.display(),
            state.schema
        )),
        Err(e) => StateStatus::Invalid(format!("{} does not parse: {e}", path.display())),
    }
}

pub fn save_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NONCE: AtomicU64 = AtomicU64::new(0);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    let body = serde_json::to_string_pretty(value)
        .map_err(|e| std::io::Error::other(format!("serialize: {e}")))?;
    let saved = std::fs::write(&tmp, body).and_then(|()| std::fs::rename(&tmp, path));
    if saved.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    saved
}

pub fn load_prewarm(worktree_root: &Path) -> Option<DepsPrewarm> {
    let raw = std::fs::read_to_string(prewarm_path(worktree_root)).ok()?;
    let record: DepsPrewarm = serde_json::from_str(&raw).ok()?;
    (record.schema == PREWARM_SCHEMA && record.worktree_root == worktree_root).then_some(record)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildDecision {
    Reuse,
    Incremental,
    Clean,
}

impl BuildDecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            BuildDecision::Reuse => "reuse",
            BuildDecision::Incremental => "incremental",
            BuildDecision::Clean => "clean",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildPlan {
    pub decision: BuildDecision,
    pub fingerprint: String,
    pub reason: OutputText,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<OutputText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<CachedArtifact>,
    // Clean over a generated (git-ignored) native dir must regenerate it via
    // `expo prebuild --clean`; a git-visible native dir is candidate input and
    // is never deleted.
    #[serde(default)]
    pub regenerate_native_dir: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactStatus {
    Verified,
    Mismatch,
    MissingFile,
}

pub struct DecisionInputs<'a> {
    pub platform: &'a str,
    pub app_id: &'a str,
    pub worktree_root: &'a Path,
    pub candidate_sha: &'a str,
    pub fingerprint: &'a str,
    pub fingerprint_parts: &'a BTreeMap<String, String>,
    pub fingerprint_complete: bool,
    pub incompleteness: &'a [String],
    pub expo_unavailable: Option<&'a str>,
    pub scheme: Option<&'a str>,
    pub force_clean: bool,
    pub native_dir_exists: bool,
    pub native_dir_in_candidate: bool,
}

fn sha_evidence(built: &str, current: &str) -> String {
    if built == current {
        format!("recorded build and current candidate are the same sha {current}")
    } else {
        format!(
            "recorded build was of candidate {built}; current candidate {current} serves fresh JS via Metro, native compatibility proven by fingerprint, never by sha"
        )
    }
}

pub fn decide(
    inputs: &DecisionInputs,
    state: &StateStatus,
    store: Option<(StoreRecord, ArtifactStatus)>,
) -> BuildPlan {
    let regenerate = inputs.native_dir_exists && !inputs.native_dir_in_candidate;
    let clean = |reason: String, evidence: Vec<String>| BuildPlan {
        decision: BuildDecision::Clean,
        fingerprint: inputs.fingerprint.to_string(),
        reason: OutputText::from_output(&reason),
        evidence: evidence
            .iter()
            .map(|text| OutputText::from_output(text))
            .collect(),
        artifact: None,
        regenerate_native_dir: regenerate,
    };
    if inputs.force_clean {
        return clean(
            "scenario build.strategy=clean mandates a clean native build".to_string(),
            Vec::new(),
        );
    }
    let kind_ok = |a: &CachedArtifact| {
        matches!(
            (inputs.platform, a.kind),
            ("ios", ArtifactKind::AppBundle) | ("android", ArtifactKind::Apk)
        )
    };
    // A verified build of this exact fingerprint needs nothing from this worktree's state.
    if let (Some((record, ArtifactStatus::Verified)), true, Some(scheme)) =
        (&store, inputs.fingerprint_complete, inputs.scheme)
    {
        if kind_ok(&record.artifact) {
            let mut evidence = match state {
                StateStatus::Missing => {
                    vec!["no native cache state recorded for this worktree/app".to_string()]
                }
                StateStatus::Invalid(reason) => {
                    vec![format!(
                        "native cache state is unreadable or invalid: {reason}"
                    )]
                }
                StateStatus::Loaded(state) if state.worktree_root != inputs.worktree_root => {
                    vec![format!(
                        "native cache state is bound to a different worktree: recorded {}, current {}",
                        state.worktree_root.display(),
                        inputs.worktree_root.display()
                    )]
                }
                StateStatus::Loaded(_) => Vec::new(),
            };
            evidence.extend([
                format!(
                    "native fingerprint {} matches the stored build",
                    inputs.fingerprint
                ),
                sha_evidence(&record.candidate_sha, inputs.candidate_sha),
                format!(
                    "artifact from machine store {} verified against recorded sha256 {}",
                    record.artifact.path.display(),
                    record.artifact.sha256
                ),
                format!("dev client launch scheme {scheme:?} is configured"),
            ]);
            return BuildPlan {
                decision: BuildDecision::Reuse,
                fingerprint: inputs.fingerprint.to_string(),
                reason: OutputText::from_output("native inputs are unchanged and the cached dev client is content-verified; reusing it with fresh candidate JS via Metro"),
                evidence: evidence
                    .iter()
                    .map(|text| OutputText::from_output(text))
                    .collect(),
                artifact: Some(record.artifact.clone()),
                regenerate_native_dir: false,
            };
        }
    }
    let state =
        match state {
            StateStatus::Missing => return clean(
                "no native cache state recorded for this worktree/app; compatibility is unprovable"
                    .to_string(),
                Vec::new(),
            ),
            StateStatus::Invalid(reason) => {
                return clean(
                    "native cache state is unreadable or invalid; compatibility is unprovable"
                        .to_string(),
                    vec![reason.clone()],
                )
            }
            StateStatus::Loaded(state) => state,
        };
    if state.worktree_root != inputs.worktree_root {
        return clean(
            "native cache state is bound to a different worktree; refusing cross-worktree reuse"
                .to_string(),
            vec![format!(
                "recorded worktree {}, current {}",
                state.worktree_root.display(),
                inputs.worktree_root.display()
            )],
        );
    }
    if state.platform != inputs.platform || state.app_id != inputs.app_id {
        return clean(
            "native cache state is bound to a different platform/app".to_string(),
            vec![format!(
                "recorded {}/{}, current {}/{}",
                state.platform, state.app_id, inputs.platform, inputs.app_id
            )],
        );
    }
    // Parts this run could not compute, or the recorded build did not record, are unknown, not changed.
    let changed: Vec<&str> = state
        .fingerprint_parts
        .keys()
        .chain(inputs.fingerprint_parts.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|part| {
            state.fingerprint_parts.get(*part) != inputs.fingerprint_parts.get(*part)
                && state.fingerprint_parts.contains_key(*part)
                && (inputs.expo_unavailable.is_none()
                    || inputs.fingerprint_parts.contains_key(*part))
        })
        .map(String::as_str)
        .collect();
    let unrecorded: Vec<&str> = inputs
        .fingerprint_parts
        .keys()
        .filter(|part| !state.fingerprint_parts.contains_key(*part))
        .map(String::as_str)
        .collect();
    let uncomparable = match inputs.expo_unavailable {
        _ if !changed.is_empty() => None,
        Some(cause) => Some(format!(
            "Expo fingerprint unavailable: {cause}; the native fingerprint cannot be compared with the recorded build"
        )),
        None if !unrecorded.is_empty() => Some(format!(
            "the recorded build has no value for {}; the native fingerprint cannot be compared with it",
            unrecorded.join(", ")
        )),
        None => None,
    };
    // A generated native dir that qaren's own builds did not create carries
    // caches of unprovable origin; only a clean regeneration is trustworthy.
    let platform_dir_proven = !inputs.native_dir_exists
        || inputs.native_dir_in_candidate
        || state
            .generated_native_dirs
            .iter()
            .any(|d| d == inputs.platform);
    let incremental = |reason: String, mut evidence: Vec<String>| {
        if !platform_dir_proven {
            evidence.push(format!(
                "the generated {}/ dir was not created by a recorded qaren build",
                inputs.platform
            ));
            return clean(
                "existing generated native dir has no recorded qaren provenance; requiring a clean regeneration"
                    .to_string(),
                evidence,
            );
        }
        if regenerate && state.fingerprint != inputs.fingerprint {
            return clean(
                format!(
                    "{}; regenerating the generated native dir via expo prebuild --clean, which deletes it with its installed native dependencies and build outputs",
                    uncomparable.as_deref().unwrap_or("native inputs changed")
                ),
                evidence,
            );
        }
        if regenerate && !inputs.fingerprint_complete {
            return clean(
                format!(
                    "native fingerprint matches, but {}; regenerating the generated native dir via expo prebuild --clean instead of reuse, which deletes it with its installed native dependencies and build outputs",
                    inputs
                        .incompleteness
                        .first()
                        .map(String::as_str)
                        .unwrap_or("its input set is unprovably complete")
                ),
                evidence,
            );
        }
        BuildPlan {
            decision: BuildDecision::Incremental,
            fingerprint: inputs.fingerprint.to_string(),
            reason: OutputText::from_output(&reason),
            evidence: evidence
                .iter()
                .map(|text| OutputText::from_output(text))
                .collect(),
            artifact: None,
            regenerate_native_dir: false,
        }
    };
    // The candidate SHA binds evidence; the fingerprint proves native
    // compatibility. A SHA delta with an identical fingerprint is the
    // JS-only-change case reuse exists for — the comparison is always recorded.
    let sha_evidence = sha_evidence(&state.candidate_sha, inputs.candidate_sha);
    if state.fingerprint == inputs.fingerprint {
        let match_evidence = format!(
            "native fingerprint {} matches the recorded build",
            state.fingerprint
        );
        if !inputs.fingerprint_complete {
            let mut evidence = vec![match_evidence, sha_evidence];
            evidence.extend(inputs.incompleteness.iter().cloned());
            return incremental(
                format!(
                    "native fingerprint matches, but {}; refusing cached reuse",
                    inputs
                        .incompleteness
                        .first()
                        .map(String::as_str)
                        .unwrap_or("its input set is unprovably complete")
                ),
                evidence,
            );
        }
        // A cached artifact of the wrong kind for the platform indicates a
        // corrupt cache state; it can never authorize reuse.
        if store.as_ref().is_some_and(|(r, _)| !kind_ok(&r.artifact)) {
            return incremental(
                "cached artifact kind does not match the platform; refusing it and using a keyed incremental build"
                    .to_string(),
                vec![match_evidence, sha_evidence],
            );
        }
        // A verified artifact with a scheme already reused above.
        match store {
            Some((_, ArtifactStatus::Verified)) => incremental(
                "fingerprint matches but candidate.dev_client_scheme is not configured, so a cached dev client cannot be launched; using a keyed incremental build"
                    .to_string(),
                vec![match_evidence, sha_evidence],
            ),
            Some((record, ArtifactStatus::Mismatch)) => incremental(
                "cached artifact content no longer matches its recorded sha256; refusing the stale binary and using a keyed incremental build"
                    .to_string(),
                vec![
                    match_evidence,
                    sha_evidence,
                    format!("artifact {} failed content verification", record.artifact.path.display()),
                ],
            ),
            Some((record, ArtifactStatus::MissingFile)) => incremental(
                "recorded cached artifact is missing on disk; using a keyed incremental build"
                    .to_string(),
                vec![
                    match_evidence,
                    sha_evidence,
                    format!("artifact {} not found", record.artifact.path.display()),
                ],
            ),
            None => incremental(
                "fingerprint matches but no verified cached artifact is available; using a keyed incremental build"
                    .to_string(),
                vec![match_evidence, sha_evidence],
            ),
        }
    } else {
        let mut evidence = vec![
            format!(
                "recorded fingerprint {}, current {}",
                state.fingerprint, inputs.fingerprint
            ),
            sha_evidence,
        ];
        if !changed.is_empty() {
            evidence.push(format!("native inputs changed: {}", changed.join(", ")));
        }
        if !unrecorded.is_empty() {
            evidence.push(format!(
                "recorded build has no value for: {}",
                unrecorded.join(", ")
            ));
        }
        if let Some(cause) = inputs.expo_unavailable {
            evidence.push(format!("Expo fingerprint unavailable: {cause}"));
        }
        let reason = match &uncomparable {
            Some(uncomparable) => format!(
                "{uncomparable}; caches keyed to this exact worktree/app remain valid for an incremental compile"
            ),
            None => "native inputs changed since the recorded build; caches keyed to this exact worktree/app remain valid for an incremental compile".to_string(),
        };
        incremental(reason, evidence)
    }
}

// Deterministic content identity for a cached artifact: a plain sha256 for a
// file (apk), a sorted path+content manifest hash for a bundle directory
// (.app). Symlinks hash their link text, matching the fingerprint convention.
pub fn hash_artifact(path: &Path) -> Result<String, String> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
    if meta.is_file() {
        let bytes =
            std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        return Ok(crate::candidate::sha256_hex(&bytes));
    }
    if !meta.is_dir() {
        return Err(format!(
            "{} is neither a file nor a directory",
            path.display()
        ));
    }
    let mut entries: Vec<(String, String)> = Vec::new();
    walk_artifact(path, path, &mut entries)?;
    entries.sort();
    let mut manifest = String::new();
    for (rel, hash) in &entries {
        manifest.push_str(rel);
        manifest.push('\0');
        manifest.push_str(hash);
        manifest.push('\n');
    }
    Ok(crate::candidate::sha256_hex(manifest.as_bytes()))
}

fn walk_artifact(
    base: &Path,
    dir: &Path,
    entries: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let listed =
        std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    for entry in listed {
        let entry = entry.map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
        let path = entry.path();
        let rel = path
            .strip_prefix(base)
            .map_err(|_| format!("{} escaped its base", path.display()))?
            .to_string_lossy()
            .into_owned();
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&path)
                .map_err(|e| format!("cannot read symlink {}: {e}", path.display()))?;
            entries.push((
                rel,
                crate::candidate::sha256_hex(format!("symlink:{}", target.display()).as_bytes()),
            ));
        } else if meta.is_dir() {
            walk_artifact(base, &path, entries)?;
        } else {
            let bytes =
                std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            entries.push((rel, crate::candidate::sha256_hex(&bytes)));
        }
    }
    Ok(())
}

pub fn copy_artifact(runner: &dyn Runner, src: &Path, dest: &Path) -> Result<(), String> {
    use std::io::{Read, Write};
    crate::cancel::ensure_running(runner, "native_cache").map_err(|e| e.detail.to_string())?;
    let meta = std::fs::symlink_metadata(src)
        .map_err(|e| format!("cannot stat {}: {e}", src.display()))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(src)
            .map_err(|e| format!("cannot read symlink {}: {e}", src.display()))?;
        std::os::unix::fs::symlink(&target, dest)
            .map_err(|e| format!("cannot recreate symlink {}: {e}", dest.display()))?;
        return Ok(());
    }
    if meta.is_file() {
        let copied = (|| -> std::io::Result<()> {
            let mut source = std::fs::File::open(src)?;
            let mut target = std::fs::File::create(dest)?;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                if let Some(reason) = runner.cancellation() {
                    return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, reason));
                }
                let bytes = source.read(&mut buffer)?;
                if bytes == 0 {
                    break;
                }
                target.write_all(&buffer[..bytes])?;
            }
            target.set_permissions(meta.permissions())
        })();
        copied.map_err(|e| format!("cannot copy {} to {}: {e}", src.display(), dest.display()))?;
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(dest)
            .map_err(|e| format!("cannot create {}: {e}", dest.display()))?;
        let listed =
            std::fs::read_dir(src).map_err(|e| format!("cannot list {}: {e}", src.display()))?;
        for entry in listed {
            let entry = entry.map_err(|e| format!("cannot list {}: {e}", src.display()))?;
            copy_artifact(runner, &entry.path(), &dest.join(entry.file_name()))?;
        }
        return Ok(());
    }
    Err(format!("{} is not a copyable artifact", src.display()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockHolder {
    pub holder: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<PidIdentity>,
    pub at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockPolicy {
    // Device claims: any existing claim is a structured refusal, even a stale
    // one — a dead holder's resources may still be live.
    Strict,
    // Build serialization: a claim whose recorded holder is provably dead may
    // be adopted; it only guards compile concurrency, not device ownership.
    AdoptDead,
}

#[derive(Debug)]
pub enum LockOutcome {
    Claimed {
        adopted_stale: bool,
    },
    Contended {
        holder: Option<LockHolder>,
        liveness: Option<PidLiveness>,
        detail: String,
    },
    Error(String),
}

pub fn lock_dir(lock_root: &Path, name: &str) -> PathBuf {
    lock_root.join(name)
}

// Lock protocol: a lock is a directory whose holder.json names the owner.
// Every take (claim-adoption or release) first atomically renames the lock
// directory to a process-unique tombstone, inspects the isolated copy, and
// only then deletes it — so no path ever inspects a lock another process could
// have replaced in between. A tombstone that turns out to be foreign is
// renamed back; if that restore loses a race, the foreign lock is preserved
// at the tombstone path and reported, never silently deleted. POSIX rename
// offers no compare-and-swap, so a replacement landing between a passed
// pre-check and the take is detected by the post-take re-verify rather than
// prevented; the residual worst case is a preserved tombstone plus an
// unresolved report, never a lost or silently deleted claim. A restore can
// never clobber a fresh claim either: claims only ever rename a populated
// staging dir into place, so no canonical lock dir is ever empty, and rename
// refuses to replace a non-empty directory.
fn tombstone_path(lock_root: &Path, name: &str, purpose: &str) -> PathBuf {
    lock_root.join(format!(
        ".{purpose}-{name}-{}-{}",
        std::process::id(),
        crate::timefmt::epoch_ms()
    ))
}

pub fn claim_lock(
    runner: &mut dyn Runner,
    lock_root: &Path,
    name: &str,
    holder: &LockHolder,
    policy: LockPolicy,
) -> LockOutcome {
    if let Err(e) = std::fs::create_dir_all(lock_root) {
        return LockOutcome::Error(format!(
            "cannot create lock root {}: {e}",
            lock_root.display()
        ));
    }
    let dir = lock_dir(lock_root, name);
    let mut adopted_stale = false;
    for _ in 0..2 {
        let staging = tombstone_path(lock_root, name, "claim");
        if let Err(e) = std::fs::create_dir(&staging) {
            return LockOutcome::Error(format!("cannot stage lock {}: {e}", staging.display()));
        }
        if let Err(e) = save_json(&staging.join("holder.json"), holder) {
            let _ = std::fs::remove_dir_all(&staging);
            return LockOutcome::Error(format!("cannot record lock holder: {e}"));
        }
        // rename onto an existing directory fails, so this is the atomic claim.
        match std::fs::rename(&staging, &dir) {
            Ok(()) => return LockOutcome::Claimed { adopted_stale },
            Err(_) => {
                let _ = std::fs::remove_dir_all(&staging);
            }
        }
        let existing = read_holder(&dir);
        let liveness = existing
            .as_ref()
            .and_then(|h| h.identity.as_ref())
            .map(|i| probe_pid_identity(runner, i));
        if policy == LockPolicy::AdoptDead
            && matches!(
                liveness,
                Some(PidLiveness::Dead) | Some(PidLiveness::AliveForeign)
            )
        {
            let taken = tombstone_path(lock_root, name, "stale");
            if std::fs::rename(&dir, &taken).is_err() {
                // Someone else raced the adoption: nothing of the stale lock
                // was taken by this process, so no adoption may be claimed.
                continue;
            }
            // Re-verify the isolated copy: it must still be the dead holder we
            // probed, not a replacement claimed between probe and rename.
            let isolated = read_holder(&taken);
            let same = match (&existing, &isolated) {
                (Some(a), Some(b)) => a.holder == b.holder && a.run_id == b.run_id && a.at == b.at,
                _ => false,
            };
            if same {
                let _ = std::fs::remove_dir_all(&taken);
                adopted_stale = true;
                continue;
            }
            if std::fs::rename(&taken, &dir).is_err() {
                return LockOutcome::Contended {
                    holder: isolated,
                    liveness: None,
                    detail: format!(
                        "a foreign lock replaced the stale one mid-adoption and was preserved at {}; resolve it manually",
                        taken.display()
                    ),
                };
            }
            return LockOutcome::Contended {
                holder: read_holder(&dir),
                liveness: None,
                detail: format!(
                    "lock {} was re-claimed while adopting a stale holder",
                    dir.display()
                ),
            };
        }
        let detail = match (&existing, liveness) {
            (Some(h), Some(PidLiveness::AliveMatching)) => format!(
                "lock {} is held by {} (holder process alive)",
                dir.display(),
                h.holder
            ),
            (Some(h), _) => format!(
                "lock {} is held by {} (holder liveness not proven)",
                dir.display(),
                h.holder
            ),
            (None, _) => format!(
                "lock {} exists but its holder record is unreadable",
                dir.display()
            ),
        };
        return LockOutcome::Contended {
            holder: existing,
            liveness,
            detail,
        };
    }
    LockOutcome::Error(format!(
        "lock {} kept reappearing during stale adoption",
        dir.display()
    ))
}

pub fn read_holder(dir: &Path) -> Option<LockHolder> {
    let raw = std::fs::read_to_string(dir.join("holder.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseOutcome {
    Removed,
    Absent,
    // Held by someone else: under persist-before-claim plus Strict/no-adopt
    // policies this proves the caller's claim never succeeded.
    Foreign(String),
    Refused(String),
    Unresolved(String),
}

pub fn release_lock(dir: &Path, expected_holder: &str, expected_run_id: &str) -> ReleaseOutcome {
    let Some(parent) = dir.parent() else {
        return ReleaseOutcome::Refused(format!(
            "lock path {} has no parent directory; refusing",
            dir.display()
        ));
    };
    let Some(name) = dir.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return ReleaseOutcome::Refused(format!(
            "lock path {} has no final component; refusing",
            dir.display()
        ));
    };
    // Pre-check before displacing anything: a lock that is not plausibly ours
    // is refused without ever being moved. symlink_metadata distinguishes a
    // truly absent lock from a dangling symlink or an unreadable path.
    match std::fs::symlink_metadata(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ReleaseOutcome::Absent,
        Err(e) => {
            return ReleaseOutcome::Unresolved(format!(
                "lock {} cannot be inspected: {e}",
                dir.display()
            ))
        }
        Ok(meta) if !meta.is_dir() => {
            return ReleaseOutcome::Refused(format!(
                "lock path {} is not a plain directory; not guessing ownership",
                dir.display()
            ))
        }
        Ok(_) => {}
    }
    match read_holder(dir) {
        Some(h) if h.holder == expected_holder && h.run_id == expected_run_id => {}
        Some(h) => {
            return ReleaseOutcome::Foreign(format!(
                "lock {} is held by {:?} (run {:?}), not {:?}",
                dir.display(),
                h.holder,
                h.run_id,
                expected_holder
            ))
        }
        None => {
            return ReleaseOutcome::Refused(format!(
                "lock {} has no readable holder record; not guessing ownership",
                dir.display()
            ))
        }
    }
    let taken = tombstone_path(parent, &name, "release");
    match std::fs::rename(dir, &taken) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ReleaseOutcome::Absent,
        Err(e) => {
            return ReleaseOutcome::Unresolved(format!(
                "cannot take lock {} for release: {e}",
                dir.display()
            ))
        }
    }
    // Re-verify the isolated copy: the canonical path could have been
    // re-claimed between the pre-check and the take.
    match read_holder(&taken) {
        Some(h) if h.holder == expected_holder && h.run_id == expected_run_id => {
            match std::fs::remove_dir_all(&taken) {
                Ok(()) => ReleaseOutcome::Removed,
                Err(e) => ReleaseOutcome::Unresolved(format!("cannot remove lock: {e}")),
            }
        }
        other => {
            let readable = other.is_some();
            let described = other
                .map(|h| format!("held by {:?} (run {:?})", h.holder, h.run_id))
                .unwrap_or_else(|| "with no readable holder record".to_string());
            if std::fs::rename(&taken, dir).is_err() {
                return ReleaseOutcome::Unresolved(format!(
                    "foreign lock {described} was taken for release and could not be restored; it is preserved at {}",
                    taken.display()
                ));
            }
            if readable {
                ReleaseOutcome::Foreign(format!(
                    "lock {} is {described}, not {:?}",
                    dir.display(),
                    expected_holder
                ))
            } else {
                ReleaseOutcome::Refused(format!(
                    "lock {} has no readable holder record; not guessing ownership",
                    dir.display()
                ))
            }
        }
    }
}
