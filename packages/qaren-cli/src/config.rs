use crate::failure::{Failure, FailureCode};
use crate::scenario::{
    require_launch_scheme, BuildArch, BuildOwner, BuildPriority, Deadlines, IosWorkspaceBuild,
    Platform,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

mod keys;

pub const DEFAULT_CONFIG_PATH: &str = ".qaren/config.yaml";
pub const DEFAULT_METRO_PORT: u16 = 8791;

// What a refused file trips on and the next step, in fixed words, key names and counts only:
// no value or other text from the file, so qaren doctor may print it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Named {
    pub seen: String,
    pub fix: String,
}

impl Named {
    // The whole next step, the same for check, pr and doctor.
    pub fn next_action(&self) -> String {
        format!(
            "in the config file, {}; then run the same command again",
            self.fix
        )
    }
}

#[derive(Debug, Clone)]
pub struct ConfigRefusal {
    pub failure: Failure,
    pub named: Option<Named>,
}

// `.qaren/config.yaml` in the app root. Flags override what they name.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CheckConfig {
    pub app_id: String,
    #[serde(default = "d_video", deserialize_with = "declared_video_policy")]
    pub video: crate::record::VideoPolicy,
    #[serde(default = "d_package_manager")]
    pub package_manager: String,
    #[serde(
        default,
        deserialize_with = "crate::redact::deserialize_registry_auth_env"
    )]
    pub registry_auth_env: Vec<String>,
    #[serde(default = "d_metro_port")]
    pub metro_port: u16,
    #[serde(default)]
    pub ios: Option<IosConfig>,
    #[serde(default)]
    pub android: Option<AndroidConfig>,
    #[serde(default)]
    pub node_path: Option<String>,
    #[serde(default)]
    pub dev_client_scheme: Option<String>,
    #[serde(default)]
    pub login_block: Option<String>,
    #[serde(default)]
    pub login_marker: Option<LoginMarker>,
    #[serde(default)]
    pub save_plans: Option<bool>,
    #[serde(default)]
    pub proof_in_description: Option<bool>,
    #[serde(default)]
    pub deps_cache: Option<bool>,
    #[serde(default)]
    pub build: BuildConfig,
    // Nested keys stay snake_case; this block does not inherit camelCase.
    #[serde(default)]
    pub deadlines: Deadlines,
}

// Overrides for how hard a native build may use the machine.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildConfig {
    #[serde(default)]
    pub jobs: Option<std::num::NonZeroU32>,
    #[serde(default)]
    pub priority: Option<BuildPriority>,
    #[serde(default)]
    pub arch: Option<BuildArch>,
}

fn declared_video_policy<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<crate::record::VideoPolicy, D::Error> {
    match String::deserialize(deserializer)?.as_str() {
        "strict" => Ok(crate::record::VideoPolicy::Strict),
        "non-strict" => Ok(crate::record::VideoPolicy::NonStrict),
        _ => Err(serde::de::Error::custom(
            "video must be strict or non-strict",
        )),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LoginMarker {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

// The core's action-ID grammar: the block is read from .qaren/actions/<slug>.yaml.
fn valid_action_id(slug: &str) -> bool {
    let mut bytes = slug.bytes();
    slug.len() <= 64
        && !slug.contains("..")
        && bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IosConfig {
    #[serde(default)]
    pub device_type: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub build: Option<IosWorkspaceBuild>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AndroidConfig {
    #[serde(default)]
    pub avd: Option<String>,
}

fn d_package_manager() -> String {
    "pnpm".to_string()
}

// No `video` key: dev mode is the default and privacy (strict) is opt-in.
fn d_video() -> crate::record::VideoPolicy {
    crate::record::VideoPolicy::DefaultNonStrict
}

fn d_metro_port() -> u16 {
    DEFAULT_METRO_PORT
}

impl CheckConfig {
    pub fn validate_for_platform(&self, platform: Platform) -> Result<(), Failure> {
        if platform == Platform::Ios {
            if let Some(build) = self.ios.as_ref().and_then(|ios| ios.build.as_ref()) {
                build.validate_for(platform, BuildOwner::Cli)?;
            }
        }
        require_launch_scheme(self.dev_client_scheme.as_deref())
    }

    // Returns the bytes it parsed so the run record hashes exactly that configuration.
    pub fn load(path: &Path) -> Result<(CheckConfig, String), Failure> {
        Self::load_named(path).map_err(|refusal| refusal.failure)
    }

    // `load`, keeping what a refusal can say without a value from the file.
    pub fn load_named(path: &Path) -> Result<(CheckConfig, String), ConfigRefusal> {
        let raw = std::fs::read_to_string(path).map_err(|e| ConfigRefusal {
            failure: Failure::new(
                "config",
                FailureCode::ScenarioUnreadable,
                format!("cannot read {}: {e}", path.display()),
                // Only a missing file is to be created; anything else there is the user's to keep.
                if e.kind() == std::io::ErrorKind::NotFound {
                    "create the config file with at least `appId: <bundle id>` and `devClientScheme: <the app's registered URI scheme>` (.qaren/config.yaml unless --config selects another)"
                } else {
                    "make the selected config path a readable UTF-8 text file, then run the same command again"
                },
            ),
            named: None,
        })?;
        let config: CheckConfig = serde_yaml::from_str(&raw).map_err(|_| {
            let named = keys::name_faults(&raw);
            let (detail, next_action) = match &named {
                Some(named) => (
                    format!(
                        "{} does not parse as check configuration: {}",
                        path.display(),
                        named.seen
                    ),
                    named.next_action(),
                ),
                None => (
                    format!("{} does not parse as check configuration", path.display()),
                    "fix the config file (video must be strict or non-strict; keys: video, appId, packageManager, metroPort, ios, android, nodePath, devClientScheme, loginBlock, loginMarker, savePlans, proofInDescription, depsCache, registryAuthEnv, build (jobs: a positive number, priority: low or normal, arch: all), deadlines)".to_string(),
                ),
            };
            ConfigRefusal {
                failure: Failure::new("config", FailureCode::ScenarioInvalid, detail, next_action),
                named,
            }
        })?;
        config.validate(path)?;
        Ok((config, raw))
    }

    fn validate(&self, path: &Path) -> Result<(), ConfigRefusal> {
        // Each refusal states which key failed its rule, and never what the file held.
        let invalid = |phase: &str, seen: &str, fix: &str| {
            let named = Named {
                seen: seen.to_string(),
                fix: fix.to_string(),
            };
            ConfigRefusal {
                failure: Failure::new(
                    phase,
                    FailureCode::ScenarioInvalid,
                    format!("{}: {seen}", path.display()),
                    named.next_action(),
                ),
                named: Some(named),
            }
        };
        if let Some(build) = self.ios.as_ref().and_then(|ios| ios.build.as_ref()) {
            // The rule is the shared validator's; its phase is kept, its prepare wording is not.
            build.validate().map_err(|failure| {
                invalid(
                    &failure.phase,
                    "`build:` under `ios:` is not a normal project-relative ios/*.xcworkspace path with a trimmed 1–256-byte scheme without controls or a leading hyphen",
                    "correct `workspace` and `scheme` under `ios:` then `build:`, or remove that `build:` block to use the default build route",
                )
            })?;
        }
        let invalid = |seen: &str, fix: &str| invalid("config", seen, fix);
        if !crate::redact::valid_registry_auth_env_names(&self.registry_auth_env) {
            return Err(invalid(
                "`registryAuthEnv` is not a list of at most 64 allowed environment names",
                "list at most 64 names, each matching [A-Za-z_][A-Za-z0-9_]* and at most 128 ASCII bytes, and neither TYPESAFE_API_KEY nor a name starting with QAREN_INPUT_ (in any letter case)",
            ));
        }
        if self.package_manager != "pnpm" {
            return Err(invalid(
                "`packageManager` is not pnpm, the only package manager this release supports",
                "set `packageManager: pnpm` or remove the key",
            ));
        }
        if self.metro_port < 1024 {
            return Err(invalid(
                "`metroPort` is below 1024",
                "set `metroPort` to a port from 1024 through 65535, or remove the key",
            ));
        }
        if let Some((field, _)) = self.deadlines.out_of_range() {
            return Err(invalid(
                &format!("`{field}` is outside 30 through 7200 seconds"),
                &format!("set `{field}` to a whole number of seconds from 30 through 7200"),
            ));
        }
        if self.app_id.trim().is_empty() {
            return Err(invalid(
                "`appId` is blank",
                "set `appId` to the app's bundle ID or package name",
            ));
        }
        if let Some(node) = &self.node_path {
            if !Path::new(node).is_absolute() {
                return Err(invalid(
                    "`nodePath` is not an absolute path",
                    "set `nodePath` to the absolute path of a Node 24 or newer binary, or remove the key",
                ));
            }
        }
        if self.login_block.is_some() != self.login_marker.is_some() {
            return Err(invalid(
                "`loginBlock` and `loginMarker` are not set together",
                "set both `loginBlock` and `loginMarker`, or neither",
            ));
        }
        if let Some(slug) = &self.login_block {
            if !valid_action_id(slug) {
                return Err(invalid(
                    "`loginBlock` is not a saved-block slug",
                    "set `loginBlock` to a slug of ASCII letters, digits, `_`, `.` or `-` that starts with a letter or digit, at most 64 characters, without `..`",
                ));
            }
        }
        if let Some(marker) = &self.login_marker {
            let one = match (&marker.id, &marker.text) {
                (Some(value), None) | (None, Some(value)) => !value.is_empty(),
                _ => false,
            };
            if !one {
                return Err(invalid(
                    "`loginMarker` does not have exactly one of `id` and `text`, set to a non-empty value",
                    "set exactly one of `id` (testID) or `text` (label) in `loginMarker` to a non-empty value and omit the other",
                ));
            }
        }
        Ok(())
    }
}
