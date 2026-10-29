mod common;

use qaren::failure::FailureCode;
use qaren::scenario::{Platform, Scenario};
use std::path::Path;

fn valid_ios_yaml() -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("scenarios/ios-simulator.yaml"),
    )
    .unwrap()
    .replace(
        "revision: HEAD",
        "revision: HEAD\n  dev_client_scheme: rndatest",
    )
}

fn valid_android_yaml() -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("scenarios/nuc-android.yaml"),
    )
    .unwrap()
}

fn parse(yaml: &str) -> Result<Scenario, qaren::failure::Failure> {
    let scenario: Scenario = serde_yaml::from_str(yaml).map_err(|e| {
        qaren::failure::Failure::new("validate", FailureCode::ScenarioInvalid, e.to_string(), "")
    })?;
    scenario.validate()?;
    Ok(scenario)
}

#[test]
fn ios_cli_scenario_requires_bounded_launch_scheme_with_content_free_refusal() {
    let mut scenario: Scenario = serde_yaml::from_str(&valid_ios_yaml()).unwrap();
    for scheme in ["rndatest", "A", "Expo+test-1.2", &"a".repeat(128)] {
        scenario.candidate.dev_client_scheme = Some(scheme.into());
        assert!(scenario.validate().is_ok(), "{scheme:?}");
    }
    let mut refusal = None;
    for scheme in [
        None,
        Some(""),
        Some(" "),
        Some(" rndatest"),
        Some("rndatest "),
        Some("rnda test"),
        Some("rnda\ntest"),
        Some("rnda\ttest"),
        Some("rnda\0test"),
        Some("1rndatest"),
        Some("+rndatest"),
        Some("rnda/test"),
        Some("rndatest://"),
        Some("rnda_test"),
        Some("rndatést"),
        Some(&"a".repeat(129)),
    ] {
        scenario.candidate.dev_client_scheme = scheme.map(String::from);
        let failure = scenario.validate().expect_err("invalid scheme must refuse");
        assert_eq!(failure.code, FailureCode::DevClientSchemeRequired);
        assert!(failure.code.is_refusal());
        let json = serde_json::to_value(failure).unwrap();
        assert_eq!(refusal.get_or_insert(json.clone()), &json);
    }
}

#[test]
fn checked_in_ios_example_requires_a_launch_scheme() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("scenarios/ios-simulator.yaml");
    assert_eq!(
        Scenario::load(&path).unwrap_err().code,
        FailureCode::DevClientSchemeRequired
    );
}

#[test]
fn ios_example_with_launch_scheme_is_valid() {
    let scenario = parse(&valid_ios_yaml()).unwrap();
    assert_eq!(scenario.platform, Platform::Ios);
    assert_eq!(scenario.name, "ios-simulator");
    assert_eq!(scenario.metro.as_ref().unwrap().port, 8791);
    assert_eq!(scenario.candidate.app_id, "com.rndevagent.testapp");
    assert!(scenario.ios.is_some());
    assert!(scenario.android.is_none());
}

#[test]
fn checked_in_android_example_is_valid() {
    let scenario = parse(&valid_android_yaml()).unwrap();
    assert_eq!(scenario.platform, Platform::Android);
    let android = scenario.android.unwrap();
    assert_eq!(android.ssh_host, "nuc");
    assert_eq!(android.farm_path, "bin/android-farm");
    assert_eq!(android.slot, 1);
}

#[test]
fn android_scenario_scheme_is_optional_but_uses_the_same_syntax_and_bounds() {
    let mut scenario = parse(&valid_android_yaml()).unwrap();
    assert!(scenario.candidate.dev_client_scheme.is_none());
    scenario.candidate.dev_client_scheme = Some("a".repeat(128));
    assert!(scenario.validate().is_ok());
    for scheme in ["", "private://payload", &"a".repeat(129)] {
        scenario.candidate.dev_client_scheme = Some(scheme.into());
        let failure = scenario.validate().unwrap_err();
        assert_eq!(failure.code, FailureCode::ScenarioInvalid);
        assert!(!failure.detail.contains("private"));
        assert!(!failure.detail.contains(&"a".repeat(129)));
    }
}

#[test]
fn examples_use_distinct_metro_ports() {
    let ios = parse(&valid_ios_yaml()).unwrap();
    let android = parse(&valid_android_yaml()).unwrap();
    assert_ne!(ios.metro.unwrap().port, android.metro.unwrap().port);
}

#[test]
fn rejects_unsupported_schema() {
    let yaml = valid_ios_yaml().replace("qaren/1", "qaren/999");
    let failure = parse(&yaml).unwrap_err();
    assert_eq!(failure.code, FailureCode::ScenarioSchemaUnsupported);
}

#[test]
fn rejects_unknown_fields() {
    let yaml = format!("{}\nextra_field: nope\n", valid_ios_yaml());
    assert!(parse(&yaml).is_err());
}

#[test]
fn rejects_traversal_project_root() {
    for root in ["../outside", "/absolute", "a/../../b"] {
        let yaml =
            valid_ios_yaml().replace("project_root: test-app", &format!("project_root: {root}"));
        let failure = parse(&yaml).unwrap_err();
        assert_eq!(
            failure.code,
            FailureCode::ScenarioInvalid,
            "root {root} must be rejected"
        );
    }
}

#[test]
fn rejects_option_like_ssh_host_and_farm_path() {
    for (from, to) in [
        ("ssh_host: nuc", "ssh_host: -oProxyCommand=evil"),
        ("ssh_host: nuc", "ssh_host: \"nuc evil\""),
        (
            "farm_path: bin/android-farm",
            "farm_path: \"bin/farm; rm -rf /\"",
        ),
        ("farm_path: bin/android-farm", "farm_path: ../escape"),
        ("farm_path: bin/android-farm", "farm_path: /abs/path"),
    ] {
        let yaml = valid_android_yaml().replace(from, to);
        assert!(parse(&yaml).is_err(), "{to} must be rejected");
    }
}

#[test]
fn rejects_bad_app_ids() {
    for app_id in [
        "-leading.dash",
        "double..dot",
        "trailing.",
        "has space",
        "semi;colon",
    ] {
        let yaml = valid_ios_yaml().replace(
            "app_id: com.rndevagent.testapp",
            &format!("app_id: \"{app_id}\""),
        );
        assert!(parse(&yaml).is_err(), "{app_id} must be rejected");
    }
}

#[test]
fn rejects_low_ports_and_bad_deadlines() {
    let yaml = valid_ios_yaml().replace("port: 8791", "port: 80");
    assert!(parse(&yaml).is_err());
    let yaml = valid_ios_yaml().replace("build_seconds: 2400", "build_seconds: 999999");
    assert!(parse(&yaml).is_err());
    let yaml = valid_ios_yaml().replace("install_deps_seconds: 900", "install_deps_seconds: 5");
    assert!(parse(&yaml).is_err());
}

#[test]
fn rejects_platform_section_mismatch() {
    let yaml = valid_ios_yaml().replace("platform: ios", "platform: android");
    assert!(
        parse(&yaml).is_err(),
        "android platform with ios section must be rejected"
    );
}

#[test]
fn rejects_revision_that_is_not_head_or_sha() {
    for bad in [
        "main",
        &"a".repeat(39),
        &"a".repeat(41),
        &format!("g{}", "a".repeat(39)),
    ] {
        let yaml = valid_ios_yaml().replace("revision: HEAD", &format!("revision: {bad}"));
        assert!(parse(&yaml).is_err(), "revision {bad:?} must be rejected");
    }
    let sha_yaml =
        valid_ios_yaml().replace("revision: HEAD", &format!("revision: {}", "a".repeat(40)));
    assert!(parse(&sha_yaml).is_ok());
}

#[test]
fn rejects_bad_slot() {
    let yaml = valid_android_yaml().replace("slot: 1", "slot: 0");
    assert!(parse(&yaml).is_err());
}

fn valid_handoff_yaml() -> String {
    "schema: qaren/1\nname: coop-ios\nplatform: ios\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nbuild:\n  owner: qaren\nios:\n  device_type: com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro\n  runtime: com.apple.CoreSimulator.SimRuntime.iOS-26-4\n".to_string()
}

#[test]
fn handoff_owner_scenario_is_valid_without_metro() {
    let scenario = parse(&valid_handoff_yaml()).unwrap();
    assert!(scenario.metro.is_none());
    assert_eq!(scenario.build.owner, qaren::scenario::BuildOwner::Qaren);
}

#[test]
fn qaren_owner_still_requires_metro() {
    let yaml = valid_ios_yaml()
        .lines()
        .filter(|l| !l.starts_with("metro") && !l.contains("port:"))
        .collect::<Vec<_>>()
        .join("\n");
    let failure = parse(&yaml).unwrap_err();
    assert!(failure.detail.contains("metro"), "{}", failure.detail);
}

#[test]
fn handoff_owner_rejects_a_metro_section() {
    let yaml = valid_handoff_yaml() + "metro:\n  port: 8791\n";
    let failure = parse(&yaml).unwrap_err();
    assert!(
        failure.detail.contains("qaren session allocates"),
        "{}",
        failure.detail
    );
}

#[test]
fn handoff_owner_rejects_the_farm_adapter() {
    let yaml = valid_android_yaml() + "build:\n  owner: qaren\n";
    // Drop the metro section too, otherwise that refusal fires first.
    let yaml = yaml
        .lines()
        .filter(|l| !l.starts_with("metro") && !l.trim_start().starts_with("port: 879"))
        .collect::<Vec<_>>()
        .join("\n");
    let failure = parse(&yaml).unwrap_err();
    assert!(failure.detail.contains("farm"), "{}", failure.detail);
}

#[test]
fn handoff_owner_rejects_clean_strategy_and_scheme_and_usb_port() {
    let clean = valid_handoff_yaml().replace("owner: qaren", "owner: qaren\n  strategy: clean");
    assert!(parse(&clean).unwrap_err().detail.contains("build.strategy"));

    let scheme = valid_handoff_yaml() + "  # comment\n";
    let scheme = scheme.replace(
        "revision: HEAD",
        "revision: HEAD\n  dev_client_scheme: rndatest",
    );
    assert!(parse(&scheme)
        .unwrap_err()
        .detail
        .contains("dev_client_scheme"));

    let usb = "schema: qaren/1\nname: coop-usb\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nbuild:\n  owner: qaren\nandroid_usb:\n  serial: R5CR20XXYZ\n  adb_server_port: 15039\n";
    assert!(parse(usb).unwrap_err().detail.contains("adb_server_port"));
}

#[test]
fn qaren_owner_usb_still_requires_adb_server_port() {
    let usb = "schema: qaren/1\nname: usb\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nmetro:\n  port: 8794\nandroid_usb:\n  serial: R5CR20XXYZ\n";
    let failure = parse(usb).unwrap_err();
    assert!(
        failure.detail.contains("adb_server_port is required"),
        "{}",
        failure.detail
    );
}

fn emulator_yaml(serial: &str, avd: &str) -> String {
    format!(
        "schema: qaren/1\nname: check\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\n  dev_client_scheme: rndatest\nmetro:\n  port: 8791\nandroid_emulator:\n  serial: {serial}\n  avd: {avd}\n"
    )
}

#[test]
fn android_emulator_matrix() {
    for (serial, avd) in [
        ("emulator-5554", "Pixel_9_API_37"),
        ("emulator-65534", "a.b-c_d"),
        ("emulator-5554", &"x".repeat(128)),
    ] {
        assert!(parse(&emulator_yaml(serial, avd)).is_ok(), "{serial} {avd}");
    }
    for (serial, avd) in [
        ("emulator-554", "avd"),
        ("emulator-555444", "avd"),
        ("emulator-55a4", "avd"),
        ("0A1B2C3D", "avd"),
        ("127.0.0.1:5555", "avd"),
        ("emulator-5554", "\"\""),
        ("emulator-5554", "bad/avd"),
        ("emulator-5554", &"x".repeat(129)),
    ] {
        let failure = parse(&emulator_yaml(serial, avd)).expect_err("must refuse");
        assert_eq!(failure.code, FailureCode::ScenarioInvalid, "{serial} {avd}");
    }
    let base = emulator_yaml("emulator-5554", "avd");
    let usb = format!("{base}android_usb:\n  serial: 0A1B2C3D\n  adb_server_port: 15037\n");
    let farm = format!(
        "{base}android:\n  ssh_host: nuc\n  farm_path: bin/android-farm\n  slot: 1\n  adb_server_port: 15037\n"
    );
    let handoff = base.replace("metro:\n  port: 8791\n", "build:\n  owner: qaren\n");
    for yaml in [
        usb,
        farm,
        handoff.replace("  dev_client_scheme: rndatest\n", ""),
    ] {
        assert_eq!(
            parse(&yaml).expect_err("must refuse").code,
            FailureCode::ScenarioInvalid,
            "{yaml}"
        );
    }
    let ios = format!(
        "{}android_emulator:\n  serial: emulator-5554\n  avd: avd\n",
        valid_ios_yaml()
    );
    assert_eq!(
        parse(&ios).expect_err("ios must refuse").code,
        FailureCode::ScenarioInvalid
    );
    let unschemed = parse(&base.replace("  dev_client_scheme: rndatest\n", "")).unwrap_err();
    assert_eq!(unschemed.code, FailureCode::DevClientSchemeRequired);
    assert!(!unschemed.detail.contains("iOS"), "{}", unschemed.detail);
}

#[test]
fn prepare_refuses_a_borrowed_emulator_scenario_before_any_command() {
    let dir = std::env::temp_dir().join(format!("qaren-emulator-prepare-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("scenario.yaml");
    std::fs::write(&path, emulator_yaml("emulator-5554", "avd")).unwrap();
    let mut mock = qaren::exec::MockRunner::new();
    let receipt = qaren::commands::prepare::prepare(
        &mut mock,
        &qaren::commands::prepare::PrepareArgs {
            scenario_path: path.clone(),
            dry_run: true,
            android_home: None,
            lock_root: dir.join(".locks"),
            native_cache_root: dir.join(".native-store"),
            runs_root: dir.clone(),
            device: None,
            boot_device: false,
            pool_root: dir.join(".pool"),
            new_device: false,
        },
    );
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::ScenarioInvalid);
    assert!(
        failure.detail.contains("only by qaren check"),
        "{}",
        failure.detail
    );
    assert!(mock.calls.is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn registry_auth_scenario_defaults_roundtrips_and_refuses_value_echoes() {
    let repo = common::temp_repo();
    let path = repo.join("scenario.yaml");
    let base = valid_ios_yaml();
    std::fs::write(&path, &base).unwrap();
    let (scenario, _) = Scenario::load(&path).unwrap();
    assert!(scenario.deps.registry_auth_env.is_empty());
    assert!(!serde_yaml::to_string(&scenario)
        .unwrap()
        .contains("registry_auth_env"));
    std::fs::write(&path, format!("{base}deps:\n  registry_auth_env: [PRIVATE_REGISTRY_TOKEN, lower_token, _AUTH, PRIVATE_REGISTRY_TOKEN]\n")).unwrap();
    let (scenario, _) = Scenario::load(&path).unwrap();
    let yaml = serde_yaml::to_string(&scenario).unwrap();
    std::fs::write(&path, yaml).unwrap();
    let (roundtrip, _) = Scenario::load(&path).unwrap();
    assert_eq!(
        roundtrip.deps.registry_auth_env,
        [
            "PRIVATE_REGISTRY_TOKEN",
            "lower_token",
            "_AUTH",
            "PRIVATE_REGISTRY_TOKEN"
        ]
    );
    for value in common::invalid_registry_auth_lists() {
        std::fs::write(
            &path,
            format!("{base}deps:\n  registry_auth_env: {value}\n"),
        )
        .unwrap();
        let failure = Scenario::load(&path).unwrap_err();
        assert_eq!(failure.code, FailureCode::ScenarioInvalid);
        let output = serde_json::to_string(&failure).unwrap();
        assert!(!output.contains("mistaken-value"));
        assert!(!output.contains("fallback"));
    }
    for key in ["registryAuthEnv", "REGISTRY_AUTH_ENV", "env"] {
        std::fs::write(&path, format!("{base}deps:\n  {key}: []\n")).unwrap();
        assert_eq!(
            Scenario::load(&path).unwrap_err().code,
            FailureCode::ScenarioInvalid
        );
    }
    std::fs::remove_dir_all(repo).unwrap();
}

#[test]
fn scenario_deadline_bounds_match_the_shared_contract_and_keep_defaults() {
    for yaml in [valid_ios_yaml(), valid_android_yaml(), valid_handoff_yaml()] {
        let scenario = parse(&yaml).unwrap();
        assert_eq!(scenario.deadlines.install_deps_seconds, 900);
        assert_eq!(scenario.deadlines.build_seconds, 2400);
        assert_eq!(scenario.deadlines.device_boot_seconds, 420);
    }
    let stripped = valid_ios_yaml().replace(
        "deadlines:\n  install_deps_seconds: 900\n  build_seconds: 2400\n  device_boot_seconds: 420\n",
        "",
    );
    assert!(!stripped.contains("deadlines:"));
    let omitted = parse(&stripped).unwrap();
    assert_eq!(omitted.deadlines.install_deps_seconds, 900);
    assert_eq!(omitted.deadlines.build_seconds, 2400);
    assert_eq!(omitted.deadlines.device_boot_seconds, 420);

    let repo = common::temp_repo();
    let path = repo.join("scenario.yaml");
    for (field, from, value) in [
        ("install_deps_seconds", "900", 30u64),
        ("install_deps_seconds", "900", 7200),
        ("build_seconds", "2400", 30),
        ("build_seconds", "2400", 7200),
        ("device_boot_seconds", "420", 30),
        ("device_boot_seconds", "420", 7200),
    ] {
        let yaml =
            valid_ios_yaml().replace(&format!("{field}: {from}"), &format!("{field}: {value}"));
        std::fs::write(&path, &yaml).unwrap();
        let (scenario, raw) = Scenario::load(&path).unwrap();
        assert_eq!(raw, yaml);
        let actual = match field {
            "install_deps_seconds" => scenario.deadlines.install_deps_seconds,
            "build_seconds" => scenario.deadlines.build_seconds,
            "device_boot_seconds" => scenario.deadlines.device_boot_seconds,
            _ => unreachable!(),
        };
        assert_eq!(actual, value, "{field}");
    }
    for (field, value) in [
        ("install_deps_seconds", 0u64),
        ("build_seconds", 29),
        ("device_boot_seconds", 7201),
        ("build_seconds", u64::MAX),
    ] {
        let from = match field {
            "install_deps_seconds" => "900",
            "build_seconds" => "2400",
            "device_boot_seconds" => "420",
            _ => unreachable!(),
        };
        let yaml =
            valid_ios_yaml().replace(&format!("{field}: {from}"), &format!("{field}: {value}"));
        let failure = parse(&yaml).unwrap_err();
        assert_eq!(failure.code, FailureCode::ScenarioInvalid);
        assert!(
            failure.detail.contains(&format!(
                "deadlines.{field} = {value} must be within 30..=7200 seconds"
            )),
            "{}",
            failure.detail
        );
        std::fs::write(&path, &yaml).unwrap();
        let loaded = Scenario::load(&path).unwrap_err();
        assert_eq!(loaded.code, FailureCode::ScenarioInvalid);
        assert_eq!(loaded.detail.to_string(), failure.detail.to_string());
    }
}

#[test]
fn max_devices_zero_is_invalid_and_absent_defaults_to_one() {
    let base = valid_ios_yaml();
    let runtime = base
        .lines()
        .find(|l| l.trim_start().starts_with("runtime:"))
        .unwrap()
        .to_string();
    let with = |cap: &str| base.replace(&runtime, &format!("{runtime}\n  max_devices: {cap}"));
    let failure = parse(&with("0")).unwrap_err();
    assert_eq!(failure.code, FailureCode::ScenarioInvalid);
    assert!(failure.detail.to_string().contains("max_devices"));
    assert_eq!(parse(&with("3")).unwrap().ios.unwrap().max_devices, Some(3));
    let absent = parse(&base).unwrap().ios.unwrap();
    assert_eq!(absent.max_devices, None);
    assert_eq!(qaren::pool::default_cap(&absent), 1);
}
