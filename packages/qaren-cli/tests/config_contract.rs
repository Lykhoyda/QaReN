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

// A refused file with the path it was written to, so a test can compare whole texts.
fn refused(yaml: &str) -> (String, qaren::failure::Failure) {
    let repo = common::temp_repo();
    let path = repo.join("config.yaml");
    std::fs::write(&path, yaml).unwrap();
    let failure = CheckConfig::load(&path).unwrap_err();
    (path.display().to_string(), failure)
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
fn build_jobs_and_priority_load_and_refuse_values_that_cannot_apply() {
    use qaren::scenario::BuildPriority;
    let config = load(&config_yaml("")).unwrap();
    assert_eq!(config.build.jobs, None);
    assert_eq!(config.build.priority, None);
    let config = load(&config_yaml("build:\n  jobs: 3\n  priority: normal\n")).unwrap();
    assert_eq!(config.build.jobs.map(|n| n.get()), Some(3));
    assert_eq!(config.build.priority, Some(BuildPriority::Normal));
    let config = load(&config_yaml("build:\n  priority: low\n")).unwrap();
    assert_eq!(config.build.priority, Some(BuildPriority::Low));
    assert_eq!(config.build.arch, None);
    let config = load(&config_yaml("build:\n  arch: all\n")).unwrap();
    assert_eq!(config.build.arch, Some(qaren::scenario::BuildArch::All));
    for block in [
        "build:\n  arch: arm64\n",
        "build:\n  jobs: 0\n",
        "build:\n  jobs: -2\n",
        "build:\n  priority: high\n",
        "build:\n  workers: 3\n",
    ] {
        let failure = load(&config_yaml(block)).unwrap_err();
        assert_eq!(failure.code, FailureCode::ScenarioInvalid, "{block}");
    }
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
        ("manifest_warmup_seconds", 29),
        ("manifest_warmup_seconds", 7201),
        ("attach_seconds", 29),
        ("attach_seconds", 7201),
    ] {
        let yaml = config_yaml(&format!("deadlines:\n  {field}: {value}\n"));
        let (path, failure) = refused(&yaml);
        assert_eq!(
            failure.code,
            FailureCode::ScenarioInvalid,
            "{field}={value}"
        );
        // The whole detail is fixed text: the value read is not in it.
        assert_eq!(
            failure.detail.to_string(),
            format!("{path}: `deadlines.{field}` is outside 30 through 7200 seconds"),
            "{field}={value}"
        );
        assert_eq!(
            failure.next_action.to_string(),
            format!("in the config file, set `deadlines.{field}` to a whole number of seconds from 30 through 7200; then run the same command again")
        );
    }
}

#[test]
fn deadline_parse_refusals_never_echo_values() {
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
    let tmp = common::temp_repo();
    let repo = tmp.join("deadline-5400");
    std::fs::create_dir_all(&repo).unwrap();
    let config_path = repo.join("config.yaml");
    for block in blocks {
        std::fs::write(&config_path, config_yaml(block)).unwrap();
        let failure = CheckConfig::load(&config_path).unwrap_err();
        assert_eq!(failure.code, FailureCode::ScenarioInvalid, "{block}");
        let output = serde_json::to_string(&failure).unwrap();
        assert!(
            output.contains("does not parse as check configuration"),
            "{block}: {output}"
        );
        assert!(!output.contains("mistaken-value"), "{block}: {output}");
        assert!(!output.contains("18446744073709551616"), "{output}");
        let mut without_path = serde_json::to_value(&failure).unwrap();
        without_path["detail"] = failure
            .detail
            .to_string()
            .replace(config_path.to_str().unwrap(), "<config path>")
            .into();
        assert!(
            !serde_json::to_string(&without_path)
                .unwrap()
                .contains("5400"),
            "{block}: {output}"
        );
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

#[test]
fn proof_in_description_is_an_optional_boolean() {
    assert_eq!(
        load("appId: com.test.app\n").unwrap().proof_in_description,
        None
    );
    assert_eq!(
        load("appId: com.test.app\nproofInDescription: true\n")
            .unwrap()
            .proof_in_description,
        Some(true)
    );
    assert!(load("appId: com.test.app\nproofInDescription: maybe\n").is_err());
}

#[test]
fn video_policy_is_explicit_and_invalid_values_refuse_without_echoing_them() {
    use qaren::record::VideoPolicy;
    let repo = common::temp_repo();
    let path = repo.join("config.yaml");
    for (suffix, expected) in [
        ("", VideoPolicy::DefaultNonStrict),
        ("video: strict\n", VideoPolicy::Strict),
        ("video: non-strict\n", VideoPolicy::NonStrict),
    ] {
        std::fs::write(&path, format!("appId: com.test.app\n{suffix}")).unwrap();
        assert_eq!(CheckConfig::load(&path).unwrap().0.video, expected);
    }
    for value in [
        "undeclared",
        "default-non-strict",
        "unknown",
        "private-canary",
        "null",
        "true",
        "1",
        "[]",
        "{}",
        "\"\"",
    ] {
        std::fs::write(&path, format!("appId: com.test.app\nvideo: {value}\n")).unwrap();
        let error = CheckConfig::load(&path).unwrap_err();
        assert_eq!(error.code, FailureCode::ScenarioInvalid);
        assert!(!error.detail.contains("private-canary"));
        assert!(error
            .next_action
            .contains("video must be strict or non-strict"));
    }
}

#[test]
fn manifest_deadline_defaults_to_420_seconds_and_validates_overrides() {
    let (config, _) = load_raw(&config_yaml("")).unwrap();
    assert_eq!(config.deadlines.manifest_warmup_seconds, 420);
    for seconds in [30, 7200] {
        let (config, _) = load_raw(&config_yaml(&format!(
            "deadlines:\n  manifest_warmup_seconds: {seconds}\n"
        )))
        .unwrap();
        assert_eq!(config.deadlines.manifest_warmup_seconds, seconds);
    }
    for seconds in [0, 29, 7201] {
        assert!(load_raw(&config_yaml(&format!(
            "deadlines:\n  manifest_warmup_seconds: {seconds}\n"
        )))
        .is_err());
    }
}

const AGAIN: &str = "; then run the same command again";

// The one next step for every stated parse fault: no edit of its own, and where each key is read.
const KEY_FAULT_NEXT: &str = "in the config file, correct what the detail identifies; this qaren reads, at the top level: appId, video, packageManager, registryAuthEnv, metroPort, ios, android, nodePath, devClientScheme, loginBlock, loginMarker, savePlans, proofInDescription, depsCache, build, deadlines; under `ios:`: deviceType, runtime, build; under `ios:` then `build:`: workspace, scheme; under `android:`: avd; under `loginMarker:`: id, text; under `build:`: jobs, priority, arch; under `deadlines:`: install_deps_seconds, build_seconds, device_boot_seconds, manifest_warmup_seconds, attach_seconds; then run the same command again";

#[test]
fn the_documented_attach_limit_shape_loads_as_every_2_x_release_read_it() {
    let yaml = config_yaml(
        "deadlines:\n  install_deps_seconds: 600\n  build_seconds: 3600\n  device_boot_seconds: 240\n  attach_seconds: 300\n",
    );
    let (config, raw) = load_raw(&yaml).unwrap();
    assert_eq!(raw, yaml);
    assert_eq!(config.deadlines.attach_seconds, 300);
    assert_eq!(config.deadlines.manifest_warmup_seconds, 420);
    assert_deadline_values(&config, 600, 3600, 240);
}

#[test]
fn a_misplaced_or_respelled_attach_limit_refuses_naming_the_key_and_its_place() {
    let moved = |from: &str| {
        format!("{from} has a key for `attach_seconds`, which is read only under `deadlines:`")
    };
    let respelled = "`deadlines:` has a key for `attach_seconds` in another spelling".to_string();
    for (block, seen) in [
        ("attach_seconds: 4271\n", moved("the top level")),
        ("attachSeconds: 4271\n", moved("the top level")),
        ("ios:\n  attach_seconds: 4271\n", moved("`ios:`")),
        ("android:\n  attach_seconds: 4271\n", moved("`android:`")),
        ("deadlines:\n  attachSeconds: 4271\n", respelled.clone()),
        ("deadlines:\n  attach-seconds: 4271\n", respelled.clone()),
        // Overlapping keys are each stated as they are; nothing says which to keep.
        (
            "deadlines:\n  attach_seconds: 300\n  attachSeconds: 4271\n",
            respelled.clone(),
        ),
        (
            "attach_seconds: 4271\ndeadlines:\n  attach_seconds: 300\n",
            moved("the top level"),
        ),
        (
            "deadlines:\n  attachSeconds: 4271\n  attach-seconds: 4272\n",
            respelled.clone(),
        ),
        (
            "Deadlines: {attach_seconds: 300}\nattach_seconds: 4271\n",
            format!(
                "the top level has a key for `deadlines` in another spelling; {}",
                moved("the top level")
            ),
        ),
        (
            "build: &b {jobs: 2}\nios: *b\n",
            "`ios:` has a key for `jobs`, which is read only under `build:`".to_string(),
        ),
        (
            "ios:\n  deadlines: {video: strict, attach_seconds: 4271}\n",
            "`ios:` has a key for `deadlines`, which is read only at the top level".to_string(),
        ),
    ] {
        let (path, failure) = refused(&config_yaml(block));
        assert_eq!(failure.code, FailureCode::ScenarioInvalid, "{block}");
        assert_eq!(failure.phase, "config");
        assert!(!failure.code.is_refusal());
        assert_eq!(
            failure.detail.to_string(),
            format!("{path} does not parse as check configuration: {seen}"),
            "{block}"
        );
        assert_eq!(failure.next_action.to_string(), KEY_FAULT_NEXT, "{block}");
    }
    // The reader stopping is given by position, with the same fixed next step.
    let (path, failure) = refused(&config_yaml("deadlines:\n\tattach_seconds: 4271\n"));
    assert_eq!(
        failure.detail.to_string(),
        format!("{path} does not parse as check configuration: the YAML reader stopped at line 4, column 1")
    );
    assert_eq!(failure.next_action.to_string(), KEY_FAULT_NEXT);
    // No next step tells the user to remove a key or to keep one of several.
    assert!(!KEY_FAULT_NEXT.contains("remove") && !KEY_FAULT_NEXT.contains("keep one"));
}

// Writing the key where the refusal says it is read is one edit that loads; the refusal itself
// prescribes no edit, so this is a control on the fixtures, not a promise of the product.
#[test]
fn an_attach_limit_written_where_it_is_read_loads() {
    for (bad, edited) in [
        (
            "attach_seconds: 300\n",
            "deadlines:\n  attach_seconds: 300\n",
        ),
        (
            "deadlines:\n  attachSeconds: 300\n",
            "deadlines:\n  attach_seconds: 300\n",
        ),
    ] {
        assert!(load(&config_yaml(bad)).is_err(), "{bad}");
        let config = load(&config_yaml(edited)).unwrap();
        assert_eq!(config.deadlines.attach_seconds, 300);
    }
}

// What this change does not name keeps the general refusal, and that refusal speaks of the
// file that was selected, not of the default path.
#[test]
fn faults_that_are_not_named_keep_the_general_refusal_for_the_selected_file() {
    for block in [
        "deadlines:\n  attach_seconds: \"4271\"\n",
        "deadlines:\n  attach_seconds: 4271.5\n",
        "deadlines:\n  attach_seconds: 300\n  attach_seconds: 4271\n",
        "attach_seconds: !!str 4271\n",
        "metroPort: private-canary\n",
    ] {
        let (path, failure) = refused(&config_yaml(block));
        assert_eq!(failure.code, FailureCode::ScenarioInvalid, "{block}");
        assert_eq!(
            failure.detail.to_string(),
            format!("{path} does not parse as check configuration"),
            "{block}"
        );
        let next = failure.next_action.to_string();
        assert!(
            next.starts_with("fix the config file (video must be strict or non-strict; keys: "),
            "{next}"
        );
        assert!(!next.contains(".qaren/config.yaml"), "{next}");
    }
    // A missing file is to be created; a path that exists and cannot be read is not.
    let repo = common::temp_repo();
    let missing = CheckConfig::load(&repo.join("other.yaml")).unwrap_err();
    assert_eq!(missing.code, FailureCode::ScenarioUnreadable);
    assert_eq!(
        missing.next_action.to_string(),
        "create the config file with at least `appId: <bundle id>` and `devClientScheme: <the app's registered URI scheme>` (.qaren/config.yaml unless --config selects another)"
    );
    for unreadable in ["a-directory", "not-utf8.yaml"] {
        let path = repo.join(unreadable);
        if unreadable == "a-directory" {
            std::fs::create_dir(&path).unwrap();
        } else {
            std::fs::write(&path, [0xff, 0xfe, b'a']).unwrap();
        }
        let failure = CheckConfig::load(&path).unwrap_err();
        assert_eq!(
            failure.code,
            FailureCode::ScenarioUnreadable,
            "{unreadable}"
        );
        assert_eq!(
            failure.next_action.to_string(),
            "make the selected config path a readable UTF-8 text file, then run the same command again",
            "{unreadable}"
        );
    }
}

#[test]
fn a_key_this_build_does_not_read_is_counted_and_never_quoted() {
    let (path, failure) = refused(&config_yaml(
        "privateCanaryKey: private-canary-value\ndeadlines:\n  attach_seconds: 300\n  private_canary_limit: 300\n",
    ));
    assert_eq!(failure.code, FailureCode::ScenarioInvalid);
    assert_eq!(
        failure.detail.to_string(),
        format!(
            "{path} does not parse as check configuration: key 3 of 4 at the top level is not one qaren {v} reads; key 2 of 2 under `deadlines:` is not one qaren {v} reads",
            v = qaren::VERSION
        )
    );
    assert_eq!(failure.next_action.to_string(), KEY_FAULT_NEXT);
}

#[test]
fn every_value_refusal_names_its_key_and_never_what_the_file_held() {
    let cases = [
        (
            "registryAuthEnv: [QAREN_INPUT_PRIVATE_CANARY]\n",
            "`registryAuthEnv` is not a list of at most 64 allowed environment names",
            "list at most 64 names, each matching [A-Za-z_][A-Za-z0-9_]* and at most 128 ASCII bytes, and neither TYPESAFE_API_KEY nor a name starting with QAREN_INPUT_ (in any letter case)",
        ),
        (
            "packageManager: private-canary\n",
            "`packageManager` is not pnpm, the only package manager this release supports",
            "set `packageManager: pnpm` or remove the key",
        ),
        (
            "metroPort: 1023\n",
            "`metroPort` is below 1024",
            "set `metroPort` to a port from 1024 through 65535, or remove the key",
        ),
        (
            "deadlines:\n  attach_seconds: 7201\n",
            "`deadlines.attach_seconds` is outside 30 through 7200 seconds",
            "set `deadlines.attach_seconds` to a whole number of seconds from 30 through 7200",
        ),
        (
            "nodePath: private-canary/bin/node\n",
            "`nodePath` is not an absolute path",
            "set `nodePath` to the absolute path of a Node 24 or newer binary, or remove the key",
        ),
        (
            "loginBlock: private-canary\n",
            "`loginBlock` and `loginMarker` are not set together",
            "set both `loginBlock` and `loginMarker`, or neither",
        ),
        (
            "loginBlock: ../private-canary\nloginMarker: { id: m }\n",
            "`loginBlock` is not a saved-block slug",
            "set `loginBlock` to a slug of ASCII letters, digits, `_`, `.` or `-` that starts with a letter or digit, at most 64 characters, without `..`",
        ),
        (
            "loginBlock: log-in\nloginMarker: { id: private-canary, text: private-canary }\n",
            "`loginMarker` does not have exactly one of `id` and `text`, set to a non-empty value",
            "set exactly one of `id` (testID) or `text` (label) in `loginMarker` to a non-empty value and omit the other",
        ),
        (
            "loginBlock: log-in\nloginMarker: { id: private-canary, text: '' }\n",
            "`loginMarker` does not have exactly one of `id` and `text`, set to a non-empty value",
            "set exactly one of `id` (testID) or `text` (label) in `loginMarker` to a non-empty value and omit the other",
        ),
    ];
    for (block, seen, fix) in cases {
        let (path, failure) = refused(&config_yaml(block));
        assert_eq!(failure.code, FailureCode::ScenarioInvalid, "{block}");
        assert_eq!(failure.phase, "config");
        assert_eq!(
            failure.detail.to_string(),
            format!("{path}: {seen}"),
            "{block}"
        );
        assert_eq!(
            failure.next_action.to_string(),
            format!("in the config file, {fix}{AGAIN}"),
            "{block}"
        );
    }
    let (path, failure) = refused("appId: '  '\ndevClientScheme: testapp\n");
    assert_eq!(failure.code, FailureCode::ScenarioInvalid);
    assert_eq!(failure.phase, "config");
    assert_eq!(
        failure.detail.to_string(),
        format!("{path}: `appId` is blank")
    );
    assert_eq!(
        failure.next_action.to_string(),
        format!("in the config file, set `appId` to the app's bundle ID or package name{AGAIN}")
    );
    // The workspace rule keeps the phase of the validator it shares with prepare.
    let (path, failure) = refused(&config_yaml(
        "ios:\n  build:\n    workspace: ../private-canary.xcworkspace\n    scheme: private-canary\n",
    ));
    assert_eq!(failure.code, FailureCode::ScenarioInvalid);
    assert_eq!(failure.phase, "validate");
    assert_eq!(
        failure.detail.to_string(),
        format!("{path}: `build:` under `ios:` is not a normal project-relative ios/*.xcworkspace path with a trimmed 1–256-byte scheme without controls or a leading hyphen")
    );
    assert_eq!(
        failure.next_action.to_string(),
        format!("in the config file, correct `workspace` and `scheme` under `ios:` then `build:`, or remove that `build:` block to use the default build route{AGAIN}")
    );
}
