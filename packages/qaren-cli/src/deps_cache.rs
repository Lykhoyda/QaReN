use crate::buildplan::{self, LockHolder, LockOutcome, LockPolicy};
use crate::candidate::sha256_hex;
use crate::commands::prepare::Ctx;
use crate::events::{self, StageState};
use crate::exec::{CmdSpec, Runner};
use crate::failure::Failure;
use crate::runrecord::{probe_pid_identity, PidIdentity, PidLiveness};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Component, Path, PathBuf};

const RESERVE_BYTES: u64 = 1024 * 1024 * 1024;
const SCHEMA: &str = "qaren-deps-cache/1";
const LOCK: &str = "cache-lock";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Installer {
    pub pnpm: String,
    pub node: String,
    pub arch: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheResource {
    pub repo_id: String,
    pub key: String,
    pub reader: bool,
    pub staging: bool,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct Entry {
    schema: String,
    key: String,
    created_ms: u64,
    modules: Vec<PathBuf>,
    bytes: u64,
}

struct CacheLock {
    path: PathBuf,
    holder: String,
    run_id: String,
}

impl Drop for CacheLock {
    fn drop(&mut self) {
        buildplan::release_lock(&self.path, &self.holder, &self.run_id);
    }
}

fn directory(path: &Path, create: bool) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta)
            if meta.is_dir()
                && meta.uid() == unsafe { libc::geteuid() }
                && meta.mode() & 0o022 == 0 =>
        {
            Ok(true)
        }
        Ok(_) => Err("cache directory is not a private owned directory".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => {
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(path)
                .map_err(|e| e.to_string())?;
            directory(path, false)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

fn cache_root(runs_root: &Path) -> PathBuf {
    runs_root.join("deps-cache")
}

fn lock(
    runner: &mut dyn Runner,
    runs_root: &Path,
    run_id: &str,
    identity: Option<&PidIdentity>,
) -> Result<CacheLock, String> {
    let root = cache_root(runs_root);
    directory(&root, true)?;
    let holder = LockHolder {
        holder: format!("deps-{run_id}"),
        run_id: run_id.into(),
        identity: identity.cloned(),
        at: crate::timefmt::iso8601_utc(runner.now_epoch_ms()),
        home: None,
        qaren_home: None,
        group: None,
    };
    match buildplan::claim_lock(runner, &root, LOCK, &holder, LockPolicy::AdoptDead) {
        LockOutcome::Claimed { .. } => Ok(CacheLock {
            path: root.join(LOCK),
            holder: holder.holder,
            run_id: run_id.into(),
        }),
        _ => Err("dependency cache lock unavailable".into()),
    }
}

fn safe_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn safe_run(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
fn repo_dir(runs_root: &Path, resource: &CacheResource) -> Result<PathBuf, String> {
    if !safe_hash(&resource.repo_id) || !safe_hash(&resource.key) {
        return Err("invalid cache identity".into());
    }
    Ok(cache_root(runs_root).join(&resource.repo_id))
}
fn staging_dir(repo: &Path, run_id: &str) -> Result<PathBuf, String> {
    if !safe_run(run_id) {
        return Err("invalid cache run identity".into());
    }
    Ok(repo.join(".staging").join(run_id))
}
fn modules_paths(app_rel: &Path) -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("node_modules")];
    if !app_rel.as_os_str().is_empty() {
        paths.push(app_rel.join("node_modules"));
    }
    paths
}
fn relative(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)))
}

fn config_value<'a>(config: &'a Value, camel: &str, kebab: &str) -> Option<&'a Value> {
    config.get(camel).or_else(|| config.get(kebab))
}

fn layout(config: &Value, repo: &Path, app_rel: &Path) -> Result<(), String> {
    if config_value(config, "nodeLinker", "node-linker").and_then(Value::as_str) != Some("hoisted")
    {
        return Err("layout-unsupported".into());
    }
    for (camel, kebab, expected) in [
        ("modulesDir", "modules-dir", "node_modules"),
        ("virtualStoreDir", "virtual-store-dir", "node_modules/.pnpm"),
    ] {
        if config_value(config, camel, kebab).is_some_and(|v| v.as_str() != Some(expected)) {
            return Err("layout-unsupported".into());
        }
    }
    for (camel, kebab) in [
        ("workspaceDir", "workspace-dir"),
        ("lockfileDir", "lockfile-dir"),
    ] {
        if let Some(value) = config_value(config, camel, kebab) {
            let Some(path) = value.as_str() else {
                return Err("layout-unsupported".into());
            };
            let path = Path::new(path);
            if path != repo && path != repo.join(app_rel) && path != Path::new(".") {
                return Err("layout-unsupported".into());
            }
        }
    }
    for (camel, kebab) in [
        ("enableGlobalVirtualStore", "enable-global-virtual-store"),
        ("global", "global"),
        ("virtualStoreOnly", "virtual-store-only"),
    ] {
        if config_value(config, camel, kebab).is_some_and(|v| v != false && v != "false") {
            return Err("layout-unsupported".into());
        }
    }
    for root in [repo.to_path_buf(), repo.join(app_rel)] {
        let path = root.join("pnpm-workspace.yaml");
        if let Ok(bytes) = std::fs::read(path) {
            let workspace: Value =
                serde_yaml::from_slice(&bytes).map_err(|_| "layout-unsupported")?;
            if workspace.get("packages").is_some_and(|v| {
                v.as_array().is_none_or(|items| {
                    items.iter().any(|p| {
                        p.as_str()
                            .is_none_or(|p| p != "." && p != app_rel.to_string_lossy())
                    })
                })
            }) {
                return Err("layout-unsupported".into());
            }
        }
    }
    Ok(())
}

fn probe(runner: &mut dyn Runner, project: &Path) -> Result<(Installer, Value), String> {
    let pnpm = runner.run_private(
        &CmdSpec::new("deps-cache-pnpm", "pnpm", &["--version"], 30).cwd(project),
        b"",
    );
    if !pnpm.clean() || pnpm.stdout().trim().is_empty() {
        return Err("disabled".into());
    }
    let node = runner.run_private(&CmdSpec::new("deps-cache-node", "node", &["-p", "JSON.stringify({version:process.version,arch:process.arch,platform:process.platform})"], 10).cwd(project), b"");
    if !node.clean() {
        return Err("disabled".into());
    }
    let node: Value = serde_json::from_str(node.stdout()).map_err(|_| "disabled")?;
    let field = |name| {
        node.get(name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "disabled".to_string())
    };
    let installer = Installer {
        pnpm: pnpm.stdout().trim().into(),
        node: field("version")?,
        arch: field("arch")?,
        platform: field("platform")?,
    };
    let config = runner.run_private(
        &CmdSpec::new(
            "deps-cache-config",
            "pnpm",
            &["config", "list", "--json"],
            30,
        )
        .cwd(project),
        b"",
    );
    if !config.clean() {
        return Err("disabled".into());
    }
    let config: Value = serde_json::from_str(config.stdout()).map_err(|_| "disabled")?;
    if !config.is_object() {
        return Err("disabled".into());
    }
    Ok((installer, config))
}

fn key(
    repo: &Path,
    app_rel: &Path,
    repo_id: &str,
    installer: &Installer,
    effective: &Value,
) -> Result<String, String> {
    let mut parts = vec![
        SCHEMA.as_bytes().to_vec(),
        repo_id.as_bytes().to_vec(),
        app_rel.as_os_str().as_encoded_bytes().to_vec(),
        serde_json::to_vec(installer).map_err(|e| e.to_string())?,
    ];
    for root in [repo.to_path_buf(), repo.join(app_rel)] {
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(root.join("package.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        parts.push(
            serde_json::to_vec(
                &serde_json::json!({"scripts":manifest.get("scripts"),"pnpm":manifest.get("pnpm")}),
            )
            .unwrap(),
        );
        for name in [".npmrc", "pnpm-workspace.yaml"] {
            match std::fs::read(root.join(name)) {
                Ok(bytes) => {
                    parts.push(vec![1]);
                    parts.push(bytes);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => parts.push(vec![0]),
                Err(e) => return Err(e.to_string()),
            }
        }
    }
    parts
        .push(std::fs::read(repo.join(app_rel).join("pnpm-lock.yaml")).map_err(|e| e.to_string())?);
    let selected: std::collections::BTreeMap<_, _> = effective
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| {
            [
                "nodeLinker",
                "node-linker",
                "modulesDir",
                "modules-dir",
                "virtualStoreDir",
                "virtual-store-dir",
                "enableGlobalVirtualStore",
                "enable-global-virtual-store",
                "ignoreScripts",
                "ignore-scripts",
                "production",
                "dev",
                "optional",
            ]
            .contains(&k.as_str())
        })
        .collect();
    parts.push(serde_json::to_vec(&selected).unwrap());
    let bytes: Vec<u8> = parts
        .into_iter()
        .flat_map(|part| (part.len() as u64).to_be_bytes().into_iter().chain(part))
        .collect();
    Ok(sha256_hex(&bytes))
}

fn note(ctx: &mut Ctx, value: &str) {
    ctx.notes.push(("deps_cache".into(), value.into()));
    events::stage("deps_cache", StageState::Passed, Some(value), None);
}
fn timed(ctx: &mut Ctx, name: &'static str, started: u64) {
    let stage = match name {
        "restore" => "deps_cache_restore",
        "stage" => "deps_cache_stage",
        _ => "deps_cache_publish",
    };
    events::stage(
        stage,
        StageState::Passed,
        None,
        Some(ctx.runner.now_epoch_ms().saturating_sub(started)),
    );
    ctx.timings.push((
        format!("deps_cache_{name}"),
        ctx.runner.now_epoch_ms().saturating_sub(started),
    ));
}

pub(crate) fn restore(ctx: &mut Ctx, repository: &Path, enabled: bool) -> Result<(), Failure> {
    if !enabled {
        note(ctx, "disabled");
        return Ok(());
    }
    let started = ctx.runner.now_epoch_ms();
    let candidate = &ctx.record.candidate;
    let repo = candidate.repo_root.clone();
    let project = candidate.project_root.clone();
    let Ok(app_rel) = project.strip_prefix(&repo) else {
        note(ctx, "layout-unsupported");
        return Ok(());
    };
    // Missing inputs disable reuse without changing the existing install path.
    if !repo.join("package.json").is_file() || !project.join("pnpm-lock.yaml").is_file() {
        note(ctx, "disabled");
        return Ok(());
    }
    let (installer, effective) = match probe(ctx.runner, &project) {
        Ok(v) => v,
        Err(reason) => {
            note(ctx, &reason);
            return Ok(());
        }
    };
    ctx.record.resources.deps_installer = Some(installer.clone());
    ctx.save()?;
    if let Err(reason) = layout(&effective, &repo, app_rel) {
        note(ctx, &reason);
        return Ok(());
    }
    if supported_modules(&repo, app_rel).is_err() {
        note(ctx, "layout-unsupported");
        return Ok(());
    }
    let repo_id = sha256_hex(repository.as_os_str().as_encoded_bytes());
    let key = match key(&repo, app_rel, &repo_id, &installer, &effective) {
        Ok(key) => key,
        Err(_) => {
            note(ctx, "disabled");
            return Ok(());
        }
    };
    let resource = CacheResource {
        repo_id,
        key,
        reader: true,
        staging: false,
        enabled: true,
    };
    let dir = repo_dir(&ctx.runs_root, &resource).unwrap();
    let entry_path = dir.join(&resource.key);
    ctx.record.resources.deps_cache = Some(resource);
    ctx.save()?;
    events::stage("deps_cache_restore", StageState::Running, None, None);
    let admitted = (|| -> Result<Option<Entry>, String> {
        let _guard = lock(
            ctx.runner,
            &ctx.runs_root,
            &ctx.record.run_id,
            ctx.record.prepare.as_ref(),
        )?;
        directory(&dir, true)?;
        if !directory(&entry_path, false)? {
            return Ok(None);
        }
        let entry = read_entry(
            &entry_path,
            ctx.record.resources.deps_cache.as_ref().unwrap(),
            app_rel,
        )?;
        directory(&entry_path.join(".readers"), true)?;
        buildplan::save_json(
            &entry_path.join(".readers").join(&ctx.record.run_id),
            &ctx.record.prepare,
        )
        .map_err(|e| e.to_string())?;
        Ok(Some(entry))
    })();
    match admitted {
        Ok(None) => note(ctx, "miss"),
        Err(_) => {
            ctx.record.resources.deps_cache = None;
            ctx.save()?;
            note(ctx, "disabled");
        }
        Ok(Some(entry)) => {
            let result = (|| {
                space(ctx.runner, &[&ctx.runs_root, &repo], entry.bytes)?;
                restore_modules(ctx.runner, &entry_path.join("tree"), &repo, &entry.modules)
            })();
            match result {
                Ok(()) => note(ctx, "hit"),
                Err(reason) => {
                    note(ctx, &reason);
                    ctx.record.resources.deps_cache.as_mut().unwrap().enabled = false;
                    if reason == "restore-cleanup-failed" {
                        return Err(Failure::new(
                            "deps",
                            crate::failure::FailureCode::DepsInstallFailed,
                            "partial dependency restore could not be removed",
                            "run qaren cleanup for this run before retrying",
                        ));
                    }
                }
            }
        }
    }
    timed(ctx, "restore", started);
    Ok(())
}

fn space(runner: &mut dyn Runner, paths: &[&Path], bytes: u64) -> Result<(), String> {
    let (kb, _) = crate::run::tightest_volume(runner, paths).map_err(|_| "disabled".to_string())?;
    if kb.saturating_mul(1024) < RESERVE_BYTES.saturating_add(bytes) {
        return Err("disabled".into());
    }
    Ok(())
}

fn clone_modules(runner: &mut dyn Runner, src: &Path, dest: &Path) -> Result<(), String> {
    if dest.symlink_metadata().is_ok() {
        return Err("disabled".into());
    }
    std::fs::create_dir_all(dest.parent().ok_or("disabled")?).map_err(|_| "disabled")?;
    let args = if cfg!(target_os = "macos") {
        vec!["-c", "-R"]
    } else {
        vec!["-R", "--reflink=always"]
    };
    let src = src.to_str().ok_or("disabled")?;
    let dest = dest.to_str().ok_or("disabled")?;
    let mut args = args;
    args.extend([src, dest]);
    let out = runner.run(&CmdSpec::new("deps-cache-clone", "cp", &args, 120));
    if !out.ok() {
        return Err("clone-unsupported".into());
    }
    Ok(())
}

fn restore_modules(
    runner: &mut dyn Runner,
    source: &Path,
    repo: &Path,
    modules: &[PathBuf],
) -> Result<(), String> {
    if modules
        .iter()
        .any(|rel| repo.join(rel).symlink_metadata().is_ok())
    {
        return Err("disabled".into());
    }
    let mut copied = Vec::new();
    for rel in modules {
        copied.push(repo.join(rel));
        if let Err(reason) = clone_modules(runner, &source.join(rel), &repo.join(rel)) {
            for path in copied {
                match std::fs::remove_dir_all(path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err("restore-cleanup-failed".into()),
                }
            }
            return Err(reason);
        }
    }
    Ok(())
}

fn tree_bytes(path: &Path, containment: &Path) -> Result<u64, String> {
    let containment = containment.canonicalize().map_err(|e| e.to_string())?;
    tree_size(path, &containment)
}

fn tree_size(path: &Path, containment: &Path) -> Result<u64, String> {
    let meta = path.symlink_metadata().map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(path).map_err(|e| e.to_string())?;
        if target.is_absolute()
            || !path
                .canonicalize()
                .map_err(|e| e.to_string())?
                .starts_with(containment)
        {
            return Err("layout-unsupported".into());
        }
        return Ok(meta.len());
    }
    if meta.is_file() {
        return Ok(meta.len());
    }
    if !meta.is_dir() {
        return Err("layout-unsupported".into());
    }
    let mut bytes = 0u64;
    for child in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let child = child.map_err(|e| e.to_string())?;
        if child.file_name() == ".pnpm" && child.path().is_dir() {
            for item in std::fs::read_dir(child.path()).map_err(|e| e.to_string())? {
                if item.map_err(|e| e.to_string())?.file_name() != "lock.yaml" {
                    return Err("layout-unsupported".into());
                }
            }
        }
        bytes = bytes.saturating_add(tree_size(&child.path(), containment)?);
    }
    Ok(bytes)
}

fn supported_modules(repo: &Path, app_rel: &Path) -> Result<Vec<PathBuf>, String> {
    let allowed = modules_paths(app_rel);
    if !directory_chain(repo, app_rel)? {
        return Err("layout-unsupported".into());
    }
    fn scan(path: &Path, repo: &Path, allowed: &[PathBuf]) -> Result<(), String> {
        for item in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let name = item.file_name();
            if name == ".git" || name == ".qaren" {
                continue;
            }
            let meta = item.path().symlink_metadata().map_err(|e| e.to_string())?;
            if name == "node_modules" {
                if !meta.is_dir() || !allowed.iter().any(|rel| repo.join(rel) == item.path()) {
                    return Err("layout-unsupported".into());
                }
            } else if meta.is_dir() {
                scan(&item.path(), repo, allowed)?;
            }
        }
        Ok(())
    }
    scan(repo, repo, &allowed)?;
    Ok(allowed
        .into_iter()
        .filter(|rel| repo.join(rel).is_dir())
        .collect())
}

fn directory_chain(root: &Path, relative: &Path) -> Result<bool, String> {
    let mut path = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("layout-unsupported".into());
        };
        path.push(name);
        if !directory(&path, false)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn read_entry(path: &Path, resource: &CacheResource, app_rel: &Path) -> Result<Entry, String> {
    let entry: Entry =
        serde_json::from_slice(&std::fs::read(path.join("entry.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let allowed = modules_paths(app_rel);
    if entry.schema != SCHEMA
        || entry.key != resource.key
        || entry.modules.is_empty()
        || entry
            .modules
            .iter()
            .any(|rel| !relative(rel) || !allowed.contains(rel))
    {
        return Err("invalid dependency cache entry".into());
    }
    for rel in &entry.modules {
        if !directory_chain(path, &Path::new("tree").join(rel))? {
            return Err("missing cached modules".into());
        }
    }
    Ok(entry)
}

pub(crate) fn stage(ctx: &mut Ctx) -> Result<(), Failure> {
    let Some(mut resource) = ctx
        .record
        .resources
        .deps_cache
        .clone()
        .filter(|r| r.enabled)
    else {
        return Ok(());
    };
    let started = ctx.runner.now_epoch_ms();
    let repo = ctx.record.candidate.repo_root.clone();
    let app_rel = ctx
        .record
        .candidate
        .project_root
        .strip_prefix(&repo)
        .unwrap()
        .to_path_buf();
    let dir = repo_dir(&ctx.runs_root, &resource).unwrap();
    // Publish keeps an existing entry, so a second copy of a hit would only be deleted.
    if directory(&dir.join(&resource.key), false).unwrap_or(false) {
        return Ok(());
    }
    let staged = staging_dir(&dir, &ctx.record.run_id).unwrap();
    resource.staging = true;
    ctx.record.resources.deps_cache = Some(resource.clone());
    ctx.save()?;
    events::stage("deps_cache_stage", StageState::Running, None, None);
    let result = (|| -> Result<(), String> {
        let modules = supported_modules(&repo, &app_rel)?;
        if modules.is_empty() {
            return Err("layout-unsupported".into());
        }
        let bytes = modules.iter().try_fold(0u64, |n, rel| {
            tree_bytes(&repo.join(rel), &repo.join(rel)).map(|s| n.saturating_add(s))
        })?;
        space(ctx.runner, &[&ctx.runs_root, &repo], bytes)?;
        {
            let _guard = lock(
                ctx.runner,
                &ctx.runs_root,
                &ctx.record.run_id,
                ctx.record.prepare.as_ref(),
            )?;
            directory(&dir, true)?;
            directory(&dir.join(".staging"), true)?;
            if directory(&staged, false)? {
                return Err("disabled".into());
            }
            directory(&staged, true)?;
            buildplan::save_json(&staged.join("owner.json"), &ctx.record.prepare)
                .map_err(|e| e.to_string())?;
        }
        for rel in &modules {
            clone_modules(ctx.runner, &repo.join(rel), &staged.join("tree").join(rel))?;
        }
        buildplan::save_json(
            &staged.join("entry.json"),
            &Entry {
                schema: SCHEMA.into(),
                key: resource.key,
                created_ms: ctx.runner.now_epoch_ms(),
                modules,
                bytes,
            },
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(reason) = result {
        ctx.record.resources.deps_cache.as_mut().unwrap().enabled = false;
        if directory(&staged, false).unwrap_or(false) {
            let _ = std::fs::remove_dir_all(&staged);
        }
        note(
            ctx,
            if reason == "clone-unsupported" || reason == "layout-unsupported" {
                &reason
            } else {
                "disabled"
            },
        );
    }
    timed(ctx, "stage", started);
    Ok(())
}

pub(crate) fn publish(ctx: &mut Ctx) -> Result<(), Failure> {
    crate::cancel::ensure_running(ctx.runner, "deps")?;
    let Some(resource) = ctx
        .record
        .resources
        .deps_cache
        .clone()
        .filter(|r| r.staging)
    else {
        return Ok(());
    };
    let started = ctx.runner.now_epoch_ms();
    events::stage("deps_cache_publish", StageState::Running, None, None);
    let result = (|| -> Result<(), String> {
        let _guard = lock(
            ctx.runner,
            &ctx.runs_root,
            &ctx.record.run_id,
            ctx.record.prepare.as_ref(),
        )?;
        let repo = repo_dir(&ctx.runs_root, &resource)?;
        let staged = staging_dir(&repo, &ctx.record.run_id)?;
        reclaim_staging(ctx.runner, &repo, Some(&ctx.record.run_id))?;
        let app_rel = ctx
            .record
            .candidate
            .project_root
            .strip_prefix(&ctx.record.candidate.repo_root)
            .map_err(|e| e.to_string())?;
        if staged.join("entry.json").is_file() {
            read_entry(&staged, &resource, app_rel)?;
            if ctx.runner.cancellation().is_some() {
                return Err("disabled".into());
            }
            let dest = repo.join(&resource.key);
            if directory(&dest, false)? {
                std::fs::remove_dir_all(&staged).map_err(|e| e.to_string())?;
            } else {
                std::fs::rename(&staged, &dest).map_err(|e| e.to_string())?;
            }
        }
        prune(ctx.runner, &repo, false)?;
        Ok(())
    })();
    if result.is_err() {
        note(ctx, "disabled");
    }
    timed(ctx, "publish", started);
    Ok(())
}

fn dead(runner: &mut dyn Runner, path: &Path) -> bool {
    let owner: Option<PidIdentity> = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .flatten();
    owner.as_ref().is_some_and(|id| {
        matches!(
            probe_pid_identity(runner, id),
            PidLiveness::Dead | PidLiveness::AliveForeign
        )
    })
}
fn children(path: &Path) -> Result<Vec<PathBuf>, String> {
    if !directory(path, false)? {
        return Ok(Vec::new());
    }
    std::fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .map(|v| v.map(|v| v.path()).map_err(|e| e.to_string()))
        .collect()
}
fn reclaim_staging(
    runner: &mut dyn Runner,
    repo: &Path,
    skip_run: Option<&str>,
) -> Result<(), String> {
    for stage in children(&repo.join(".staging"))? {
        if skip_run.is_some_and(|run| stage.file_name().is_some_and(|name| name == run)) {
            continue;
        }
        if directory(&stage, false)? && dead(runner, &stage.join("owner.json")) {
            std::fs::remove_dir_all(stage).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn prune(runner: &mut dyn Runner, repo: &Path, all: bool) -> Result<(), String> {
    let mut entries = Vec::new();
    for path in children(repo)? {
        if !path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(safe_hash)
            || !directory(&path, false)?
        {
            continue;
        }
        let entry: Entry = match std::fs::read(path.join("entry.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
        {
            Some(e) => e,
            None => continue,
        };
        entries.push((entry.created_ms, path));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    for (_, path) in entries.into_iter().skip(if all { 0 } else { 2 }) {
        let readers = children(&path.join(".readers"))?;
        if readers.iter().all(|marker| dead(runner, marker)) {
            std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn cleanup_run(
    runner: &mut dyn Runner,
    runs_root: &Path,
    run_id: &str,
    identity: Option<&PidIdentity>,
    resource: &mut CacheResource,
) -> Result<(), String> {
    if !safe_run(run_id) {
        return Err("invalid cache run identity".into());
    }
    let _guard = lock(runner, runs_root, run_id, identity)?;
    let repo = repo_dir(runs_root, resource)?;
    if !directory(&repo, false)? {
        resource.reader = false;
        resource.staging = false;
        return Ok(());
    }
    let entry = repo.join(&resource.key);
    if resource.reader && directory(&entry, false)? && directory(&entry.join(".readers"), false)? {
        match std::fs::remove_file(entry.join(".readers").join(run_id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    let staged = staging_dir(&repo, run_id)?;
    if resource.staging && directory(&repo.join(".staging"), false)? && directory(&staged, false)? {
        std::fs::remove_dir_all(staged).map_err(|e| e.to_string())?;
    }
    resource.reader = false;
    resource.staging = false;
    Ok(())
}

pub fn cleanup_cache(runner: &mut dyn Runner, runs_root: &Path) -> Result<(), String> {
    if !directory(&cache_root(runs_root), false)? {
        return Ok(());
    }
    let identity = crate::runrecord::capture_pid_identity(runner, std::process::id() as i32);
    let _guard = lock(runner, runs_root, "cleanup-deps-cache", identity.as_ref())?;
    for repo in children(&cache_root(runs_root))? {
        if repo
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(safe_hash)
            && directory(&repo, false)?
        {
            reclaim_staging(runner, &repo, None)?;
            prune(runner, &repo, true)?;
        }
    }
    Ok(())
}

pub fn inventory(runs_root: &Path) -> Result<String, String> {
    let mut entries = 0;
    let mut staging = 0;
    let mut bytes = 0u64;
    for repo in children(&cache_root(runs_root))? {
        if !repo
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(safe_hash)
        {
            continue;
        }
        for stage in children(&repo.join(".staging"))? {
            staging += 1;
            bytes = bytes.saturating_add(tree_bytes(&stage, &stage)?);
        }
        for entry in children(&repo)? {
            if entry
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(safe_hash)
            {
                entries += 1;
                let recorded: Entry = serde_json::from_slice(
                    &std::fs::read(entry.join("entry.json")).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                bytes = bytes.saturating_add(recorded.bytes);
            }
        }
    }
    Ok(format!(
        "{entries} entries, {staging} staging, {bytes} bytes (apparent size)"
    ))
}

#[cfg(test)]
mod tests;
