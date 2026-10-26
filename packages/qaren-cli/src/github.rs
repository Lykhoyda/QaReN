use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const NEEDS_QA: &str = "needs-qa";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: u64,
    pub url: String,
    pub head_ref_oid: String,
    pub head_ref_name: String,
    pub is_cross_repository: bool,
    #[serde(default)]
    pub labels: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewJson {
    number: u64,
    url: String,
    head_ref_oid: String,
    head_ref_name: String,
    is_cross_repository: bool,
    #[serde(default)]
    labels: Vec<LabelJson>,
}

#[derive(Deserialize)]
struct LabelJson {
    name: String,
}

fn gh_failure(what: &str, detail: String) -> Failure {
    Failure::new(
        "pr",
        FailureCode::PrUnavailable,
        format!("gh {what} failed: {detail}"),
        "check `gh auth status` and the pull request, then re-run",
    )
}

pub fn pr_view(runner: &mut dyn Runner, target: &str, cwd: &Path) -> Result<PrInfo, Failure> {
    let output = runner.run(
        &CmdSpec::new(
            "gh-pr-view",
            "gh",
            &[
                "pr",
                "view",
                target,
                "--json",
                "number,url,headRefOid,headRefName,isCrossRepository,labels",
            ],
            60,
        )
        .cwd(cwd),
    );
    if !output.ok() {
        return Err(gh_failure("pr view", output.summary()));
    }
    let view: ViewJson = serde_json::from_str(output.stdout.trim())
        .map_err(|e| gh_failure("pr view", format!("unreadable JSON: {e}")))?;
    if view.head_ref_oid.len() != 40 || !view.head_ref_oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(gh_failure(
            "pr view",
            "headRefOid is not a commit sha".into(),
        ));
    }
    Ok(PrInfo {
        number: view.number,
        url: view.url,
        head_ref_oid: view.head_ref_oid,
        head_ref_name: view.head_ref_name,
        is_cross_repository: view.is_cross_repository,
        labels: view.labels.into_iter().map(|l| l.name).collect(),
    })
}

impl PrInfo {
    // `[HOST/]OWNER/REPO` from the PR URL, so later calls address the PR that was viewed.
    pub fn repo(&self) -> Option<String> {
        let rest = self.url.strip_prefix("https://")?;
        let (repo, _) = rest.split_once("/pull/")?;
        (repo.split('/').count() == 3).then(|| repo.to_string())
    }

    fn repo_or_fail(&self) -> Result<String, Failure> {
        self.repo()
            .ok_or_else(|| gh_failure("pr view", format!("unexpected PR URL {}", self.url)))
    }
}

// Returns the comment URL gh prints.
pub fn comment_create(
    runner: &mut dyn Runner,
    pr: &PrInfo,
    body_file: &Path,
    attachments: &[(PathBuf, Option<String>)],
    cwd: &Path,
) -> Result<String, Failure> {
    let mut args = vec![
        "pr".to_string(),
        "comment".to_string(),
        pr.number.to_string(),
        "-R".to_string(),
        pr.repo_or_fail()?,
        "--body-file".to_string(),
        body_file.to_string_lossy().into_owned(),
    ];
    // Video renders as a player and gh refuses alt text for it.
    for (path, alt) in attachments {
        args.push("--attach".to_string());
        args.push(match alt {
            Some(alt) => format!("{}#{alt}", path.display()),
            None => path.display().to_string(),
        });
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = runner.run(&CmdSpec::new("gh-pr-comment", "gh", &args, 600).cwd(cwd));
    let url = output
        .stdout
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("https://"))
        .map(str::to_string);
    match (output.ok(), url) {
        (true, Some(url)) => Ok(url),
        (true, None) => Err(gh_failure(
            "pr comment",
            "no comment URL was printed".into(),
        )),
        (false, _) => Err(gh_failure("pr comment", output.summary())),
    }
}

// A label the PR does not carry needs no call; Ok(false) says nothing was removed.
pub fn remove_label(
    runner: &mut dyn Runner,
    pr: &PrInfo,
    label: &str,
    cwd: &Path,
) -> Result<bool, Failure> {
    if !pr.labels.iter().any(|l| l == label) {
        return Ok(false);
    }
    let output = runner.run(
        &CmdSpec::new(
            "gh-pr-edit",
            "gh",
            &[
                "pr",
                "edit",
                &pr.number.to_string(),
                "-R",
                &pr.repo_or_fail()?,
                "--remove-label",
                label,
            ],
            60,
        )
        .cwd(cwd),
    );
    if !output.ok() {
        return Err(gh_failure("pr edit", output.summary()));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner};

    fn pr(labels: &[&str]) -> PrInfo {
        PrInfo {
            number: 12,
            url: "https://github.com/o/r/pull/12".into(),
            head_ref_oid: "a".repeat(40),
            head_ref_name: "feat/x".into(),
            is_cross_repository: false,
            labels: labels.iter().map(|l| l.to_string()).collect(),
        }
    }

    fn view_json(labels: &str) -> String {
        format!(
            r#"{{"number":12,"url":"https://github.com/o/r/pull/12","headRefOid":"{}","headRefName":"feat/x","isCrossRepository":false,"labels":[{labels}]}}"#,
            "a".repeat(40)
        )
    }

    #[test]
    fn pr_view_reads_the_exact_fields() {
        let mut mock = MockRunner::new();
        mock.expect_run(
            "gh pr view",
            CmdOutput::success(&view_json(r#"{"id":"L1","name":"needs-qa"}"#)),
        );
        let pr = pr_view(
            &mut mock,
            "https://github.com/o/r/pull/12",
            Path::new("/repo"),
        )
        .unwrap();
        assert_eq!(
            mock.calls[0].args,
            [
                "pr",
                "view",
                "https://github.com/o/r/pull/12",
                "--json",
                "number,url,headRefOid,headRefName,isCrossRepository,labels"
            ]
        );
        assert_eq!(mock.calls[0].cwd.as_deref(), Some(Path::new("/repo")));
        assert_eq!(pr.number, 12);
        assert_eq!(pr.head_ref_name, "feat/x");
        assert_eq!(pr.labels, ["needs-qa"]);
    }

    #[test]
    fn pr_view_refuses_a_head_that_is_not_a_sha() {
        let mut mock = MockRunner::new();
        mock.expect_run(
            "gh pr view",
            CmdOutput::success(&view_json("").replace(&"a".repeat(40), "main")),
        );
        let failure = pr_view(&mut mock, "12", Path::new("/repo")).unwrap_err();
        assert_eq!(failure.code, FailureCode::PrUnavailable);
    }

    #[test]
    fn comment_create_attaches_each_file_with_alt_text_and_returns_the_url() {
        let mut mock = MockRunner::new();
        mock.expect_run(
            "gh pr comment",
            CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-9\n"),
        );
        let url = comment_create(
            &mut mock,
            &pr(&[]),
            Path::new("comment.md"),
            &[
                (PathBuf::from("./media/video.mp4"), None),
                (
                    PathBuf::from("./screenshots/03.png"),
                    Some("Failing step".to_string()),
                ),
            ],
            Path::new("/run"),
        )
        .unwrap();
        assert_eq!(url, "https://github.com/o/r/pull/12#issuecomment-9");
        assert_eq!(
            mock.calls[0].args,
            [
                "pr",
                "comment",
                "12",
                "-R",
                "github.com/o/r",
                "--body-file",
                "comment.md",
                "--attach",
                "./media/video.mp4",
                "--attach",
                "./screenshots/03.png#Failing step"
            ]
        );
        assert_eq!(mock.calls[0].cwd.as_deref(), Some(Path::new("/run")));
    }

    #[test]
    fn remove_label_edits_only_when_the_label_is_present() {
        let mut mock = MockRunner::new();
        mock.expect_run("gh pr edit", CmdOutput::success(""));
        let mut pr = pr(&["needs-qa"]);
        assert!(remove_label(&mut mock, &pr, NEEDS_QA, Path::new("/repo")).unwrap());
        assert_eq!(
            mock.calls[0].args,
            [
                "pr",
                "edit",
                "12",
                "-R",
                "github.com/o/r",
                "--remove-label",
                "needs-qa"
            ]
        );
        pr.labels.clear();
        assert!(!remove_label(&mut mock, &pr, NEEDS_QA, Path::new("/repo")).unwrap());
        assert_eq!(mock.calls.len(), 1);
    }
}
