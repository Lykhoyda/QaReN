use qaren::actions;
use qaren::exec::RealRunner;
use qaren::run::{app_root_for, worktree_drift, worktree_status};
use std::path::{Path, PathBuf};
use std::process::Command;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qaren-blocks-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(".qaren/actions")).unwrap();
    dir.canonicalize().unwrap()
}

fn block(slug: &str, platform: &str, hash: &str) -> String {
    format!(
        "appId: com.example.app\n---\n# id: {slug}\n# intent: {slug}\n# status: active\n# appId: com.example.app\n# plan: {slug}\n# planHash: {hash}\n# platform: {platform}\n\n# 1. Tap \"Go\"\n- tapOn: {{ id: \"go\" }}\n"
    )
}

#[test]
fn actions_list_reads_slug_platform_plan_hash_and_status() {
    let root = temp_dir("list");
    let dir = root.join(".qaren/actions");
    std::fs::write(
        dir.join("onboarding.yaml"),
        block("onboarding", "ios", "abc123"),
    )
    .unwrap();
    std::fs::write(
        dir.join("checkout.yml"),
        block("checkout", "android", "def456"),
    )
    .unwrap();
    std::fs::write(
        dir.join("recorded.yaml"),
        "# id: recorded\n# intent: recorded flow\n- launchApp\n",
    )
    .unwrap();
    std::fs::write(dir.join("notes.txt"), "not an action").unwrap();
    std::fs::write(dir.join("headless.yaml"), "- launchApp\n").unwrap();

    let entries = actions::list(&mut RealRunner::new(), &root).unwrap();
    let json = serde_json::to_value(&entries).unwrap();
    assert_eq!(
        json,
        serde_json::json!([
            {"slug": "checkout", "platform": "android", "planHash": "def456", "status": "active"},
            {"slug": "onboarding", "platform": "ios", "planHash": "abc123", "status": "active"},
            {"slug": "recorded", "platform": null, "planHash": null, "status": "experimental"}
        ])
    );
    assert_eq!(
        actions::render(&entries),
        "checkout\tandroid\tdef456\tactive\nonboarding\tios\tabc123\tactive\nrecorded\t-\t-\texperimental\n"
    );
    assert_eq!(
        actions::show(&mut RealRunner::new(), &root, "onboarding").unwrap(),
        block("onboarding", "ios", "abc123")
    );
    assert_eq!(
        actions::show(&mut RealRunner::new(), &root, "checkout").unwrap(),
        block("checkout", "android", "def456")
    );
    assert!(actions::show(&mut RealRunner::new(), &root, "../escape").is_err());
    assert!(actions::show(&mut RealRunner::new(), &root, "missing").is_err());
}

#[test]
fn actions_list_and_show_refuse_yaml_yml_twins() {
    let root = temp_dir("twins");
    let dir = root.join(".qaren/actions");
    std::fs::write(dir.join("login.yml"), block("login", "ios", "abc123")).unwrap();
    for twin in [block("login", "ios", "def456"), "- launchApp\n".to_string()] {
        std::fs::write(dir.join("login.yaml"), twin).unwrap();
        assert!(actions::list(&mut RealRunner::new(), &root)
            .unwrap_err()
            .contains("ambiguous"));
        assert!(actions::show(&mut RealRunner::new(), &root, "login")
            .unwrap_err()
            .contains("ambiguous"));
    }
}

#[test]
fn actions_list_is_empty_without_a_corpus_and_refuses_a_symlinked_one() {
    let root = temp_dir("empty");
    std::fs::remove_dir_all(root.join(".qaren/actions")).unwrap();
    assert!(actions::list(&mut RealRunner::new(), &root)
        .unwrap()
        .is_empty());
    let target = temp_dir("elsewhere");
    std::os::unix::fs::symlink(target.join(".qaren/actions"), root.join(".qaren/actions")).unwrap();
    assert!(actions::list(&mut RealRunner::new(), &root)
        .unwrap_err()
        .contains("symlinked"));
}

#[test]
fn main_copy_link_fixture_parity() {
    for scenario in [
        "accepted",
        "aliased",
        "local-copy",
        "other-clone",
        "bare",
        "chained",
        "qaren-link",
        "wrong-app",
        "ancestor-link",
        "file-link",
    ] {
        let root = temp_dir(&format!("main-copy-{scenario}"));
        let main = root.join("main");
        let linked = root.join("linked");
        std::fs::create_dir_all(&main).unwrap();
        std::fs::create_dir_all(&linked).unwrap();
        if scenario == "bare" {
            git(&main, &["init", "-q", "--bare"]);
        } else {
            git(&main, &["init", "-q"]);
        }
        let common = if scenario == "bare" {
            main.clone()
        } else {
            main.join(".git")
        };
        let gitdir = common.join("worktrees/linked");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/linked\n").unwrap();
        std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        std::fs::write(
            gitdir.join("gitdir"),
            format!("{}/.git\n", linked.display()),
        )
        .unwrap();
        std::fs::write(
            linked.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();
        let main_app = main.join("apps/example");
        let mut app = linked.join("apps/example");
        let actions_dir = main_app.join(".qaren/actions");
        std::fs::create_dir_all(&actions_dir).unwrap();
        std::fs::create_dir_all(app.join(".qaren")).unwrap();
        let bytes = block("welcome", "ios", "abc123");
        std::fs::write(actions_dir.join("welcome.yaml"), &bytes).unwrap();
        let mut target = actions_dir.clone();
        if matches!(scenario, "other-clone" | "local-copy" | "wrong-app") {
            let other = root.join("other");
            git(
                &root,
                &[
                    "clone",
                    "-q",
                    main.to_str().unwrap(),
                    other.to_str().unwrap(),
                ],
            );
            target = if scenario == "wrong-app" {
                main.join("apps/other/.qaren/actions")
            } else {
                other.join("apps/example/.qaren/actions")
            };
            std::fs::create_dir_all(&target).unwrap();
            std::fs::write(target.join("welcome.yaml"), &bytes).unwrap();
            if scenario == "local-copy" {
                app = target.parent().unwrap().parent().unwrap().to_path_buf();
            }
        } else if scenario == "aliased" {
            let alias = root.join("main-alias");
            std::os::unix::fs::symlink(&main, &alias).unwrap();
            target = alias.join("apps/example/.qaren/actions");
        } else if scenario == "chained" {
            let real = main_app.join("real-actions");
            std::fs::rename(&actions_dir, &real).unwrap();
            std::os::unix::fs::symlink(&real, &actions_dir).unwrap();
        } else if scenario == "ancestor-link" {
            let real = root.join("elsewhere");
            std::fs::rename(&main_app, &real).unwrap();
            std::os::unix::fs::symlink(&real, &main_app).unwrap();
        } else if scenario == "file-link" {
            let file = actions_dir.join("welcome.yaml");
            std::fs::rename(&file, root.join("outside.yaml")).unwrap();
            std::os::unix::fs::symlink(root.join("outside.yaml"), file).unwrap();
        }
        if scenario == "qaren-link" {
            std::fs::remove_dir(app.join(".qaren")).unwrap();
            std::os::unix::fs::symlink(main_app.join(".qaren"), app.join(".qaren")).unwrap();
        } else if scenario != "local-copy" {
            std::os::unix::fs::symlink(&target, app.join(".qaren/actions")).unwrap();
        }
        let accepted = matches!(scenario, "accepted" | "aliased" | "local-copy");
        assert_eq!(
            actions::list(&mut RealRunner::new(), &app).is_ok(),
            accepted,
            "{scenario}"
        );
        assert_eq!(
            actions::show(&mut RealRunner::new(), &app, "welcome").is_ok(),
            accepted,
            "{scenario}"
        );
        let dest = root.join("copied");
        let (copied, refused) =
            qaren::worktree::copy_blocks(&mut RealRunner::new(), &app, &["welcome".into()], &dest);
        assert_eq!(copied.len(), usize::from(accepted), "{scenario}");
        assert_eq!(refused.len(), usize::from(!accepted), "{scenario}");
        if accepted {
            assert_eq!(
                actions::list(&mut RealRunner::new(), &app).unwrap()[0].slug,
                "welcome"
            );
            assert_eq!(
                actions::show(&mut RealRunner::new(), &app, "welcome").unwrap(),
                bytes
            );
            assert_eq!(
                std::fs::read_to_string(dest.join("welcome.yaml")).unwrap(),
                bytes
            );
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}

#[test]
fn external_config_never_writes_into_its_project() {
    let root = temp_dir("root");
    let tree = temp_dir("tree");
    assert_eq!(
        app_root_for(&root.join(".qaren/config.yaml"), &tree).unwrap(),
        tree
    );
    assert_eq!(
        app_root_for(&root.join("qa/external.yaml"), &tree).unwrap(),
        tree
    );
    assert_eq!(
        app_root_for(&tree.join(".qaren/config.yaml"), &tree).unwrap(),
        tree
    );
    let action = root.join(".qaren/actions/login.yaml");
    std::fs::write(&action, "project B action").unwrap();
    let selected = app_root_for(&root.join(".qaren/config.yaml"), &tree).unwrap();
    std::fs::write(
        selected.join(".qaren/actions/login.yaml"),
        "project A action",
    )
    .unwrap();
    assert_eq!(std::fs::read_to_string(action).unwrap(), "project B action");
    assert!(app_root_for(Path::new("unused"), Path::new("/nonexistent-qaren")).is_err());
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

#[test]
fn worktree_drift_excludes_saved_blocks_and_reports_other_changed_paths() {
    let root = temp_dir("drift");
    git(&root, &["init", "-q"]);
    std::fs::write(root.join("app.ts"), "export {}\n").unwrap();
    std::fs::write(root.join("dirty.ts"), "before\n").unwrap();
    git(&root, &["add", "."]);
    git(
        &root,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "init",
        ],
    );
    std::fs::write(root.join("dirty.ts"), "already dirty\n").unwrap();
    let mut runner = RealRunner::new();
    let before = worktree_status(&mut runner, &root).unwrap();

    std::fs::write(
        root.join(".qaren/actions/onboarding.yaml"),
        "# id: onboarding\n",
    )
    .unwrap();
    std::fs::write(root.join("app.ts"), "export const changed = 1\n").unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/new.ts"), "export {}\n").unwrap();
    let after = worktree_status(&mut runner, &root).unwrap();

    assert_eq!(
        worktree_drift(&before, &after),
        vec!["app.ts".to_string(), "src/new.ts".to_string()]
    );
    assert!(worktree_drift(&after, &after).is_empty());

    git(&root, &["add", "-A"]);
    git(
        &root,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "two",
        ],
    );
    let clean = worktree_status(&mut runner, &root).unwrap();
    git(&root, &["mv", "app.ts", "renamed file.ts"]);
    let moved = worktree_status(&mut runner, &root).unwrap();
    assert_eq!(
        worktree_drift(&clean, &moved),
        vec!["app.ts".to_string(), "renamed file.ts".to_string()]
    );
}

#[test]
fn actions_refuse_a_symlinked_action_file_instead_of_skipping_it() {
    let root = temp_dir("filelink");
    let outside = temp_dir("outside").join("secret.yaml");
    std::fs::write(&outside, "# id: secret\n# intent: outside\n").unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".qaren/actions/linked.yaml")).unwrap();
    assert!(actions::show(&mut RealRunner::new(), &root, "linked").is_err());
    assert!(actions::list(&mut RealRunner::new(), &root).is_err());
    std::fs::remove_file(root.join(".qaren/actions/linked.yaml")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".qaren/actions/linked.yml")).unwrap();
    assert!(actions::show(&mut RealRunner::new(), &root, "linked").is_err());
    assert!(actions::list(&mut RealRunner::new(), &root).is_err());
}

#[test]
fn action_headers_match_core_validity_fallback_and_status_defaults() {
    for extension in ["yaml", "yml"] {
        let root = temp_dir(&format!("headers-{extension}"));
        let dir = root.join(".qaren/actions");
        let explicit = "# id: explicit\n# intent: do something\n- launchApp\n";
        let implicit = "# intent: do something\n- launchApp\n";
        let invalid = "# id: invalid\n- launchApp\n";
        for (slug, text) in [
            ("explicit", explicit),
            ("implicit", implicit),
            ("invalid", invalid),
        ] {
            std::fs::write(dir.join(format!("{slug}.{extension}")), text).unwrap();
        }
        assert_eq!(
            serde_json::to_value(actions::list(&mut RealRunner::new(), &root).unwrap()).unwrap(),
            serde_json::json!([
                {"slug":"explicit", "platform":null, "planHash":null, "status":"experimental"},
                {"slug":"implicit", "platform":null, "planHash":null, "status":"experimental"}
            ])
        );
        assert_eq!(
            actions::show(&mut RealRunner::new(), &root, "explicit").unwrap(),
            explicit
        );
        assert_eq!(
            actions::show(&mut RealRunner::new(), &root, "implicit").unwrap(),
            implicit
        );
        assert!(actions::show(&mut RealRunner::new(), &root, "invalid").is_err());
        assert_eq!(
            actions::header(implicit, "implicit").unwrap()["id"],
            "implicit"
        );
    }
}
