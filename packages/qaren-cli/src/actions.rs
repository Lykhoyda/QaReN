use crate::exec::{CmdSpec, Runner};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct LoginCandidate {
    pub inputs: Vec<String>,
    pub marker: Option<crate::core::Selector>,
    pub signs_out_at: Option<usize>,
}

fn signs_out(text: &str) -> bool {
    let text = text.to_lowercase();
    let word = |c: char| c.is_alphanumeric() || c == '_';
    text.char_indices().any(|(at, _)| {
        if text[..at].chars().next_back().is_some_and(word) {
            return false;
        }
        ["log", "sign"].iter().any(|prefix| {
            let Some(rest) = text[at..].strip_prefix(prefix) else {
                return false;
            };
            let rest = rest
                .strip_prefix(|c: char| c.is_whitespace() || c == '_' || c == '-')
                .unwrap_or(rest);
            rest.strip_prefix("out")
                .is_some_and(|tail| !tail.chars().next().is_some_and(word))
        })
    })
}

pub fn login_candidate(text: &str) -> Option<LoginCandidate> {
    let (_, body) = text.split_once("\n---\n")?;
    let (_, body) = body.split_once("\n\n")?;
    let mut candidate = LoginCandidate {
        inputs: Vec::new(),
        marker: None,
        signs_out_at: None,
    };
    let mut step = 0;
    for line in body.lines() {
        if let Some(comment) = line.strip_prefix("# ") {
            if !comment.starts_with("qaren:") {
                step += 1;
                if candidate.inputs.is_empty() && signs_out(comment) {
                    candidate.signs_out_at.get_or_insert(step);
                }
            }
            continue;
        }
        let Some(command) = line.strip_prefix("- ") else {
            continue;
        };
        let value: serde_yaml::Value = serde_yaml::from_str(command).ok()?;
        let selector = value
            .get("tapOn")
            .or_else(|| value.get("extendedWaitUntil")?.get("visible"))
            .or_else(|| value.get("scrollUntilVisible")?.get("element"));
        if candidate.inputs.is_empty()
            && selector
                .or_else(|| value.get("assertVisible"))
                .is_some_and(|selector| {
                    ["id", "text"]
                        .iter()
                        .filter_map(|key| selector.get(key)?.as_str())
                        .any(signs_out)
                })
        {
            candidate.signs_out_at.get_or_insert(step.max(1));
        }
        if let Some(selector) = selector {
            let id = selector.get("id").and_then(serde_yaml::Value::as_str);
            let text = selector.get("text").and_then(serde_yaml::Value::as_str);
            if candidate.marker.is_none() && (id.is_some() ^ text.is_some()) {
                candidate.marker = Some(crate::core::Selector {
                    id: id.map(str::to_string),
                    text: text.map(str::to_string),
                });
            }
        }
        if let Some(fill) = value
            .get("inputText")
            .filter(|fill| fill.get("sensitivity").is_none())
        {
            if let Some(name) = fill
                .get("input")
                .and_then(serde_yaml::Value::as_str)
                .filter(|name| crate::redact::valid_input_name(name))
            {
                if !candidate.inputs.iter().any(|input| input == name) {
                    candidate.inputs.push(name.to_string());
                }
            }
        }
    }
    (!candidate.inputs.is_empty()).then_some(candidate)
}

impl LoginCandidate {
    pub fn hint(&self, slug: &str) -> Option<crate::receipt::Hint> {
        let slug_quoted = serde_json::to_string(slug).ok()?;
        if let Some(step) = self.signs_out_at {
            return Some(crate::receipt::Hint {
                code: "LOGIN_BLOCK_SIGNS_OUT".into(),
                text: format!("▸ login: block {slug_quoted} signs out (step {step}) before it signs in, so it starts signed in.\n  Login recovery replays a block from the sign-in screen: move the sign-out steps into\n  their own block above it and start the sign-in block on the sign-in screen."),
            });
        }
        let marker = self.marker.as_ref()?;
        let (key, value) = marker
            .id
            .as_ref()
            .map(|id| ("id", id))
            .or_else(|| marker.text.as_ref().map(|text| ("text", text)))?;
        let envs = self
            .inputs
            .iter()
            .map(|name| format!("QAREN_INPUT_{name}"))
            .collect::<Vec<_>>()
            .join(" and ");
        let config_slug = match serde_yaml::from_str::<serde_yaml::Value>(slug) {
            Ok(serde_yaml::Value::String(_)) => slug,
            _ => &slug_quoted,
        };
        Some(crate::receipt::Hint {
            code: "LOGIN_BLOCK_CANDIDATE".into(),
            text: format!("▸ login: block {slug_quoted} signs in with runtime inputs {}.\n  To replay it whenever its first screen appears, add to .qaren/config.yaml:\n    loginBlock: {config_slug}\n    loginMarker:\n      {key}: {}\n  Every run then needs {envs} set.", self.inputs.join(", "), serde_json::to_string(value).ok()?),
        })
    }
}

pub fn login_for(
    app_root: &Path,
    slug: &str,
    platform: &str,
    app_id: &str,
) -> Option<LoginCandidate> {
    login_candidate(&show_for(app_root, slug, platform, app_id)?)
}

pub fn show_for(app_root: &Path, slug: &str, platform: &str, app_id: &str) -> Option<String> {
    let text = show(app_root, slug).ok()?;
    let fields = header(&text, slug)?;
    if fields.get("platform").map(String::as_str) != Some(platform)
        || fields.get("appId").map(String::as_str) != Some(app_id)
    {
        return None;
    }
    Some(text)
}

#[derive(Debug, PartialEq, Eq)]
pub enum CorpusLocation {
    NotGit,
    Primary,
    Linked { local: bool },
}

pub fn corpus_location(runner: &mut dyn crate::exec::Runner, app_root: &Path) -> CorpusLocation {
    let output = crate::worktree::git(
        runner,
        "git-corpus-location",
        app_root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
            "--git-common-dir",
        ],
        10,
    );
    let mut paths = output.stdout.lines();
    let (Some(dir), Some(common)) = (paths.next(), paths.next()) else {
        return CorpusLocation::NotGit;
    };
    if !output.ok() {
        return CorpusLocation::NotGit;
    }
    if Path::new(dir) == Path::new(common) {
        CorpusLocation::Primary
    } else {
        CorpusLocation::Linked {
            local: std::fs::symlink_metadata(app_root.join(".qaren/actions"))
                .is_ok_and(|meta| meta.is_dir()),
        }
    }
}

pub fn corpus_hint(written: usize) -> crate::receipt::Hint {
    crate::receipt::Hint {
        code: "CORPUS_NOT_SHARED".into(),
        text: format!("▸ saved blocks: {written} written to this linked worktree's .qaren/actions; they leave with this\n  worktree and other checkouts walk them again. Commit them, or share saved blocks with\n  the main copy: move them to <main>/<app>/.qaren/actions, remove this worktree's\n  .qaren/actions, then: ln -s <main>/<app>/.qaren/actions .qaren/actions"),
    }
}

pub fn corpus_link_is_main_copy(runner: &mut dyn crate::exec::Runner, root: &Path) -> bool {
    let link = root.join(".qaren/actions");
    if !std::fs::symlink_metadata(&link).is_ok_and(|meta| meta.is_symlink())
        || !std::fs::symlink_metadata(root.join(".qaren")).is_ok_and(|meta| meta.is_dir())
    {
        return false;
    }
    let top = crate::worktree::git(
        runner,
        "git-corpus-root",
        root,
        &["rev-parse", "--show-toplevel"],
        10,
    );
    let worktrees = crate::worktree::git(
        runner,
        "git-corpus-main",
        root,
        &["worktree", "list", "--porcelain", "-z"],
        10,
    );
    let Some(record) = worktrees.stdout.split("\0\0").next() else {
        return false;
    };
    if !top.ok() || !worktrees.ok() || record.split('\0').any(|field| field == "bare") {
        return false;
    }
    let Some(main) = record
        .split('\0')
        .next()
        .and_then(|field| field.strip_prefix("worktree "))
    else {
        return false;
    };
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    let Ok(relative) = root.strip_prefix(top.stdout.trim()) else {
        return false;
    };
    let target = Path::new(main).join(relative).join(".qaren/actions");
    let Ok(link_target) = std::fs::read_link(&link) else {
        return false;
    };
    let link_target = link.parent().unwrap().join(link_target);
    std::fs::symlink_metadata(&target).is_ok_and(|meta| meta.is_dir())
        && std::fs::symlink_metadata(&link_target).is_ok_and(|meta| meta.is_dir())
        && link_target.canonicalize().ok() == target.canonicalize().ok()
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn block(commands: &str) -> String {
        format!("appId: com.example.app\n---\n# id: sign-in\n# intent: Sign in\n# appId: com.example.app\n# platform: ios\n\n{commands}")
    }

    #[test]
    fn login_candidates_use_the_first_selector_and_strict_input_names() {
        for (command, field) in [
            ("tapOn: { id: \"login-email\" }", "id"),
            (
                "extendedWaitUntil: { visible: { text: \"Email\" }, timeout: 15000 }",
                "text",
            ),
            (
                "scrollUntilVisible: { element: { text: \"Email\" }, direction: DOWN }",
                "text",
            ),
        ] {
            let candidate = login_candidate(&block(&format!(
                "# 1. Fill email\n- {command}\n- inputText: {{ input: \"USERNAME\" }}\n# 2. Fill password\n- tapOn: {{ id: \"password\" }}\n- inputText: {{ input: \"PASSWORD\" }}\n"
            )))
            .unwrap();
            assert_eq!(candidate.inputs, ["USERNAME", "PASSWORD"]);
            let marker = candidate.marker.unwrap();
            assert_eq!(marker.id.is_some(), field == "id");
            assert_eq!(candidate.signs_out_at, None);
        }
        assert!(login_candidate(&block(
            "- tapOn: { text: Email }\n- inputText: { input: OTP, sensitivity: non-secret }\n"
        ))
        .is_none());
    }

    #[test]
    fn sign_out_detection_stops_at_the_first_strict_fill() {
        for label in ["Logout", "sign-out", "SignOut", "Log out", "sign_out"] {
            let candidate = login_candidate(&block(&format!(
                "# 1. Tap \"{label}\"\n- tapOn: {{ text: \"{label}\" }}\n# 2. Fill email\n- tapOn: {{ id: email }}\n- inputText: {{ input: USERNAME }}\n"
            ))).unwrap();
            assert_eq!(candidate.signs_out_at, Some(1), "{label}");
        }
        let candidate = login_candidate(&block("# 1. Fill email\n- tapOn: { id: logo }\n- inputText: { input: USERNAME }\n# 2. Log out\n- tapOn: { text: Logout }\n")).unwrap();
        assert_eq!(candidate.signs_out_at, None);
    }

    #[test]
    fn hints_quote_yaml_scalars_and_json_selector_text() {
        let candidate = login_candidate(&block("# 1. Fill email\n- tapOn: { text: 'Email \"primary\"' }\n- inputText: { input: USERNAME }\n")).unwrap();
        let hint = candidate.hint("123").unwrap();
        assert!(hint.text.contains("loginBlock: \"123\""));
        assert!(hint.text.contains("text: \"Email \\\"primary\\\"\""));
    }

    #[test]
    fn sign_out_comments_and_stored_selectors_each_flag_the_block() {
        for commands in [
            "# 1. Sign-out\n- tapOn: { id: account-control }\n# 2. Fill email\n- inputText: { input: USERNAME }\n",
            "# 1. Open account\n- tapOn: { id: SignOut }\n# 2. Fill email\n- inputText: { input: USERNAME }\n",
        ] {
            assert_eq!(login_candidate(&block(commands)).unwrap().signs_out_at, Some(1));
        }
    }
}
