use crate::exec::{CmdSpec, Runner};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct LoginCandidate {
    pub inputs: Vec<String>,
    pub marker: Option<crate::core::Selector>,
    pub signs_out_at: Option<usize>,
    likely: bool,
}

fn signs_out(text: &str) -> bool {
    joins(text, "out")
}

fn names_sign_in(text: &str) -> bool {
    joins(text, "in")
        || text
            .to_lowercase()
            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .any(|word| word == "authenticate")
}

fn joins(text: &str, tail: &str) -> bool {
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
            rest.strip_prefix(tail)
                .is_some_and(|tail| !tail.chars().next().is_some_and(word))
        })
    })
}

pub fn login_candidate(text: &str) -> Option<LoginCandidate> {
    login_block(text).filter(|candidate| candidate.likely)
}

pub fn login_block(text: &str) -> Option<LoginCandidate> {
    for document in serde_yaml::Deserializer::from_str(text) {
        serde_yaml::Value::deserialize(document).ok()?;
    }
    let (_, body) = text.split_once("\n---\n")?;
    let (head, body) = body.split_once("\n\n")?;
    let mut candidate = LoginCandidate {
        inputs: Vec::new(),
        marker: None,
        signs_out_at: None,
        likely: header(head, "-").is_some_and(|fields| names_sign_in(&fields["intent"])),
    };
    let mut step = 0;
    let mut step_text = "";
    let mut navigated_at = None;
    let mut strict_filled = false;
    let mut lines = body.lines().peekable();
    while let Some(line) = lines.next() {
        if let Some(comment) = line.strip_prefix("# ") {
            if comment == "qaren: back" {
                navigated_at.get_or_insert(step);
            }
            if !comment.starts_with("qaren:") {
                step += 1;
                step_text = comment;
            }
            continue;
        }
        let Some(command) = line.strip_prefix("- ") else {
            continue;
        };
        let value: serde_yaml::Value = serde_yaml::from_str(command).ok()?;
        if value.get("tapOn").is_some() || value.as_str() == Some("back") {
            navigated_at.get_or_insert(step);
        }
        if let Some(tap) = value.get("tapOn") {
            let presses = !lines
                .peek()
                .is_some_and(|next| next.starts_with("- inputText:"));
            if presses
                && candidate.inputs.is_empty()
                && (signs_out(step_text)
                    || ["id", "text"]
                        .iter()
                        .filter_map(|key| tap.get(key)?.as_str())
                        .any(signs_out))
            {
                candidate.signs_out_at.get_or_insert(step.max(1));
            }
        }
        let selector = value
            .get("tapOn")
            .or_else(|| value.get("extendedWaitUntil")?.get("visible"))
            .or_else(|| value.get("scrollUntilVisible")?.get("element"));
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
        if let Some(fill) = value.get("inputText") {
            if let Some(name) = fill
                .get("input")
                .and_then(serde_yaml::Value::as_str)
                .filter(|name| crate::redact::valid_input_name(name))
            {
                if fill.get("sensitivity").is_none() && !strict_filled {
                    strict_filled = true;
                    candidate.likely |= navigated_at.is_none_or(|at| at == step);
                }
                if !candidate.inputs.iter().any(|input| input == name) {
                    candidate.inputs.push(name.to_string());
                }
            }
        }
    }
    candidate.likely &= !candidate.inputs.is_empty();
    Some(candidate)
}

impl LoginCandidate {
    pub fn hint(&self, slug: &str) -> Option<crate::receipt::Hint> {
        let slug_quoted = serde_json::to_string(slug).ok()?;
        if let Some(hint) = self.signs_out_hint(&slug_quoted) {
            return Some(hint);
        }
        let marker = self.marker_line()?;
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
            text: format!("▸ login: block {slug_quoted} is a likely login block with runtime inputs {}.\n  Confirm it signs in; then, to replay it whenever its first screen appears, add to .qaren/config.yaml:\n    loginBlock: {config_slug}\n    loginMarker:\n      {marker}\n  Every run then needs {envs} set.", self.inputs.join(", ")),
        })
    }

    pub fn config_hint(
        &self,
        slug: &str,
        configured: Option<&crate::config::LoginMarker>,
    ) -> Option<crate::receipt::Hint> {
        let slug_quoted = serde_json::to_string(slug).ok()?;
        if let Some(hint) = self.signs_out_hint(&slug_quoted) {
            return Some(hint);
        }
        if self.inputs.is_empty() {
            return Some(crate::receipt::Hint {
                code: "LOGIN_BLOCK_NO_INPUTS".into(),
                text: format!("▸ login: loginBlock {slug_quoted} fills no runtime inputs, so login recovery replays it without credentials.\n  Re-save it from a `### Sign in` block that fills `input USERNAME` and `input PASSWORD`."),
            });
        }
        if configured.is_some_and(|marker| {
            self.marker
                .as_ref()
                .is_some_and(|first| marker.id == first.id && marker.text == first.text)
        }) {
            return None;
        }
        let text = match self.marker_line() {
            Some(marker) => format!("▸ login: loginMarker is not the first selector of loginBlock {slug_quoted}. Make sure this marker is\n  visible only on the sign-in screen. The block's first selector is:\n    loginMarker:\n      {marker}"),
            None => format!("▸ login: loginBlock {slug_quoted} has no first-screen testID or label to compare with loginMarker.\n  Make sure this marker is visible only on the sign-in screen."),
        };
        Some(crate::receipt::Hint {
            code: "LOGIN_MARKER_MISMATCH".into(),
            text,
        })
    }

    fn signs_out_hint(&self, slug_quoted: &str) -> Option<crate::receipt::Hint> {
        let step = self.signs_out_at?;
        Some(crate::receipt::Hint {
            code: "LOGIN_BLOCK_SIGNS_OUT".into(),
            text: format!("▸ login: block {slug_quoted} signs out (step {step}) before it signs in, so it starts signed in.\n  Login recovery replays a block from the sign-in screen: move the sign-out steps into\n  their own block above it and start the sign-in block on the sign-in screen."),
        })
    }

    fn marker_line(&self) -> Option<String> {
        let marker = self.marker.as_ref()?;
        let (key, value) = marker
            .id
            .as_ref()
            .map(|id| ("id", id))
            .or_else(|| marker.text.as_ref().map(|text| ("text", text)))?;
        Some(format!("{key}: {}", serde_json::to_string(value).ok()?))
    }
}

pub fn login_hint(
    runner: &mut dyn Runner,
    app_root: &Path,
    slug: &str,
    platform: &str,
    config: &crate::config::CheckConfig,
    kept: bool,
) -> Option<crate::receipt::Hint> {
    let text = show_for(runner, app_root, slug, platform, &config.app_id)?;
    let slug_quoted = serde_json::to_string(slug).ok()?;
    match config.login_block.as_deref() {
        Some(block) if block == slug => {
            login_block(&text)?.config_hint(slug, config.login_marker.as_ref())
        }
        Some(_) => login_candidate(&text)?.signs_out_hint(&slug_quoted),
        None if kept => login_candidate(&text)?.hint(slug),
        None => {
            let candidate = login_candidate(&text)?;
            candidate.signs_out_hint(&slug_quoted).or_else(|| Some(crate::receipt::Hint {
                code: "LOGIN_BLOCK_RUN_ONLY".into(),
                text: format!("▸ login: block {slug_quoted} is a likely login block, but it was saved only to this PR run's evidence.\n  To reuse it, save it with `qaren check` in the main copy, then configure loginBlock and\n  loginMarker from that run's hint."),
            }))
        }
    }
}

pub fn show_for(
    runner: &mut dyn Runner,
    app_root: &Path,
    slug: &str,
    platform: &str,
    app_id: &str,
) -> Option<String> {
    let text = show(runner, app_root, slug).ok()?;
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
        assert!(login_candidate(
            &block("# 1. Fill email\n- tapOn: { text: Email }\n- inputText: { input: OTP, sensitivity: non-secret }\n")
                .replace("# intent: Sign in", "# intent: Reach the dashboard")
        )
        .is_none());
    }

    #[test]
    fn non_secret_inputs_join_the_inventory_but_not_strict_candidacy() {
        let mixed = login_candidate(&block("# 1. Fill email\n- tapOn: { id: email }\n- inputText: { input: EMAIL, sensitivity: \"non-secret\" }\n# 2. Fill password\n- tapOn: { id: password }\n- inputText: { input: PASSWORD }\n")).unwrap();
        assert_eq!(mixed.inputs, ["EMAIL", "PASSWORD"]);
        let hint = mixed.hint("sign-in").unwrap().text;
        assert!(hint.contains("runtime inputs EMAIL, PASSWORD"), "{hint}");
        assert!(
            hint.contains("QAREN_INPUT_EMAIL and QAREN_INPUT_PASSWORD set"),
            "{hint}"
        );
        let demo = login_block(&block("# 1. Fill user\n- tapOn: { id: login-user }\n- inputText: { input: USERNAME, sensitivity: \"non-secret\" }\n")).unwrap();
        assert_eq!(demo.inputs, ["USERNAME"]);
        let marker =
            serde_yaml::from_str::<crate::config::LoginMarker>("id: login-user\n").unwrap();
        assert!(demo.config_hint("sign-in", Some(&marker)).is_none());
        let navigated = block("# 1. Tap \"Account\"\n- tapOn: { text: Account }\n# 2. Fill user\n- tapOn: { id: login-user }\n- inputText: { input: USERNAME, sensitivity: \"non-secret\" }\n# 3. Fill password\n- tapOn: { id: password }\n- inputText: { input: PASSWORD }\n")
            .replace("# intent: Sign in", "# intent: Open account");
        assert!(login_candidate(&navigated).is_none());
        let first_strict =
            block("# 1. Fill code\n- tapOn: { id: code }\n- inputText: { input: CODE }\n")
                .replace("# intent: Sign in", "# intent: Unlock");
        assert!(login_candidate(&first_strict).is_some());
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
    fn login_candidates_need_a_sign_in_title_or_a_fill_on_the_starting_screen() {
        let titled = |intent: &str, commands: &str| {
            block(commands).replace("# intent: Sign in", &format!("# intent: {intent}"))
        };
        let change_password = titled(
            "Change password",
            "# 1. Tap \"Settings\"\n- tapOn: { text: Settings }\n# 2. Fill \"New password\" with input NEW_PASSWORD\n- tapOn: { id: new-password }\n- inputText: { input: NEW_PASSWORD }\n",
        );
        assert!(login_candidate(&change_password).is_none());
        assert_eq!(
            login_block(&change_password).unwrap().inputs,
            ["NEW_PASSWORD"]
        );
        for intent in [
            "Sign in",
            "Log in as admin",
            "Login",
            "Authenticate the user",
        ] {
            assert!(login_candidate(&titled(intent, "# 1. Open account\n- tapOn: { text: Account }\n# 2. Fill email\n- tapOn: { id: email }\n- inputText: { input: USERNAME }\n")).is_some(), "{intent}");
        }
        let fill_first = titled(
            "Reach the dashboard",
            "# 1. Wait for \"Email\"\n- extendedWaitUntil: { visible: { text: Email }, timeout: 15000 }\n# 2. Fill \"Email\" with input USERNAME\n- tapOn: { text: Email }\n- inputText: { input: USERNAME }\n# 3. Tap \"Continue\"\n- tapOn: { text: Continue }\n",
        );
        let candidate = login_candidate(&fill_first).unwrap();
        assert_eq!(candidate.marker.unwrap().text.as_deref(), Some("Email"));
        let hint = login_candidate(&block(
            "# 1. Fill email\n- tapOn: { id: email }\n- inputText: { input: USERNAME }\n",
        ))
        .unwrap()
        .hint("sign-in")
        .unwrap();
        assert!(
            hint.text.contains("is a likely login block"),
            "{}",
            hint.text
        );
        assert!(hint.text.contains("Confirm it signs in"), "{}", hint.text);
    }

    #[test]
    fn configured_login_blocks_need_a_matching_marker_and_runtime_inputs() {
        let saved = login_block(&block(
            "# 1. Fill email\n- tapOn: { id: login-email }\n- inputText: { input: USERNAME }\n",
        ))
        .unwrap();
        let marker = |yaml: &str| serde_yaml::from_str::<crate::config::LoginMarker>(yaml).unwrap();
        assert!(saved
            .config_hint("sign-in", Some(&marker("id: login-email\n")))
            .is_none());
        for configured in [
            Some(marker("id: home-tab\n")),
            Some(marker("text: login-email\n")),
            None,
        ] {
            let hint = saved.config_hint("sign-in", configured.as_ref()).unwrap();
            assert_eq!(hint.code, "LOGIN_MARKER_MISMATCH");
            assert!(
                hint.text
                    .ends_with("loginMarker:\n      id: \"login-email\""),
                "{}",
                hint.text
            );
            assert!(
                hint.text
                    .contains("Make sure this marker is\n  visible only on the sign-in screen"),
                "{}",
                hint.text
            );
            assert!(!hint.text.contains("never"), "{}", hint.text);
        }
        let hint = login_block(&block(
            "# 1. Fill email\n- tapOn: { id: login-email }\n- inputText: \"someone\"\n",
        ))
        .unwrap()
        .config_hint("sign-in", Some(&marker("id: login-email\n")))
        .unwrap();
        assert_eq!(hint.code, "LOGIN_BLOCK_NO_INPUTS");
        assert!(!hint.text.contains("someone"));
    }

    #[test]
    fn only_sign_out_presses_flag_the_block_not_checks_waits_or_fills() {
        let fill = "# 2. Fill email\n- tapOn: { id: email }\n- inputText: { input: USERNAME }\n";
        for first in [
            "# 1. Check \"Log out\" is not visible\n",
            "# 1. Check \"Log out\" is visible\n- assertVisible: { text: \"Log out\" }\n",
            "# 1. Wait for \"Sign out\"\n- extendedWaitUntil: { visible: { text: \"Sign out\" }, timeout: 15000 }\n",
            "# 1. Scroll down until \"Logout\" is visible\n- scrollUntilVisible: { element: { id: logout }, direction: DOWN }\n",
        ] {
            let candidate = login_candidate(&block(&format!("{first}{fill}"))).unwrap();
            assert_eq!(candidate.signs_out_at, None, "{first}");
            assert_eq!(candidate.hint("sign-in").unwrap().code, "LOGIN_BLOCK_CANDIDATE");
        }
        let sign_out_reason = login_block(&block("# 1. Fill \"Sign out reason\" with input REASON\n- tapOn: { id: sign-out-reason }\n- inputText: { input: REASON }\n")).unwrap();
        assert_eq!(sign_out_reason.signs_out_at, None);
        let tapped = login_candidate(&block(&format!(
            "# 1. Check \"Log out\" is visible\n- assertVisible: {{ text: \"Log out\" }}\n# 2. Tap \"Log out\"\n- tapOn: {{ text: \"Log out\" }}\n{}",
            fill.replace("# 2.", "# 3.")
        )))
        .unwrap();
        assert_eq!(tapped.signs_out_at, Some(2));
        assert_eq!(
            tapped.hint("sign-in").unwrap().code,
            "LOGIN_BLOCK_SIGNS_OUT"
        );
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
