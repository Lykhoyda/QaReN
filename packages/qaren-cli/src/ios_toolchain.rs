use crate::candidate::sha256_hex;
use crate::exec::Runner;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

mod probe;
pub(crate) use probe::has_expo_dependency;
pub(crate) use probe::inspect_for_doctor;
pub(crate) use probe::resolved_modes_for_build;
pub use probe::{inspect, requested_modes, Linkage, NativeBuildConfig, RequestedModes};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct SwiftVersion([u32; 4]);

impl SwiftVersion {
    pub fn parse(value: &str) -> Option<Self> {
        let parts: Vec<_> = value.split('.').collect();
        if !(2..=4).contains(&parts.len()) || value.len() > 32 {
            return None;
        }
        let mut numbers = [0; 4];
        for (i, part) in parts.iter().enumerate() {
            if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            numbers[i] = part.parse().ok()?;
        }
        Some(Self(numbers))
    }

    fn from_compiler(text: &str) -> Option<Self> {
        let tail = text.split_once("Swift version ")?.1;
        let version = tail
            .split(|c: char| !(c.is_ascii_digit() || c == '.'))
            .next()?;
        Self::parse(version)
    }
}

impl std::fmt::Display for SwiftVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let last = self.0.iter().rposition(|n| *n != 0).unwrap_or(1).max(1);
        let parts: Vec<_> = self.0[..=last].iter().map(u32::to_string).collect();
        f.write_str(&parts.join("."))
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    On,
    Off,
    #[default]
    Unknown,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::On => "on",
            Self::Off => "off",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompilerIdentity {
    pub xcode: Option<String>,
    pub swift: Option<SwiftVersion>,
    pub xcode_hash: Option<String>,
    pub swift_hash: Option<String>,
}

impl CompilerIdentity {
    pub fn collect(runner: &mut dyn Runner) -> Self {
        let mut identity = Self::collect_xcode(runner);
        let swift = runner.run_private(&crate::adapters::ios::swift_version_spec(), &[]);
        let text = swift.stdout().trim();
        if swift.clean() && !text.is_empty() && text.len() <= 16384 {
            identity.swift = SwiftVersion::from_compiler(text);
            identity.swift_hash = Some(sha256_hex(text.as_bytes()));
        }
        identity
    }

    pub(crate) fn collect_xcode(runner: &mut dyn Runner) -> Self {
        let xcode = runner.run_private(&crate::adapters::ios::xcode_version_spec(), &[]);
        let xcode_text = xcode.stdout().trim();
        let token = |s: &str| {
            !s.is_empty()
                && s.len() <= 32
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
        };
        let normalized = (|| {
            let mut lines = xcode_text.lines();
            let version = lines.next()?.strip_prefix("Xcode ")?;
            let build = lines.next()?.strip_prefix("Build version ")?;
            (token(version) && token(build) && lines.next().is_none())
                .then(|| format!("{version}/{build}"))
        })();
        Self {
            xcode: xcode.clean().then_some(normalized).flatten(),
            swift: None,
            xcode_hash: (xcode.clean() && !xcode_text.is_empty() && xcode_text.len() <= 16384)
                .then(|| sha256_hex(xcode_text.as_bytes())),
            swift_hash: None,
        }
    }

    pub fn parts(&self) -> BTreeMap<String, String> {
        [
            ("toolchain.xcode", &self.xcode_hash),
            ("toolchain.swift", &self.swift_hash),
        ]
        .into_iter()
        .filter_map(|(key, hash)| Some((key.into(), hash.clone()?)))
        .collect()
    }

    pub fn complete(&self) -> bool {
        self.xcode.is_some()
            && self.swift.is_some()
            && self.xcode_hash.is_some()
            && self.swift_hash.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interface {
    pub package: &'static str,
    pub swift: SwiftVersion,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observation {
    pub compiler: CompilerIdentity,
    pub interfaces: Vec<Interface>,
    pub incomplete: bool,
}

pub const UNKNOWN_FIX: &str =
    "verify the selected Xcode and installed Expo packages, then re-run qaren doctor --json";
pub const JSI_SOURCE_FIX: &str = "Expo module source builds are already selected; update expo-modules-jsi and expo-modules-core to compatible Expo patch versions, or select a compatible installed Xcode with DEVELOPER_DIR, then re-run qaren doctor --json";
pub const SOURCE_FIX: &str = "select source-built Expo modules and regenerate pods, update the app's Expo patch versions, or select a compatible installed Xcode with DEVELOPER_DIR; re-run qaren doctor --json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterfaceFailure {
    package: &'static str,
    host: Option<SwiftVersion>,
    built: Option<SwiftVersion>,
}

pub struct RecoveryAdvice {
    pub next_action: String,
    pub next_rung: &'static str,
    pub destroys_state: &'static str,
    pub requires_user_ok: bool,
}

impl InterfaceFailure {
    pub fn cause(&self) -> Option<&'static str> {
        self.host
            .as_ref()
            .zip(self.built.as_ref())
            .filter(|(host, built)| host > built)
            .map(|_| "toolchain-newer-than-prebuilt")
    }

    pub fn detail(&self) -> String {
        match (&self.host, &self.built, self.cause()) {
            (Some(host), Some(built), Some(cause)) => format!(
                "cause={cause}; the host Swift {host} is newer than the Swift {built} that built {}",
                self.package
            ),
            _ => format!("an inspected {} interface failed to compile; compiler compatibility is unproven", self.package),
        }
    }

    pub fn recovery(&self, generated: bool, source_mode: Mode) -> RecoveryAdvice {
        let explanation = match (&self.host, &self.built, self.cause()) {
            (Some(host), Some(built), Some(_)) => format!(
                "the host Swift {host} is newer than the Swift {built} that built {}; ",
                self.package
            ),
            _ => String::new(),
        };
        if self.package == "expo-modules-jsi" && source_mode == Mode::Off {
            return RecoveryAdvice {
                next_action: format!("{explanation}Expo module source linkage is already proven; do not repeat that rebuild for this expo-modules-jsi interface failure; ask the app owner to update expo-modules-jsi and expo-modules-core to compatible Expo patch versions, or select a compatible installed Xcode with DEVELOPER_DIR, then retry the original command only after owned-resource cleanup completes"),
                next_rung: "expo-patch-or-compatible-xcode",
                destroys_state: "false",
                requires_user_ok: true,
            };
        }
        let action: String = if generated {
            "export EXPO_USE_PRECOMPILED_MODULES=0, set build.owner=cli and build.strategy=clean in a valid preparation scenario, then run qaren prepare <scenario.yaml> --device <udid> --json; after Ready, run qaren cleanup <recovery-run-id> --json and retry the original qaren check or pr command with the same exported environment only after cleanup completes; this regenerates a generated ios directory and pods and makes a slower source build; ask the user to preserve any manual native changes before regeneration, or to update expo-modules-jsi and expo-modules-core to compatible Expo patch versions, or select a compatible installed Xcode with DEVELOPER_DIR=<path>".into()
        } else {
            "ask the user for a valid CLI-owned preparation scenario and permission to regenerate the generated ios directory; for tracked native source, have the app owner reinstall pods with EXPO_USE_PRECOMPILED_MODULES=0 without deleting native source, then re-run the original qaren check command with EXPO_USE_PRECOMPILED_MODULES=0 still exported; alternatively update the Expo patch versions or select a compatible installed Xcode with DEVELOPER_DIR".into()
        };
        if self.cause().is_none() {
            RecoveryAdvice {
                next_action: format!("verify the selected Xcode and installed Expo interfaces with qaren doctor --json; if an incompatible Expo interface is confirmed, {action}"),
                next_rung: "inspect-interface-compatibility",
                destroys_state: "false",
                requires_user_ok: false,
            }
        } else {
            RecoveryAdvice {
                next_action: format!("{explanation}{action}"),
                next_rung: "source-rebuild",
                destroys_state: if generated {
                    "generated-native-directory"
                } else {
                    "false"
                },
                requires_user_ok: true,
            }
        }
    }
}

pub fn classify_failure(log: &str, observation: Option<&Observation>) -> Option<InterfaceFailure> {
    if log.len() > 8 * 1024 * 1024 {
        return None;
    }
    for line in log.lines() {
        let Some((before_error, _)) = line.split_once("error:") else {
            continue;
        };
        if before_error.contains("warning:")
            || !(line.contains(".swiftinterface")
                || line.contains("SDK")
                || line.contains("built with")
                || line.contains("compiled with"))
            || !(line.contains("is not supported by the compiler")
                || line.contains("cannot find type '__ObjC::expo'"))
        {
            continue;
        }
        let Some(package) = [
            ("ExpoModulesCore", "expo-modules-core"),
            ("ExpoModulesJSI", "expo-modules-jsi"),
        ]
        .into_iter()
        .find_map(|(module, package)| {
            line.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .any(|token| token == module)
                .then_some(package)
        }) else {
            continue;
        };
        let built = ["built with", "compiled with"]
            .iter()
            .find_map(|marker| SwiftVersion::from_compiler(line.split_once(marker)?.1))
            .or_else(|| {
                let mut versions = observation
                    .filter(|o| !o.incomplete)?
                    .interfaces
                    .iter()
                    .filter(|i| i.package == package)
                    .map(|i| &i.swift);
                let first = versions.next()?;
                versions.all(|v| v == first).then(|| first.clone())
            });
        let host = line
            .split_once("compiler is")
            .and_then(|(_, s)| SwiftVersion::from_compiler(s))
            .or_else(|| observation?.compiler.swift.clone());
        return Some(InterfaceFailure {
            package,
            host,
            built,
        });
    }
    None
}
