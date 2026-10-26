mod common;

use qaren::adapters::ios;
use qaren::config::CheckConfig;
use qaren::exec::MockRunner;
use qaren::scenario::{BuildOwner, BuildSpec, IosWorkspaceBuild, Platform, Scenario};

#[test]
fn explicit_workspace_config_admits_an_app_without_expo_build_capability_or_probes() {
    let repo = common::temp_repo();
    let root = repo.join("test-app");
    let workspace = root.join("ios/Native App.xcworkspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(
        workspace.join("contents.xcworkspacedata"),
        "opaque workspace",
    )
    .unwrap();
    let config: CheckConfig = serde_yaml::from_str(
        "appId: com.example.app\ndevClientScheme: example\nios:\n  build:\n    workspace: ios/Native App.xcworkspace\n    scheme: Native Debug\n",
    )
    .unwrap();
    config.validate_for_platform(Platform::Ios).unwrap();
    let spec = config.ios.as_ref().unwrap().build.as_ref().unwrap();
    assert_eq!(spec.workspace, "ios/Native App.xcworkspace");
    assert_eq!(spec.scheme, "Native Debug");
    let mut runner = MockRunner::new();
    ios::require_build(&mut runner, &root, Some(spec)).unwrap();
    std::fs::remove_file(root.join("node_modules/.bin/expo")).unwrap();
    ios::require_build(&mut runner, &root, Some(spec)).unwrap();
    assert!(runner.calls.is_empty());
    assert!(runner.private_inputs.is_empty());
}

#[test]
fn workspace_and_scheme_validation_is_shared_by_config_and_scenario_preflight() {
    let repo = common::temp_repo();
    let config_path = repo.join("config.yaml");
    let valid = IosWorkspaceBuild {
        workspace: "ios/Nested Folder/Unrelated Native Name.xcworkspace".into(),
        scheme: "Arbitrary App (Debug)".into(),
    };
    let mut cases = vec![(valid.clone(), true)];
    for workspace in [
        "",
        "Native.xcworkspace",
        "/ios/Native.xcworkspace",
        "../ios/Native.xcworkspace",
        "./ios/Native.xcworkspace",
        "ios/../Native.xcworkspace",
        "ios/./Native.xcworkspace",
        "ios//Native.xcworkspace",
        "ios/Native.xcworkspace/",
        "ios/Native.xcodeproj",
        "ios2/Native.xcworkspace",
        "ios\\Native.xcworkspace",
        "ios/Bad\nName.xcworkspace",
        "ios/Bad\0Name.xcworkspace",
        "ios/Bad\rName.xcworkspace",
    ] {
        cases.push((
            IosWorkspaceBuild {
                workspace: workspace.into(),
                ..valid.clone()
            },
            false,
        ));
    }
    for scheme in [
        "",
        " ",
        " Debug",
        "Debug ",
        "-Debug",
        "Debug\nName",
        "Debug\0Name",
        "Debug\tName",
        "Debug\u{7f}Name",
        "Debug\u{85}Name",
    ] {
        cases.push((
            IosWorkspaceBuild {
                scheme: scheme.into(),
                ..valid.clone()
            },
            false,
        ));
    }
    cases.push((
        IosWorkspaceBuild {
            scheme: "s".repeat(256),
            ..valid.clone()
        },
        true,
    ));
    cases.push((
        IosWorkspaceBuild {
            scheme: "s".repeat(257),
            ..valid
        },
        false,
    ));
    for (spec, accepted) in cases {
        assert_eq!(spec.validate().is_ok(), accepted, "{spec:?}");
        let json = serde_json::json!({
            "appId": "com.example.app", "devClientScheme": "example", "ios": {"build": spec}
        });
        std::fs::write(&config_path, serde_yaml::to_string(&json).unwrap()).unwrap();
        assert_eq!(
            CheckConfig::load(&config_path).is_ok(),
            accepted,
            "{spec:?}"
        );
        let config: CheckConfig = serde_json::from_value(json).unwrap();
        assert_eq!(
            config.validate_for_platform(Platform::Ios).is_ok(),
            accepted,
            "{spec:?}"
        );
        let mut scenario = common::scenario_from(&common::ios_scenario_yaml(8791));
        scenario.build.ios_workspace = Some(spec.clone());
        assert_eq!(scenario.validate().is_ok(), accepted, "{spec:?}");
    }
}

#[test]
fn platform_specific_config_is_shared_but_workspace_builds_require_cli_owned_ios() {
    let spec = IosWorkspaceBuild {
        workspace: "ios/App.xcworkspace".into(),
        scheme: "App".into(),
    };
    let config: CheckConfig = serde_json::from_value(serde_json::json!({
        "appId": "com.example.app", "devClientScheme": "example", "ios": {"build": spec}
    }))
    .unwrap();
    config.validate_for_platform(Platform::Android).unwrap();
    let mut android = common::scenario_from(&common::android_scenario_yaml(8791));
    android.build.ios_workspace = Some(spec.clone());
    assert!(android.validate().is_err());
    let mut handoff = common::scenario_from(&common::ios_scenario_yaml(8791));
    handoff.build.owner = BuildOwner::Qaren;
    handoff.metro = None;
    handoff.candidate.dev_client_scheme = None;
    handoff.validate().unwrap();
    handoff.build.ios_workspace = Some(spec);
    assert!(handoff.validate().is_err());
}

#[test]
fn workspace_opt_in_has_strict_simple_keys_and_absent_defaults_round_trip() {
    let legacy: BuildSpec = serde_yaml::from_str("strategy: auto\nowner: cli\n").unwrap();
    assert!(legacy.ios_workspace.is_none());
    assert!(BuildSpec::default().ios_workspace.is_none());
    assert!(serde_json::to_value(legacy)
        .unwrap()
        .get("ios_workspace")
        .is_none());
    let config: CheckConfig = serde_yaml::from_str("appId: com.example.app\nios: {}\n").unwrap();
    assert!(config.ios.unwrap().build.is_none());
    let raw = format!(
        "{}build:\n  ios_workspace:\n    workspace: ios/App.xcworkspace\n    scheme: App\n",
        common::ios_scenario_yaml(8791)
    );
    let scenario = common::scenario_from(&raw);
    let round_trip: Scenario =
        serde_yaml::from_str(&serde_yaml::to_string(&scenario).unwrap()).unwrap();
    round_trip.validate().unwrap();
    assert_eq!(
        round_trip.build.ios_workspace.unwrap().workspace,
        "ios/App.xcworkspace"
    );
    for build in [
        serde_json::json!({"workspace":"ios/App.xcworkspace","scheme":"App","discover":true}),
        serde_json::json!({"workspacePath":"ios/App.xcworkspace","scheme":"App"}),
        serde_json::json!({"workspace":"ios/App.xcworkspace","schemeName":"App"}),
        serde_json::json!({"workspace":"ios/App.xcworkspace"}),
        serde_json::json!({"scheme":"App"}),
    ] {
        assert!(serde_json::from_value::<IosWorkspaceBuild>(build.clone()).is_err());
        assert!(serde_json::from_value::<CheckConfig>(serde_json::json!({
            "appId":"com.example.app", "ios":{"build":build}
        }))
        .is_err());
    }
}
