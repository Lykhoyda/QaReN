use super::*;
use crate::exec::{CmdOutput, MockRunner, PipedChild, RealRunner, Spawned};
use crate::runrecord::{Phase, RunRecord};
use std::sync::atomic::{AtomicU64, Ordering};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "qaren-deps-{}-{}-{}",
            std::process::id(),
            crate::timefmt::epoch_ms(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(root.join("repo/app")).unwrap();
        std::fs::create_dir(root.join("runs")).unwrap();
        std::fs::write(root.join("repo/package.json"), "{}").unwrap();
        std::fs::write(root.join("repo/app/package.json"), "{}").unwrap();
        std::fs::write(
            root.join("repo/app/pnpm-lock.yaml"),
            "lockfileVersion: '9.0'\n",
        )
        .unwrap();
        Self(root)
    }
    fn context<'a>(&self, runner: &'a mut dyn Runner, run_id: &str) -> Ctx<'a> {
        let record: RunRecord = serde_json::from_value(serde_json::json!({
            "schema":"qaren-run/1", "run_id":run_id,"created_at":"2026-11-05T00:00:00Z",
            "scenario":{"schema":"qaren/1","name":"deps","platform":"ios","candidate":{"project_root":"app","app_id":"test","revision":"HEAD"}},
            "scenario_path":self.0.join("config.yaml"),"scenario_sha256":"0".repeat(64),
            "candidate":{"repo_root":self.0.join("repo"),"project_root":self.0.join("repo/app"),"app_id":"test","git_sha":"a".repeat(40),"git_dirty":false,"lockfile_sha256":sha256_hex(&std::fs::read(self.0.join("repo/app/pnpm-lock.yaml")).unwrap())},
            "phase":"created", "prepare":{"pid":999,"started_at":"start","command":"qaren"}
        })).unwrap();
        Ctx {
            runner,
            runs_root: self.0.join("runs"),
            native_cache_root: self.0.join("native"),
            native_store_entry: None,
            ios_observation: None,
            linkage_before_build: None,
            ios_generated_native: false,
            record,
            started_ms: 0,
            timings: vec![],
            notes: vec![],
            verb: "pr",
            bundle_requests_at_launch: None,
            manifest_warm: None,
            lane_owned: false,
            build_deadline_ms: None,
        }
    }
    fn modules(&self) {
        for rel in ["node_modules/root-package", "app/node_modules/app-package"] {
            std::fs::create_dir_all(self.0.join("repo").join(rel)).unwrap();
            std::fs::write(
                self.0.join("repo").join(rel).join("index.js"),
                "module.exports = 42;",
            )
            .unwrap();
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn copy_tree(src: &Path, dst: &Path) {
    if src.symlink_metadata().unwrap().file_type().is_symlink() {
        std::os::unix::fs::symlink(std::fs::read_link(src).unwrap(), dst).unwrap();
    } else if src.is_dir() {
        std::fs::create_dir_all(dst).unwrap();
        for item in std::fs::read_dir(src).unwrap() {
            let item = item.unwrap();
            copy_tree(&item.path(), &dst.join(item.file_name()));
        }
    } else {
        std::fs::copy(src, dst).unwrap();
    }
}

struct CloneRunner {
    mock: MockRunner,
    clones: usize,
    fail_clone: Option<usize>,
}
impl CloneRunner {
    fn new() -> Self {
        Self {
            mock: MockRunner::new(),
            clones: 0,
            fail_clone: None,
        }
    }
}
impl Runner for CloneRunner {
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        if spec.label == "deps-cache-clone" {
            self.mock.calls.push(spec.clone());
            self.clones += 1;
            let src = Path::new(&spec.args[spec.args.len() - 2]);
            let dest = Path::new(spec.args.last().unwrap());
            if self.fail_clone == Some(self.clones) {
                std::fs::create_dir_all(dest).unwrap();
                std::fs::write(dest.join("partial"), "partial").unwrap();
                return CmdOutput::failed(1, "clone unsupported");
            }
            copy_tree(src, dest);
            return CmdOutput::success("");
        }
        self.mock.execute(spec, interruptible)
    }
    fn execute_private(
        &mut self,
        spec: &CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> crate::exec::PrivateOutput {
        self.mock.execute_private(spec, input, interruptible)
    }
    fn spawn_group_unchecked(&mut self, _: &CmdSpec, _: &Path) -> std::io::Result<Spawned> {
        unreachable!()
    }
    fn spawn_piped_unchecked(&mut self, _: &CmdSpec, _: &Path) -> std::io::Result<PipedChild> {
        unreachable!()
    }
    fn sleep(&mut self, d: std::time::Duration) {
        self.mock.sleep(d);
    }
    fn now_epoch_ms(&self) -> u64 {
        self.mock.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.mock.commands_executed()
    }
    fn cancellation(&self) -> Option<String> {
        self.mock.cancellation()
    }
}
fn probes(mock: &mut MockRunner) {
    mock.expect_run("pnpm --version", CmdOutput::success("10.0.0"));
    mock.expect_run(
        "JSON.stringify",
        CmdOutput::success(r#"{"version":"v24.0.0","arch":"arm64","platform":"darwin"}"#),
    );
    mock.expect_run(
        "config list --json",
        CmdOutput::success(r#"{"node-linker":"hoisted"}"#),
    );
}
fn disk(mock: &mut MockRunner, kb: u64) {
    mock.expect_run("df", CmdOutput::success(&format!("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/test 999999999 1 {kb} 1% /\n/dev/test 999999999 1 {kb} 1% /\n")));
}
fn stage_ok(ctx: &mut Ctx) {
    stage(ctx).unwrap();
    assert!(ctx.record.resources.deps_cache.as_ref().unwrap().staging);
}
fn release(ctx: &mut Ctx) {
    let mut resource = ctx.record.resources.deps_cache.clone().unwrap();
    cleanup_run(
        ctx.runner,
        &ctx.runs_root,
        &ctx.record.run_id,
        ctx.record.prepare.as_ref(),
        &mut resource,
    )
    .unwrap();
    ctx.record.resources.deps_cache = Some(resource);
}
fn entry_path(ctx: &Ctx) -> PathBuf {
    let r = ctx.record.resources.deps_cache.as_ref().unwrap();
    repo_dir(&ctx.runs_root, r).unwrap().join(&r.key)
}

#[test]
fn miss_then_hit_still_installs_and_stages_before_build_mutation() {
    let f = Fixture::new();
    let mut runner = CloneRunner::new();
    probes(&mut runner.mock);
    disk(&mut runner.mock, u64::MAX / 1024);
    let mut ctx = f.context(&mut runner, "first");
    restore(&mut ctx, &f.0.join("repo"), true).unwrap();
    assert!(ctx.notes.contains(&("deps_cache".into(), "miss".into())));
    f.modules();
    stage_ok(&mut ctx);
    std::fs::write(
        f.0.join("repo/node_modules/root-package/build-mutated"),
        "native output",
    )
    .unwrap();
    publish(&mut ctx).unwrap();
    let entry = entry_path(&ctx);
    assert!(entry.is_dir());
    assert!(!entry
        .join("tree/node_modules/root-package/build-mutated")
        .exists());
    release(&mut ctx);
    drop(ctx);
    for rel in ["node_modules", "app/node_modules"] {
        std::fs::remove_dir_all(f.0.join("repo").join(rel)).unwrap();
    }
    probes(&mut runner.mock);
    disk(&mut runner.mock, u64::MAX / 1024);
    runner
        .mock
        .expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    let mut ctx = f.context(&mut runner, "second");
    restore(&mut ctx, &f.0.join("repo"), true).unwrap();
    assert!(entry.join(".readers/second").is_file());
    assert!(ctx.notes.contains(&("deps_cache".into(), "hit".into())));
    crate::commands::prepare::install_deps(&mut ctx).unwrap();
    assert_eq!(ctx.record.phase, Phase::DepsInstalled);
    // A hit already has its entry, so staging runs no command at all.
    let before = ctx.runner.commands_executed();
    stage(&mut ctx).unwrap();
    assert_eq!(ctx.runner.commands_executed(), before);
    assert!(!ctx.record.resources.deps_cache.as_ref().unwrap().staging);
    assert!(!staging_dir(entry.parent().unwrap(), "second")
        .unwrap()
        .exists());
    std::fs::write(
        f.0.join("repo/node_modules/root-package/index.js"),
        "changed",
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(entry.join("tree/node_modules/root-package/index.js")).unwrap(),
        "module.exports = 42;"
    );
    release(&mut ctx);
    assert!(!entry.join(".readers/second").exists());
    drop(ctx);
    assert_eq!(runner.mock.remaining(), 0);
    for cmd in runner
        .mock
        .calls
        .iter()
        .filter(|s| s.label == "deps-cache-clone")
    {
        assert!(cmd.args.contains(
            &if cfg!(target_os = "macos") {
                "-c"
            } else {
                "--reflink=always"
            }
            .into()
        ));
    }
}

#[test]
fn every_key_input_and_path_node_identity_invalidates_reuse() {
    let f = Fixture::new();
    let installer = Installer {
        pnpm: "10".into(),
        node: "v24".into(),
        arch: "arm64".into(),
        platform: "darwin".into(),
    };
    let config = serde_json::json!({"node-linker":"hoisted"});
    let get = |i: &Installer| {
        key(
            &f.0.join("repo"),
            Path::new("app"),
            "repository",
            i,
            &config,
        )
        .unwrap()
    };
    let baseline = get(&installer);
    for (file, bytes) in [
        ("app/pnpm-lock.yaml", "changed"),
        ("package.json", r#"{"scripts":{"postinstall":"echo ok"}}"#),
        ("package.json", r#"{"pnpm":{"overrides":{"pkg":"2"}}}"#),
        (".npmrc", "node-linker=hoisted\n"),
        ("pnpm-workspace.yaml", "nodeLinker: hoisted\n"),
        ("app/.npmrc", "ignore-scripts=true\n"),
        ("app/pnpm-workspace.yaml", "nodeLinker: hoisted\n"),
    ] {
        let p = f.0.join("repo").join(file);
        let old = std::fs::read(&p).ok();
        std::fs::write(&p, bytes).unwrap();
        assert_ne!(baseline, get(&installer), "{file}");
        if let Some(old) = old {
            std::fs::write(p, old).unwrap();
        } else {
            std::fs::remove_file(p).unwrap();
        }
    }
    for field in ["pnpm", "node", "arch", "platform"] {
        let mut changed = installer.clone();
        match field {
            "pnpm" => changed.pnpm.push('1'),
            "node" => changed.node.push('1'),
            "arch" => changed.arch.push('1'),
            _ => changed.platform.push('1'),
        };
        assert_ne!(baseline, get(&changed));
    }
    assert_ne!(
        baseline,
        key(
            &f.0.join("repo"),
            Path::new("app"),
            "other-repository",
            &installer,
            &config
        )
        .unwrap()
    );
    copy_tree(&f.0.join("repo/app"), &f.0.join("repo/other"));
    assert_ne!(
        baseline,
        key(
            &f.0.join("repo"),
            Path::new("other"),
            "repository",
            &installer,
            &config
        )
        .unwrap()
    );
}

#[test]
fn partial_restore_removes_every_copied_directory() {
    let f = Fixture::new();
    f.modules();
    let target = f.0.join("target");
    std::fs::create_dir(&target).unwrap();
    let mut runner = CloneRunner::new();
    runner.fail_clone = Some(2);
    let result = restore_modules(
        &mut runner,
        &f.0.join("repo"),
        &target,
        &modules_paths(Path::new("app")),
    );
    assert_eq!(result.unwrap_err(), "clone-unsupported");
    assert!(!target.join("node_modules").exists());
    assert!(!target.join("app/node_modules").exists());
    runner
        .mock
        .expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    let mut ctx = f.context(&mut runner, "cold");
    crate::commands::prepare::install_deps(&mut ctx).unwrap();
}

#[test]
fn failed_install_disabled_cache_unsupported_layout_and_disk_do_not_publish() {
    for case in ["disabled", "layout", "space", "clone", "install"] {
        let f = Fixture::new();
        let mut runner = CloneRunner::new();
        if case != "disabled" {
            probes(&mut runner.mock);
        }
        if case == "layout" {
            std::fs::write(
                f.0.join("repo/pnpm-workspace.yaml"),
                "packages: ['packages/*']\n",
            )
            .unwrap();
        }
        if ["space", "clone"].contains(&case) {
            disk(
                &mut runner.mock,
                if case == "space" { 1 } else { 999999999 },
            );
        }
        if case == "clone" {
            runner.fail_clone = Some(1);
        }
        if case == "install" {
            runner
                .mock
                .expect_run("pnpm install", CmdOutput::failed(1, "install failed"));
        }
        let mut ctx = f.context(&mut runner, "failed");
        restore(&mut ctx, &f.0.join("repo"), case != "disabled").unwrap();
        if case == "install" {
            assert!(crate::commands::prepare::install_deps(&mut ctx).is_err());
        } else {
            f.modules();
            stage(&mut ctx).unwrap();
            publish(&mut ctx).unwrap();
        }
        if ctx.record.resources.deps_cache.is_some() {
            assert!(!entry_path(&ctx).exists());
            release(&mut ctx);
        }
        assert!(
            ctx.notes.iter().any(|(_, n)| n
                == match case {
                    "layout" => "layout-unsupported",
                    "clone" => "clone-unsupported",
                    _ => "disabled",
                })
                || case == "install"
        );
        drop(ctx);
        assert_eq!(runner.mock.remaining(), 0, "{case}");
    }
}

fn seed_entry(f: &Fixture, key: &str, created_ms: u64) -> (PathBuf, CacheResource) {
    let resource = CacheResource {
        repo_id: "a".repeat(64),
        key: key.into(),
        reader: false,
        staging: false,
        enabled: true,
    };
    let repo = repo_dir(&f.0.join("runs"), &resource).unwrap();
    std::fs::create_dir_all(repo.join(key).join("tree/node_modules")).unwrap();
    buildplan::save_json(
        &repo.join(key).join("entry.json"),
        &Entry {
            schema: SCHEMA.into(),
            key: key.into(),
            created_ms,
            modules: vec!["node_modules".into()],
            bytes: 0,
        },
    )
    .unwrap();
    (repo, resource)
}
fn marker(path: &Path, owner: Option<PidIdentity>) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    buildplan::save_json(path, &owner).unwrap();
}
fn owner() -> PidIdentity {
    PidIdentity {
        pid: 999,
        started_at: "start".into(),
        command: crate::redact::OutputText::from_output("qaren"),
    }
}

#[test]
fn pruning_and_explicit_cleanup_retain_live_and_unknown_readers_regardless_of_age() {
    for state in ["live", "unknown", "dead", "foreign"] {
        let f = Fixture::new();
        let (old, _) = seed_entry(&f, &"1".repeat(64), 1);
        seed_entry(&f, &"2".repeat(64), 2);
        seed_entry(&f, &"3".repeat(64), 3);
        let entry = old.join("1".repeat(64));
        marker(&entry.join(".readers/ancient"), Some(owner()));
        let mut runner = MockRunner::new();
        match state {
            "live" => {
                runner.expect_run("lstart=", CmdOutput::success("start"));
                runner.expect_run("stat=", CmdOutput::success("S"));
            }
            "unknown" => runner.expect_run("lstart=", CmdOutput::failed(1, "unreadable")),
            "foreign" => runner.expect_run("lstart=", CmdOutput::success("different")),
            _ => runner.expect_run("lstart=", CmdOutput::failed(1, "")),
        };
        prune(&mut runner, &old, false).unwrap();
        assert_eq!(entry.exists(), ["live", "unknown"].contains(&state));
        assert_eq!(runner.remaining(), 0);
    }
    let f = Fixture::new();
    let (repo, _) = seed_entry(&f, &"1".repeat(64), 1);
    let entry = repo.join("1".repeat(64));
    marker(&entry.join(".readers/unproven"), None);
    let mut runner = MockRunner::new();
    prune(&mut runner, &repo, true).unwrap();
    assert!(entry.exists());
    std::fs::remove_file(entry.join(".readers/unproven")).unwrap();
    prune(&mut runner, &repo, true).unwrap();
    assert!(!entry.exists());
}

#[test]
fn reader_admission_and_pruning_cannot_interleave_under_the_cache_lock() {
    let f = Fixture::new();
    let mut first = MockRunner::new();
    let mut second = MockRunner::new();
    let guard = lock(&mut first, &f.0.join("runs"), "reader", Some(&owner())).unwrap();
    second.expect_run("lstart=", CmdOutput::success("start"));
    second.expect_run("stat=", CmdOutput::success("S"));
    assert!(lock(&mut second, &f.0.join("runs"), "pruner", Some(&owner())).is_err());
    drop(guard);
    assert!(lock(&mut second, &f.0.join("runs"), "pruner", Some(&owner())).is_ok());
    assert_eq!(second.remaining(), 0);
}

#[test]
fn concurrent_publishers_keep_one_entry_and_remove_the_losing_stage() {
    let f = Fixture::new();
    f.modules();
    let mut runner = CloneRunner::new();
    probes(&mut runner.mock);
    disk(&mut runner.mock, 999999999);
    let mut first = f.context(&mut runner, "first");
    restore(&mut first, &f.0.join("repo"), true).unwrap();
    stage_ok(&mut first);
    let resource = first.record.resources.deps_cache.clone().unwrap();
    drop(first);
    let mut runner2 = CloneRunner::new();
    probes(&mut runner2.mock);
    disk(&mut runner2.mock, 999999999);
    // The other publisher remains alive while this one publishes.
    runner2
        .mock
        .expect_run("lstart=", CmdOutput::success("start"));
    runner2.mock.expect_run("stat=", CmdOutput::success("S"));
    let mut second = f.context(&mut runner2, "second");
    restore(&mut second, &f.0.join("repo"), true).unwrap();
    stage_ok(&mut second);
    publish(&mut second).unwrap();
    let entry = entry_path(&second);
    assert!(entry.is_dir());
    release(&mut second);
    drop(second);
    let mut first = f.context(&mut runner, "first");
    first.record.resources.deps_cache = Some(resource);
    publish(&mut first).unwrap();
    assert!(entry.is_dir());
    assert!(!staging_dir(&entry.parent().unwrap(), "first")
        .unwrap()
        .exists());
    release(&mut first);
}

#[test]
fn abandoned_staging_is_reclaimed_only_for_proven_dead_owners() {
    let f = Fixture::new();
    let (repo, _) = seed_entry(&f, &"1".repeat(64), 1);
    for run in ["dead", "live", "unknown"] {
        let stage = staging_dir(&repo, run).unwrap();
        std::fs::create_dir_all(&stage).unwrap();
        marker(
            &stage.join("owner.json"),
            if run == "unknown" {
                None
            } else {
                Some(owner())
            },
        );
    }
    let mut runner = MockRunner::new();
    // Both known owners are dead; unknown evidence still retains its staging.
    runner.expect_run("lstart=", CmdOutput::failed(1, ""));
    runner.expect_run("lstart=", CmdOutput::failed(1, ""));
    reclaim_staging(&mut runner, &repo, None).unwrap();
    assert!(!staging_dir(&repo, "dead").unwrap().exists());
    assert!(staging_dir(&repo, "unknown").unwrap().exists());
}

#[test]
fn external_modules_virtual_store_and_nonrelocatable_links_disable_layout() {
    let f = Fixture::new();
    for config in [
        serde_json::json!({"node-linker":"isolated"}),
        serde_json::json!({"node-linker":"hoisted","virtual-store-dir":"/outside"}),
        serde_json::json!({"node-linker":"hoisted","enable-global-virtual-store":true}),
        serde_json::json!({"node-linker":"hoisted","modules-dir":"elsewhere"}),
    ] {
        assert!(layout(&config, &f.0.join("repo"), Path::new("app")).is_err());
    }
    std::fs::create_dir_all(f.0.join("repo/extra/node_modules")).unwrap();
    assert!(supported_modules(&f.0.join("repo"), Path::new("app")).is_err());
    f.modules();
    std::os::unix::fs::symlink(
        &f.0.join("repo/app/package.json"),
        f.0.join("repo/node_modules/absolute"),
    )
    .unwrap();
    assert!(tree_bytes(
        &f.0.join("repo/node_modules"),
        &f.0.join("repo/node_modules")
    )
    .is_err());
}

#[test]
#[ignore = "requires installed pnpm and a clone-capable filesystem"]
fn real_pnpm_tree_relocates_after_origin_is_deleted_and_remains_isolated() {
    let f = Fixture::new();
    let source = f.0.join("repo");
    std::fs::create_dir(source.join("fixture-pkg")).unwrap();
    std::fs::write(source.join("package.json"),r#"{"name":"relocation-test","private":true,"dependencies":{"relocation-package":"file:./fixture-pkg"}}"#).unwrap();
    std::fs::write(
        source.join(".npmrc"),
        format!(
            "node-linker=hoisted\nstore-dir={}\n",
            f.0.join("store").display()
        ),
    )
    .unwrap();
    std::fs::write(source.join("fixture-pkg/package.json"),r#"{"name":"relocation-package","version":"1.0.0","main":"index.js","bin":{"relocation-hello":"hello.js"}}"#).unwrap();
    std::fs::write(
        source.join("fixture-pkg/index.js"),
        "module.exports = 42;\n",
    )
    .unwrap();
    std::fs::write(
        source.join("fixture-pkg/hello.js"),
        "#!/usr/bin/env node\nconsole.log('relocation-ok');\n",
    )
    .unwrap();
    std::fs::write(source.join("pnpm-workspace.yaml"), "nodeLinker: hoisted\n").unwrap();
    std::fs::remove_file(source.join("app/pnpm-lock.yaml")).unwrap();
    let task_home = f.0.join("home");
    std::fs::create_dir_all(task_home.join(".local/bin")).unwrap();
    let store = f.0.join("store");
    let mut runner = RealRunner::new();
    let install = runner.run_private(
        &CmdSpec::new(
            "test-install",
            "pnpm",
            &[
                "install",
                "--offline",
                "--store-dir",
                store.to_str().unwrap(),
                "--ignore-scripts",
                "--config.node-linker=hoisted",
                "--config.userconfig=/dev/null",
            ],
            60,
        )
        .cwd(&source)
        .env("HOME", task_home.to_str().unwrap()),
        b"",
    );
    assert_eq!(install.exit_code(), Some(0), "{}", install.summary());
    assert!(!install.timed_out());
    let (_, effective) = probe(&mut runner, &source).unwrap();
    assert!(layout(&effective, &source, Path::new("")).is_ok());
    let entry = f.0.join("entry");
    std::fs::create_dir(&entry).unwrap();
    tree_bytes(&source.join("node_modules"), &source.join("node_modules")).unwrap();
    clone_modules(
        &mut runner,
        &source.join("node_modules"),
        &entry.join("node_modules"),
    )
    .unwrap();
    std::fs::remove_dir_all(&source).unwrap();
    let dest = f.0.join("restored");
    std::fs::create_dir(&dest).unwrap();
    restore_modules(&mut runner, &entry, &dest, &["node_modules".into()]).unwrap();
    let resolved = runner.run(
        &CmdSpec::new(
            "resolve",
            "node",
            &["-p", "require('relocation-package')"],
            10,
        )
        .cwd(&dest),
    );
    assert!(resolved.ok());
    assert_eq!(resolved.stdout.trim(), "42");
    let bin = runner.run(
        &CmdSpec::new(
            "shim",
            dest.join("node_modules/.bin/relocation-hello")
                .to_str()
                .unwrap(),
            &[],
            10,
        )
        .cwd(&dest),
    );
    assert!(bin.ok(), "{}", bin.summary());
    assert_eq!(bin.stdout.trim(), "relocation-ok");
    std::fs::write(
        dest.join("node_modules/relocation-package/index.js"),
        "changed",
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(entry.join("node_modules/relocation-package/index.js")).unwrap(),
        "module.exports = 42;\n"
    );
}

#[test]
fn candidate_head_tracked_file_and_lockfile_changes_withhold_staged_publication() {
    for change in ["head", "tracked", "lockfile"] {
        let f = Fixture::new();
        f.modules();
        let mut runner = CloneRunner::new();
        probes(&mut runner.mock);
        disk(&mut runner.mock, 999999999);
        runner.mock.expect_run(
            "rev-parse HEAD",
            CmdOutput::success(&if change == "head" {
                "b".repeat(40)
            } else {
                "a".repeat(40)
            }),
        );
        if change != "head" {
            runner.mock.expect_run(
                "status --porcelain",
                CmdOutput::success(if change == "tracked" {
                    " M app/package.json\0"
                } else {
                    ""
                }),
            );
        }
        let mut ctx = f.context(&mut runner, "drift");
        restore(&mut ctx, &f.0.join("repo"), true).unwrap();
        stage_ok(&mut ctx);
        if change == "lockfile" {
            std::fs::write(f.0.join("repo/app/pnpm-lock.yaml"), "changed").unwrap();
        }
        assert!(crate::candidate::verify_unchanged(ctx.runner, &ctx.record.candidate).is_err());
        assert!(!entry_path(&ctx).exists());
        release(&mut ctx);
    }
}

#[test]
fn explicit_cache_cleanup_reclaims_dead_staging_and_retains_unknown_readers() {
    let f = Fixture::new();
    let (repo, _) = seed_entry(&f, &"1".repeat(64), 1);
    let entry = repo.join("1".repeat(64));
    marker(&entry.join(".readers/unknown"), None);
    let stage = staging_dir(&repo, "cancelled").unwrap();
    marker(&stage.join("owner.json"), Some(owner()));
    let mut runner = MockRunner::new();
    runner.expect_run("lstart=", CmdOutput::success("cleanup-start"));
    runner.expect_run("command=", CmdOutput::success("qaren cleanup"));
    runner.expect_run("lstart=", CmdOutput::failed(1, ""));
    cleanup_cache(&mut runner, &f.0.join("runs")).unwrap();
    assert!(entry.exists());
    assert!(!stage.exists());
    assert!(inventory(&f.0.join("runs"))
        .unwrap()
        .starts_with("1 entries, 0 staging,"));
    assert_eq!(runner.remaining(), 0);
}

#[test]
fn run_cleanup_drops_only_its_markers_and_stage_and_refuses_live_or_unknown_owners() {
    for state in ["dead", "live", "unknown"] {
        let live = state != "dead";
        let f = Fixture::new();
        let (repo, mut resource) = seed_entry(&f, &"1".repeat(64), 1);
        resource.reader = true;
        resource.staging = true;
        let entry = repo.join(&resource.key);
        marker(&entry.join(".readers/owned"), Some(owner()));
        marker(&entry.join(".readers/other"), None);
        let stage = staging_dir(&repo, "owned").unwrap();
        marker(&stage.join("owner.json"), Some(owner()));
        let mut runner = MockRunner::new();
        let mut ctx = f.context(&mut runner, "owned");
        ctx.record.resources.deps_cache = Some(resource);
        ctx.record.resources.lease = Some(crate::lease::Lease {
            run_id: "owned".into(),
            token: "t".into(),
            lock_dir: f.0.join("locks/absent"),
            holder: "owned".into(),
            released_orphan: None,
        });
        ctx.save().unwrap();
        drop(ctx);
        if state == "live" {
            runner.expect_run("lstart=", CmdOutput::success("start"));
            runner.expect_run("stat=", CmdOutput::success("S"));
        } else if state == "unknown" {
            runner.expect_run("lstart=", CmdOutput::failed(1, "unreadable"));
        } else {
            runner.expect_run("lstart=", CmdOutput::failed(1, ""));
            runner.expect_run("lstart=", CmdOutput::success("cleanup-start"));
            runner.expect_run("command=", CmdOutput::success("qaren cleanup"));
        }
        let receipt = crate::commands::cleanup::cleanup(&mut runner, &f.0.join("runs"), "owned");
        assert_eq!(entry.join(".readers/owned").exists(), live);
        assert_eq!(stage.exists(), live);
        assert!(entry.join(".readers/other").exists());
        // An unknown owner no longer stops the legs that never needed it proven gone.
        assert_eq!(
            receipt.cleanup.contains_key("device_lease"),
            state != "live"
        );
        // A live owner refuses the whole run; an unknown one refuses only this leg.
        assert_eq!(
            receipt.cleanup[if state == "live" {
                "core"
            } else {
                "deps_cache"
            }],
            if live {
                "refused: the run's qaren process is alive or unproven gone"
            } else {
                "removed"
            }
        );
        assert_eq!(runner.remaining(), 0);
    }
}

#[test]
fn cancellation_after_staging_never_publishes_and_leaves_owned_recovery() {
    let f = Fixture::new();
    f.modules();
    let mut runner = CloneRunner::new();
    probes(&mut runner.mock);
    disk(&mut runner.mock, 999999999);
    let mut ctx = f.context(&mut runner, "cancelled");
    restore(&mut ctx, &f.0.join("repo"), true).unwrap();
    stage_ok(&mut ctx);
    let resource = ctx.record.resources.deps_cache.clone().unwrap();
    drop(ctx);
    runner.mock.cancel_at_ms = Some((0, "cancelled".into()));
    let mut ctx = f.context(&mut runner, "cancelled");
    ctx.record.resources.deps_cache = Some(resource);
    assert!(publish(&mut ctx).is_err());
    assert!(!entry_path(&ctx).exists());
    assert!(
        staging_dir(&entry_path(&ctx).parent().unwrap(), "cancelled")
            .unwrap()
            .is_dir()
    );
}
