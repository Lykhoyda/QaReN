use crate::failure::{Failure, FailureCode};
use crate::scenario::{require_launch_scheme, BuildOwner, Deadlines, IosWorkspaceBuild, Platform};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const DEFAULT_CONFIG_PATH: &str = ".qaren/config.yaml";
pub const DEFAULT_METRO_PORT: u16 = 8791;

// `.qaren/config.yaml` in the app root. Flags override what they name.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CheckConfig {
    pub app_id: String,
    #[serde(default, deserialize_with = "declared_video_policy")]
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
    // Nested keys stay snake_case; this block does not inherit camelCase.
    #[serde(default)]
    pub deadlines: Deadlines,
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
        let raw = std::fs::read_to_string(path).map_err(|e| {
            Failure::new(
                "config",
                FailureCode::ScenarioUnreadable,
                format!("cannot read {}: {e}", path.display()),
                "create .qaren/config.yaml with at least `appId: <bundle id>`",
            )
        })?;
        let config: CheckConfig = serde_yaml::from_str(&raw).map_err(|_| {
            Failure::new(
                "config",
                FailureCode::ScenarioInvalid,
                format!("{} does not parse as check configuration", path.display()),
                "fix .qaren/config.yaml (video must be strict or non-strict; keys: video, appId, packageManager, metroPort, ios, android, nodePath, devClientScheme, loginBlock, loginMarker, savePlans, registryAuthEnv, deadlines)",
            )
        })?;
        config.validate(path)?;
        Ok((config, raw))
    }

    fn validate(&self, path: &Path) -> Result<(), Failure> {
        if let Some(build) = self.ios.as_ref().and_then(|ios| ios.build.as_ref()) {
            build.validate()?;
        }
        let invalid = |detail: String| {
            Failure::new(
                "config",
                FailureCode::ScenarioInvalid,
                format!("{}: {detail}", path.display()),
                "fix .qaren/config.yaml",
            )
        };
        if !crate::redact::valid_registry_auth_env_names(&self.registry_auth_env) {
            return Err(invalid("registryAuthEnv requires at most 64 non-reserved environment names matching [A-Za-z_][A-Za-z0-9_]*, each at most 128 ASCII bytes".into()));
        }
        if self.package_manager != "pnpm" {
            return Err(invalid(format!(
                "packageManager {:?} is not supported in this release; only pnpm is",
                self.package_manager
            )));
        }
        if self.metro_port < 1024 {
            return Err(invalid(format!(
                "metroPort {} must be >= 1024",
                self.metro_port
            )));
        }
        self.deadlines.validate().map_err(invalid)?;
        if self.app_id.trim().is_empty() {
            return Err(invalid("appId is required".to_string()));
        }
        if let Some(node) = &self.node_path {
            if !Path::new(node).is_absolute() {
                return Err(invalid(format!(
                    "nodePath {node:?} must be an absolute path"
                )));
            }
        }
        if self.login_block.is_some() != self.login_marker.is_some() {
            return Err(invalid(
                "loginBlock and loginMarker must be set together".to_string(),
            ));
        }
        if let Some(slug) = &self.login_block {
            if !valid_action_id(slug) {
                return Err(invalid(format!(
                    "loginBlock {slug:?} is not an action slug ([A-Za-z0-9][A-Za-z0-9_.-]*, at most 64, no \"..\")"
                )));
            }
        }
        if let Some(marker) = &self.login_marker {
            let one = match (&marker.id, &marker.text) {
                (Some(value), None) | (None, Some(value)) => !value.is_empty(),
                _ => false,
            };
            if !one {
                return Err(invalid(
                    "loginMarker needs exactly one non-empty `id` (testID) or `text` (label)"
                        .to_string(),
                ));
            }
        }
        Ok(())
    }
}
