use crate::candidate::Candidate;
use crate::exec::{CmdSpec, Runner};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const PLATFORMS: [&str; 2] = ["ios", "android"];
const MAX_VARIANTS: u32 = 99;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Saved,
    Unchanged,
    NotSaved,
    Flagged,
    Cleared,
    NotMarked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeOutcome {
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl RecipeOutcome {
    fn at(outcome: Outcome, path: &Path) -> Self {
        RecipeOutcome {
            outcome,
            path: Some(path.to_path_buf()),
            reason: None,
        }
    }

    fn because(outcome: Outcome, reason: &str) -> Self {
        RecipeOutcome {
            outcome,
            path: None,
            reason: Some(reason.to_string()),
        }
    }

    pub fn render(&self) -> String {
        let outcome = serde_json::to_value(self.outcome)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default();
        let detail = match (&self.path, &self.reason) {
            (Some(path), _) => path.display().to_string(),
            (None, Some(reason)) => reason.clone(),
            (None, None) => String::new(),
        };
        format!("{outcome} {detail}").trim_end().to_string()
    }
}

// The core's privacy-checked canonical copy of a fully passing plan, or why it has none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RecipeCandidate {
    Markdown { slug: String, markdown: String },
    Unsavable { unsavable: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanEntry {
    pub file: String,
    pub title: Option<String>,
    pub blocks: Vec<String>,
    pub broken: Vec<String>,
}

pub fn plans_dir(app_root: &Path) -> Result<PathBuf, String> {
    let qaren = app_root.join(".qaren");
    let dir = qaren.join("plans");
    for path in [&qaren, &dir] {
        match std::fs::symlink_metadata(path) {
            Ok(meta) if !meta.is_dir() => {
                return Err(format!(
                    "refusing {} (a symlink or not a directory)",
                    path.display()
                ))
            }
            Ok(_) | Err(_) => {}
        }
    }
    Ok(dir)
}

pub fn in_book(app_root: &Path, plan_file: &Path) -> bool {
    let Some(dir) = plans_dir(app_root)
        .ok()
        .and_then(|dir| dir.canonicalize().ok())
    else {
        return false;
    };
    std::fs::symlink_metadata(plan_file).is_ok_and(|meta| meta.is_file())
        && plan_file
            .parent()
            .and_then(|parent| parent.canonicalize().ok())
            .is_some_and(|parent| parent == dir)
}

fn read_regular(path: &Path) -> Option<String> {
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    if !file.metadata().is_ok_and(|meta| meta.is_file()) {
        return None;
    }
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    Some(text)
}

fn marker(platform: &str) -> String {
    format!("<!-- qaren:broken {platform} -->")
}

const BARE_MARKER: &str = "<!-- qaren:broken -->";

fn broken(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    PLATFORMS
        .iter()
        .filter(|platform| {
            lines
                .iter()
                .any(|line| *line == BARE_MARKER || *line == marker(platform))
        })
        .map(|platform| platform.to_string())
        .collect()
}

pub(crate) fn unmarked(text: &str) -> String {
    text.split_inclusive('\n')
        .filter(|line| {
            let line = line.trim();
            line != BARE_MARKER && PLATFORMS.iter().all(|platform| line != marker(platform))
        })
        .collect()
}

// Strips HTML comments, carrying an open one across lines, as the plan parser does.
fn visible_lines(text: &str) -> Vec<String> {
    let mut open = false;
    text.lines()
        .map(|line| {
            let mut rest = line;
            let mut out = String::new();
            loop {
                if open {
                    let Some(close) = rest.find("-->") else { break };
                    open = false;
                    rest = &rest[close + 3..];
                } else if let Some(start) = rest.find("<!--") {
                    out.push_str(&rest[..start]);
                    open = true;
                    rest = &rest[start + 4..];
                } else {
                    out.push_str(rest);
                    break;
                }
            }
            out.trim().to_string()
        })
        .collect()
}

fn heading<'a>(line: &'a str, hashes: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(hashes)?;
    rest.starts_with(char::is_whitespace).then(|| rest.trim())
}

// A numbered step or a check: the lines that open the parser's unnamed block before any `###`.
fn step_line(line: &str) -> bool {
    let digits = line.trim_start_matches(|c: char| c.is_ascii_digit());
    let numbered = digits.len() < line.len()
        && digits
            .strip_prefix(['.', ')'])
            .is_some_and(|rest| rest.starts_with(char::is_whitespace));
    let check = line
        .trim_start_matches(['-', '*'])
        .trim_start()
        .starts_with(['✓', '✔']);
    numbered || check
}

pub fn list(app_root: &Path) -> Result<Vec<PlanEntry>, String> {
    let dir = plans_dir(app_root)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("cannot read {}: {e}", dir.display())),
    };
    let mut plans = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|e| format!("cannot read {}: {e}", dir.display()))?
            .path();
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.starts_with('.') || path.extension().is_none_or(|ext| ext != "md") {
            continue;
        }
        let Some(text) = read_regular(&path) else {
            continue;
        };
        let visible = visible_lines(&text);
        let section = match visible
            .iter()
            .position(|line| heading(line, "##").is_some_and(|t| t.eq_ignore_ascii_case("qa")))
        {
            Some(qa) => {
                let rest = &visible[qa + 1..];
                let end = rest
                    .iter()
                    .position(|line| heading(line, "##").is_some())
                    .unwrap_or(rest.len());
                &rest[..end]
            }
            None => &visible[..],
        };
        let title = visible
            .iter()
            .find_map(|line| heading(line, "#"))
            .map(str::to_string);
        let unnamed = section
            .iter()
            .take_while(|line| heading(line, "###").is_none())
            .any(|line| step_line(line));
        plans.push(PlanEntry {
            file: format!(".qaren/plans/{name}"),
            blocks: unnamed
                .then(|| title.clone().unwrap_or_else(|| "plan".to_string()))
                .into_iter()
                .chain(
                    section
                        .iter()
                        .filter_map(|line| heading(line, "###"))
                        .map(str::to_string),
                )
                .collect(),
            title,
            broken: broken(&text),
        });
    }
    plans.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(plans)
}

pub fn render(plans: &[PlanEntry]) -> String {
    let cell = |values: &[String]| {
        if values.is_empty() {
            "-".to_string()
        } else {
            values.join(", ")
        }
    };
    plans
        .iter()
        .map(|plan| {
            format!(
                "{}\t{}\t{}\t{}\n",
                plan.file,
                plan.title.as_deref().unwrap_or("-"),
                cell(&plan.blocks),
                cell(&plan.broken)
            )
        })
        .collect()
}

fn temp_path(dir: &Path, stem: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    dir.join(format!(
        ".{stem}.{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

fn write_new(path: &Path, bytes: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes.as_bytes())?;
    file.sync_all()
}

fn valid_slug(slug: &str) -> bool {
    slug.len() <= 64
        && slug
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

// Exclusive create through a hard link, so a reader never sees a partial file and an existing plan is never replaced.
pub fn save(app_root: &Path, slug: &str, markdown: &str) -> RecipeOutcome {
    if !valid_slug(slug) {
        return RecipeOutcome::because(Outcome::NotSaved, "invalid plan name");
    }
    let Ok(dir) = plans_dir(app_root) else {
        return RecipeOutcome::because(Outcome::NotSaved, "unsafe .qaren/plans");
    };
    if std::fs::create_dir_all(&dir).is_err() || plans_dir(app_root).is_err() {
        return RecipeOutcome::because(Outcome::NotSaved, "unsafe .qaren/plans");
    }
    let temp = temp_path(&dir, slug);
    if write_new(&temp, markdown).is_err() {
        let _ = std::fs::remove_file(&temp);
        return RecipeOutcome::because(Outcome::NotSaved, "could not write");
    }
    let outcome = (1..=MAX_VARIANTS)
        .find_map(|n| {
            let target = if n == 1 {
                dir.join(format!("{slug}.md"))
            } else {
                dir.join(format!("{slug}-{n}.md"))
            };
            match std::fs::hard_link(&temp, &target) {
                Ok(()) => Some(RecipeOutcome::at(Outcome::Saved, &target)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => read_regular(&target)
                    .is_some_and(|existing| unmarked(&existing) == markdown)
                    .then(|| RecipeOutcome::at(Outcome::Unchanged, &target)),
                Err(_) => Some(RecipeOutcome::because(Outcome::NotSaved, "could not write")),
            }
        })
        .unwrap_or_else(|| RecipeOutcome::because(Outcome::NotSaved, "too many variants"));
    let _ = std::fs::remove_file(&temp);
    outcome
}

fn with_marker(text: &str, platform: &str) -> String {
    let line = marker(platform);
    if text.lines().any(|existing| existing.trim() == line) {
        text.to_string()
    } else {
        format!("{line}\n{text}")
    }
}

// A bare marker is the user's to remove; only this platform's marker is cleared.
fn without_marker(text: &str, platform: &str) -> String {
    let line = marker(platform);
    text.split_inclusive('\n')
        .filter(|existing| existing.trim() != line)
        .collect()
}

// Applies one platform's marker edit to the current bytes, under a lock on the plans directory,
// so concurrent iOS and Android runs keep both markers; any non-marker change since intake refuses.
fn update(
    path: &Path,
    platform: &str,
    preimage: &str,
    edit: fn(&str, &str) -> String,
    outcome: Outcome,
) -> RecipeOutcome {
    let Some(dir) = path.parent() else {
        return RecipeOutcome::because(Outcome::NotMarked, "could not write");
    };
    let Ok(lock) = std::fs::File::open(dir) else {
        return RecipeOutcome::because(Outcome::NotMarked, "could not write");
    };
    if unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&lock), libc::LOCK_EX) } != 0 {
        return RecipeOutcome::because(Outcome::NotMarked, "could not write");
    }
    let Some(current) =
        read_regular(path).filter(|current| unmarked(current) == unmarked(preimage))
    else {
        return RecipeOutcome::because(Outcome::NotMarked, "changed during the run");
    };
    let next = edit(&current, platform);
    if next == current {
        return RecipeOutcome::at(Outcome::Unchanged, path);
    }
    let stem = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = temp_path(dir, &stem);
    let replaced = write_new(&temp, &next)
        .and_then(|()| std::fs::set_permissions(&temp, std::fs::metadata(path)?.permissions()))
        .and_then(|()| std::fs::rename(&temp, path));
    if replaced.is_err() {
        let _ = std::fs::remove_file(&temp);
        return RecipeOutcome::because(Outcome::NotMarked, "could not write");
    }
    RecipeOutcome::at(outcome, path)
}

pub fn flag(path: &Path, platform: &str, preimage: &str) -> RecipeOutcome {
    update(path, platform, preimage, with_marker, Outcome::Flagged)
}

pub fn clear(path: &Path, platform: &str, preimage: &str) -> RecipeOutcome {
    update(path, platform, preimage, without_marker, Outcome::Cleared)
}

// The run tested the default branch itself: no local change and HEAD at origin's default-branch commit.
pub fn base_identity(runner: &mut dyn Runner, candidate: &Candidate) -> Result<(), &'static str> {
    if candidate.git_dirty {
        return Err("local changes");
    }
    let base = runner.run(&CmdSpec::new(
        "git-default-branch",
        "git",
        &[
            "-C",
            &candidate.repo_root.to_string_lossy(),
            "rev-parse",
            "--verify",
            "--quiet",
            "refs/remotes/origin/HEAD^{commit}",
        ],
        30,
    ));
    if !base.ok() || base.stdout.trim().is_empty() {
        return Err("default branch unknown");
    }
    if base.stdout.trim() != candidate.git_sha {
        return Err("not the default-branch commit");
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Walk {
    Pass,
    // A genuine step failure: the core judged a plan step FAIL, the candidate held and the run was not cancelled.
    StepFailure,
    // Any other FAIL with the candidate held and the run not cancelled.
    OtherFailure,
    Other,
}

pub struct RunFacts<'a> {
    pub pr: bool,
    pub save_plans: bool,
    pub in_book: bool,
    pub walk: Walk,
    pub recipe: Option<&'a RecipeCandidate>,
    pub has_input_values: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision<'a> {
    Nothing,
    Report(RecipeOutcome),
    Save { slug: &'a str, markdown: &'a str },
    Mark { broken: bool },
}

pub fn decide<'a>(
    facts: &RunFacts<'a>,
    base: impl FnOnce() -> Result<(), &'static str>,
) -> Decision<'a> {
    if facts.walk == Walk::Other {
        return Decision::Nothing;
    }
    if facts.pr {
        return match facts.walk {
            Walk::Pass => Decision::Report(RecipeOutcome::because(
                Outcome::NotSaved,
                "pull request run",
            )),
            _ => Decision::Nothing,
        };
    }
    if facts.in_book {
        if !facts.save_plans {
            return Decision::Report(RecipeOutcome::because(Outcome::NotMarked, "disabled"));
        }
        return match base() {
            Err(reason) => Decision::Report(RecipeOutcome::because(Outcome::NotMarked, reason)),
            Ok(()) if facts.walk == Walk::OtherFailure => Decision::Report(RecipeOutcome::because(
                Outcome::NotMarked,
                "not a definite step failure",
            )),
            Ok(()) => Decision::Mark {
                broken: facts.walk == Walk::StepFailure,
            },
        };
    }
    if facts.walk != Walk::Pass {
        return Decision::Nothing;
    }
    if !facts.save_plans {
        return Decision::Report(RecipeOutcome::because(Outcome::NotSaved, "disabled"));
    }
    match facts.recipe {
        None => Decision::Nothing,
        Some(RecipeCandidate::Unsavable { unsavable }) => {
            Decision::Report(RecipeOutcome::because(Outcome::NotSaved, unsavable))
        }
        Some(RecipeCandidate::Markdown { .. }) if facts.has_input_values => Decision::Report(
            RecipeOutcome::because(Outcome::NotSaved, "contains a runtime input value"),
        ),
        Some(RecipeCandidate::Markdown { slug, markdown }) => Decision::Save { slug, markdown },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner};

    const PLAN: &str = "# Add a task\n\n## QA\n\n### Add one\n1. Tap \"Add\"\n";

    fn app(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("qaren-recipes-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".qaren/plans")).unwrap();
        root
    }

    fn recipe(app: &Path, name: &str, text: &str) -> PathBuf {
        let path = app.join(".qaren/plans").join(name);
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn flag_inserts_one_marker_line_and_is_idempotent() {
        let app = app("flag");
        let path = recipe(&app, "x.md", PLAN);
        assert_eq!(flag(&path, "ios", PLAN).outcome, Outcome::Flagged);
        let flagged = std::fs::read_to_string(&path).unwrap();
        assert_eq!(flagged, format!("<!-- qaren:broken ios -->\n{PLAN}"));
        assert_eq!(flag(&path, "ios", &flagged).outcome, Outcome::Unchanged);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), flagged);
    }

    #[test]
    fn clear_removes_only_that_platform_and_never_a_bare_marker() {
        let app = app("clear");
        let text = format!(
            "<!-- qaren:broken android -->\n<!-- qaren:broken ios -->\n<!-- qaren:broken -->\n{PLAN}"
        );
        let path = recipe(&app, "x.md", &text);
        assert_eq!(clear(&path, "ios", &text).outcome, Outcome::Cleared);
        let cleared = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            cleared,
            format!("<!-- qaren:broken android -->\n<!-- qaren:broken -->\n{PLAN}")
        );
        assert_eq!(clear(&path, "ios", &cleared).outcome, Outcome::Unchanged);
    }

    #[test]
    fn concurrent_platform_flags_keep_both_markers() {
        let app = app("both-platforms");
        let path = recipe(&app, "x.md", PLAN);
        let threads: Vec<_> = ["ios", "android", "ios", "android"]
            .into_iter()
            .map(|platform| {
                let path = path.clone();
                std::thread::spawn(move || flag(&path, platform, PLAN).outcome)
            })
            .collect();
        for thread in threads {
            assert_ne!(thread.join().unwrap(), Outcome::NotMarked);
        }
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            broken(&text),
            vec!["ios".to_string(), "android".to_string()]
        );
        assert_eq!(unmarked(&text), PLAN);
    }

    #[test]
    fn another_runs_marker_since_intake_does_not_block_this_platform() {
        let app = app("marker-since-intake");
        let android = format!("<!-- qaren:broken android -->\n{PLAN}");
        let path = recipe(&app, "x.md", &android);
        assert_eq!(flag(&path, "ios", PLAN).outcome, Outcome::Flagged);
        let both = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            broken(&both),
            vec!["ios".to_string(), "android".to_string()]
        );
        assert_eq!(clear(&path, "android", PLAN).outcome, Outcome::Cleared);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("<!-- qaren:broken ios -->\n{PLAN}")
        );
    }

    #[test]
    fn a_recipe_edited_during_the_run_is_not_marked() {
        let app = app("preimage");
        let path = recipe(&app, "x.md", "# Edited\n");
        assert_eq!(
            flag(&path, "ios", PLAN),
            RecipeOutcome::because(Outcome::NotMarked, "changed during the run")
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Edited\n");
        assert_eq!(
            std::fs::read_dir(app.join(".qaren/plans")).unwrap().count(),
            1
        );
    }

    #[test]
    fn listing_reads_titles_blocks_and_broken_platforms_and_skips_symlinks() {
        let app = app("list");
        recipe(
            &app,
            "b.md",
            &format!("<!-- qaren:broken android -->\n{PLAN}### Check\n✓ \"Done\"\n"),
        );
        recipe(&app, "a.md", &format!("<!-- qaren:broken -->\n{PLAN}"));
        recipe(&app, "notes.txt", PLAN);
        std::os::unix::fs::symlink(app.join(".qaren/plans/a.md"), app.join(".qaren/plans/c.md"))
            .unwrap();
        let plans = list(&app).unwrap();
        assert_eq!(
            plans,
            vec![
                PlanEntry {
                    file: ".qaren/plans/a.md".into(),
                    title: Some("Add a task".into()),
                    blocks: vec!["Add one".into()],
                    broken: vec!["ios".into(), "android".into()],
                },
                PlanEntry {
                    file: ".qaren/plans/b.md".into(),
                    title: Some("Add a task".into()),
                    blocks: vec!["Add one".into(), "Check".into()],
                    broken: vec!["android".into()],
                },
            ]
        );
        assert_eq!(
            render(&plans[1..]),
            ".qaren/plans/b.md\tAdd a task\tAdd one, Check\tandroid\n"
        );
    }

    #[test]
    fn listing_ignores_headings_inside_html_comments() {
        let app = app("list-comments");
        recipe(
            &app,
            "x.md",
            "<!-- qaren:broken ios -->\n<!--\n# Old journey\n### Old block\n-->\n# Real <!-- note -->\n\n## QA\n\n<!-- ### Hidden -->\n### Block\n1. Tap \"Add\"\n",
        );
        assert_eq!(
            list(&app).unwrap(),
            vec![PlanEntry {
                file: ".qaren/plans/x.md".into(),
                title: Some("Real".into()),
                blocks: vec!["Block".into()],
                broken: vec!["ios".into()],
            }]
        );
    }

    #[test]
    fn listing_reads_blocks_only_from_the_qa_section_when_present() {
        let app = app("list-section");
        recipe(
            &app,
            "x.md",
            "# Tasks\n\n### Setup\n\n## qa\n\n###\tAdd one\n1. Tap \"Add\"\n\n## Notes\n\n### Follow-ups\n",
        );
        recipe(
            &app,
            "y.md",
            "# Loose\n\n### First\n1. Tap \"Add\"\n\n## Notes\n\n### Second\n",
        );
        assert_eq!(
            list(&app).unwrap(),
            vec![
                PlanEntry {
                    file: ".qaren/plans/x.md".into(),
                    title: Some("Tasks".into()),
                    blocks: vec!["Add one".into()],
                    broken: vec![],
                },
                PlanEntry {
                    file: ".qaren/plans/y.md".into(),
                    title: Some("Loose".into()),
                    blocks: vec!["First".into(), "Second".into()],
                    broken: vec![],
                },
            ]
        );
    }

    #[test]
    fn listing_names_headingless_blocks_and_tab_titles_like_the_parser() {
        let app = app("list-unnamed");
        recipe(&app, "a.md", "# Login\n\n## QA\n\n1. Tap \"Sign in\"\n");
        recipe(
            &app,
            "b.md",
            "#\tLogin\n1. Tap \"Sign in\"\n✓ \"Welcome\"\n",
        );
        recipe(&app, "c.md", "1. Tap \"Sign in\"\n");
        recipe(
            &app,
            "d.md",
            "# Tasks\n## QA\nstarts on: \"Home\"\n1. Tap \"Tasks\"\n### Add one\n1. Tap \"Add\"\n",
        );
        recipe(
            &app,
            "e.md",
            "# Tasks\n## QA\nstarts on: \"Home\"\n### Add one\n1. Tap \"Add\"\n",
        );
        let listed: Vec<_> = list(&app)
            .unwrap()
            .into_iter()
            .map(|plan| (plan.title, plan.blocks))
            .collect();
        let some = |title: &str| Some(title.to_string());
        assert_eq!(
            listed,
            vec![
                (some("Login"), vec!["Login".to_string()]),
                (some("Login"), vec!["Login".to_string()]),
                (None, vec!["plan".to_string()]),
                (
                    some("Tasks"),
                    vec!["Tasks".to_string(), "Add one".to_string()]
                ),
                (some("Tasks"), vec!["Add one".to_string()]),
            ]
        );
    }

    #[test]
    fn listing_skips_a_file_that_is_not_utf8() {
        let app = app("list-latin1");
        recipe(&app, "a.md", PLAN);
        std::fs::write(
            app.join(".qaren/plans/b.md"),
            b"# Caf\xe9\n1. Tap \"Add\"\n",
        )
        .unwrap();
        assert_eq!(
            list(&app).unwrap(),
            vec![PlanEntry {
                file: ".qaren/plans/a.md".into(),
                title: Some("Add a task".into()),
                blocks: vec!["Add one".into()],
                broken: vec![],
            }]
        );
    }

    #[test]
    fn listing_refuses_a_symlinked_plans_directory() {
        let app = app("list-link");
        std::fs::remove_dir(app.join(".qaren/plans")).unwrap();
        std::os::unix::fs::symlink(std::env::temp_dir(), app.join(".qaren/plans")).unwrap();
        assert!(list(&app).is_err());
        assert!(!in_book(&app, &app.join(".qaren/plans/x.md")));
    }

    #[test]
    fn save_creates_reuses_identical_bytes_and_numbers_variants() {
        let app = app("save");
        let first = save(&app, "add-a-task", PLAN);
        assert_eq!(first.outcome, Outcome::Saved);
        let path = app.join(".qaren/plans/add-a-task.md");
        assert_eq!(first.path.as_deref(), Some(path.as_path()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), PLAN);
        assert!(in_book(&app, &path));
        assert_eq!(
            save(&app, "add-a-task", PLAN),
            RecipeOutcome::at(Outcome::Unchanged, &path)
        );
        let other = format!("{PLAN}✓ \"Added\"\n");
        assert_eq!(
            save(&app, "add-a-task", &other),
            RecipeOutcome::at(Outcome::Saved, &app.join(".qaren/plans/add-a-task-2.md"))
        );
        assert_eq!(save(&app, "add-a-task", &other).outcome, Outcome::Unchanged);
        assert_eq!(
            std::fs::read_dir(app.join(".qaren/plans")).unwrap().count(),
            2
        );
        assert_eq!(save(&app, "../escape", PLAN).outcome, Outcome::NotSaved);
    }

    #[test]
    fn save_treats_a_flagged_copy_of_the_same_plan_as_unchanged() {
        let app = app("save-flagged");
        let path = app.join(".qaren/plans/add-a-task.md");
        assert_eq!(save(&app, "add-a-task", PLAN).outcome, Outcome::Saved);
        assert_eq!(flag(&path, "android", PLAN).outcome, Outcome::Flagged);
        let flagged = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            save(&app, "add-a-task", PLAN),
            RecipeOutcome::at(Outcome::Unchanged, &path)
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), flagged);
        assert!(!app.join(".qaren/plans/add-a-task-2.md").exists());
    }

    #[test]
    fn save_refuses_a_symlinked_plans_directory() {
        let app = app("save-link");
        let elsewhere = app.join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::remove_dir(app.join(".qaren/plans")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, app.join(".qaren/plans")).unwrap();
        assert_eq!(
            save(&app, "x", PLAN),
            RecipeOutcome::because(Outcome::NotSaved, "unsafe .qaren/plans")
        );
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
    }

    #[test]
    fn concurrent_saves_of_one_recipe_leave_one_file() {
        let app = app("race");
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let app = app.clone();
                std::thread::spawn(move || save(&app, "x", PLAN).outcome)
            })
            .collect();
        let outcomes: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(outcomes.iter().filter(|o| **o == Outcome::Saved).count(), 1);
        let names: Vec<_> = std::fs::read_dir(app.join(".qaren/plans"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("x.md")]);
    }

    fn candidate(dirty: bool) -> Candidate {
        Candidate {
            repo_root: PathBuf::from("/repo"),
            project_root: PathBuf::from("/repo"),
            app_id: "com.example".into(),
            git_sha: "abc123".into(),
            git_dirty: dirty,
            lockfile_sha256: None,
            worktree_fingerprint: None,
        }
    }

    #[test]
    fn base_identity_requires_a_clean_tree_at_the_default_branch_commit() {
        let mut runner = MockRunner::new();
        assert_eq!(
            base_identity(&mut runner, &candidate(true)),
            Err("local changes")
        );
        runner.expect_run("origin/HEAD", CmdOutput::failed(1, ""));
        assert_eq!(
            base_identity(&mut runner, &candidate(false)),
            Err("default branch unknown")
        );
        runner.expect_run("origin/HEAD", CmdOutput::success("def456\n"));
        assert_eq!(
            base_identity(&mut runner, &candidate(false)),
            Err("not the default-branch commit")
        );
        runner.expect_run("origin/HEAD", CmdOutput::success("abc123\n"));
        assert_eq!(base_identity(&mut runner, &candidate(false)), Ok(()));
        assert_eq!(runner.calls.len(), 3);
    }

    #[test]
    fn decision_table() {
        let saved = RecipeCandidate::Markdown {
            slug: "x".into(),
            markdown: PLAN.into(),
        };
        let private = RecipeCandidate::Unsavable {
            unsavable: "line 3: fills a private input".into(),
        };
        let facts = |pr, save_plans, in_book, walk, recipe, has_input_values| RunFacts {
            pr,
            save_plans,
            in_book,
            walk,
            recipe,
            has_input_values,
        };
        let not_saved =
            |reason: &str| Decision::Report(RecipeOutcome::because(Outcome::NotSaved, reason));
        let not_marked =
            |reason: &str| Decision::Report(RecipeOutcome::because(Outcome::NotMarked, reason));
        let on_base = || Ok(());
        let ahead = || Err("not the default-branch commit");
        let unused = || -> Result<(), &'static str> { panic!("base resolved needlessly") };
        use Walk::*;
        let cases = [
            (
                facts(false, true, false, Pass, Some(&saved), false),
                Decision::Save {
                    slug: "x",
                    markdown: PLAN,
                },
            ),
            (
                facts(true, true, false, Pass, Some(&saved), false),
                not_saved("pull request run"),
            ),
            (
                facts(true, true, true, StepFailure, None, false),
                Decision::Nothing,
            ),
            (
                facts(false, false, false, Pass, Some(&saved), false),
                not_saved("disabled"),
            ),
            (
                facts(false, true, false, StepFailure, None, false),
                Decision::Nothing,
            ),
            (
                facts(false, true, false, Other, None, false),
                Decision::Nothing,
            ),
            (
                facts(false, true, false, OtherFailure, None, false),
                Decision::Nothing,
            ),
            (
                facts(true, true, true, OtherFailure, None, false),
                Decision::Nothing,
            ),
            (
                facts(false, true, false, Pass, Some(&private), false),
                not_saved("line 3: fills a private input"),
            ),
            (
                facts(false, true, false, Pass, Some(&saved), true),
                not_saved("contains a runtime input value"),
            ),
            (
                facts(false, true, false, Pass, None, false),
                Decision::Nothing,
            ),
            (
                facts(false, true, true, Other, None, false),
                Decision::Nothing,
            ),
            (
                facts(false, false, true, StepFailure, None, false),
                not_marked("disabled"),
            ),
        ];
        for (facts, expected) in cases {
            assert_eq!(decide(&facts, unused), expected);
        }
        assert_eq!(
            decide(&facts(false, true, true, StepFailure, None, false), on_base),
            Decision::Mark { broken: true }
        );
        assert_eq!(
            decide(
                &facts(false, true, true, Pass, Some(&saved), false),
                on_base
            ),
            Decision::Mark { broken: false }
        );
        assert_eq!(
            decide(&facts(false, true, true, StepFailure, None, false), ahead),
            not_marked("not the default-branch commit")
        );
        assert_eq!(
            decide(
                &facts(false, true, true, OtherFailure, None, false),
                on_base
            ),
            not_marked("not a definite step failure")
        );
        assert_eq!(
            decide(&facts(false, true, true, OtherFailure, None, false), ahead),
            not_marked("not the default-branch commit")
        );
    }

    #[test]
    fn the_recipe_candidate_reads_both_wire_shapes() {
        let read = |json: &str| serde_json::from_str::<RecipeCandidate>(json).unwrap();
        assert_eq!(
            read(r##"{"slug":"x","markdown":"# X\n"}"##),
            RecipeCandidate::Markdown {
                slug: "x".into(),
                markdown: "# X\n".into()
            }
        );
        assert_eq!(
            read(r#"{"unsavable":"why"}"#),
            RecipeCandidate::Unsavable {
                unsavable: "why".into()
            }
        );
        assert_eq!(
            RecipeOutcome::because(Outcome::NotSaved, "pull request run").render(),
            "not_saved pull request run"
        );
    }
}
