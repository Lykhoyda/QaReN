use qaren::exec::{CmdOutput, MockRunner};
use qaren::fingerprint::{compute, NativeFingerprint, FINGERPRINT_VERSION};
use qaren::scenario::IosWorkspaceBuild;
use std::path::Path;

fn prior_fingerprint() -> NativeFingerprint {
    NativeFingerprint {
        value: "rnfp1:prior-native-inputs".into(),
        file_count: 7,
        native_dir_in_candidate: true,
        complete: true,
        incompleteness: vec![],
        parts: Default::default(),
        expo_fingerprint_ms: None,
        expo_unavailable: None,
    }
}

#[test]
fn no_workspace_preserves_the_entire_existing_fingerprint() {
    let prior = prior_fingerprint();
    assert_eq!(prior.clone().with_ios_workspace(None), prior);
}

#[test]
fn workspace_hash_uses_domain_separated_typed_json_bytes() {
    let prior = prior_fingerprint();
    let spec = IosWorkspaceBuild {
        workspace: "ios/My \"App\".xcworkspace".into(),
        scheme: "App\\Debug".into(),
    };
    let bytes = serde_json::to_vec(&(
        "qaren-ios-workspace-build/2",
        &prior.value,
        &spec.workspace,
        &spec.scheme,
    ))
    .unwrap();
    assert_eq!(
        bytes,
        br#"["qaren-ios-workspace-build/2","rnfp1:prior-native-inputs","ios/My \"App\".xcworkspace","App\\Debug"]"#
    );
    let expected = "rnfp1:8c131379d0df721b64df109680d2b7541b98f98a6e8e7a35e85816d6b2819fcb";
    let actual = prior.clone().with_ios_workspace(Some(&spec));
    assert_eq!(actual.value, expected);
    assert_eq!(actual, prior.with_ios_workspace(Some(&spec)));
}

#[test]
fn workspace_scheme_backend_and_prior_inputs_each_change_the_hash() {
    let prior = prior_fingerprint();
    let spec = IosWorkspaceBuild {
        workspace: "ios/App.xcworkspace".into(),
        scheme: "App".into(),
    };
    let actual = prior.clone().with_ios_workspace(Some(&spec));
    for changed in [
        None,
        Some(IosWorkspaceBuild {
            workspace: "ios/Other.xcworkspace".into(),
            ..spec.clone()
        }),
        Some(IosWorkspaceBuild {
            scheme: "Other".into(),
            ..spec.clone()
        }),
    ] {
        assert_ne!(
            actual.value,
            prior.clone().with_ios_workspace(changed.as_ref()).value
        );
    }
    let changed_prior = NativeFingerprint {
        value: "rnfp1:changed-native-inputs".into(),
        ..prior
    };
    assert_ne!(
        actual.value,
        changed_prior.with_ios_workspace(Some(&spec)).value
    );
    assert_eq!(FINGERPRINT_VERSION, "rnfp1");
    assert!(actual.value.starts_with("rnfp1:"));
}

#[test]
fn workspace_binding_preserves_all_facts_and_cannot_make_incomplete_inputs_complete() {
    let spec = IosWorkspaceBuild {
        workspace: "ios/App.xcworkspace".into(),
        scheme: "App".into(),
    };
    for complete in [false, true] {
        for native_dir_in_candidate in [false, true] {
            let prior = NativeFingerprint {
                complete,
                native_dir_in_candidate,
                incompleteness: if complete {
                    vec![]
                } else {
                    vec![
                        "dynamic config imports".into(),
                        "unresolved local dependency".into(),
                    ]
                },
                ..prior_fingerprint()
            };
            assert_eq!(prior.clone().with_ios_workspace(None), prior);
            let actual = prior.clone().with_ios_workspace(Some(&spec));
            assert_ne!(actual.value, prior.value);
            assert_eq!(
                actual,
                NativeFingerprint {
                    value: actual.value.clone(),
                    ..prior
                }
            );
        }
    }
}

#[test]
fn default_expo_backend_keeps_the_legacy_cache_key() {
    let mut runner = MockRunner::new();
    runner.expect_run("ls-files", CmdOutput::success(""));
    let root = Path::new("/candidate");
    let prior = compute(&mut runner, root, root, "ios").unwrap();
    assert_eq!(
        prior.value,
        "rnfp1:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(prior.clone().with_ios_workspace(None), prior);
}

fn plugin_project(plugin: &str) -> std::path::PathBuf {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "qaren-fp-scan-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("plugins")).unwrap();
    std::fs::create_dir_all(root.join("config")).unwrap();
    std::fs::write(
        root.join("app.json"),
        r#"{"expo":{"plugins":["./plugins/withX.js"]}}"#,
    )
    .unwrap();
    std::fs::write(root.join("plugins/withX.js"), plugin).unwrap();
    std::fs::write(root.join("config/x.json"), r#"{"a":1}"#).unwrap();
    root
}

fn fingerprint(root: &Path) -> NativeFingerprint {
    let mut runner = MockRunner::new();
    runner.expect_run(
        "ls-files",
        CmdOutput::success("app.json\0plugins/withX.js\0config/x.json\0"),
    );
    compute(&mut runner, root, root, "ios").unwrap()
}

#[test]
fn input_reading_node_imports_forbid_native_reuse() {
    for name in [
        "fs",
        "fs/promises",
        "child_process",
        "module",
        "vm",
        "worker_threads",
        "net",
        "http",
        "https",
        "os",
        "process",
    ] {
        for specifier in [name.to_string(), format!("node:{name}")] {
            let root = plugin_project(&format!("require({specifier:?});"));
            let fp = fingerprint(&root);
            assert!(!fp.complete, "{specifier}");
            assert!(fp
                .incompleteness
                .iter()
                .any(|reason| reason.contains("unbound inputs")));
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    let root = plugin_project("require('node:unknown_builtin');");
    assert!(!fingerprint(&root).complete);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn pure_node_imports_keep_native_inputs_complete() {
    for name in [
        "path",
        "url",
        "util",
        "assert",
        "events",
        "buffer",
        "string_decoder",
        "querystring",
    ] {
        for specifier in [
            name.to_string(),
            format!("node:{name}"),
            format!("{name}/subpath"),
            format!("node:{name}/subpath"),
        ] {
            let root = plugin_project(&format!("require({specifier:?});"));
            let fp = fingerprint(&root);
            assert!(fp.complete, "{specifier}: {:?}", fp.incompleteness);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

#[test]
fn global_process_inputs_forbid_native_reuse() {
    for source in [
        "module.exports = c => { c.ios.infoPlist.NativeEndpoint = process.env.X; return c; };",
        "module.exports = process.cwd();",
        "const { env } = process; module.exports = env.X;",
        "const p = globalThis.process; module.exports = p.argv;",
        "module.exports = process['env']['X'];",
    ] {
        let root = plugin_project(source);
        let fp = fingerprint(&root);
        assert!(!fp.complete);
        assert!(fp.incompleteness.iter().any(|reason| reason
            == "local module plugins/withX.js uses process; ambient inputs are unbound"));
        std::fs::remove_dir_all(root).unwrap();
    }
    let root = plugin_project("module.exports = require('../config/ambient.js');");
    std::fs::write(
        root.join("config/ambient.js"),
        "module.exports = process.env.X;",
    )
    .unwrap();
    assert!(!fingerprint(&root).complete);
    std::fs::remove_dir_all(root).unwrap();
    let root = plugin_project("const processor = 1; module.exports = processor;");
    assert!(fingerprint(&root).complete);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_spaced_static_require_is_traced_into_the_fingerprint() {
    let root =
        plugin_project("const x = require( '../config/x.json' );\nmodule.exports = (c) => c;\n");
    let before = fingerprint(&root);
    assert!(before.complete, "{:?}", before.incompleteness);
    std::fs::write(root.join("config/x.json"), r#"{"a":2}"#).unwrap();
    let after = fingerprint(&root);
    assert_ne!(
        before.value, after.value,
        "a traced input change must invalidate reuse"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn an_unparseable_require_or_import_makes_the_fingerprint_incomplete() {
    for plugin in [
        "const name = '../config/x.json';\nconst x = require(name);\n",
        "const x = require(`../config/${'x'}.json`);\n",
        "const x = await import( name );\n",
        "const x = require /* explanation */ ('../config/x.json');",
        "const x = module.require('../config/x.json');",
        r"const x = require('\x2e./config/x.json');",
        r"const x = require('../config/\x78.json');",
        r"import x from '../config/\x78.json';",
        "const x = import /* explanation */ ('../config/x.json');",
    ] {
        let root = plugin_project(plugin);
        let fp = fingerprint(&root);
        assert!(!fp.complete, "{plugin:?} must not claim completeness");
        assert!(
            fp.incompleteness
                .iter()
                .any(|reason| reason.contains("plugins/withX.js")),
            "{:?}",
            fp.incompleteness
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[test]
fn react_native_config_imports_are_traced() {
    for name in ["react-native.config.js", "react-native.config.ts"] {
        let root = plugin_project("module.exports = (c) => c;");
        std::fs::write(
            root.join(name),
            "import x from './config/x.json'; export default x;",
        )
        .unwrap();
        let compute_config = || {
            let mut runner = MockRunner::new();
            runner.expect_run(
                "ls-files",
                CmdOutput::success(&format!("app.json\0{name}\0config/x.json\0")),
            );
            compute(&mut runner, &root, &root, "ios").unwrap()
        };
        let before = compute_config();
        assert!(before.complete, "{:?}", before.incompleteness);
        std::fs::write(root.join("config/x.json"), r#"{"a":2}"#).unwrap();
        assert_ne!(before.value, compute_config().value);
        std::fs::write(root.join(name), "module.require(name)").unwrap();
        assert!(!compute_config().complete);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn only_direct_file_dependencies_can_claim_completeness() {
    for specifier in ["../config/native", "../config/native/value", "some-package"] {
        let root = plugin_project(&format!("const native = require({specifier:?});"));
        std::fs::create_dir_all(root.join("config/native")).unwrap();
        std::fs::write(
            root.join("config/native/package.json"),
            r#"{"main":"values.json"}"#,
        )
        .unwrap();
        std::fs::write(root.join("config/native/index.js"), "module.exports = 1;").unwrap();
        std::fs::write(root.join("config/native/values.json"), "1").unwrap();
        std::fs::write(root.join("config/native/value.ts"), "export default 1;").unwrap();
        std::fs::write(root.join("config/native/value.json"), "1").unwrap();
        assert!(!fingerprint(&root).complete, "{specifier}");
        std::fs::remove_dir_all(root).unwrap();
    }
    let root = plugin_project("module.exports = 1;");
    std::fs::create_dir_all(root.join("config/native")).unwrap();
    std::fs::write(
        root.join("config/native/package.json"),
        r#"{"main":"values.json"}"#,
    )
    .unwrap();
    std::fs::write(root.join("config/native/index.js"), "module.exports = 1;").unwrap();
    std::fs::write(
        root.join("app.json"),
        r#"{"expo":{"plugins":["./config/native"]}}"#,
    )
    .unwrap();
    assert!(!fingerprint(&root).complete);
    std::fs::write(
        root.join("app.json"),
        r#"{"expo":{"plugins":["./plugins/withX"]}}"#,
    )
    .unwrap();
    assert!(!fingerprint(&root).complete);
    std::fs::write(
        root.join("app.json"),
        r#"{"expo":{"plugins":["some-package"]}}"#,
    )
    .unwrap();
    assert!(!fingerprint(&root).complete);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn extensionless_plugin_seeds_and_dependencies_forbid_reuse() {
    for seed in [true, false] {
        let root = plugin_project("require('../config/native')");
        std::fs::write(root.join("config/native"), "require('./x.json')").unwrap();
        if seed {
            std::fs::write(
                root.join("app.json"),
                r#"{"expo":{"plugins":["./config/native"]}}"#,
            )
            .unwrap();
        }
        let fp = fingerprint(&root);
        assert!(!fp.complete);
        assert!(fp
            .incompleteness
            .iter()
            .any(|reason| reason.contains("recognized extension")));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn symlinked_plugin_seeds_dependencies_and_parent_directories_forbid_reuse() {
    use std::os::unix::fs::symlink;
    for site in ["seed", "dependency", "parent"] {
        let root = plugin_project("require('../config/value.js')");
        std::fs::write(root.join("config/value.js"), "require('./x.json')").unwrap();
        match site {
            "seed" => {
                std::fs::remove_file(root.join("plugins/withX.js")).unwrap();
                symlink("../config/value.js", root.join("plugins/withX.js")).unwrap();
            }
            "dependency" => {
                symlink("value.js", root.join("config/linked.js")).unwrap();
                std::fs::write(
                    root.join("plugins/withX.js"),
                    "require('../config/linked.js')",
                )
                .unwrap();
            }
            _ => {
                symlink("config", root.join("linked")).unwrap();
                std::fs::write(
                    root.join("plugins/withX.js"),
                    "require('../linked/value.js')",
                )
                .unwrap();
            }
        }
        let fp = fingerprint(&root);
        assert!(!fp.complete, "{site}");
        assert!(fp
            .incompleteness
            .iter()
            .any(|reason| reason.contains("non-symlink")));
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn local_dependency_project(spec: &str) -> std::path::PathBuf {
    let root = plugin_project("module.exports = (c) => c;");
    std::fs::write(
        root.join("package.json"),
        serde_json::json!({"dependencies": {"foo": format!("{spec}./foo")}}).to_string(),
    )
    .unwrap();
    std::fs::create_dir_all(root.join("foo/cpp")).unwrap();
    std::fs::write(root.join("foo/package.json"), r#"{"name":"foo"}"#).unwrap();
    std::fs::write(
        root.join("foo/Foo.podspec"),
        "Pod::Spec.new { |s| s.source_files = 'ios/**', 'cpp/**/*.{cpp,h}' }",
    )
    .unwrap();
    std::fs::write(root.join("foo/cpp/Foo.cpp"), "int foo = 1;").unwrap();
    root
}

fn local_fingerprint(root: &Path, platform: &str) -> NativeFingerprint {
    let mut runner = MockRunner::new();
    runner.expect_run("ls-files", CmdOutput::success("package.json\0"));
    compute(&mut runner, root, root, platform).unwrap()
}

#[test]
fn local_dependency_cpp_inputs_invalidate_both_platform_fingerprints() {
    for spec in ["file:", "link:"] {
        let root = local_dependency_project(spec);
        let before: Vec<_> = ["ios", "android"]
            .map(|platform| local_fingerprint(&root, platform))
            .into();
        for fp in &before {
            assert!(fp.complete, "{:?}", fp.incompleteness);
        }
        std::fs::write(root.join("foo/cpp/Foo.cpp"), "int foo = 2;").unwrap();
        for (platform, before) in ["ios", "android"].into_iter().zip(before) {
            let after = local_fingerprint(&root, platform);
            assert!(after.complete, "{:?}", after.incompleteness);
            assert_ne!(before.value, after.value, "{spec} {platform}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn local_dependency_build_outputs_do_not_invalidate_fingerprints() {
    let root = local_dependency_project("file:");
    let before = local_fingerprint(&root, "ios");
    for excluded in [
        "node_modules",
        "build",
        ".gradle",
        "Pods",
        "DerivedData",
        "android/app/build",
        "ios/Pods",
        "ios/DerivedData",
        "cpp/build",
        ".cxx",
    ] {
        let dir = root.join("foo").join(excluded);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("generated"), "output").unwrap();
    }
    let after = local_fingerprint(&root, "ios");
    assert!(after.complete, "{:?}", after.incompleteness);
    assert_eq!(before.value, after.value);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn local_dependency_unreadable_files_and_directories_forbid_reuse() {
    use std::os::unix::fs::PermissionsExt;
    for spec in ["file:", "link:"] {
        for site in ["cpp/Foo.cpp", "cpp"] {
            let root = local_dependency_project(spec);
            let path = root.join("foo").join(site);
            let permissions = std::fs::metadata(&path).unwrap().permissions();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0)).unwrap();
            let fp = local_fingerprint(&root, "ios");
            std::fs::set_permissions(&path, permissions).unwrap();
            std::fs::remove_dir_all(root).unwrap();
            assert!(!fp.complete, "{spec} {site} must forbid reuse");
            assert!(
                fp.incompleteness
                    .iter()
                    .any(|reason| reason.contains("local dependency foo")),
                "{:?}",
                fp.incompleteness
            );
        }
    }
}

#[test]
fn optional_local_dependencies_bind_native_inputs_and_unresolved_workspaces() {
    for spec in ["file:", "link:", "workspace:"] {
        let root = local_dependency_project(spec);
        std::fs::write(
            root.join("package.json"),
            serde_json::json!({"optionalDependencies": {"foo": format!("{spec}./foo")}})
                .to_string(),
        )
        .unwrap();
        for platform in ["ios", "android"] {
            let before = local_fingerprint(&root, platform);
            if spec == "workspace:" {
                assert!(!before.complete);
                assert!(before
                    .incompleteness
                    .iter()
                    .any(|reason| reason.contains("workspace:")));
                continue;
            }
            assert!(before.complete, "{:?}", before.incompleteness);
            std::fs::write(
                root.join("foo/cpp/Foo.cpp"),
                format!("int foo = {};", platform.len()),
            )
            .unwrap();
            let after = local_fingerprint(&root, platform);
            assert!(after.complete, "{:?}", after.incompleteness);
            assert_ne!(before.value, after.value, "{spec} {platform}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn package_project() -> std::path::PathBuf {
    let root = plugin_project(
        "import { type ConfigPlugin, withAppDelegate } from 'expo/config-plugins';\n\
         import path from 'path';\n\
         const swift = `\n  // Scene launches read it from launch options.\n`;\n\
         export default ((c) => c) as ConfigPlugin;\n",
    );
    std::fs::rename(root.join("plugins/withX.js"), root.join("plugins/withX.ts")).unwrap();
    std::fs::write(
        root.join("app.json"),
        r#"{"expo":{"plugins":["expo-asset",["expo-build-properties",{"ios":{"deploymentTarget":"16.4"}}],"./plugins/withX.ts","expo-router","@scope/native-plugin/plugin"]}}"#,
    )
    .unwrap();
    std::fs::write(root.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n").unwrap();
    for (name, version) in [
        ("expo", "56.0.22"),
        ("expo-asset", "12.0.1"),
        ("expo-build-properties", "1.0.9"),
        ("@scope/native-plugin", "2.1.0"),
    ] {
        let dir = root.join("node_modules").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            format!(r#"{{"name":"{name}","version":"{version}"}}"#),
        )
        .unwrap();
    }
    let store = root.join("node_modules/.pnpm/expo-router@6.0.0/node_modules/expo-router");
    std::fs::create_dir_all(&store).unwrap();
    std::fs::write(
        store.join("package.json"),
        r#"{"name":"expo-router","version":"6.0.0"}"#,
    )
    .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        ".pnpm/expo-router@6.0.0/node_modules/expo-router",
        root.join("node_modules/expo-router"),
    )
    .unwrap();
    root
}

fn package_fingerprint(root: &Path) -> NativeFingerprint {
    let mut runner = MockRunner::new();
    runner.expect_run(
        "ls-files",
        CmdOutput::success("app.json\0plugins/withX.ts\0pnpm-lock.yaml\0"),
    );
    compute(&mut runner, root, root, "ios").unwrap()
}

fn local_package_plugin(spec: &str, section: &str, bare_import: bool) -> std::path::PathBuf {
    let root = local_dependency_project(spec);
    std::fs::write(
        root.join("package.json"),
        serde_json::json!({(section): {"foo": format!("{spec}./foo")}}).to_string(),
    )
    .unwrap();
    std::fs::write(
        root.join("foo/package.json"),
        r#"{"name":"foo","version":"1.0.0"}"#,
    )
    .unwrap();
    std::fs::write(root.join("foo/index.js"), "module.exports = c => c;").unwrap();
    std::fs::create_dir_all(root.join("node_modules/foo")).unwrap();
    std::fs::write(
        root.join("node_modules/foo/package.json"),
        r#"{"name":"foo","version":"1.0.0"}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("app.json"),
        if bare_import {
            r#"{"expo":{"plugins":["./plugins/withX.js"]}}"#
        } else {
            r#"{"expo":{"plugins":["foo"]}}"#
        },
    )
    .unwrap();
    if bare_import {
        std::fs::write(
            root.join("plugins/withX.js"),
            "module.exports = require('foo');",
        )
        .unwrap();
    }
    root
}

fn local_package_fingerprint(root: &Path, platform: &str) -> NativeFingerprint {
    let mut runner = MockRunner::new();
    runner.expect_run(
        "ls-files",
        CmdOutput::success("package.json\0app.json\0plugins/withX.js\0"),
    );
    compute(&mut runner, root, root, platform).unwrap()
}

fn matching_build(
    root: &Path,
    fp: &NativeFingerprint,
    platform: &str,
) -> qaren::buildplan::BuildPlan {
    build_after(root, fp, fp, platform)
}

fn build_after(
    root: &Path,
    recorded: &NativeFingerprint,
    fp: &NativeFingerprint,
    platform: &str,
) -> qaren::buildplan::BuildPlan {
    use qaren::buildplan::{
        decide, ArtifactKind, ArtifactStatus, CachedArtifact, DecisionInputs, NativeCacheState,
        StateStatus, CACHE_SCHEMA,
    };
    let cached = NativeCacheState {
        schema: CACHE_SCHEMA.to_string(),
        fingerprint_parts: recorded.parts.clone(),
        platform: platform.to_string(),
        app_id: "com.rndevagent.testapp".to_string(),
        worktree_root: root.to_path_buf(),
        fingerprint: recorded.value.clone(),
        built_at: "2026-10-05T00:00:00Z".to_string(),
        candidate_sha: "a".repeat(40),
        lockfile_sha256: "b".repeat(64),
        generated_native_dirs: vec![platform.to_string()],
        artifact: Some(CachedArtifact {
            path: root.join(if platform == "ios" {
                "testapp.app"
            } else {
                "testapp.apk"
            }),
            sha256: "c".repeat(64),
            kind: if platform == "ios" {
                ArtifactKind::AppBundle
            } else {
                ArtifactKind::Apk
            },
        }),
    };
    decide(
        &DecisionInputs {
            platform,
            app_id: &cached.app_id,
            worktree_root: root,
            candidate_sha: &cached.candidate_sha,
            fingerprint: &fp.value,
            fingerprint_parts: &fp.parts,
            fingerprint_complete: fp.complete,
            incompleteness: &fp.incompleteness,
            expo_unavailable: fp.expo_unavailable.as_deref(),
            scheme: Some("rndatest"),
            force_clean: false,
            native_dir_exists: true,
            native_dir_in_candidate: false,
        },
        &StateStatus::Loaded(Box::new(cached.clone())),
        Some(ArtifactStatus::Verified),
    )
}

#[test]
fn local_package_plugins_and_bare_imports_are_always_incomplete() {
    for spec in ["file:", "link:", "workspace:"] {
        for section in ["dependencies", "devDependencies", "optionalDependencies"] {
            for bare_import in [false, true] {
                for exports in [false, true] {
                    let root = local_package_plugin(spec, section, bare_import);
                    let mut package =
                        serde_json::json!({"name":"foo", "version":"1.0.0", "main":"index.js"});
                    if exports {
                        package["exports"] = serde_json::json!("./native.js");
                    }
                    std::fs::write(root.join("foo/package.json"), package.to_string()).unwrap();
                    std::fs::write(
                        root.join("foo/native.js"),
                        "module.exports = process.env.X;",
                    )
                    .unwrap();
                    for platform in ["ios", "android"] {
                        let fp = local_package_fingerprint(&root, platform);
                        assert!(
                            !fp.complete,
                            "{spec} {section} bare={bare_import} exports={exports}"
                        );
                        assert!(fp.incompleteness.iter().any(|reason| reason ==
                            "local package plugin foo is not traced; the input set is unprovably complete"), "{:?}", fp.incompleteness);
                        let build = matching_build(&root, &fp, platform);
                        assert_eq!(build.decision, qaren::buildplan::BuildDecision::Clean);
                        assert!(build.regenerate_native_dir);
                    }
                    std::fs::remove_dir_all(root).unwrap();
                }
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn installed_links_into_worktree_source_are_not_registry_packages() {
    for bare_import in [false, true] {
        let root = local_package_plugin("link:", "dependencies", bare_import);
        std::fs::write(root.join("package.json"), "{}").unwrap();
        std::fs::remove_dir_all(root.join("node_modules/foo")).unwrap();
        std::os::unix::fs::symlink("../foo", root.join("node_modules/foo")).unwrap();
        for platform in ["ios", "android"] {
            let fp = local_package_fingerprint(&root, platform);
            assert!(!fp.complete);
            assert_eq!(
                fp.incompleteness,
                ["local package plugin foo is not traced; the input set is unprovably complete"]
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn nested_package_resolution_in_plugins_and_config_closures_is_incomplete() {
    for (importer, nested, config) in [
        ("plugins/withX.js", "plugins/node_modules", false),
        ("plugins/deep/withY.js", "plugins/deep/node_modules", false),
        ("plugins/deep/withY.js", "plugins/node_modules", false),
        ("config/native.js", "config/node_modules", true),
    ] {
        let root = plugin_project("module.exports = (c) => c;");
        std::fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"foo":"1.0.0"}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(root.join("node_modules/foo")).unwrap();
        std::fs::write(
            root.join("node_modules/foo/package.json"),
            r#"{"name":"foo","version":"1.0.0"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(root.join(importer).parent().unwrap()).unwrap();
        std::fs::write(root.join(importer), "module.exports = require('foo');").unwrap();
        std::fs::write(root.join("react-native.config.js"), "module.exports = {};").unwrap();
        if config {
            std::fs::write(
                root.join("react-native.config.js"),
                "module.exports = require('./config/native.js');",
            )
            .unwrap();
        } else if importer != "plugins/withX.js" {
            std::fs::write(
                root.join("plugins/withX.js"),
                "module.exports = require('./deep/withY.js');",
            )
            .unwrap();
        }
        std::fs::create_dir_all(root.join("foo")).unwrap();
        std::fs::write(
            root.join("foo/package.json"),
            r#"{"name":"foo","version":"1.0.0"}"#,
        )
        .unwrap();
        std::fs::write(root.join("foo/index.js"), "module.exports = process.env.X;").unwrap();
        for platform in ["ios", "android"] {
            let compute_current = || {
                let mut runner = MockRunner::new();
                runner.expect_run(
                    "ls-files",
                    CmdOutput::success(
                        "package.json\0app.json\0plugins/withX.js\0react-native.config.js\0",
                    ),
                );
                compute(&mut runner, &root, &root, platform).unwrap()
            };
            let before = compute_current();
            assert!(before.complete, "{:?}", before.incompleteness);
            std::fs::create_dir_all(root.join(nested)).unwrap();
            std::os::unix::fs::symlink(root.join("foo"), root.join(nested).join("foo")).unwrap();
            let after = compute_current();
            assert!(!after.complete, "{importer} {nested} {platform}");
            assert_eq!(after.incompleteness, [
                "traced module has nested node_modules on its import resolution path; the input set is unprovably complete"
            ]);
            assert_eq!(
                matching_build(&root, &after, platform).decision,
                qaren::buildplan::BuildDecision::Clean
            );
            std::fs::remove_dir_all(root.join(nested)).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn registry_package_plugins_remain_complete_with_or_without_exports() {
    for bare_import in [false, true] {
        for exports in [false, true] {
            let root = local_package_plugin("link:", "dependencies", bare_import);
            std::fs::write(
                root.join("package.json"),
                r#"{"dependencies":{"foo":"1.0.0"}}"#,
            )
            .unwrap();
            let mut package = serde_json::json!({"name":"foo", "version":"1.0.0"});
            if exports {
                package["exports"] = serde_json::json!("./native.js");
            }
            std::fs::write(
                root.join("node_modules/foo/package.json"),
                package.to_string(),
            )
            .unwrap();
            let fp = local_package_fingerprint(&root, "ios");
            assert!(fp.complete, "{:?}", fp.incompleteness);
            assert_eq!(
                matching_build(&root, &fp, "ios").decision,
                qaren::buildplan::BuildDecision::Reuse
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

#[cfg(unix)]
#[test]
fn package_plugins_and_bare_imports_resolve_so_a_warm_run_can_reuse() {
    let root = package_project();
    let first = package_fingerprint(&root);
    assert!(first.complete, "{:?}", first.incompleteness);
    assert_eq!(
        matching_build(&root, &first, "ios").decision,
        qaren::buildplan::BuildDecision::Reuse
    );
    assert_eq!(
        package_fingerprint(&root),
        first,
        "an unchanged project must fingerprint identically"
    );

    std::fs::write(root.join("plugins/withX.ts"), "export default (c) => c;\n").unwrap();
    let plugin_changed = package_fingerprint(&root);
    assert!(plugin_changed.complete);
    assert_ne!(
        plugin_changed.value, first.value,
        "a local plugin change must invalidate reuse"
    );

    let root = package_project();
    std::fs::write(root.join("pnpm-lock.yaml"), "lockfileVersion: '9.1'\n").unwrap();
    assert_ne!(
        package_fingerprint(&root).value,
        first.value,
        "a lockfile change must invalidate reuse"
    );

    let root = package_project();
    std::fs::write(
        root.join("node_modules/expo/package.json"),
        r#"{"name":"expo","version":"56.0.23"}"#,
    )
    .unwrap();
    assert_ne!(
        package_fingerprint(&root).value,
        first.value,
        "a resolved package version change must invalidate reuse"
    );
}

#[cfg(unix)]
#[test]
fn an_unresolvable_package_plugin_or_import_still_forbids_reuse() {
    for missing in ["node_modules/expo-router", "node_modules/expo"] {
        let root = package_project();
        std::fs::remove_file(root.join(missing))
            .or_else(|_| std::fs::remove_dir_all(root.join(missing)))
            .unwrap();
        let fp = package_fingerprint(&root);
        assert!(!fp.complete, "{missing}");
        assert!(
            fp.incompleteness
                .iter()
                .any(|reason| reason.contains("does not resolve")),
            "{:?}",
            fp.incompleteness
        );
    }
    let root = package_project();
    std::fs::write(
        root.join("node_modules/expo/package.json"),
        r#"{"name":"expo"}"#,
    )
    .unwrap();
    assert!(
        !package_fingerprint(&root).complete,
        "a package without a version cannot be bound"
    );
}

mod common;

const EXPO_H: &str = "562e2ce413075778e281d21d5d710ac72e76cb12";
const XCODE: &str = "Xcode 27.0\nBuild version 27A266a\n";

fn dynamic_project() -> std::path::PathBuf {
    let root = plugin_project("module.exports = c => c;");
    std::fs::remove_file(root.join("app.json")).unwrap();
    std::fs::write(
        root.join("app.config.ts"),
        "import flavor from './config/flavor';\nexport default () => ({ extra: { flavor: process.env.QA_FLAVOR ?? flavor } });\n",
    )
    .unwrap();
    std::fs::write(root.join("package.json"), r#"{"name":"app"}"#).unwrap();
    root
}

const DYNAMIC_FILES: &str = "package.json\0app.config.ts\0";

fn dynamic_fingerprint(
    root: &Path,
    files: &str,
    script: impl FnOnce(&mut MockRunner),
) -> (NativeFingerprint, MockRunner) {
    let mut runner = MockRunner::new();
    runner.expect_run("ls-files", CmdOutput::success(files));
    script(&mut runner);
    let fp = compute(&mut runner, root, root, "ios").unwrap();
    assert_eq!(runner.remaining(), 0);
    (fp, runner)
}

fn evaluated(root: &Path, hash: &str, xcode: &str) -> NativeFingerprint {
    dynamic_fingerprint(root, DYNAMIC_FILES, |m| {
        common::script_expo_fingerprint(m, hash, xcode)
    })
    .0
}

#[test]
fn static_config_never_runs_expo_and_keeps_its_cache_key() {
    let root = plugin_project("module.exports = c => c;");
    let fp = fingerprint(&root);
    assert!(fp.complete, "{:?}", fp.incompleteness);
    assert_eq!(fp.expo_fingerprint_ms, None);
    assert_eq!(fp.parts.keys().collect::<Vec<_>>(), ["rnfp"]);
    assert_eq!(fp.parts["rnfp"], fp.value);
    assert_eq!(
        matching_build(&root, &fp, "ios").decision,
        qaren::buildplan::BuildDecision::Reuse
    );
}

#[test]
fn evaluated_dynamic_config_clears_only_its_own_incompleteness_and_reuses() {
    let root = dynamic_project();
    let (fp, runner) = dynamic_fingerprint(&root, DYNAMIC_FILES, |m| {
        common::script_expo_fingerprint(m, EXPO_H, XCODE)
    });
    assert!(fp.complete, "{:?}", fp.incompleteness);
    assert_eq!(
        fp.parts.keys().collect::<Vec<_>>(),
        ["expo", "rnfp", "toolchain"]
    );
    assert_eq!(fp.parts["expo"], format!("expo:{EXPO_H}"));
    assert_ne!(fp.value, fp.parts["rnfp"]);
    assert!(fp.expo_fingerprint_ms.is_some());
    assert_eq!(
        runner.private_inputs.len(),
        2,
        "both Expo commands use private capture"
    );
    let plan = matching_build(&root, &fp, "ios");
    assert_eq!(
        plan.decision,
        qaren::buildplan::BuildDecision::Reuse,
        "{}",
        plan.reason
    );
}

#[test]
fn stable_expo_hash_is_stable_and_every_bound_part_invalidates() {
    let root = dynamic_project();
    let base = evaluated(&root, EXPO_H, XCODE);
    assert_eq!(base, evaluated(&root, EXPO_H, XCODE));
    let config_or_loaded_module = evaluated(&root, &"a".repeat(40), XCODE);
    assert_ne!(base.value, config_or_loaded_module.value);
    let toolchain = evaluated(&root, EXPO_H, "Xcode 27.1\nBuild version 27B5\n");
    assert_ne!(base.value, toolchain.value);
    assert_eq!(base.parts["rnfp"], toolchain.parts["rnfp"]);
    std::fs::write(
        root.join("package.json"),
        r#"{"name":"app","dependencies":{"x":"1"}}"#,
    )
    .unwrap();
    let native_input = evaluated(&root, EXPO_H, XCODE);
    assert_ne!(base.parts["rnfp"], native_input.parts["rnfp"]);
    assert_ne!(base.value, native_input.value);
    for changed in [&config_or_loaded_module, &toolchain, &native_input] {
        assert_ne!(
            matching_build(&root, &base, "ios").fingerprint,
            changed.value
        );
    }
}

#[test]
fn js_only_and_plan_only_changes_keep_the_composite() {
    let root = dynamic_project();
    let base = evaluated(&root, EXPO_H, XCODE);
    std::fs::write(root.join("App.tsx"), "export default 1;").unwrap();
    std::fs::write(root.join("plan.md"), "- tap Home").unwrap();
    let after = dynamic_fingerprint(&root, &format!("{DYNAMIC_FILES}App.tsx\0plan.md\0"), |m| {
        common::script_expo_fingerprint(m, EXPO_H, XCODE)
    })
    .0;
    assert_eq!(base.value, after.value);
}

type Script = Box<dyn FnOnce(&mut MockRunner)>;

const UNAVAILABLE_CANARY: &str = "CANARY-unavailable-9d2e";

#[test]
fn unavailable_expo_evaluation_keeps_todays_conservative_rebuild() {
    let root = dynamic_project();
    let recorded = evaluated(&root, EXPO_H, XCODE);
    let cases: Vec<(&str, Script)> = vec![
        (
            "does not resolve",
            Box::new(common::script_expo_fingerprint_unresolvable),
        ),
        (
            "does not resolve",
            Box::new(|m: &mut MockRunner| {
                m.expect_run("require.resolve", CmdOutput::success("relative/cli.js"))
            }),
        ),
        (
            "did not complete (exit 1)",
            Box::new(|m: &mut MockRunner| {
                m.expect_run(
                    "require.resolve",
                    CmdOutput::success(common::EXPO_FINGERPRINT_CLI),
                );
                m.expect_run(
                    "fingerprint:generate",
                    CmdOutput {
                        stdout: format!("{UNAVAILABLE_CANARY}\n"),
                        ..CmdOutput::failed(1, &format!("config threw: {UNAVAILABLE_CANARY}"))
                    },
                );
            }),
        ),
        (
            "timed out after 120 s",
            Box::new(|m: &mut MockRunner| {
                m.expect_run(
                    "require.resolve",
                    CmdOutput::success(common::EXPO_FINGERPRINT_CLI),
                );
                m.expect_run(
                    "fingerprint:generate",
                    CmdOutput {
                        timed_out: true,
                        ..CmdOutput::failed(124, "")
                    },
                );
            }),
        ),
        (
            "no hex hash",
            Box::new(|m: &mut MockRunner| {
                m.expect_run(
                    "require.resolve",
                    CmdOutput::success(common::EXPO_FINGERPRINT_CLI),
                );
                m.expect_run("fingerprint:generate", CmdOutput::success("not json"));
            }),
        ),
        (
            "no hex hash",
            Box::new(|m: &mut MockRunner| {
                m.expect_run(
                    "require.resolve",
                    CmdOutput::success(common::EXPO_FINGERPRINT_CLI),
                );
                m.expect_run(
                    "fingerprint:generate",
                    CmdOutput::success(r#"{"hash":"../x"}"#),
                );
            }),
        ),
    ];
    for (reason, script) in cases {
        let (fp, _) = dynamic_fingerprint(&root, DYNAMIC_FILES, script);
        assert!(!fp.complete);
        assert_eq!(fp.incompleteness.len(), 2, "{:?}", fp.incompleteness);
        assert!(fp.incompleteness[0].starts_with("app.config.ts is a dynamic config"));
        assert!(
            fp.incompleteness[1].starts_with("Expo fingerprint unavailable: ")
                && fp.incompleteness[1].contains(reason),
            "{:?}",
            fp.incompleteness
        );
        assert_eq!(fp.value, fp.parts["rnfp"]);
        assert!(
            fp.expo_unavailable
                .as_deref()
                .is_some_and(|cause| cause.contains(reason)),
            "{:?}",
            fp.expo_unavailable
        );
        let plan = matching_build(&root, &fp, "ios");
        assert_eq!(plan.decision, qaren::buildplan::BuildDecision::Clean);
        assert!(plan.regenerate_native_dir);
        let after_evaluated = build_after(&root, &recorded, &fp, "ios");
        assert_eq!(
            after_evaluated.decision,
            qaren::buildplan::BuildDecision::Clean
        );
        assert!(after_evaluated.regenerate_native_dir);
        let shown = serde_json::to_string(&after_evaluated).unwrap();
        assert!(
            !shown.contains("native inputs changed")
                && after_evaluated.reason.contains(&format!(
                    "Expo fingerprint unavailable: {}",
                    fp.expo_unavailable.as_deref().unwrap()
                ))
                && !shown.contains(UNAVAILABLE_CANARY),
            "{shown}"
        );
    }
}

#[test]
fn unavailable_toolchain_identity_forbids_reuse() {
    let root = dynamic_project();
    let (fp, _) = dynamic_fingerprint(&root, DYNAMIC_FILES, |m| {
        m.expect_run(
            "require.resolve",
            CmdOutput::success(common::EXPO_FINGERPRINT_CLI),
        );
        m.expect_run(
            "fingerprint:generate",
            CmdOutput::success(&format!(r#"{{"hash":"{EXPO_H}"}}"#)),
        );
        m.expect_run(
            "xcodebuild -version",
            CmdOutput::failed(1, "no developer dir"),
        );
    });
    assert!(!fp.complete);
    assert_eq!(fp.incompleteness.len(), 1);
    assert!(fp.incompleteness[0].starts_with("toolchain identity unavailable"));
    assert_ne!(
        matching_build(&root, &fp, "ios").decision,
        qaren::buildplan::BuildDecision::Reuse
    );
}

#[test]
fn an_evaluated_config_never_clears_any_other_incompleteness() {
    let root = dynamic_project();
    std::fs::write(
        root.join("package.json"),
        r#"{"name":"app","dependencies":{"shared":"workspace:*"}}"#,
    )
    .unwrap();
    let fp = evaluated(&root, EXPO_H, XCODE);
    assert!(!fp.complete);
    assert_eq!(fp.incompleteness.len(), 1, "{:?}", fp.incompleteness);
    assert!(fp.incompleteness[0].contains("workspace:"));
    assert_ne!(
        matching_build(&root, &fp, "ios").decision,
        qaren::buildplan::BuildDecision::Reuse
    );
}

#[test]
fn android_dynamic_config_is_unchanged_and_never_runs_expo() {
    let root = dynamic_project();
    let mut runner = MockRunner::new();
    runner.expect_run("ls-files", CmdOutput::success(DYNAMIC_FILES));
    let fp = compute(&mut runner, &root, &root, "android").unwrap();
    assert_eq!(fp.incompleteness.len(), 1);
    assert!(fp.incompleteness[0].starts_with("app.config.ts is a dynamic config"));
    assert_eq!(fp.expo_fingerprint_ms, None);
}

#[test]
fn evaluated_config_output_never_reaches_fingerprint_or_decision() {
    const CANARY: &str = "CANARY-sk_live_7f3a";
    let root = dynamic_project();
    let leak = |stdout: String, stderr: &str| -> String {
        let (fp, _) = dynamic_fingerprint(&root, DYNAMIC_FILES, |m| {
            m.expect_run(
                "require.resolve",
                CmdOutput::success(common::EXPO_FINGERPRINT_CLI),
            );
            m.expect_run(
                "fingerprint:generate",
                CmdOutput {
                    stdout,
                    stderr: stderr.to_string(),
                    ..CmdOutput::failed(if stderr.is_empty() { 0 } else { 1 }, stderr)
                },
            );
            if stderr.is_empty() {
                m.expect_run("xcodebuild -version", CmdOutput::success(XCODE));
            }
        });
        let plan = matching_build(&root, &fp, "ios");
        format!("{fp:?}{}", serde_json::to_string(&plan).unwrap())
    };
    let ok = serde_json::json!({
        "sources": [{"type": "contents", "id": "expoConfig", "contents": format!("{{\"extra\":{{\"key\":\"{CANARY}\"}}}}")}],
        "hash": EXPO_H,
    });
    for observed in [
        leak(format!("{ok}\n"), ""),
        leak(format!("{CANARY}\n"), &format!("config threw: {CANARY}")),
    ] {
        assert!(!observed.contains(CANARY), "{observed}");
    }
}

#[test]
fn a_pnpm_dependency_check_preamble_on_stdout_is_ignored() {
    let root = dynamic_project();
    const PREAMBLE: &str = "Already up to date\nDone in 216ms using pnpm v11.5.2\n";
    let (fp, _) = dynamic_fingerprint(&root, DYNAMIC_FILES, |m| {
        m.expect_run(
            "require.resolve",
            CmdOutput::success(&format!("{PREAMBLE}{}", common::EXPO_FINGERPRINT_CLI)),
        );
        m.expect_run(
            "fingerprint:generate",
            CmdOutput::success(&format!(
                "{PREAMBLE}{{\"sources\":[],\"hash\":\"{EXPO_H}\"}}\n"
            )),
        );
        m.expect_run("xcodebuild -version", CmdOutput::success(XCODE));
    });
    assert!(fp.complete, "{:?}", fp.incompleteness);
    assert_eq!(fp, evaluated(&root, EXPO_H, XCODE));
}
