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
    let repo = common::temp_repo();
    let path = repo.join("config.yaml");
    std::fs::write(&path, yaml).unwrap();
    CheckConfig::load(&path).map(|(config, _)| config)
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
