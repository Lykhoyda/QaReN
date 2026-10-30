use qaren::ios_toolchain::{classify_failure, SwiftVersion};
mod common;
use qaren::exec::{CmdOutput, MockRunner};
use qaren::ios_toolchain::{
    inspect, requested_modes, CompilerIdentity, Linkage, Mode, NativeBuildConfig,
};
use std::path::Path;

fn write(root: &Path, path: &str, body: &str) {
    let file = root.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, body).unwrap();
}

fn compiler() -> CompilerIdentity {
    CompilerIdentity {
        xcode: Some("27.0/27A1".into()),
        swift: SwiftVersion::parse("6.4"),
        xcode_hash: Some("a".repeat(64)),
        swift_hash: Some("b".repeat(64)),
    }
}

fn framework(root: &Path, package: &str, compiler: &str) {
    let module = if package == "expo-modules-core" {
        "ExpoModulesCore"
    } else {
        "ExpoModulesJSI"
    };
    let base = format!("node_modules/{package}/apple/Products/Fixture.xcframework");
    write(root, &format!("{base}/Info.plist"), "synthetic plist");
    for (slice, version) in [("ios-device", "99.0"), ("ios-simulator", compiler)] {
        write(root, &format!("{base}/{slice}/{module}.framework/Modules/{module}.swiftmodule/arm64.swiftinterface"), &format!("// swift-compiler-version: Apple Swift version {version} (swiftlang-test clang-test)\n{}", "public struct Fixture {}\n".repeat(2000)));
        write(root, &format!("{base}/{slice}/{module}.framework/Modules/{module}.swiftmodule/arm64.private.swiftinterface"), "not a compiler header");
    }
}

fn script_plist(runner: &mut MockRunner) {
    runner.expect_run("plutil -convert json -o - -- -", CmdOutput::success(r#"{"AvailableLibraries":[{"LibraryIdentifier":"ios-device","SupportedPlatform":"ios"},{"LibraryIdentifier":"ios-simulator","SupportedPlatform":"ios","SupportedPlatformVariant":"simulator"}]}"#));
}

#[test]
fn interface_probe_uses_metadata_and_public_headers_from_both_packages() {
    let root = common::temp_repo();
    framework(&root, "expo-modules-core", "6.3.1");
    framework(&root, "expo-modules-jsi", "6.3.2");
    let mut runner = MockRunner::new();
    script_plist(&mut runner);
    script_plist(&mut runner);
    let result = inspect(&mut runner, &root, compiler());
    assert!(!result.incomplete);
    assert_eq!(result.interfaces.len(), 2);
    assert_eq!(
        result.interfaces[0].swift,
        SwiftVersion::parse("6.3.1").unwrap()
    );
    assert_eq!(
        result.interfaces[1].swift,
        SwiftVersion::parse("6.3.2").unwrap()
    );
    assert!(runner
        .calls
        .iter()
        .all(|spec| spec.label == "expo-xcframework-plist"));
    assert!(runner.calls.iter().all(|spec| spec.timeout_seconds <= 2));
    assert!(!root.join("ios").exists());
}

#[test]
fn package_root_links_work_but_descendant_links_are_unknown() {
    let root = common::temp_repo();
    framework(&root, "expo-modules-core", "6.3.1");
    let installed = root.join("node_modules/expo-modules-core");
    let actual = root.join("node_modules/.pnpm/core");
    std::fs::create_dir_all(actual.parent().unwrap()).unwrap();
    std::fs::rename(&installed, &actual).unwrap();
    std::os::unix::fs::symlink(&actual, &installed).unwrap();
    let mut runner = MockRunner::new();
    script_plist(&mut runner);
    assert_eq!(inspect(&mut runner, &root, compiler()).interfaces.len(), 1);
    std::os::unix::fs::symlink(root.join("private"), actual.join("escape")).unwrap();
    let mut runner = MockRunner::new();
    script_plist(&mut runner);
    assert!(inspect(&mut runner, &root, compiler()).incomplete);
}

#[test]
fn malformed_headers_slices_and_entry_overflow_are_unknown() {
    for variant in ["header", "slice", "overflow"] {
        let root = common::temp_repo();
        framework(&root, "expo-modules-core", "6.3.1");
        let mut runner = MockRunner::new();
        if variant == "slice" {
            runner.expect_run("plutil", CmdOutput::success(r#"{"AvailableLibraries":[{"LibraryIdentifier":"../escape","SupportedPlatform":"ios","SupportedPlatformVariant":"simulator"}]}"#));
        } else {
            script_plist(&mut runner);
        }
        if variant == "header" {
            write(&root, "node_modules/expo-modules-core/apple/Products/Fixture.xcframework/ios-simulator/ExpoModulesCore.framework/Modules/ExpoModulesCore.swiftmodule/arm64.swiftinterface", "// swift-compiler-version: unknown\n");
        }
        if variant == "overflow" {
            for i in 0..257 {
                write(
                    &root,
                    &format!("node_modules/expo-modules-core/file-{i}"),
                    "",
                );
            }
            // The entry budget can end the walk before any plist conversion.
        }
        let result = inspect(&mut runner, &root, compiler());
        assert!(result.incomplete, "{variant}");
    }
}

#[test]
fn requested_mode_is_separate_from_installed_pods() {
    let root = common::temp_repo();
    write(
        &root,
        "package.json",
        r#"{"dependencies":{"expo":"56.0.0"}}"#,
    );
    write(&root, "node_modules/expo-modules-core/package.json", "{}");
    let mut runner = MockRunner::new();
    assert_eq!(requested_modes(&runner, &root, None).expo, Mode::On);
    runner
        .environment
        .insert("EXPO_USE_PRECOMPILED_MODULES".into(), "0".into());
    let desired = requested_modes(&runner, &root, None);
    assert_eq!(desired.expo, Mode::Off);
    assert!(!Linkage::inspect(&root).matches(&desired));
    write(&root, "app.config.ts", "export default {};");
    assert_eq!(requested_modes(&runner, &root, None).expo, Mode::Unknown);
    assert_eq!(
        requested_modes(
            &runner,
            &root,
            Some(NativeBuildConfig {
                precompiled_modules: Some(false),
                ..Default::default()
            })
        )
        .expo,
        Mode::Off
    );
    write(&root, "ios/Podfile", "custom_native_policy()\n");
    assert_eq!(
        requested_modes(
            &runner,
            &root,
            Some(NativeBuildConfig {
                precompiled_modules: Some(false),
                ..Default::default()
            })
        )
        .expo,
        Mode::Unknown
    );
}

#[test]
fn linkage_requires_matching_target_support_evidence_and_detects_both_transitions() {
    let root = common::temp_repo();
    write(
        &root,
        "package.json",
        r#"{"dependencies":{"expo":"56.0.0"}}"#,
    );
    let mut runner = MockRunner::new();
    let on = requested_modes(&runner, &root, None);
    runner
        .environment
        .insert("EXPO_USE_PRECOMPILED_MODULES".into(), "0".into());
    let off = requested_modes(&runner, &root, None);
    let path = "ios/Pods/Local Podspecs/ExpoModulesCore.podspec.json";
    let support = "ios/Pods/Target Support Files/ExpoModulesCore/ExpoModulesCore.debug.xcconfig";
    write(
        &root,
        path,
        r#"{"name":"ExpoModulesCore","vendored_frameworks":["ExpoModulesCore.xcframework"]}"#,
    );
    write(
        &root,
        support,
        "FRAMEWORK_SEARCH_PATHS = XCFrameworkIntermediates/ExpoModulesCore\n",
    );
    let prebuilt = Linkage::inspect(&root);
    assert!(prebuilt.matches(&on));
    assert!(!prebuilt.matches(&off));
    write(
        &root,
        path,
        r#"{"name":"ExpoModulesCore","source_files":["ios/**/*.swift"]}"#,
    );
    write(
        &root,
        support,
        "PODS_TARGET_SRCROOT = ${PODS_ROOT}/../../node_modules/expo-modules-core\n",
    );
    let source = Linkage::inspect(&root);
    assert!(source.matches(&off));
    assert!(!source.matches(&on));
    assert_ne!(prebuilt.digest, source.digest);
    write(&root, support, "custom linkage\n");
    assert_eq!(Linkage::inspect(&root).expo, Mode::Unknown);
}

#[test]
fn the_full_private_compiler_build_shapes_identity_without_publishing_raw_output() {
    let mut identities = Vec::new();
    for tag in ["A", "B"] {
        let mut runner = MockRunner::new();
        runner.expect_run(
            "xcodebuild -version",
            CmdOutput::success("Xcode 27.0\nBuild version 27A1\n"),
        );
        runner.expect_run("xcrun swift --version", CmdOutput::success(&format!("Apple Swift version 6.4 (swiftlang-{tag} clang-{tag})\nTarget: arm64-apple-macosx\n")));
        identities.push(CompilerIdentity::collect(&mut runner));
    }
    assert_eq!(identities[0].swift, identities[1].swift);
    assert_ne!(identities[0].parts(), identities[1].parts());
    let json = serde_json::to_string(&identities).unwrap();
    assert!(!json.contains("swiftlang"));
    assert!(!json.contains("Target:"));
}

#[test]
fn static_plugin_modes_conflicts_and_invalid_env_are_explicit() {
    let root = common::temp_repo();
    write(
        &root,
        "package.json",
        r#"{"dependencies":{"expo":"56.0.0","react-native":"0.84.0"}}"#,
    );
    write(
        &root,
        "app.json",
        r#"{"expo":{"plugins":[["expo-build-properties",{"ios":{"usePrecompiledModules":false,"buildReactNativeFromSource":true}}]]}}"#,
    );
    let mut runner = MockRunner::new();
    let selected = requested_modes(&runner, &root, None);
    assert_eq!(selected.expo, Mode::Off);
    assert_eq!(selected.rncore, Mode::Off);
    runner
        .environment
        .insert("EXPO_USE_PRECOMPILED_MODULES".into(), "true".into());
    assert_eq!(requested_modes(&runner, &root, None).expo, Mode::Unknown);
    write(
        &root,
        "app.json",
        r#"{"expo":{"plugins":[["expo-build-properties",{"ios":{"usePrecompiledModules":false}}],["expo-build-properties",{"ios":{"usePrecompiledModules":true}}]]}}"#,
    );
    assert_eq!(requested_modes(&runner, &root, None).expo, Mode::Unknown);
    runner.environment.remove("EXPO_USE_PRECOMPILED_MODULES");
    write(
        &root,
        "ios/Podfile",
        include_str!("fixtures/ios-standard-podfile.txt"),
    );
    write(
        &root,
        "ios/Podfile.properties.json",
        r#"{"EXPO_USE_PRECOMPILED_MODULES":"false"}"#,
    );
    write(&root, "app.json", "{}");
    runner
        .environment
        .insert("EXPO_USE_PRECOMPILED_MODULES".into(), "1".into());
    assert_eq!(requested_modes(&runner, &root, None).expo, Mode::Off);
    let injected = include_str!("fixtures/ios-standard-podfile.txt").replace(
        "target 'HelloWorld' do",
        "target 'HelloWorld' do; ENV['EXPO_USE_PRECOMPILED_MODULES'] = '1'",
    );
    write(&root, "ios/Podfile", &injected);
    assert_eq!(requested_modes(&runner, &root, None).expo, Mode::Unknown);
}

#[test]
fn missing_or_ambiguous_public_simulator_headers_are_unknown() {
    for variant in [
        "absent",
        "module",
        "no-simulator",
        "duplicate",
        "metadata-size",
    ] {
        let root = common::temp_repo();
        framework(&root, "expo-modules-core", "6.3.1");
        let base =
            "node_modules/expo-modules-core/apple/Products/Fixture.xcframework/ios-simulator";
        let header = format!("{base}/ExpoModulesCore.framework/Modules/ExpoModulesCore.swiftmodule/arm64.swiftinterface");
        let mut runner = MockRunner::new();
        match variant {
            "absent" => { std::fs::remove_file(root.join(&header)).unwrap(); script_plist(&mut runner); }
            "module" => { std::fs::rename(root.join(base).join("ExpoModulesCore.framework"), root.join(base).join("Other.framework")).unwrap(); script_plist(&mut runner); }
            "no-simulator" => runner.expect_run("plutil", CmdOutput::success(r#"{"AvailableLibraries":[{"LibraryIdentifier":"ios-device","SupportedPlatform":"ios"}]}"#)),
            "duplicate" => { write(&root, &header, "// swift-compiler-version: Apple Swift version 6.3.1\n// swift-compiler-version: Apple Swift version 6.4\n"); script_plist(&mut runner); }
            _ => runner.expect_run("plutil", CmdOutput::success(&"x".repeat(65537))),
        }
        let observation = inspect(&mut runner, &root, compiler());
        assert!(observation.incomplete, "{variant}");
        assert!(observation.interfaces.is_empty(), "{variant}");
    }
    let root = common::temp_repo();
    std::fs::create_dir_all(root.join("node_modules")).unwrap();
    std::os::unix::fs::symlink(
        root.join("missing-private-location"),
        root.join("node_modules/expo-modules-jsi"),
    )
    .unwrap();
    let mut runner = MockRunner::new();
    assert!(inspect(&mut runner, &root, compiler()).incomplete);
    assert_eq!(requested_modes(&runner, &root, None).jsi, Mode::Unknown);
    assert!(runner.calls.is_empty());
}

#[test]
fn compiler_versions_are_numeric_and_bounded() {
    let parse = |s| SwiftVersion::parse(s).unwrap();
    assert!(parse("6.10") > parse("6.9.9"));
    assert_eq!(parse("6.4"), parse("6.4.0"));
    for invalid in ["6", "6.4.bad", "6.4\nprivate", "6.4/path", "999999999999.4"] {
        assert!(SwiftVersion::parse(invalid).is_none());
    }
}

#[test]
fn mismatch_uses_the_failed_invocations_versions() {
    let log = "ExpoModulesCore.swiftinterface: error: this SDK is not supported by the compiler (the SDK is built with 'Apple Swift version 6.3.1 (swiftlang-A)', while this compiler is 'Apple Swift version 6.4 (swiftlang-B)')";
    let failure = classify_failure(log, None).unwrap();
    assert_eq!(failure.cause(), Some("toolchain-newer-than-prebuilt"));
    assert!(failure.detail().contains("expo-modules-core"));
    assert!(failure.detail().contains("6.3.1"));
    assert!(failure.detail().contains("6.4"));
    assert!(failure
        .recovery(true, Mode::Unknown)
        .next_action
        .contains("Swift 6.3.1"));
    assert!(failure
        .recovery(true, Mode::Unknown)
        .next_action
        .contains("host Swift 6.4"));
}

#[test]
fn signatures_without_version_proof_get_conditional_guidance() {
    let failure = classify_failure(
        "ExpoModulesJSI.swiftinterface: error: cannot find type '__ObjC::expo'",
        None,
    )
    .unwrap();
    assert_eq!(failure.cause(), None);
    assert_eq!(
        failure.recovery(false, Mode::Unknown).next_rung,
        "inspect-interface-compatibility"
    );
    let source_selected = failure.recovery(true, Mode::Off);
    assert_eq!(source_selected.next_rung, "expo-patch-or-compatible-xcode");
    assert!(!source_selected.next_action.contains("qaren prepare"));
    assert!(failure
        .recovery(false, Mode::Unknown)
        .next_action
        .contains("EXPO_USE_PRECOMPILED_MODULES=0"));
    assert!(failure
        .recovery(false, Mode::Unknown)
        .next_action
        .contains("without deleting native source"));
    assert!(!failure
        .recovery(false, Mode::Unknown)
        .next_action
        .contains("qaren prepare"));
    assert!(failure
        .recovery(true, Mode::Unknown)
        .next_action
        .contains("after Ready"));
    assert!(failure
        .recovery(true, Mode::Unknown)
        .next_action
        .contains("only after cleanup completes"));
}

#[test]
fn unrelated_output_and_unproven_inequality_never_claim_a_newer_host() {
    for log in [
        "ExpoModulesCore warning: something unrelated\nOther.swiftinterface: error: is not supported by the compiler",
        "ExpoModulesCore: warning: is not supported by the compiler",
        "ExpoModulesCore.swiftinterface: warning: quoted error: is not supported by the compiler",
        "ExpoModulesCore.cpp: error: this option is not supported by the compiler",
        "Other.swiftinterface: error: cannot find type '__ObjC::expo'",
    ] {
        assert!(classify_failure(log, None).is_none());
    }
    let log = "ExpoModulesCore.swiftinterface: error: is not supported by the compiler (built with Apple Swift version 6.4; compiler is Apple Swift version 6.3.1)";
    assert_eq!(classify_failure(log, None).unwrap().cause(), None);
}

#[test]
fn incomplete_interface_observations_never_supply_missing_version_proof() {
    use qaren::ios_toolchain::{Interface, Observation};
    let mut observation = Observation {
        compiler: compiler(),
        interfaces: vec![Interface {
            package: "expo-modules-core",
            swift: SwiftVersion::parse("6.3.1").unwrap(),
        }],
        incomplete: true,
    };
    let log = "ExpoModulesCore.swiftinterface: error: this SDK is not supported by the compiler";
    assert_eq!(
        classify_failure(log, Some(&observation)).unwrap().cause(),
        None
    );
    observation.incomplete = false;
    assert_eq!(
        classify_failure(log, Some(&observation)).unwrap().cause(),
        Some("toolchain-newer-than-prebuilt")
    );
    observation.incomplete = true;
    let explicit = include_str!("fixtures/ios-toolchain-mismatch.txt");
    assert_eq!(
        classify_failure(explicit, Some(&observation))
            .unwrap()
            .cause(),
        Some("toolchain-newer-than-prebuilt")
    );
}
