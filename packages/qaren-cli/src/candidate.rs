use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::scenario::Scenario;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candidate {
    pub repo_root: PathBuf,
    pub project_root: PathBuf,
    pub app_id: String,
    pub git_sha: String,
    pub git_dirty: bool,
    pub lockfile_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_fingerprint: Option<String>,
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

// An explicit worktree must BE a git toplevel, not merely live inside one:
// binding to a parent repo would couple the run to files outside the project
// the scenario named.
fn resolve_explicit_worktree(runner: &mut dyn Runner, worktree: &str) -> Result<PathBuf, Failure> {
    let canonical = std::fs::canonicalize(worktree).map_err(|e| {
        Failure::new(
            "validate",
            FailureCode::CandidatePathInvalid,
            format!("candidate.worktree {worktree:?} cannot be resolved: {e}"),
            "fix candidate.worktree in the scenario",
        )
    })?;
    let toplevel = runner.run(&CmdSpec::new(
        "git-toplevel",
        "git",
        &[
            "-C",
            &canonical.to_string_lossy(),
            "rev-parse",
            "--show-toplevel",
        ],
        20,
    ));
    if !toplevel.ok() {
        return Err(Failure::new(
            "validate",
            FailureCode::CandidateGitUnavailable,
            format!(
                "git toplevel of candidate.worktree {} failed: {}",
                canonical.display(),
                toplevel.summary()
            ),
            "candidate.worktree must be a git checkout",
        ));
    }
    let resolved = std::fs::canonicalize(toplevel.stdout.trim())
        .unwrap_or_else(|_| PathBuf::from(toplevel.stdout.trim()));
    if resolved != canonical {
        return Err(Failure::new(
            "validate",
            FailureCode::CandidatePathInvalid,
            format!(
                "candidate.worktree {} is not a git toplevel (the enclosing toplevel is {}); refusing an ambiguous worktree binding",
                canonical.display(),
                resolved.display()
            ),
            "point candidate.worktree at the exact git toplevel of the project",
        ));
    }
    Ok(canonical)
}

pub fn worktree_fingerprint(repo_root: &Path, porcelain: &str) -> Result<String, String> {
    use std::os::unix::ffi::OsStrExt;
    let entries = parse_porcelain_z(porcelain).ok_or("invalid git status records")?;
    let mut hasher = Sha256::new();
    hasher.update(porcelain.as_bytes());
    let mut paths: Vec<_> = entries
        .into_iter()
        .flat_map(PorcelainEntry::paths)
        .collect();
    paths.sort_unstable();
    paths.dedup();
    for path in paths {
        let relative = Path::new(path);
        if relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("git status path escapes the candidate".into());
        }
        let full = repo_root.join(relative);
        let mut parent = repo_root.to_path_buf();
        for component in relative.parent().into_iter().flat_map(Path::components) {
            parent.push(component);
            if std::fs::symlink_metadata(&parent).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("git status path has a symlinked parent".into());
            }
        }
        hasher.update((path.len() as u64).to_le_bytes());
        hasher.update(path.as_bytes());
        let metadata = match std::fs::symlink_metadata(&full) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                hasher.update(b"absent");
                continue;
            }
            Err(_) => return Err("cannot inspect dirty candidate file".into()),
        };
        let content = if metadata.file_type().is_symlink() {
            hasher.update(b"symlink");
            std::fs::read_link(&full)
                .map_err(|_| "cannot read candidate symlink")?
                .as_os_str()
                .as_bytes()
                .to_vec()
        } else if metadata.is_file() {
            hasher.update(b"file");
            std::fs::read(&full).map_err(|_| "cannot read dirty candidate file")?
        } else {
            return Err("git status entry is not a candidate file".into());
        };
        hasher.update((content.len() as u64).to_le_bytes());
        hasher.update(&content);
        use std::os::unix::fs::PermissionsExt;
        hasher.update((metadata.permissions().mode() & 0o111).to_le_bytes());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Clone, Copy)]
struct PorcelainEntry<'a> {
    status: &'a str,
    path: &'a str,
    original_path: Option<&'a str>,
}

impl<'a> PorcelainEntry<'a> {
    fn paths(self) -> impl Iterator<Item = &'a str> {
        std::iter::once(self.path).chain(self.original_path)
    }
}

fn parse_porcelain_z(porcelain: &str) -> Option<Vec<PorcelainEntry<'_>>> {
    if !porcelain.is_empty() && !porcelain.ends_with('\0') {
        return None;
    }
    let mut records = porcelain.split_terminator('\0');
    let mut entries = Vec::new();
    while let Some(record) = records.next() {
        let status = record.get(..2)?;
        if record.as_bytes().get(2) != Some(&b' ') {
            return None;
        }
        let path = record.get(3..)?;
        if path.is_empty() {
            return None;
        }
        let original_path = if status.contains('R') || status.contains('C') {
            Some(records.next().filter(|path| !path.is_empty())?)
        } else {
            None
        };
        entries.push(PorcelainEntry {
            status,
            path,
            original_path,
        });
    }
    Some(entries)
}

fn serialize_porcelain_z<'a>(entries: impl IntoIterator<Item = PorcelainEntry<'a>>) -> String {
    let mut serialized = String::new();
    for entry in entries {
        serialized.push_str(entry.status);
        serialized.push(' ');
        serialized.push_str(entry.path);
        serialized.push('\0');
        if let Some(original_path) = entry.original_path {
            serialized.push_str(original_path);
            serialized.push('\0');
        }
    }
    serialized
}

pub fn porcelain_without_qaren_state(
    porcelain_stdout: &str,
    repo_root: &Path,
    project_root: &Path,
) -> String {
    let app_qaren = project_root
        .strip_prefix(repo_root)
        .ok()
        .map(|relative| relative.join(".qaren"));
    let actions = app_qaren.as_ref().map(|qaren| qaren.join("actions"));
    let plans = app_qaren.map(|qaren| qaren.join("plans"));
    let Some(entries) = parse_porcelain_z(porcelain_stdout) else {
        return porcelain_stdout.to_string();
    };
    serialize_porcelain_z(entries.into_iter().filter(|entry| {
        !entry.paths().all(|path| {
            let path_ref = Path::new(path);
            is_qaren_state_path(path)
                || actions.as_deref().is_some_and(|actions| {
                    path_ref.parent() == Some(actions)
                        && path_ref
                            .extension()
                            .is_some_and(|extension| extension == "yaml" || extension == "yml")
                })
                || plans.as_deref().is_some_and(|plans| {
                    path_ref.parent() == Some(plans)
                        && path_ref
                            .extension()
                            .is_some_and(|extension| extension == "md")
                })
        })
    }))
}

fn is_qaren_state_path(path: &str) -> bool {
    path == ".qaren" || path.starts_with(".qaren/")
}

// Only file-level untracked integration outputs belong to the session.
fn is_untracked_integration_entry(entry: PorcelainEntry<'_>, rn_agent_prefix: &str) -> bool {
    entry.status == "??"
        && entry.original_path.is_none()
        && entry
            .path
            .starts_with(&format!("{rn_agent_prefix}/integration/"))
        && !entry.path.ends_with('/')
}

// True when the working package.json differs from HEAD only in the two
// integration-owned script entries.
fn package_json_delta_is_integration_only(
    runner: &mut dyn Runner,
    repo_root: &Path,
    rel_path: &str,
) -> bool {
    let head = runner.run(&CmdSpec::new(
        "git-show-package-json",
        "git",
        &[
            "-C",
            &repo_root.to_string_lossy(),
            "show",
            &format!("HEAD:{rel_path}"),
        ],
        20,
    ));
    if !head.ok() {
        return false;
    }
    let working = std::fs::read_to_string(repo_root.join(rel_path)).ok();
    let (Some(mut working), Ok(mut head_json)) = (
        working.and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok()),
        serde_json::from_str::<serde_json::Value>(&head.stdout),
    ) else {
        return false;
    };
    let head_has_scripts = head_json.get("scripts").is_some();
    let removed_working_scripts = working
        .get_mut("scripts")
        .and_then(|scripts| scripts.as_object_mut())
        .is_some_and(|scripts| {
            let removed_ios = scripts.remove("ios").is_some();
            let removed_android = scripts.remove("android").is_some();
            (removed_ios || removed_android) && scripts.is_empty()
        });
    if !head_has_scripts && removed_working_scripts {
        if let Some(object) = working.as_object_mut() {
            object.remove("scripts");
        }
    }
    if let Some(scripts) = head_json
        .get_mut("scripts")
        .and_then(|scripts| scripts.as_object_mut())
    {
        scripts.remove("ios");
        scripts.remove("android");
    }
    working == head_json
}

const METRO_INTEGRATION_BEGIN: &str = "// qaren session integration: begin";
const METRO_INTEGRATION_END: &str = "// qaren session integration: end";
const METRO_INTEGRATION_BODY: &str =
    "module.exports = require('./.qaren/integration/rn-session-metro.cjs')(module.exports);";

fn metro_integration_transform(head: &str) -> String {
    format!(
        "{}\n\n{METRO_INTEGRATION_BEGIN}\n{METRO_INTEGRATION_BODY}\n{METRO_INTEGRATION_END}\n",
        head.trim_end()
    )
}

// True when the working metro config differs from HEAD only by the session's
// marked integration block.
fn metro_config_delta_is_integration_only(
    runner: &mut dyn Runner,
    repo_root: &Path,
    rel_path: &str,
) -> bool {
    let head = runner.run(&CmdSpec::new(
        "git-show-metro-config",
        "git",
        &[
            "-C",
            &repo_root.to_string_lossy(),
            "show",
            &format!("HEAD:{rel_path}"),
        ],
        20,
    ));
    if !head.ok() {
        return false;
    }
    let Ok(working) = std::fs::read_to_string(repo_root.join(rel_path)) else {
        return false;
    };
    working == metro_integration_transform(&head.stdout)
}

fn git_object_record<'a>(stdout: &'a str, expected_path: &str) -> Option<&'a str> {
    let record = stdout.strip_suffix('\0')?;
    if record.contains('\0') {
        return None;
    }
    let (metadata, path) = record.split_once('\t')?;
    (path == expected_path).then_some(metadata)
}

fn tracked_file_identity_is_unchanged(
    runner: &mut dyn Runner,
    repo_root: &Path,
    rel_path: &str,
) -> bool {
    let repo = repo_root.to_string_lossy();
    let head = runner.run(&CmdSpec::new(
        "git-ls-tree-integration",
        "git",
        &["-C", &repo, "ls-tree", "-z", "HEAD", "--", rel_path],
        20,
    ));
    let index = runner.run(&CmdSpec::new(
        "git-ls-files-integration",
        "git",
        &["-C", &repo, "ls-files", "--stage", "-z", "--", rel_path],
        20,
    ));
    if !head.ok() || !index.ok() {
        return false;
    }
    let Some(head_metadata) = git_object_record(&head.stdout, rel_path) else {
        return false;
    };
    let Some(index_metadata) = git_object_record(&index.stdout, rel_path) else {
        return false;
    };
    let mut head_fields = head_metadata.split_whitespace();
    let (Some(head_mode), Some("blob"), Some(head_oid), None) = (
        head_fields.next(),
        head_fields.next(),
        head_fields.next(),
        head_fields.next(),
    ) else {
        return false;
    };
    let mut index_fields = index_metadata.split_whitespace();
    let (Some(index_mode), Some(index_oid), Some("0"), None) = (
        index_fields.next(),
        index_fields.next(),
        index_fields.next(),
        index_fields.next(),
    ) else {
        return false;
    };
    if !matches!(head_mode, "100644" | "100755")
        || head_mode != index_mode
        || head_oid.is_empty()
        || head_oid != index_oid
    {
        return false;
    }
    working_file_mode_matches(repo_root.join(rel_path), head_mode)
}

#[cfg(unix)]
fn working_file_mode_matches(path: PathBuf, git_mode: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .is_ok_and(|executable| executable == (git_mode == "100755"))
}

#[cfg(not(unix))]
fn working_file_mode_matches(_path: PathBuf, _git_mode: &str) -> bool {
    false
}

pub fn filter_integration_entries(
    runner: &mut dyn Runner,
    repo_root: &Path,
    project_root: &Path,
    porcelain: &str,
) -> String {
    let Some(entries) = parse_porcelain_z(porcelain) else {
        return porcelain.to_string();
    };
    let project_rel = project_root
        .strip_prefix(repo_root)
        .map(|rel| rel.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (package_json_rel, metro_config_prefix, rn_agent_prefix) = if project_rel.is_empty() {
        (
            "package.json".to_string(),
            "metro.config.".to_string(),
            ".qaren".to_string(),
        )
    } else {
        (
            format!("{project_rel}/package.json"),
            format!("{project_rel}/metro.config."),
            format!("{project_rel}/.qaren"),
        )
    };
    let mut kept = Vec::new();
    for entry in entries {
        if is_untracked_integration_entry(entry, &rn_agent_prefix) {
            continue;
        }
        let entry_path = entry.original_path.is_none().then_some(entry.path);
        if entry.status == " M"
            && entry_path == Some(package_json_rel.as_str())
            && package_json_delta_is_integration_only(runner, repo_root, &package_json_rel)
            && tracked_file_identity_is_unchanged(runner, repo_root, &package_json_rel)
        {
            continue;
        }
        if let Some(path) = entry_path {
            if entry.status == " M"
                && path.starts_with(&metro_config_prefix)
                && !path[metro_config_prefix.len()..].contains('/')
                && metro_config_delta_is_integration_only(runner, repo_root, path)
                && tracked_file_identity_is_unchanged(runner, repo_root, path)
            {
                continue;
            }
        }
        kept.push(entry);
    }
    serialize_porcelain_z(kept)
}

// Re-verifies the live worktree against a recorded candidate identity (sha,
// cleanliness, worktree fingerprint, lockfile). Returns the drift detail so
// callers wrap it in their own phase/next-action failure. Handoff-mode
// callers pass `tolerate_integration: true` so the session's declared
// integration surface is not read as drift; their baseline was recorded
// through the same filter.
pub fn verify_unchanged_with(
    runner: &mut dyn Runner,
    recorded: &Candidate,
    tolerate_integration: bool,
) -> Result<(), String> {
    verify_unchanged_inner(runner, recorded, tolerate_integration)
}

pub fn verify_unchanged(runner: &mut dyn Runner, recorded: &Candidate) -> Result<(), String> {
    verify_unchanged_inner(runner, recorded, false)
}

fn verify_unchanged_inner(
    runner: &mut dyn Runner,
    recorded: &Candidate,
    tolerate_integration: bool,
) -> Result<(), String> {
    let repo_root = recorded.repo_root.to_string_lossy().into_owned();
    let head = runner.run(&CmdSpec::new(
        "git-head",
        "git",
        &["-C", &repo_root, "rev-parse", "HEAD"],
        20,
    ));
    if !head.ok() {
        return Err(format!("git rev-parse HEAD failed: {}", head.summary()));
    }
    let sha_now = head.stdout.trim();
    if sha_now != recorded.git_sha {
        return Err(format!(
            "checkout HEAD moved: recorded {}, now {sha_now}",
            recorded.git_sha
        ));
    }
    let porcelain = runner.run(&CmdSpec::new(
        "git-dirty",
        "git",
        &[
            "-C",
            &repo_root,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
        30,
    ));
    if !porcelain.ok() {
        return Err(format!(
            "git status --porcelain=v1 -z failed: {}",
            porcelain.summary()
        ));
    }
    let project_state = porcelain_without_qaren_state(
        &porcelain.stdout,
        &recorded.repo_root,
        &recorded.project_root,
    );
    let project_state = if tolerate_integration {
        filter_integration_entries(
            runner,
            &recorded.repo_root,
            &recorded.project_root,
            &project_state,
        )
    } else {
        project_state
    };
    let dirty_now = !project_state.trim().is_empty();
    if dirty_now != recorded.git_dirty {
        return Err(format!(
            "worktree cleanliness changed: recorded dirty={}, now dirty={dirty_now}",
            recorded.git_dirty
        ));
    }
    let fingerprint_now = worktree_fingerprint(&recorded.repo_root, &project_state)?;
    if let Some(fp) = recorded.worktree_fingerprint.as_deref() {
        if fp != fingerprint_now {
            return Err(format!(
                "worktree contents changed: recorded fingerprint {fp}, now {fingerprint_now}"
            ));
        }
    }
    let lockfile = recorded.project_root.join("pnpm-lock.yaml");
    let lockfile_now = std::fs::read(&lockfile)
        .ok()
        .map(|bytes| sha256_hex(&bytes));
    if lockfile_now != recorded.lockfile_sha256 {
        return Err("pnpm-lock.yaml changed".to_string());
    }
    Ok(())
}

pub fn resolve(
    runner: &mut dyn Runner,
    scenario: &Scenario,
    scenario_dir: &Path,
) -> Result<Candidate, Failure> {
    let repo_root = match &scenario.candidate.worktree {
        Some(worktree) => resolve_explicit_worktree(runner, worktree)?,
        None => {
            let toplevel = runner.run(&CmdSpec::new(
                "git-toplevel",
                "git",
                &[
                    "-C",
                    &scenario_dir.to_string_lossy(),
                    "rev-parse",
                    "--show-toplevel",
                ],
                20,
            ));
            if !toplevel.ok() {
                return Err(Failure::new(
                    "validate",
                    FailureCode::CandidateGitUnavailable,
                    format!(
                        "git toplevel of {} failed: {}",
                        scenario_dir.display(),
                        toplevel.summary()
                    ),
                    "run qaren with the scenario inside the qaren-workspace checkout",
                ));
            }
            PathBuf::from(toplevel.stdout.trim())
        }
    };
    let project_root = if scenario.candidate.project_root == "." {
        repo_root.clone()
    } else {
        repo_root.join(&scenario.candidate.project_root)
    };
    let contained = repo_root
        .canonicalize()
        .and_then(|repo| {
            project_root
                .canonicalize()
                .map(|proj| proj.starts_with(&repo))
        })
        .unwrap_or(false);
    if !contained {
        return Err(Failure::new(
            "validate",
            FailureCode::CandidatePathInvalid,
            format!(
                "{} does not resolve inside {}",
                project_root.display(),
                repo_root.display()
            ),
            "fix candidate.project_root in the scenario",
        ));
    }
    if !project_root.join("package.json").is_file() {
        return Err(Failure::new(
            "validate",
            FailureCode::CandidatePathInvalid,
            format!("{} has no package.json", project_root.display()),
            "fix candidate.project_root in the scenario",
        ));
    }
    let head = runner.run(&CmdSpec::new(
        "git-head",
        "git",
        &["-C", &repo_root.to_string_lossy(), "rev-parse", "HEAD"],
        20,
    ));
    if !head.ok() {
        return Err(Failure::new(
            "validate",
            FailureCode::CandidateGitUnavailable,
            format!("git rev-parse HEAD failed: {}", head.summary()),
            "ensure the checkout has a resolvable HEAD",
        ));
    }
    let git_sha = head.stdout.trim().to_string();
    if scenario.candidate.revision != "HEAD" && scenario.candidate.revision != git_sha {
        return Err(Failure::new(
            "validate",
            FailureCode::CandidateRevisionMismatch,
            format!(
                "scenario pins revision {} but checkout HEAD is {git_sha}",
                scenario.candidate.revision
            ),
            "check out the pinned revision or update the scenario",
        ));
    }
    let porcelain = runner.run(&CmdSpec::new(
        "git-dirty",
        "git",
        &[
            "-C",
            &repo_root.to_string_lossy(),
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
        30,
    ));
    if !porcelain.ok() {
        return Err(Failure::new(
            "validate",
            FailureCode::CandidateGitUnavailable,
            format!(
                "git status --porcelain=v1 -z failed: {}",
                porcelain.summary()
            ),
            "ensure git can inspect the checkout",
        ));
    }
    let lockfile = project_root.join("pnpm-lock.yaml");
    let lockfile_sha256 = match std::fs::read(&lockfile) {
        Ok(bytes) => Some(sha256_hex(&bytes)),
        Err(e) => {
            return Err(Failure::new(
                "validate",
                FailureCode::CandidatePathInvalid,
                format!("cannot read {} for provenance: {e}", lockfile.display()),
                "the candidate must carry a pnpm-lock.yaml; commit one or fix project_root",
            ))
        }
    };
    let project_state = porcelain_without_qaren_state(&porcelain.stdout, &repo_root, &project_root);
    // Handoff-mode baselines are normalized through the integration filter so
    // the same comparison holds before and after the session applies (or has
    // left applied) its declared integration surface.
    let project_state = if scenario.build.owner == crate::scenario::BuildOwner::Qaren {
        filter_integration_entries(runner, &repo_root, &project_root, &project_state)
    } else {
        project_state
    };
    let fingerprint = worktree_fingerprint(&repo_root, &project_state).map_err(|detail| {
        Failure::new(
            "validate",
            FailureCode::CandidatePathInvalid,
            detail,
            "restore readable candidate files and retry",
        )
    })?;
    Ok(Candidate {
        repo_root,
        project_root,
        app_id: scenario.candidate.app_id.clone(),
        git_sha,
        git_dirty: !project_state.trim().is_empty(),
        lockfile_sha256,
        worktree_fingerprint: Some(fingerprint),
    })
}

#[cfg(test)]
mod tests {
    fn porcelain_without_qaren_state(porcelain: &str) -> String {
        super::porcelain_without_qaren_state(
            porcelain,
            std::path::Path::new("repo"),
            std::path::Path::new("repo"),
        )
    }

    #[test]
    fn app_actions_are_outputs_but_cross_boundary_renames_are_changes() {
        for (porcelain, expected) in [
            ("?? test-app/.qaren/actions/tasks.yaml\0", ""),
            (" M test-app/.qaren/actions/tasks.yml\0", ""),
            (" D test-app/.qaren/actions/tasks.yaml\0", ""),
            (
                "R  test-app/.qaren/actions/new.yml\0test-app/.qaren/actions/old.yaml\0",
                "",
            ),
            (
                "R  test-app/.qaren/actions/tasks.yaml\0test-app/App.tsx\0",
                "R  test-app/.qaren/actions/tasks.yaml\0test-app/App.tsx\0",
            ),
            (
                "R  test-app/App.tsx\0test-app/.qaren/actions/tasks.yaml\0",
                "R  test-app/App.tsx\0test-app/.qaren/actions/tasks.yaml\0",
            ),
            (
                " M other-app/.qaren/actions/tasks.yaml\0",
                " M other-app/.qaren/actions/tasks.yaml\0",
            ),
            (
                " M test-app/.qaren/config.yaml\0",
                " M test-app/.qaren/config.yaml\0",
            ),
            (
                " M test-app/.qaren/actions/source.ts\0",
                " M test-app/.qaren/actions/source.ts\0",
            ),
        ] {
            assert_eq!(
                super::porcelain_without_qaren_state(
                    porcelain,
                    std::path::Path::new("repo"),
                    std::path::Path::new("repo/test-app"),
                ),
                expected,
            );
        }
    }

    #[test]
    fn saved_plans_of_a_nested_app_are_outputs() {
        for (porcelain, expected) in [
            ("?? test-app/.qaren/plans/add-a-task.md\0", ""),
            (" M test-app/.qaren/plans/add-a-task.md\0", ""),
            (
                "?? test-app/.qaren/plans/notes.txt\0",
                "?? test-app/.qaren/plans/notes.txt\0",
            ),
            (
                "?? other-app/.qaren/plans/x.md\0",
                "?? other-app/.qaren/plans/x.md\0",
            ),
        ] {
            assert_eq!(
                super::porcelain_without_qaren_state(
                    porcelain,
                    std::path::Path::new("repo"),
                    std::path::Path::new("repo/test-app"),
                ),
                expected,
            );
        }
    }

    #[test]
    fn drops_the_untracked_qaren_dir_entry() {
        assert_eq!(porcelain_without_qaren_state("?? .qaren/\0"), "");
    }

    #[test]
    fn drops_entries_for_files_under_qaren() {
        assert_eq!(
            porcelain_without_qaren_state(
                "?? .qaren/runs/run-1/run.json\0 M .qaren/native-cache/state.json\0"
            ),
            ""
        );
    }

    #[test]
    fn keeps_entries_outside_qaren() {
        let porcelain = " M test-app/App.tsx\0?? stray.txt\0";
        assert_eq!(porcelain_without_qaren_state(porcelain), porcelain);
    }

    #[test]
    fn keeps_paths_that_merely_share_the_qaren_prefix() {
        let porcelain = "?? .qaren-notes.txt\0";
        assert_eq!(porcelain_without_qaren_state(porcelain), porcelain);
    }

    #[test]
    fn keeps_renames_that_cross_the_qaren_boundary() {
        let porcelain = "R  .qaren/App.tsx\0src/App.tsx\0";
        assert_eq!(porcelain_without_qaren_state(porcelain), porcelain);
    }

    #[test]
    fn drops_renames_fully_inside_qaren() {
        assert_eq!(
            porcelain_without_qaren_state("R  .qaren/b.json\0.qaren/a.json\0"),
            ""
        );
    }

    #[test]
    fn drops_paths_with_special_characters_under_qaren() {
        assert_eq!(porcelain_without_qaren_state("?? .qaren/wei\nrd\0"), "");
    }

    #[test]
    fn preserves_surviving_entries_byte_for_byte() {
        let porcelain = "?? .qaren/\0 M test-app/App.tsx\0?? .qaren/runs/x\0";
        assert_eq!(
            porcelain_without_qaren_state(porcelain),
            " M test-app/App.tsx\0"
        );
    }
}
