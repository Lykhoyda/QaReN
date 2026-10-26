mod common;

use qaren::config::CheckConfig;
use qaren::failure::FailureCode;
use qaren::scenario::Platform;

#[test]
fn launch_scheme_is_required_on_every_check_platform() {
    let repo = common::temp_repo();
    let path = repo.join("config.yaml");
    std::fs::write(&path, "appId: com.test.app\nios: {}\nandroid: {}\n").unwrap();
    let (config, _) = CheckConfig::load(&path).unwrap();
    for platform in [Platform::Ios, Platform::Android] {
        let failure = config.validate_for_platform(platform).unwrap_err();
        assert_eq!(failure.code, FailureCode::DevClientSchemeRequired);
        assert!(failure.code.is_refusal());
        assert!(!failure.detail.contains("iOS"), "{}", failure.detail);
    }
}

#[test]
fn check_config_owns_bounded_launch_scheme_validation_without_echoing_input() {
    let mut config: CheckConfig = serde_yaml::from_str("appId: com.test.app\n").unwrap();
    for scheme in ["A", "Expo+test-1.2", &"a".repeat(128)] {
        config.dev_client_scheme = Some(scheme.into());
        assert!(config.validate_for_platform(Platform::Ios).is_ok());
        assert!(config.validate_for_platform(Platform::Android).is_ok());
    }
    let mut refusal = None;
    for scheme in [
        None,
        Some(""),
        Some(" "),
        Some("1private"),
        Some("private://payload"),
        Some("private\npayload"),
        Some("privaté"),
        Some(&"a".repeat(129)),
    ] {
        config.dev_client_scheme = scheme.map(String::from);
        let failure = config.validate_for_platform(Platform::Ios).unwrap_err();
        assert_eq!(failure.code, FailureCode::DevClientSchemeRequired);
        assert!(failure.code.is_refusal());
        let json = serde_json::to_value(failure).unwrap();
        assert_eq!(refusal.get_or_insert(json.clone()), &json);
        let android =
            serde_json::to_value(config.validate_for_platform(Platform::Android).unwrap_err())
                .unwrap();
        assert_eq!(android, json);
    }
}

fn load(yaml: &str) -> Result<CheckConfig, qaren::failure::Failure> {
    load_raw(yaml).map(|(config, _)| config)
}

fn load_raw(yaml: &str) -> Result<(CheckConfig, String), qaren::failure::Failure> {
    let repo = common::temp_repo();
    let path = repo.join("config.yaml");
    std::fs::write(&path, yaml).unwrap();
    CheckConfig::load(&path)
}

#[test]
fn login_block_and_marker_load_together() {
    let config = load("appId: a\nloginBlock: log-in\nloginMarker: { id: login-screen }\n").unwrap();
    assert_eq!(config.login_block.as_deref(), Some("log-in"));
    assert_eq!(
        config.login_marker.as_ref().and_then(|m| m.id.as_deref()),
        Some("login-screen")
    );
    let config = load("appId: a\nloginBlock: log-in\nloginMarker: { text: Sign in }\n").unwrap();
    assert_eq!(
        config.login_marker.and_then(|m| m.text).as_deref(),
        Some("Sign in")
    );
}

#[test]
fn login_config_refuses_half_pairs_bad_slugs_and_ambiguous_markers() {
    for yaml in [
        "appId: a\nloginBlock: log-in\n",
        "appId: a\nloginMarker: { id: login-screen }\n",
    ] {
        let failure = load(yaml).unwrap_err();
        assert_eq!(failure.code, FailureCode::ScenarioInvalid);
        let detail = failure.detail.to_string();
        assert!(
            detail.contains("loginBlock") && detail.contains("loginMarker"),
            "{detail}"
        );
    }
    for yaml in [
        "appId: a\nloginBlock: ../x\nloginMarker: { id: m }\n",
        "appId: a\nloginBlock: a..b\nloginMarker: { id: m }\n",
        "appId: a\nloginBlock: -x\nloginMarker: { id: m }\n",
        &format!(
            "appId: a\nloginBlock: {}\nloginMarker: {{ id: m }}\n",
            "a".repeat(65)
        ),
        "appId: a\nloginBlock: log-in\nloginMarker: { id: m, text: t }\n",
        "appId: a\nloginBlock: log-in\nloginMarker: {}\n",
        "appId: a\nloginBlock: log-in\nloginMarker: { id: '' }\n",
    ] {
        assert_eq!(
            load(yaml).unwrap_err().code,
            FailureCode::ScenarioInvalid,
            "{yaml}"
        );
    }
}

#[test]
fn check_config_rejects_unsupported_environment_injection() {
    let failure = load("appId: a\nenv: { ENVIRONMENT: staging }\n").unwrap_err();
    assert_eq!(failure.code, FailureCode::ScenarioInvalid);
}

fn config_yaml(deadlines: &str) -> String {
    format!("appId: com.example.testapp\ndevClientScheme: testapp\n{deadlines}")
}

fn assert_deadline_values(config: &CheckConfig, deps: u64, build: u64, boot: u64) {
    assert_eq!(config.deadlines.install_deps_seconds, deps);
    assert_eq!(config.deadlines.build_seconds, build);
    assert_eq!(config.deadlines.device_boot_seconds, boot);
}

#[test]
fn attach_deadline_defaults_to_two_minutes_and_is_configurable() {
    let (config, _) = load_raw(&config_yaml("")).unwrap();
    assert_eq!(config.deadlines.attach_seconds, 120);
    let (config, _) = load_raw(&config_yaml("deadlines:\n  attach_seconds: 300\n")).unwrap();
    assert_eq!(config.deadlines.attach_seconds, 300);
    assert_deadline_values(&config, 900, 2400, 420);
}

#[test]
fn load_accepts_a_configured_build_deadline() {
    let yaml = config_yaml("deadlines:\n  build_seconds: 5400\n");
    let (config, raw) = load_raw(&yaml).expect("deadlines are part of check configuration");
    assert_eq!(raw, yaml);
    assert_deadline_values(&config, 900, 5400, 420);
}

#[test]
fn omitted_empty_and_bare_deadline_blocks_keep_defaults() {
    for deadlines in ["", "deadlines: {}\n", "deadlines:\n"] {
        let yaml = config_yaml(deadlines);
        let (config, raw) = load_raw(&yaml).unwrap();
        assert_eq!(raw, yaml, "{deadlines:?}");
        assert_deadline_values(&config, 900, 2400, 420);
    }
}

#[test]
fn each_deadline_field_overrides_only_itself() {
    let cases = [
        ("install_deps_seconds: 120\n", 120, 2400, 420),
        ("build_seconds: 5400\n", 900, 5400, 420),
        ("device_boot_seconds: 90\n", 900, 2400, 90),
        (
            "install_deps_seconds: 120\n  build_seconds: 5400\n  device_boot_seconds: 90\n",
            120,
            5400,
            90,
        ),
        (
            "install_deps_seconds: 30\n  build_seconds: 30\n  device_boot_seconds: 30\n",
            30,
            30,
            30,
        ),
        (
            "install_deps_seconds: 7200\n  build_seconds: 7200\n  device_boot_seconds: 7200\n",
            7200,
            7200,
            7200,
        ),
    ];
    for (fields, deps, build, boot) in cases {
        let yaml = config_yaml(&format!("deadlines:\n  {fields}"));
        let (config, raw) = load_raw(&yaml).unwrap_or_else(|e| panic!("{fields}: {e:?}"));
        assert_eq!(raw, yaml);
        assert_deadline_values(&config, deps, build, boot);
    }
}

#[test]
fn deadline_values_outside_30_through_7200_are_invalid() {
    for (field, value) in [
        ("install_deps_seconds", 0u64),
        ("install_deps_seconds", 29),
        ("install_deps_seconds", 7201),
        ("install_deps_seconds", u64::MAX),
        ("build_seconds", 0),
        ("build_seconds", 29),
        ("build_seconds", 7201),
        ("build_seconds", u64::MAX),
        ("device_boot_seconds", 0),
        ("device_boot_seconds", 29),
        ("device_boot_seconds", 7201),
        ("device_boot_seconds", u64::MAX),
        ("attach_seconds", 29),
        ("attach_seconds", 7201),
    ] {
        let yaml = config_yaml(&format!("deadlines:\n  {field}: {value}\n"));
        let failure = load(&yaml).unwrap_err();
        assert_eq!(
            failure.code,
            FailureCode::ScenarioInvalid,
            "{field}={value}"
        );
        let detail = failure.detail.to_string();
        assert!(
            detail.contains(&format!(
                "deadlines.{field} = {value} must be within 30..=7200 seconds"
            )),
            "{detail}"
        );
    }
}

#[test]
fn deadline_parse_refusals_stay_generic() {
    let blocks = [
        "deadlines: null\n",
        "deadlines: ~\n",
        "deadlines: 30\n",
        "deadlines: [30]\n",
        "deadlines:\n  - 30\n",
        "deadlines:\n  build_seconds: null\n",
        "deadlines:\n  build_seconds: ~\n",
        "deadlines:\n  build_seconds:\n",
        "deadlines:\n  build_seconds: -1\n",
        "deadlines:\n  build_seconds: 30.5\n",
        "deadlines:\n  build_seconds: \"5400\"\n",
        "deadlines:\n  build_seconds: true\n",
        "deadlines:\n  build_seconds: [30]\n",
        "deadlines:\n  build_seconds: {seconds: 30}\n",
        "deadlines:\n  build_seconds: 18446744073709551616\n",
        "deadlines:\n  build_seconds: 5400\n  build_seconds: 30\n",
        "deadlines:\n  build_seconds: 5400\n  extra: mistaken-value\n",
        "deadlines:\n  deps_seconds: 900\n",
        "deadlines:\n  boot_seconds: 420\n",
        "deadlines:\n  buildSeconds: 5400\n",
        "deadlineBudget: mistaken-value\n",
    ];
    for block in blocks {
        let failure = load(&config_yaml(block)).unwrap_err();
        assert_eq!(failure.code, FailureCode::ScenarioInvalid, "{block}");
        let output = serde_json::to_string(&failure).unwrap();
        assert!(
            output.contains("does not parse as check configuration"),
            "{block}: {output}"
        );
        assert!(!output.contains("mistaken-value"), "{block}: {output}");
        assert!(!output.contains("18446744073709551616"), "{output}");
        assert!(!output.contains("5400"), "{block}: {output}");
    }
}

#[test]
fn registry_auth_env_loads_names_only() {
    let config = load("appId: a\nregistryAuthEnv: [PRIVATE_REGISTRY_TOKEN, lower_token, _AUTH, PRIVATE_REGISTRY_TOKEN]\n").unwrap();
    assert_eq!(
        config.registry_auth_env,
        [
            "PRIVATE_REGISTRY_TOKEN",
            "lower_token",
            "_AUTH",
            "PRIVATE_REGISTRY_TOKEN"
        ]
    );
    assert!(load("appId: a\n").unwrap().registry_auth_env.is_empty());
    for name in ["A".repeat(128), "_".into()] {
        assert!(load(&format!("appId: a\nregistryAuthEnv: [{name}]\n")).is_ok());
    }
    assert!(load(&format!(
        "appId: a\nregistryAuthEnv: {}\n",
        serde_json::json!(vec!["NAME"; 64])
    ))
    .is_ok());
}

#[test]
fn registry_auth_env_refuses_invalid_lists_without_echoing_content() {
    for value in common::invalid_registry_auth_lists() {
        let failure = load(&format!("appId: a\nregistryAuthEnv: {value}\n")).unwrap_err();
        assert_eq!(failure.code, FailureCode::ScenarioInvalid);
        let output = serde_json::to_string(&failure).unwrap();
        assert!(!output.contains("mistaken-value"));
        assert!(!output.contains("fallback"));
        assert!(!output.contains("UNICODE"));
    }
    for key in ["registry_auth_env", "REGISTRYAUTHENV", "env"] {
        assert_eq!(
            load(&format!("appId: a\n{key}: []\n")).unwrap_err().code,
            FailureCode::ScenarioInvalid
        );
    }
}

#[test]
fn save_plans_is_an_optional_boolean() {
    assert_eq!(load("appId: com.test.app\n").unwrap().save_plans, None);
    assert_eq!(
        load("appId: com.test.app\nsavePlans: false\n")
            .unwrap()
            .save_plans,
        Some(false)
    );
    assert!(load("appId: com.test.app\nsavePlans: maybe\n").is_err());
}
