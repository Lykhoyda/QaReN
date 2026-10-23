use crate::exec::{CmdSpec, Runner};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionEntry {
    pub slug: String,
    pub platform: Option<String>,
    pub plan_hash: Option<String>,
    pub status: Option<String>,
}

pub fn header(text: &str, fallback_id: &str) -> Option<BTreeMap<String, String>> {
    let mut fields = BTreeMap::new();
    let mut in_comment = false;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix('#') {
            in_comment = true;
            let rest = rest.strip_prefix(' ').unwrap_or(rest).trim();
            if let Some((key, value)) = rest.split_once(':') {
                let key = key.trim();
                if matches!(
                    key,
                    "id" | "intent"
                        | "status"
                        | "appId"
                        | "createdAt"
                        | "author"
                        | "enginePin"
                        | "plan"
                        | "planHash"
                        | "platform"
                        | "tags"
                        | "mutates"
                        | "params"
                        | "produces"
                        | "expectedRouteSequence"
                ) && !value.is_empty()
                {
                    fields.insert(key.to_string(), value.trim().to_string());
                }
            }
        } else if in_comment && (!line.trim().is_empty() || !fields.is_empty()) {
            break;
        }
    }
    fields
        .entry("id".to_string())
        .or_insert_with(|| fallback_id.to_string());
    if fields.get("id").is_none_or(String::is_empty)
        || fields.get("intent").is_none_or(String::is_empty)
    {
        return None;
    }
    fields
        .entry("status".to_string())
        .or_insert_with(|| "experimental".to_string());
    Some(fields)
}

// Mirrors the action-store.ts mainCopyActionsTarget rule; fixture parity pins both readers.
pub(crate) fn main_copy_actions(runner: &mut dyn Runner, app_root: &Path) -> Option<PathBuf> {
    fn git(runner: &mut dyn Runner, root: &Path, args: &[&str]) -> Option<String> {
        let spec = CmdSpec::new("git actions main copy", "git", args, 2)
            .cwd(root)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_COMMON_DIR");
        let output = runner.run(&spec);
        output.ok().then(|| {
            output
                .stdout
                .strip_suffix('\n')
                .unwrap_or(&output.stdout)
                .to_string()
        })
    }
    fn git_path(runner: &mut dyn Runner, root: &Path, flag: &str) -> Option<PathBuf> {
        std::fs::canonicalize(git(
            runner,
            root,
            &["rev-parse", "--path-format=absolute", flag],
        )?)
        .ok()
    }
    let app_root = app_root.canonicalize().ok()?;
    let worktree = git_path(runner, &app_root, "--show-toplevel")?;
    let common = git_path(runner, &app_root, "--git-common-dir")?;
    let listing = git(
        runner,
        &app_root,
        &["worktree", "list", "--porcelain", "-z"],
    )?;
    let record = listing.split("\0\0").next()?;
    if record.split('\0').any(|field| field == "bare") {
        return None;
    }
    let main = PathBuf::from(record.split('\0').next()?.strip_prefix("worktree ")?)
        .canonicalize()
        .ok()?;
    if main == worktree
        || git_path(runner, &main, "--show-toplevel")? != main
        || git_path(runner, &main, "--git-common-dir")? != common
    {
        return None;
    }
    let relative = app_root.strip_prefix(&worktree).ok()?;
    if relative
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(main.join(relative).join(".qaren/actions"))
}

pub(crate) fn actions_dir(runner: &mut dyn Runner, app_root: &Path) -> Result<PathBuf, String> {
    let app_root = app_root
        .canonicalize()
        .unwrap_or_else(|_| app_root.to_path_buf());
    let qaren = app_root.join(".qaren");
    let dir = qaren.join("actions");
    let refuse =
        |path: &Path| format!("refusing the symlinked action corpus at {}", path.display());
    if std::fs::symlink_metadata(&qaren).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(refuse(&qaren));
    }
    if std::fs::symlink_metadata(&dir).is_ok_and(|meta| meta.file_type().is_symlink()) {
        let expected = main_copy_actions(runner, &app_root).ok_or_else(|| refuse(&dir))?;
        let target = qaren.join(std::fs::read_link(&dir).map_err(|_| refuse(&dir))?);
        let real_dir = |path: &Path| {
            std::fs::symlink_metadata(path)
                .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        };
        if !real_dir(&target)
            || !real_dir(expected.parent().unwrap())
            || target.canonicalize().ok().as_ref() != Some(&expected)
        {
            return Err(refuse(&dir));
        }
        return Ok(expected);
    }
    Ok(dir)
}

// Opens without following a symlink at the file and checks the opened descriptor is a regular file.
fn read_action(path: &Path) -> Result<String, String> {
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    if !file.metadata().is_ok_and(|meta| meta.is_file()) {
        return Err(format!("{} is not a regular file", path.display()));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    Ok(text)
}

pub(crate) fn action_path(dir: &Path, slug: &str) -> Result<Option<PathBuf>, String> {
    let mut found = None;
    for extension in ["yaml", "yml"] {
        let path = dir.join(format!("{slug}.{extension}"));
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {
                if found.is_some() {
                    return Err(format!(
                        "action {slug} is ambiguous because both {slug}.yaml and {slug}.yml exist; keep exactly one file before replay"
                    ));
                }
                found = Some(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot inspect {}: {e}", path.display())),
        }
    }
    Ok(found)
}

pub fn list(runner: &mut dyn Runner, app_root: &Path) -> Result<Vec<ActionEntry>, String> {
    let dir = actions_dir(runner, app_root)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("cannot read {}: {e}", dir.display())),
    };
    let mut actions = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|e| format!("cannot read {}: {e}", dir.display()))?
            .path();
        let slug = match (path.file_stem(), path.extension()) {
            (Some(stem), Some(ext)) if ext == "yaml" || ext == "yml" => {
                stem.to_string_lossy().into_owned()
            }
            _ => continue,
        };
        let Some(mut fields) = header(
            &read_action(
                &action_path(&dir, &slug)?
                    .ok_or_else(|| format!("no saved action named {slug}"))?,
            )?,
            &slug,
        ) else {
            continue;
        };
        actions.push(ActionEntry {
            slug,
            platform: fields.remove("platform"),
            plan_hash: fields.remove("planHash"),
            status: fields.remove("status"),
        });
    }
    actions.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(actions)
}

pub fn show(runner: &mut dyn Runner, app_root: &Path, slug: &str) -> Result<String, String> {
    let valid = !slug.is_empty()
        && slug.len() <= 128
        && !slug.starts_with('.')
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !slug.contains("..");
    if !valid {
        return Err(format!("{slug:?} is not an action slug"));
    }
    let path = action_path(&actions_dir(runner, app_root)?, slug)?
        .ok_or_else(|| format!("no saved action named {slug}"))?;
    let text = read_action(&path)?;
    if header(&text, slug).is_none() {
        return Err(format!("no valid action header for {slug}"));
    }
    Ok(text)
}

pub fn render(actions: &[ActionEntry]) -> String {
    let cell = |value: &Option<String>| value.clone().unwrap_or_else(|| "-".to_string());
    actions
        .iter()
        .map(|a| {
            format!(
                "{}\t{}\t{}\t{}\n",
                a.slug,
                cell(&a.platform),
                cell(&a.plan_hash),
                cell(&a.status)
            )
        })
        .collect()
}
