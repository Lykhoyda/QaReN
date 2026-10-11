use crate::candidate::sha256_hex;
use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub const FINGERPRINT_VERSION: &str = "rnfp1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeFingerprint {
    pub value: String,
    pub file_count: usize,
    pub native_dir_in_candidate: bool,
    // Reuse of a cached binary is only legal when the input set is provably
    // complete; a dynamic app.config.* is complete only once the app's own
    // @expo/fingerprint has evaluated it.
    pub complete: bool,
    pub incompleteness: Vec<String>,
    // Hash-only evidence of what `value` composes: rnfp, plus expo and toolchain for a dynamic config.
    pub parts: BTreeMap<String, String>,
    pub expo_fingerprint_ms: Option<u64>,
    // The closed-template cause when a dynamic config's Expo fingerprint could not be computed.
    pub expo_unavailable: Option<String>,
}

impl NativeFingerprint {
    pub fn with_ios_workspace(mut self, spec: Option<&crate::scenario::IosWorkspaceBuild>) -> Self {
        if let Some(spec) = spec {
            let bytes = serde_json::to_vec(&(
                "qaren-ios-workspace-build/2",
                &self.value,
                &spec.workspace,
                &spec.scheme,
            ))
            .expect("fingerprint and workspace strings serialize to JSON");
            self.value = format!("{FINGERPRINT_VERSION}:{}", sha256_hex(&bytes));
        }
        self
    }
}

// Native inputs are the files git considers part of the candidate (tracked or
// untracked-but-not-ignored); generated dirs like a CNG ios/ are ignored by
// git and therefore excluded — they are build outputs, not inputs.
fn is_native_input(rel: &str, platform_dir: &str) -> bool {
    match rel {
        "package.json"
        | "pnpm-lock.yaml"
        | "app.json"
        | "eas.json"
        | "app.config.js"
        | "app.config.ts"
        | "app.config.mjs"
        | "app.config.cjs"
        | "react-native.config.js"
        | "react-native.config.ts" => return true,
        _ => {}
    }
    if rel.starts_with("plugins/") || rel.starts_with("assets/") || rel.starts_with("patches/") {
        return true;
    }
    if let Some(inside) = rel.strip_prefix(&format!("{platform_dir}/")) {
        let excluded = match platform_dir {
            "ios" => {
                inside.starts_with("build/")
                    || inside.starts_with("Pods/")
                    || inside.starts_with("DerivedData/")
            }
            "android" => {
                inside.starts_with("build/")
                    || inside.starts_with("app/build/")
                    || inside.starts_with(".gradle/")
                    || inside.starts_with(".cxx/")
                    || inside == "local.properties"
            }
            _ => false,
        };
        return !excluded;
    }
    false
}

fn is_dynamic_config(rel: &str) -> bool {
    matches!(
        rel,
        "app.config.js" | "app.config.ts" | "app.config.mjs" | "app.config.cjs"
    )
}

#[derive(Debug, Default)]
struct ReferencedInputs {
    files: BTreeSet<String>,
    modules: Vec<String>,
    packages: BTreeSet<String>,
    incompleteness: Vec<String>,
}

// Static app.json can reference native inputs by relative path (icons, splash
// images, googleServicesFile, local config plugins, ...); every resolvable
// referenced file joins the manifest so an asset change invalidates reuse.
// An explicit local ref that cannot be resolved leaves the set unprovably
// complete, as does an app.json that does not parse.
fn referenced_paths(app_json: &str, project_root: &Path) -> ReferencedInputs {
    let mut out = ReferencedInputs::default();
    let parsed = match serde_json::from_str::<serde_json::Value>(app_json) {
        Ok(parsed) => parsed,
        Err(e) => {
            out.incompleteness.push(format!(
                "app.json does not parse as JSON ({e}); referenced native assets cannot be enumerated"
            ));
            return out;
        }
    };
    if let Some(plugins) = parsed.pointer("/expo/plugins").and_then(|v| v.as_array()) {
        for plugin in plugins {
            let reference = plugin
                .as_str()
                .or_else(|| plugin.as_array()?.first()?.as_str());
            if let Some(reference) = reference {
                if reference.starts_with('.') || project_root.join(reference).is_file() {
                    out.modules.push(
                        reference
                            .strip_prefix("./")
                            .unwrap_or(reference)
                            .to_string(),
                    );
                } else {
                    out.packages.insert(reference.to_string());
                }
            }
        }
    }
    collect_strings(&parsed, &mut |s| {
        let explicit_local = s.starts_with("./") || s.starts_with("../");
        let candidate = s.strip_prefix("./").unwrap_or(s);
        if candidate.is_empty() || candidate.starts_with('/') || candidate.contains("..") {
            if explicit_local {
                out.incompleteness.push(format!(
                    "local reference {s:?} in app.json is not a plain relative path"
                ));
            }
            return;
        }
        if project_root.join(candidate).is_file() {
            out.files.insert(candidate.to_string());
            return;
        }
        if explicit_local {
            out.incompleteness.push(format!(
                "local reference {s:?} in app.json does not resolve to a file; the input set is unprovably complete"
            ));
        }
    });
    out
}

fn is_executable_module(rel: &str) -> bool {
    rel.ends_with(".js") || rel.ends_with(".ts") || rel.ends_with(".mjs") || rel.ends_with(".cjs")
}

#[derive(Debug, Default, PartialEq)]
struct Specifiers {
    found: Vec<String>,
    // `require(…)`/`import(…)` whose argument is not one plain string literal.
    unparseable: Vec<String>,
}

fn import_specifiers(source: &str) -> Specifiers {
    let mut out = Specifiers::default();
    let bytes = source.as_bytes();
    let ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$';
    let skip_ws = |mut i: usize| {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        i
    };
    let literal = |i: usize| -> Option<(String, usize)> {
        let quote = *bytes.get(i)?;
        if quote != b'\'' && quote != b'"' {
            return None;
        }
        let end = source[i + 1..].find(quote as char)? + i + 1;
        let text = &source[i + 1..end];
        (!text.contains(['\n', '\r', '\\'])).then(|| (text.to_string(), end + 1))
    };
    for keyword in ["require", "import", "from"] {
        for (at, _) in source.match_indices(keyword) {
            let end = at + keyword.len();
            if (at > 0 && ident(bytes[at - 1])) || bytes.get(end).is_some_and(|&b| ident(b)) {
                continue;
            }
            let next = skip_ws(end);
            if source[..at].trim_end().ends_with('.') {
                let line = source[..at].matches('\n').count() + 1;
                out.unparseable
                    .push(format!("property {keyword} at line {line}"));
                continue;
            }
            if keyword != "from" && bytes.get(next) == Some(&b'(') {
                let arg = skip_ws(next + 1);
                match literal(arg) {
                    Some((text, after)) if bytes.get(skip_ws(after)) == Some(&b')') => {
                        out.found.push(text)
                    }
                    _ => {
                        let line = source[..at].matches('\n').count() + 1;
                        out.unparseable.push(format!("{keyword}(…) at line {line}"));
                    }
                }
            } else if keyword != "require" {
                if let Some((text, _)) = literal(next) {
                    out.found.push(text);
                } else if keyword == "from" {
                    // Import and re-export `from` always takes a string literal; anything else is prose.
                } else {
                    let static_import = keyword == "import"
                        && source[next..].find("from").is_some_and(|offset| {
                            let binding = &source[next..next + offset];
                            !binding.trim().is_empty()
                                && binding.bytes().all(|b| {
                                    ident(b)
                                        || b.is_ascii_whitespace()
                                        || matches!(b, b'{' | b'}' | b',' | b'*')
                                })
                                && literal(skip_ws(next + offset + 4)).is_some()
                        });
                    if !static_import {
                        out.unparseable.push(format!(
                            "{keyword} at line {}",
                            source[..at].matches('\n').count() + 1
                        ));
                    }
                }
            } else {
                out.unparseable.push(format!(
                    "{keyword} at line {}",
                    source[..at].matches('\n').count() + 1
                ));
            }
        }
    }
    out
}

fn normalize_rel(base_dir: &str, specifier: &str) -> Option<String> {
    let joined = if base_dir.is_empty() {
        specifier.to_string()
    } else {
        format!("{base_dir}/{specifier}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

// A local config plugin can import native configuration from other project
// modules; the deterministic closure over relative import specifiers keeps
// those inputs in the manifest. A relative import that cannot be resolved
// leaves the set unprovably complete.
fn trace_local_imports(
    project_root: &Path,
    seeds: Vec<String>,
    inputs: &mut BTreeSet<String>,
    packages: &mut BTreeSet<String>,
    incompleteness: &mut Vec<String>,
) {
    let mut worklist = seeds;
    let mut visited: BTreeSet<String> = BTreeSet::new();
    while let Some(rel) = worklist.pop() {
        if !visited.insert(rel.clone()) {
            continue;
        }
        if !Path::new(&rel)
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
        {
            incompleteness.push(format!("local module {rel} is not a project-relative file"));
            continue;
        }
        let mut path = project_root.to_path_buf();
        let regular = Path::new(&rel).components().all(|component| {
            path.push(component);
            std::fs::symlink_metadata(&path)
                .is_ok_and(|metadata| !metadata.file_type().is_symlink())
        }) && path.is_file();
        if !regular || !(is_executable_module(&rel) || rel.ends_with(".json")) {
            incompleteness.push(format!("local module {rel} is not a regular non-symlink file with a recognized extension; its dependencies cannot be proven complete"));
            continue;
        }
        let Ok(source) = std::fs::read_to_string(project_root.join(&rel)) else {
            incompleteness.push(format!(
                "local module {rel} could not be read; its imports cannot be enumerated"
            ));
            continue;
        };
        if rel.ends_with(".json") {
            if serde_json::from_str::<serde_json::Value>(&source).is_err() {
                incompleteness.push(format!("local module {rel} does not parse as JSON"));
            }
            continue;
        }
        let bytes = source.as_bytes();
        let identifier = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$';
        if source.match_indices("process").any(|(at, _)| {
            (at == 0 || !identifier(bytes[at - 1]))
                && !bytes.get(at + 7).is_some_and(|&b| identifier(b))
        }) {
            incompleteness.push(format!(
                "local module {rel} uses process; ambient inputs are unbound"
            ));
        }
        let base_dir = rel.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
        let specifiers = import_specifiers(&source);
        if specifiers
            .found
            .iter()
            .any(|specifier| !specifier.starts_with('.'))
            && project_root
                .join(base_dir)
                .ancestors()
                .take_while(|dir| *dir != project_root)
                .any(|dir| dir.join("node_modules").is_dir())
        {
            incompleteness.push(
                "traced module has nested node_modules on its import resolution path; the input set is unprovably complete"
                    .to_string(),
            );
        }
        for site in &specifiers.unparseable {
            incompleteness.push(format!(
                "{site} in {rel} is not a plain string literal; its import cannot be enumerated"
            ));
        }
        for specifier in specifiers.found {
            if !specifier.starts_with('.') {
                packages.insert(specifier);
                continue;
            }
            let Some(normalized) = normalize_rel(base_dir, &specifier) else {
                incompleteness.push(format!(
                    "import {specifier:?} in {rel} escapes the project root"
                ));
                continue;
            };
            match project_root.join(&normalized).is_file() {
                true => {
                    inputs.insert(normalized.clone());
                    worklist.push(normalized);
                }
                false => incompleteness.push(format!(
                    "import {specifier:?} in {rel} does not resolve to a project file; the input set is unprovably complete"
                )),
            }
        }
    }
}

const NODE_BUILTINS: &[&str] = &[
    "assert",
    "buffer",
    "child_process",
    "crypto",
    "events",
    "fs",
    "http",
    "https",
    "module",
    "net",
    "os",
    "path",
    "process",
    "querystring",
    "readline",
    "stream",
    "string_decoder",
    "timers",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "worker_threads",
    "zlib",
];

const PURE_NODE_BUILTINS: &[&str] = &[
    "path",
    "url",
    "util",
    "assert",
    "events",
    "buffer",
    "string_decoder",
    "querystring",
];

fn package_manifest(
    project_root: &Path,
    repo_root: &Path,
    packages: &BTreeSet<String>,
    manifest: &mut Vec<(String, String)>,
    incompleteness: &mut Vec<String>,
) {
    let mut versions: BTreeMap<String, String> = BTreeMap::new();
    for specifier in packages {
        let builtin = specifier.strip_prefix("node:").unwrap_or(specifier);
        let root = builtin.split('/').next().unwrap_or(builtin);
        if PURE_NODE_BUILTINS.contains(&root) {
            continue;
        }
        if specifier.starts_with("node:") || NODE_BUILTINS.contains(&root) {
            incompleteness.push(format!(
                "Node built-in {specifier:?} may read unbound inputs; the input set is unprovably complete"
            ));
            continue;
        }
        let segments = if specifier.starts_with('@') { 2 } else { 1 };
        let name = specifier
            .split('/')
            .take(segments)
            .collect::<Vec<_>>()
            .join("/");
        let valid = name.split('/').count() == segments
            && name.split('/').all(|part| {
                !part.is_empty() && part != "." && part != ".." && !part.contains('\\')
            });
        if !valid {
            incompleteness.push(format!(
                "package {specifier:?} is not a resolvable package name; the input set is unprovably complete"
            ));
            continue;
        }
        if versions.contains_key(&name) {
            continue;
        }
        let mut dir = Some(project_root);
        let mut found = None;
        let mut local = false;
        while let Some(current) = dir.filter(|d| d.starts_with(repo_root)) {
            if let Some(parsed) = std::fs::read_to_string(current.join("package.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            {
                local = ["dependencies", "devDependencies", "optionalDependencies"]
                    .iter()
                    .filter_map(|section| parsed.get(section)?.get(&name)?.as_str())
                    .any(|spec| {
                        spec.starts_with("file:")
                            || spec.starts_with("link:")
                            || spec.starts_with("workspace:")
                    });
                if local {
                    break;
                }
            }
            let candidate = current
                .join("node_modules")
                .join(&name)
                .join("package.json");
            if candidate.is_file() {
                found = Some(candidate);
                break;
            }
            dir = current.parent();
        }
        if let Some(path) = &found {
            if let (Ok(resolved), Ok(root)) = (path.canonicalize(), repo_root.canonicalize()) {
                if let Ok(relative) = resolved.strip_prefix(root) {
                    local = !relative
                        .components()
                        .any(|part| part.as_os_str() == "node_modules");
                }
            }
        }
        if local {
            incompleteness.push(format!(
                "local package plugin {name} is not traced; the input set is unprovably complete"
            ));
            continue;
        }
        let version = found
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|parsed| parsed.get("version")?.as_str().map(str::to_string));
        match version {
            Some(version) => {
                versions.insert(name, version);
            }
            None => incompleteness.push(format!(
                "package {name} (from {specifier:?}) does not resolve to a versioned package from the project root; the input set is unprovably complete"
            )),
        }
    }
    manifest.extend(
        versions
            .into_iter()
            .map(|(name, version)| (format!("package:{name}"), format!("version:{version}"))),
    );
}

fn local_dependency_manifest(
    project_root: &Path,
    repo_root: &Path,
    package_json: &str,
    manifest: &mut Vec<(String, String)>,
    incompleteness: &mut Vec<String>,
) {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(package_json) else {
        incompleteness.push(
            "package.json does not parse as JSON; local dependencies cannot be enumerated"
                .to_string(),
        );
        return;
    };
    let mut locals: Vec<(String, String)> = Vec::new();
    for section in ["dependencies", "devDependencies", "optionalDependencies"] {
        let Some(deps) = parsed.get(section).and_then(|d| d.as_object()) else {
            continue;
        };
        for (name, spec) in deps {
            let Some(spec) = spec.as_str() else { continue };
            if let Some(rel) = spec
                .strip_prefix("file:")
                .or_else(|| spec.strip_prefix("link:"))
            {
                locals.push((name.clone(), rel.to_string()));
            } else if spec.starts_with("workspace:") {
                incompleteness.push(format!(
                    "dependency {name} uses a workspace: specifier that qaren does not resolve; the input set is unprovably complete"
                ));
            }
        }
    }
    for (name, rel) in locals {
        let dep_dir = project_root.join(&rel);
        let (Ok(resolved), Ok(root)) = (dep_dir.canonicalize(), repo_root.canonicalize()) else {
            incompleteness.push(format!(
                "local dependency {name} ({rel}) cannot be resolved; the input set is unprovably complete"
            ));
            continue;
        };
        if !resolved.starts_with(&root) {
            incompleteness.push(format!(
                "local dependency {name} ({rel}) resolves outside the worktree; its native surface cannot be bound"
            ));
            continue;
        }
        let mut files = Vec::new();
        if let Err(detail) = collect_dep_surface(&resolved, &resolved, &mut files) {
            incompleteness.push(format!(
                "native inputs of local dependency {name} could not be enumerated: {detail}"
            ));
        }
        files.sort();
        for file_rel in files {
            let path = resolved.join(&file_rel);
            match hash_entry(
                &path,
                &format!("dep:{name}/{file_rel}"),
                repo_root,
                incompleteness,
            ) {
                Ok(hash) => manifest.push((format!("dep:{name}/{file_rel}"), hash)),
                Err(detail) => incompleteness.push(format!(
                    "native surface of local dependency {name} could not be proven: {detail}"
                )),
            }
        }
    }
}

fn collect_dep_surface(base: &Path, dir: &Path, files: &mut Vec<String>) -> Result<(), String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("cannot enumerate {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot enumerate {}: {e}", dir.display()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
        let name = entry.file_name();
        if name == ".git"
            || (file_type.is_dir()
                && matches!(
                    name.to_str(),
                    Some("node_modules" | "build" | ".gradle" | ".cxx" | "Pods" | "DerivedData")
                ))
        {
            continue;
        }
        if file_type.is_dir() {
            collect_dep_surface(base, &path, files)?;
        } else if file_type.is_file() || file_type.is_symlink() {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| format!("cannot bind {}: {e}", path.display()))?;
            let rel = rel
                .to_str()
                .ok_or_else(|| format!("cannot encode dependency path {}", path.display()))?;
            files.push(rel.to_string());
        } else {
            return Err(format!(
                "dependency input {} is not a plain file",
                path.display()
            ));
        }
    }
    Ok(())
}

// A regular file reached through a symlinked ancestor can resolve outside the
// worktree; its content is still hashed, but the escape is flagged so reuse
// is refused rather than bound to foreign state.
fn contained_or_flag(path: &Path, rel: &str, repo_root: &Path, incompleteness: &mut Vec<String>) {
    if path.is_symlink() {
        return;
    }
    let (Ok(resolved), Ok(root)) = (path.canonicalize(), repo_root.canonicalize()) else {
        return;
    };
    if !resolved.starts_with(&root) {
        incompleteness.push(format!(
            "native input {rel} resolves outside the worktree ({}); its content cannot be bound",
            resolved.display()
        ));
    }
}

fn collect_strings(value: &serde_json::Value, visit: &mut impl FnMut(&str)) {
    match value {
        serde_json::Value::String(s) => visit(s),
        serde_json::Value::Array(items) => {
            for item in items {
                collect_strings(item, visit);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                collect_strings(item, visit);
            }
        }
        _ => {}
    }
}

// A symlink hashes its link text plus, when the target resolves to a regular
// file inside the authorized worktree, the target content — so an unchanged
// link to changed content still invalidates reuse. A target outside the
// worktree (or an unenumerable directory target) leaves the input set
// unprovably complete instead of coupling the fingerprint to foreign state.
fn hash_entry(
    path: &Path,
    rel: &str,
    repo_root: &Path,
    incompleteness: &mut Vec<String>,
) -> Result<String, String> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(path)
            .map_err(|e| format!("cannot read symlink {}: {e}", path.display()))?;
        let link_hash = format!("symlink:{}", target.display());
        let resolved = path.canonicalize().ok();
        let inside = resolved.as_ref().is_some_and(|r| {
            repo_root
                .canonicalize()
                .map(|root| r.starts_with(root))
                .unwrap_or(false)
        });
        return match resolved {
            None => {
                incompleteness.push(format!(
                    "native input {rel} is a broken or unresolvable symlink; its target cannot be bound"
                ));
                Ok(sha256_hex(link_hash.as_bytes()))
            }
            Some(resolved) if inside && resolved.is_file() => {
                let content = std::fs::read(&resolved)
                    .map_err(|e| format!("cannot read symlink target of {rel}: {e}"))?;
                Ok(sha256_hex(
                    format!("{link_hash}\0{}", sha256_hex(&content)).as_bytes(),
                ))
            }
            Some(_) => {
                incompleteness.push(format!(
                    "native input {rel} is a symlink whose target is outside the worktree or not a plain file; its content cannot be bound"
                ));
                Ok(sha256_hex(link_hash.as_bytes()))
            }
        };
    }
    match std::fs::read(path) {
        Ok(bytes) => Ok(sha256_hex(&bytes)),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

pub fn compute(
    runner: &mut dyn Runner,
    repo_root: &Path,
    project_root: &Path,
    platform_dir: &str,
) -> Result<NativeFingerprint, Failure> {
    let Ok(project_rel_path) = project_root.strip_prefix(repo_root) else {
        return Err(Failure::new(
            "plan",
            FailureCode::CandidatePathInvalid,
            format!(
                "{} is not contained in {}; refusing to fingerprint outside the candidate worktree",
                project_root.display(),
                repo_root.display()
            ),
            "fix candidate.project_root / candidate.worktree in the scenario",
        ));
    };
    let project_rel = project_rel_path.to_string_lossy().into_owned();
    let pathspec = if project_rel.is_empty() {
        ".".to_string()
    } else {
        project_rel.clone()
    };
    let listed = runner.run(&CmdSpec::new(
        "git-ls-files",
        "git",
        &[
            "-C",
            &repo_root.to_string_lossy(),
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            &pathspec,
        ],
        60,
    ));
    if !listed.ok() {
        return Err(Failure::new(
            "plan",
            FailureCode::CandidateGitUnavailable,
            format!(
                "git ls-files for the native fingerprint failed: {}",
                listed.summary()
            ),
            "ensure git can inspect the candidate worktree, then re-run prepare",
        ));
    }
    let prefix = if project_rel.is_empty() {
        String::new()
    } else {
        format!("{project_rel}/")
    };
    let mut inputs: BTreeSet<String> = BTreeSet::new();
    let mut dynamic_config = None;
    for entry in listed.stdout.split('\0') {
        if entry.is_empty() {
            continue;
        }
        let Some(rel) = entry.strip_prefix(&prefix) else {
            continue;
        };
        if is_native_input(rel, platform_dir) {
            if is_dynamic_config(rel) {
                dynamic_config = Some(rel.to_string());
            }
            inputs.insert(rel.to_string());
        }
    }
    let mut incompleteness = Vec::new();
    let mut dep_manifest: Vec<(String, String)> = Vec::new();
    let mut packages: BTreeSet<String> = BTreeSet::new();
    let mut evaluated: Option<(String, Result<String, String>)> = None;
    let mut expo_fingerprint_ms = None;
    let mut expo_unavailable = None;
    if let Some(config) = &dynamic_config {
        if platform_dir == "ios" {
            let started = runner.monotonic_ms();
            let expo = expo_fingerprint(runner, project_root, platform_dir);
            expo_fingerprint_ms = Some(runner.monotonic_ms().saturating_sub(started));
            match expo {
                Ok(expo) => evaluated = Some((expo, toolchain_digest(runner))),
                Err(reason) => expo_unavailable = Some(reason),
            }
        }
        if evaluated.is_none() {
            incompleteness.push(format!(
                "{config} is a dynamic config whose imports and ambient inputs (environment and process reads) cannot be fingerprinted"
            ));
        }
        if let Some(reason) = &expo_unavailable {
            incompleteness.push(format!("Expo fingerprint unavailable: {reason}"));
        }
    }
    if let Some((_, Err(reason))) = &evaluated {
        incompleteness.push(format!(
            "toolchain identity unavailable ({reason}); reuse across an unknown Xcode is unprovable"
        ));
    }
    if inputs.contains("app.json") {
        match std::fs::read_to_string(project_root.join("app.json")) {
            Ok(app_json) => {
                let referenced = referenced_paths(&app_json, project_root);
                incompleteness.extend(referenced.incompleteness);
                packages.extend(referenced.packages);
                let executable_seeds = referenced
                    .modules
                    .into_iter()
                    .chain(
                        referenced
                            .files
                            .iter()
                            .filter(|rel| is_executable_module(rel))
                            .cloned(),
                    )
                    .collect();
                inputs.extend(referenced.files);
                trace_local_imports(
                    project_root,
                    executable_seeds,
                    &mut inputs,
                    &mut packages,
                    &mut incompleteness,
                );
            }
            Err(e) => {
                incompleteness.push(format!(
                    "app.json is listed but could not be read ({e}); referenced native assets cannot be enumerated"
                ));
            }
        }
    }
    let config_seeds = inputs
        .iter()
        .filter(|rel| {
            matches!(
                rel.as_str(),
                "react-native.config.js" | "react-native.config.ts"
            )
        })
        .cloned()
        .collect();
    trace_local_imports(
        project_root,
        config_seeds,
        &mut inputs,
        &mut packages,
        &mut incompleteness,
    );
    package_manifest(
        project_root,
        repo_root,
        &packages,
        &mut dep_manifest,
        &mut incompleteness,
    );
    if inputs.contains("package.json") {
        match std::fs::read_to_string(project_root.join("package.json")) {
            Ok(package_json) => local_dependency_manifest(
                project_root,
                repo_root,
                &package_json,
                &mut dep_manifest,
                &mut incompleteness,
            ),
            Err(e) => incompleteness.push(format!(
                "package.json is listed but could not be read ({e}); local dependencies cannot be enumerated"
            )),
        }
    }
    let native_dir_in_candidate = inputs
        .iter()
        .any(|rel| rel.starts_with(&format!("{platform_dir}/")));
    let mut entries: Vec<(String, String)> = Vec::new();
    for rel in &inputs {
        // A listed-but-deleted file still shapes the fingerprint: its absence
        // must differ from a manifest that never contained it. Any other read
        // error leaves the input unproven and must refuse, not guess.
        let path = project_root.join(rel);
        let entry = if !path.is_symlink() && !path.exists() {
            "absent".to_string()
        } else {
            contained_or_flag(&path, rel, repo_root, &mut incompleteness);
            hash_entry(&path, rel, repo_root, &mut incompleteness).map_err(|detail| {
                Failure::new(
                    "plan",
                    FailureCode::NativeInputUnreadable,
                    format!("native input {rel} could not be proven: {detail}"),
                    "make the file readable (or remove it from the candidate), then re-run prepare",
                )
            })?
        };
        entries.push((rel.clone(), entry));
    }
    entries.extend(dep_manifest);
    entries.sort();
    let mut manifest = String::new();
    for (key, hash) in &entries {
        manifest.push_str(key);
        manifest.push('\0');
        manifest.push_str(hash);
        manifest.push('\n');
    }
    let file_count = entries.len();
    let rnfp = format!("{FINGERPRINT_VERSION}:{}", sha256_hex(manifest.as_bytes()));
    let mut parts = BTreeMap::from([("rnfp".to_string(), rnfp.clone())]);
    let value = match evaluated {
        Some((expo, toolchain)) => {
            let toolchain = toolchain.unwrap_or_else(|_| "unavailable".to_string());
            let bytes = serde_json::to_vec(&("qaren-expo-native/1", &rnfp, &expo, &toolchain))
                .expect("fingerprint parts serialize to JSON");
            parts.insert("expo".to_string(), expo);
            parts.insert("toolchain".to_string(), toolchain);
            format!("{FINGERPRINT_VERSION}:{}", sha256_hex(&bytes))
        }
        None => rnfp,
    };
    Ok(NativeFingerprint {
        value,
        file_count,
        native_dir_in_candidate,
        complete: incompleteness.is_empty(),
        incompleteness,
        parts,
        expo_fingerprint_ms,
        expo_unavailable,
    })
}

const EXPO_FINGERPRINT_SECONDS: u64 = 120;

// Resolved through the app's own `expo` install so pnpm's isolated layout works without a download.
const RESOLVE_EXPO_FINGERPRINT: &str = "process.stdout.write(require.resolve('@expo/fingerprint/bin/cli.js',{paths:[require('path').dirname(require.resolve('expo/package.json',{paths:[process.argv[1]]}))]}))";

// Same launcher and environment transforms as the expo-run-ios build, so the config evaluates as the build sees it.
pub fn expo_fingerprint_spec(label: &str, project_root: &Path, args: &[&str]) -> CmdSpec {
    let mut full = vec!["exec", "node"];
    full.extend_from_slice(args);
    CmdSpec::new(label, "pnpm", &full, EXPO_FINGERPRINT_SECONDS)
        .cwd(project_root)
        .env_remove("CI")
        .env("EXPO_NO_TELEMETRY", "1")
}

// The CLI's stdout carries evaluated config contents, so only private capture is used and
// only the `hash` field is read; every failure reason is a fixed string.
fn expo_fingerprint(
    runner: &mut dyn Runner,
    project_root: &Path,
    platform: &str,
) -> Result<String, String> {
    let root = project_root.to_string_lossy();
    let resolved = runner.run_private(
        &expo_fingerprint_spec(
            "expo-fingerprint-resolve",
            project_root,
            &["-e", RESOLVE_EXPO_FINGERPRINT, &root],
        ),
        &[],
    );
    let cli = last_line(resolved.stdout());
    if !exited_zero(&resolved) || !cli.starts_with('/') || !cli.ends_with("/bin/cli.js") {
        return Err(format!(
            "@expo/fingerprint does not resolve through the app's expo install ({})",
            outcome(&resolved)
        ));
    }
    let cli = cli.to_string();
    let generated = runner.run_private(
        &expo_fingerprint_spec(
            "expo-fingerprint",
            project_root,
            &[&cli, "fingerprint:generate", "--platform", platform],
        ),
        &[],
    );
    if !exited_zero(&generated) {
        return Err(format!(
            "@expo/fingerprint fingerprint:generate did not complete ({})",
            outcome(&generated)
        ));
    }
    serde_json::from_str::<serde_json::Value>(last_line(generated.stdout()))
        .ok()
        .and_then(|result| result.get("hash")?.as_str().map(str::to_string))
        .filter(|hash| !hash.is_empty() && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(|hash| format!("expo:{hash}"))
        .ok_or_else(|| "@expo/fingerprint output carried no hex hash".to_string())
}

// pnpm can print its dependency check to stdout before the child's own output.
fn last_line(stdout: &str) -> &str {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

fn exited_zero(output: &crate::exec::PrivateOutput) -> bool {
    !output.timed_out() && output.exit_code() == Some(0)
}

fn outcome(output: &crate::exec::PrivateOutput) -> String {
    match (output.timed_out(), output.exit_code()) {
        (true, _) => format!("timed out after {EXPO_FINGERPRINT_SECONDS} s"),
        (false, Some(0)) => "exit 0 with unexpected output".to_string(),
        (false, Some(code)) => format!("exit {code}"),
        (false, None) => "terminated by a signal".to_string(),
    }
}

// The installed simulator SDK ships inside Xcode, so the selected Xcode's build version identifies both.
fn toolchain_digest(runner: &mut dyn Runner) -> Result<String, String> {
    let version = runner.run(&CmdSpec::new(
        "xcode-version",
        "xcodebuild",
        &["-version"],
        30,
    ));
    if !version.ok() || version.stdout.trim().is_empty() {
        return Err("xcodebuild -version failed".to_string());
    }
    Ok(format!(
        "xcode:{}",
        sha256_hex(version.stdout.trim().as_bytes())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_level_files_are_native_inputs() {
        for rel in [
            "package.json",
            "pnpm-lock.yaml",
            "app.json",
            "app.config.ts",
            "plugins/withThing.ts",
            "assets/icon.png",
        ] {
            assert!(
                is_native_input(rel, "ios"),
                "{rel} should be a native input"
            );
        }
    }

    #[test]
    fn js_sources_are_not_native_inputs() {
        for rel in [
            "App.tsx",
            "src/screens/Home.tsx",
            "babel.config.js",
            "index.js",
        ] {
            assert!(
                !is_native_input(rel, "ios"),
                "{rel} must not be a native input"
            );
        }
    }

    #[test]
    fn platform_dir_included_but_outputs_excluded() {
        assert!(is_native_input("ios/Podfile", "ios"));
        assert!(is_native_input("ios/testapp/Info.plist", "ios"));
        assert!(!is_native_input("ios/build/Build/x.o", "ios"));
        assert!(!is_native_input("ios/Pods/Pods.xcodeproj/x", "ios"));
        assert!(is_native_input(
            "android/app/src/main/AndroidManifest.xml",
            "android"
        ));
        assert!(!is_native_input(
            "android/app/build/outputs/apk/app.apk",
            "android"
        ));
        assert!(!is_native_input("android/.gradle/caches/x", "android"));
        assert!(!is_native_input("android/local.properties", "android"));
    }

    #[test]
    fn other_platform_dir_is_not_an_input() {
        assert!(!is_native_input("android/build.gradle", "ios"));
        assert!(!is_native_input("ios/Podfile", "android"));
    }

    #[test]
    fn referenced_paths_resolve_only_plain_existing_files() {
        let dir = std::env::temp_dir().join(format!("qaren-fp-ref-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("assets2")).unwrap();
        std::fs::write(dir.join("assets2").join("icon.png"), b"png").unwrap();
        let app_json = r#"{"expo":{"icon":"./assets2/icon.png","name":"x","other":"/etc/passwd","up":"../secret.png","missing":"./assets2/nope.png"}}"#;
        let refs = referenced_paths(app_json, &dir);
        assert_eq!(
            refs.files.into_iter().collect::<Vec<_>>(),
            vec!["assets2/icon.png".to_string()]
        );
        // `../secret.png` and the unresolvable `./assets2/nope.png` both leave
        // the set unprovably complete; the bare-absolute string is ignored.
        assert_eq!(refs.incompleteness.len(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unparseable_app_json_is_incomplete() {
        let refs = referenced_paths("not json", Path::new("/nonexistent"));
        assert!(refs.files.is_empty());
        assert_eq!(refs.incompleteness.len(), 1);
    }

    #[test]
    fn import_specifiers_finds_static_and_dynamic_forms() {
        let source = r#"
            import { withX } from './helper';
            const y = require("../lib/y");
            const z = await import('./z.json');
            import pkg from 'expo-build-properties';
        "#;
        let specs = import_specifiers(source);
        assert!(specs.unparseable.is_empty(), "{specs:?}");
        let specs = specs.found;
        assert!(specs.contains(&"./helper".to_string()));
        assert!(specs.contains(&"../lib/y".to_string()));
        assert!(specs.contains(&"./z.json".to_string()));
        assert!(specs.contains(&"expo-build-properties".to_string()));
    }

    #[test]
    fn trace_local_imports_walks_relative_closure_and_flags_unresolved() {
        let dir = std::env::temp_dir().join(format!("qaren-fp-trace-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("plugins")).unwrap();
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::write(
            dir.join("plugins").join("withThing.ts"),
            "import { helper } from '../lib/helper.ts';\nimport missing from './gone';\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("lib").join("helper.ts"),
            "export const helper = 1;\n",
        )
        .unwrap();
        let mut inputs = BTreeSet::new();
        let mut incompleteness = Vec::new();
        trace_local_imports(
            &dir,
            vec!["plugins/withThing.ts".to_string()],
            &mut inputs,
            &mut BTreeSet::new(),
            &mut incompleteness,
        );
        assert!(inputs.contains("lib/helper.ts"));
        assert_eq!(incompleteness.len(), 1, "{incompleteness:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn normalize_rel_refuses_escape() {
        assert_eq!(
            normalize_rel("plugins", "./x"),
            Some("plugins/x".to_string())
        );
        assert_eq!(
            normalize_rel("plugins", "../lib/y"),
            Some("lib/y".to_string())
        );
        assert_eq!(normalize_rel("", "../outside"), None);
    }
}
