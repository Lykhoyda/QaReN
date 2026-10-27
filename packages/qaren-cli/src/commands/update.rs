use std::path::Path;
use std::process::{Command, Stdio};

pub(crate) const INSTALLER: &str = "scripts/install-qaren-from-source.sh";
pub(crate) const PLUGIN_MANIFEST: &str = "packages/qaren-plugin/.claude-plugin/plugin.json";
// The installer names a source build with the same command: <release>-dev.<commit>.
pub(crate) const DEV_COMMIT: [&str; 3] = ["rev-parse", "--short=12", "HEAD"];

pub(crate) fn dev_version(release: &str, commit: &str) -> String {
    format!("{release}-dev.{commit}")
}

// Fast-forwards the checkout in `cwd`, rebuilds and reinstalls it, and reports by tarball sha.
pub fn update(cwd: &Path, home: &Path) -> Result<String, (u8, String)> {
    if !cwd.join(INSTALLER).is_file() {
        return Err((
            2,
            "qaren update pulls and rebuilds a QaReN checkout; run it from the checkout root.\n\
             A plugin install updates with the host's plugin update, then\n\
             bash <plugin>/scripts/ensure-qaren.sh --install"
                .to_string(),
        ));
    }
    let status = git(cwd, &["status", "--porcelain", "--untracked-files=normal"])?;
    if !status.status.success() {
        return Err((
            2,
            format!("qaren update: git status failed: {}", stderr_of(&status)),
        ));
    }
    if !status.stdout.is_empty() {
        return Err((
            2,
            "qaren update: the checkout has local changes; commit or stash them and retry. Nothing was pulled or installed."
                .to_string(),
        ));
    }
    let pull = git(cwd, &["pull", "--ff-only"])?;
    if !pull.status.success() {
        return Err((
            2,
            format!(
                "qaren update: git pull --ff-only failed; nothing was installed.\n{}",
                stderr_of(&pull)
            ),
        ));
    }

    let manifest = cwd.join(PLUGIN_MANIFEST);
    let release = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("version")?.as_str().map(str::to_string))
        .ok_or_else(|| {
            (
                2,
                format!("qaren update: no version in {}", manifest.display()),
            )
        })?;
    let head = git(cwd, &DEV_COMMIT)?;
    if !head.status.success() {
        return Err((
            2,
            format!("qaren update: git rev-parse failed: {}", stderr_of(&head)),
        ));
    }
    let head = String::from_utf8_lossy(&head.stdout).trim().to_string();
    let version = dev_version(&release, &head);
    let record = home.join("runtime").join(&version).join(".tarball-sha256");
    let read_sha = || {
        std::fs::read_to_string(&record)
            .ok()
            .map(|s| s.trim().to_string())
    };
    let before = read_sha();

    let mut installer = Command::new("bash");
    crate::redact::scrub_secret_env(&mut installer, "", &[]);
    let installed = installer
        .arg(INSTALLER)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .output()
        .map_err(|e| (1, format!("qaren update: could not run {INSTALLER}: {e}")))?;
    if !installed.status.success() {
        let code = installed
            .status
            .code()
            .map_or("a signal".to_string(), |c| format!("exit {c}"));
        return Err((1, format!("qaren update: the installer failed ({code})")));
    }
    let bin = String::from_utf8_lossy(&installed.stdout)
        .trim()
        .to_string();
    let after = read_sha().ok_or_else(|| {
        (
            1,
            format!(
                "qaren update: the installer printed {bin} but left no build record at {}",
                record.display()
            ),
        )
    })?;
    Ok(report(&version, before.as_deref(), &after, &bin))
}

fn git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, (u8, String)> {
    let mut command = Command::new("git");
    crate::redact::scrub_secret_env(&mut command, "", &[]);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| (2, format!("qaren update: could not run git: {e}")))
}

fn stderr_of(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

fn report(version: &str, before: Option<&str>, after: &str, bin: &str) -> String {
    let short = |sha: &str| sha.chars().take(8).collect::<String>();
    match before {
        Some(old) if old == after => {
            format!(
                "qaren {version} build {} is already current: {bin}",
                short(after)
            )
        }
        Some(old) => format!(
            "updated qaren {version} build {} -> {}: {bin}",
            short(old),
            short(after)
        ),
        None => format!("installed qaren {version} build {}: {bin}", short(after)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const OLD: &str = "1d9e04aa1d9e04aa1d9e04aa1d9e04aa1d9e04aa1d9e04aa1d9e04aa1d9e04aa";
    const NEW: &str = "7f3a2c1e7f3a2c1e7f3a2c1e7f3a2c1e7f3a2c1e7f3a2c1e7f3a2c1e7f3a2c1e";

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("qaren-update-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "init.defaultBranch=develop",
            ])
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    // A checkout whose fake installer records `sha` as the new build and leaves a marker when run.
    fn checkout(root: &Path, home: &Path, version: &str, sha: &str) -> PathBuf {
        let upstream = root.join("upstream.git");
        let seed = root.join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        git(&seed, &["init", "-q"]);
        write_checkout_files(&seed, home, version, sha);
        git(&seed, &["add", "-A"]);
        git(&seed, &["commit", "-qm", "seed"]);
        git(
            root,
            &[
                "clone",
                "-q",
                "--bare",
                seed.to_str().unwrap(),
                upstream.to_str().unwrap(),
            ],
        );
        let work = root.join("checkout");
        git(
            root,
            &[
                "clone",
                "-q",
                upstream.to_str().unwrap(),
                work.to_str().unwrap(),
            ],
        );
        work
    }

    fn write_checkout_files(dir: &Path, home: &Path, version: &str, sha: &str) {
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::create_dir_all(dir.join("packages/qaren-plugin/.claude-plugin")).unwrap();
        std::fs::write(
            dir.join("packages/qaren-plugin/.claude-plugin/plugin.json"),
            format!("{{\"name\":\"qaren\",\"version\":\"{version}\"}}\n"),
        )
        .unwrap();
        std::fs::write(
            dir.join("scripts/install-qaren-from-source.sh"),
            format!(
                "set -eu\ntouch \"{marker}\"\necho building >&2\nrd=\"{runtime}/{version}-dev.$(git rev-parse --short=12 HEAD)\"\nmkdir -p \"$rd/bin\"\nprintf '%s\\n' {sha} > \"$rd/.tarball-sha256\"\necho \"$rd/bin/qaren\"\n",
                marker = home.join("installer-ran").display(),
                runtime = home.join("runtime").display(),
            ),
        )
        .unwrap();
    }

    fn installed_version(work: &Path, release: &str) -> String {
        dev_version(release, &git(work, &DEV_COMMIT))
    }

    fn seed_record(home: &Path, version: &str, sha: &str) {
        let dir = home.join("runtime").join(version);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".tarball-sha256"), format!("{sha}\n")).unwrap();
    }

    fn assert_untouched(home: &Path) {
        assert!(!home.join("installer-ran").exists(), "the installer ran");
        assert!(!home.join("runtime").exists(), "the runtime was touched");
    }

    #[test]
    fn report_wordings() {
        let version = "2.0.0-dev.3082f5f4a1b2";
        assert_eq!(
            report(version, Some(NEW), NEW, "/b/qaren"),
            "qaren 2.0.0-dev.3082f5f4a1b2 build 7f3a2c1e is already current: /b/qaren"
        );
        assert_eq!(
            report(version, Some(OLD), NEW, "/b/qaren"),
            "updated qaren 2.0.0-dev.3082f5f4a1b2 build 1d9e04aa -> 7f3a2c1e: /b/qaren"
        );
        assert_eq!(
            report(version, None, NEW, "/b/qaren"),
            "installed qaren 2.0.0-dev.3082f5f4a1b2 build 7f3a2c1e: /b/qaren"
        );
    }

    #[test]
    fn refuses_outside_a_checkout() {
        let root = scratch("outside");
        let home = root.join("home");
        let (code, msg) = update(&root, &home).unwrap_err();
        assert_eq!(code, 2);
        assert!(msg.contains("QaReN checkout"), "{msg}");
        assert!(!home.exists());
    }

    #[test]
    fn refuses_a_dirty_checkout() {
        let root = scratch("dirty");
        let home = root.join("home");
        let work = checkout(&root, &home, "1.0.13", NEW);
        git(&work, &["config", "status.showUntrackedFiles", "no"]);
        std::fs::write(work.join("scratch.txt"), "local").unwrap();
        let head = git(&work, &["rev-parse", "HEAD"]);
        let (code, msg) = update(&work, &home).unwrap_err();
        assert_eq!(code, 2);
        assert!(msg.contains("commit or stash"), "{msg}");
        assert_eq!(git(&work, &["rev-parse", "HEAD"]), head);
        assert_untouched(&home);
    }

    #[test]
    fn refuses_when_the_pull_fails() {
        let root = scratch("diverged");
        let home = root.join("home");
        let work = checkout(&root, &home, "1.0.13", NEW);
        let other = root.join("other");
        git(
            &root,
            &[
                "clone",
                "-q",
                root.join("upstream.git").to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        std::fs::write(other.join("a.txt"), "theirs").unwrap();
        git(&other, &["add", "-A"]);
        git(&other, &["commit", "-qm", "theirs"]);
        git(&other, &["push", "-q", "origin", "HEAD"]);
        std::fs::write(work.join("b.txt"), "ours").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-qm", "ours"]);
        let (code, msg) = update(&work, &home).unwrap_err();
        assert_eq!(code, 2);
        assert!(msg.contains("git pull --ff-only"), "{msg}");
        assert!(
            msg.to_lowercase().contains("fast-forward"),
            "git's own message is passed on: {msg}"
        );
        assert_untouched(&home);
    }

    #[test]
    fn refuses_a_checkout_without_an_upstream() {
        let root = scratch("no-upstream");
        let home = root.join("home");
        let work = checkout(&root, &home, "1.0.13", NEW);
        git(&work, &["branch", "--unset-upstream"]);
        let head = git(&work, &["rev-parse", "HEAD"]);
        let (code, msg) = update(&work, &home).unwrap_err();
        assert_eq!(code, 2);
        assert!(msg.contains("git pull --ff-only"), "{msg}");
        assert!(
            msg.lines().nth(1).is_some_and(|line| !line.is_empty()),
            "git's own message is passed on: {msg}"
        );
        assert_eq!(git(&work, &["rev-parse", "HEAD"]), head);
        assert_untouched(&home);
    }

    #[test]
    fn already_current() {
        let root = scratch("current");
        let home = root.join("home");
        let work = checkout(&root, &home, "1.0.13", NEW);
        let version = installed_version(&work, "1.0.13");
        seed_record(&home, &version, NEW);
        let text = update(&work, &home).unwrap();
        assert!(
            text.starts_with(&format!(
                "qaren {version} build 7f3a2c1e is already current"
            )),
            "{text}"
        );
    }

    #[test]
    fn a_rebuild_of_the_same_commit_reports_the_build_change() {
        let root = scratch("rebuilt");
        let home = root.join("home");
        let work = checkout(&root, &home, "1.0.13", NEW);
        let version = installed_version(&work, "1.0.13");
        seed_record(&home, &version, OLD);
        let text = update(&work, &home).unwrap();
        assert!(
            text.starts_with(&format!(
                "updated qaren {version} build 1d9e04aa -> 7f3a2c1e"
            )),
            "{text}"
        );
    }

    #[test]
    fn a_pulled_commit_installs_beside_the_previous_build() {
        let root = scratch("updated");
        let home = root.join("home");
        let work = checkout(&root, &home, "1.0.13", OLD);
        let previous = installed_version(&work, "1.0.13");
        seed_record(&home, &previous, OLD);
        let other = root.join("other");
        git(
            &root,
            &[
                "clone",
                "-q",
                root.join("upstream.git").to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        write_checkout_files(&other, &home, "1.0.13", NEW);
        git(&other, &["commit", "-qam", "new build"]);
        git(&other, &["push", "-q", "origin", "HEAD"]);
        let pushed = installed_version(&other, "1.0.13");
        assert_ne!(pushed, previous);
        let text = update(&work, &home).unwrap();
        assert!(
            text.starts_with(&format!("installed qaren {pushed} build 7f3a2c1e")),
            "{text}"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("runtime").join(&previous).join(".tarball-sha256"))
                .unwrap(),
            format!("{OLD}\n")
        );
    }

    #[test]
    fn reads_the_version_after_the_pull() {
        let root = scratch("installed");
        let home = root.join("home");
        let work = checkout(&root, &home, "1.0.13", OLD);
        std::fs::create_dir_all(&home).unwrap();
        let other = root.join("other");
        git(
            &root,
            &[
                "clone",
                "-q",
                root.join("upstream.git").to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        write_checkout_files(&other, &home, "2.0.0", NEW);
        git(&other, &["commit", "-qam", "version bump"]);
        git(&other, &["push", "-q", "origin", "HEAD"]);
        let text = update(&work, &home).unwrap();
        assert!(text.starts_with("installed qaren 2.0.0-dev."), "{text}");
        assert!(
            !home.join("runtime/2.0.0").exists(),
            "a release folder was written"
        );
    }

    #[test]
    fn installer_failure_is_exit_one() {
        let root = scratch("installer-fails");
        let home = root.join("home");
        let work = checkout(&root, &home, "1.0.13", NEW);
        std::fs::write(
            work.join("scripts/install-qaren-from-source.sh"),
            "exit 3\n",
        )
        .unwrap();
        git(&work, &["commit", "-qam", "broken installer"]);
        git(&work, &["push", "-q", "origin", "HEAD"]);
        let (code, msg) = update(&work, &home).unwrap_err();
        assert_eq!(code, 1);
        assert!(msg.contains("exit 3"), "{msg}");
    }
}
