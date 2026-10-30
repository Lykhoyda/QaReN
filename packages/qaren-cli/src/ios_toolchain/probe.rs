use super::*;
use crate::exec::CmdSpec;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs::File;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const PACKAGES: [(&str, &str); 2] = [
    ("expo-modules-core", "ExpoModulesCore"),
    ("expo-modules-jsi", "ExpoModulesJSI"),
];

fn open_child(parent: &File, name: &std::ffi::OsStr, directory: bool) -> Option<File> {
    let name = std::ffi::CString::new(name.as_bytes()).ok()?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK
                | if directory { libc::O_DIRECTORY } else { 0 },
        )
    };
    (fd >= 0).then(|| unsafe { File::from_raw_fd(fd) })
}

fn read_at(root: &Path, relative: &Path, limit: usize) -> Option<String> {
    read_bounded(root, relative, limit, false)
}

fn read_bounded(root: &Path, relative: &Path, limit: usize, prefix: bool) -> Option<String> {
    let bytes = read_bytes(root, relative, limit, prefix)?;
    if prefix {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        String::from_utf8(bytes).ok()
    }
}

fn read_bytes(root: &Path, relative: &Path, limit: usize, prefix: bool) -> Option<Vec<u8>> {
    let mut file = File::open(root).ok()?;
    let parts: Vec<_> = relative.components().collect();
    for (i, part) in parts.iter().enumerate() {
        let std::path::Component::Normal(name) = part else {
            return None;
        };
        file = open_child(&file, name, i + 1 < parts.len())?;
    }
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + u64::from(!prefix))
        .read_to_end(&mut bytes)
        .ok()?;
    (prefix || bytes.len() <= limit).then_some(bytes)
}

fn json_at(root: &Path, path: &str) -> Option<Value> {
    serde_json::from_str(&read_at(root, Path::new(path), 64 * 1024)?).ok()
}

fn package_root(app: &Path, package: &str) -> Option<PathBuf> {
    std::fs::canonicalize(app.join("node_modules").join(package)).ok()
}

fn package_absent(app: &Path, package: &str) -> bool {
    app.join("node_modules")
        .join(package)
        .symlink_metadata()
        .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
}

fn contains_expo(package: &Value) -> bool {
    [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ]
    .iter()
    .any(|section| {
        package
            .get(section)
            .is_some_and(|deps| deps.get("expo").is_some())
    })
}

pub(crate) fn has_expo_dependency(app: &Path) -> bool {
    json_at(app, "package.json").is_some_and(|package| contains_expo(&package))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestedModes {
    pub expo: Mode,
    pub rncore: Mode,
    pub jsi: Mode,
}

impl RequestedModes {
    pub fn complete(&self) -> bool {
        [self.expo, self.rncore, self.jsi]
            .iter()
            .all(|mode| *mode != Mode::Unknown)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NativeBuildConfig {
    pub precompiled_modules: Option<bool>,
    pub build_react_native_from_source: Option<bool>,
}

impl NativeBuildConfig {
    pub fn from_config(config: &Value) -> Option<Self> {
        config.as_object()?;
        let mut selected = Self::default();
        let Some(plugins) = config.get("plugins") else {
            return Some(selected);
        };
        for plugin in plugins.as_array()? {
            let Some(tuple) = plugin.as_array() else {
                continue;
            };
            if tuple.first().and_then(Value::as_str) != Some("expo-build-properties") {
                continue;
            }
            let Some(ios) = tuple.get(1).and_then(|p| p.get("ios")) else {
                continue;
            };
            ios.as_object()?;
            for (key, mode) in [
                ("usePrecompiledModules", &mut selected.precompiled_modules),
                (
                    "buildReactNativeFromSource",
                    &mut selected.build_react_native_from_source,
                ),
            ] {
                if let Some(value) = ios.get(key) {
                    let value = value.as_bool()?;
                    if mode.is_some_and(|old| old != value) {
                        return None;
                    }
                    *mode = Some(value);
                }
            }
        }
        Some(selected)
    }
}

fn inherited_mode(value: &str) -> Mode {
    match value {
        "0" => Mode::Off,
        "1" => Mode::On,
        _ => Mode::Unknown,
    }
}

fn boolean_mode(value: Option<&str>) -> Mode {
    match value {
        Some("0" | "false") => Mode::Off,
        Some("1" | "true") => Mode::On,
        _ => Mode::Unknown,
    }
}

fn standard_podfile(text: &str) -> bool {
    let mut lines = Vec::new();
    for line in text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        if let Some(target) = line.strip_prefix("target ") {
            let Some(name) = target.strip_suffix(" do").map(str::trim) else {
                return false;
            };
            let bytes = name.as_bytes();
            if bytes.len() < 3
                || !matches!(bytes[0], b'\'' | b'"')
                || bytes.last() != bytes.first()
                || !bytes[1..bytes.len() - 1]
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() || b" _-.".contains(b))
            {
                return false;
            }
            lines.push("target do");
        } else {
            lines.push(line);
        }
    }
    let normalized = lines.join("\n");
    matches!(
        sha256_hex(normalized.as_bytes()).as_str(),
        "7bae59755790dceafba50b865d733bb49d8101d58c7521becbdbadf5055d846c"
            | "2b3c953faef4f58b2a77a7c700dcb46619b8aa8594d289a70ea5a44bf75fb1aa"
    )
}

pub fn requested_modes(
    runner: &dyn Runner,
    app: &Path,
    evaluated: Option<NativeBuildConfig>,
) -> RequestedModes {
    requested_modes_for_build(runner, app, evaluated, false)
}

pub(crate) fn requested_modes_for_build(
    runner: &dyn Runner,
    app: &Path,
    evaluated: Option<NativeBuildConfig>,
    generated: bool,
) -> RequestedModes {
    let mut result = RequestedModes::default();
    let package = json_at(app, "package.json").unwrap_or(Value::Null);
    let uses_expo = contains_expo(&package);
    let dynamic = [
        "app.config.js",
        "app.config.ts",
        "app.config.mjs",
        "app.config.cjs",
    ]
    .iter()
    .any(|name| app.join(name).exists());
    let config = json_at(app, "app.json");
    let selected = if dynamic {
        evaluated
    } else {
        config
            .as_ref()
            .and_then(|c| NativeBuildConfig::from_config(c.get("expo").unwrap_or(c)))
            .or_else(|| (!app.join("app.json").exists()).then_some(NativeBuildConfig::default()))
    };
    let configured = selected.and_then(|c| c.precompiled_modules);
    let podfile = read_at(app, Path::new("ios/Podfile"), 64 * 1024);
    let properties = json_at(app, "ios/Podfile.properties.json");
    let inherited = runner.env_var("EXPO_USE_PRECOMPILED_MODULES");
    let supported_podfile = podfile.as_ref().map_or_else(
        || {
            app.join("ios/Podfile")
                .symlink_metadata()
                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        },
        |p| standard_podfile(p),
    );
    let installed_major = package_root(app, "expo")
        .and_then(|root| json_at(&root, "package.json"))
        .and_then(|p| {
            p.get("version")?
                .as_str()?
                .split('.')
                .next()?
                .parse::<u32>()
                .ok()
        })
        .or_else(|| {
            [
                "dependencies",
                "devDependencies",
                "optionalDependencies",
                "peerDependencies",
            ]
            .iter()
            .find_map(|section| {
                package
                    .get(section)?
                    .get("expo")?
                    .as_str()?
                    .split('.')
                    .next()?
                    .parse()
                    .ok()
            })
        });
    let force_disable_supported = podfile
        .as_ref()
        .map_or(installed_major.is_some_and(|v| v >= 56), |p| {
            p.contains("ENV['EXPO_USE_PRECOMPILED_MODULES'] = '0' if")
        });
    let forced_off = force_disable_supported
        && if generated {
            configured == Some(false)
        } else {
            properties
                .as_ref()
                .and_then(|p| p.get("EXPO_USE_PRECOMPILED_MODULES"))
                .and_then(Value::as_str)
                == Some("false")
        };
    result.expo = if !uses_expo && !package_absent(app, "expo-modules-core") {
        Mode::Unknown
    } else if !uses_expo {
        Mode::Off
    } else if !supported_podfile || selected.is_none() {
        Mode::Unknown
    } else if forced_off {
        Mode::Off
    } else if let Some(env) = inherited.as_deref() {
        inherited_mode(env)
    } else if let Some(flag) = configured {
        if flag {
            Mode::On
        } else {
            Mode::Off
        }
    } else if let Some(setting) = properties
        .as_ref()
        .filter(|_| !generated)
        .and_then(|p| p.get("EXPO_USE_PRECOMPILED_MODULES"))
    {
        boolean_mode(setting.as_str())
    } else {
        match installed_major {
            Some(56..) => Mode::On,
            Some(55) => Mode::Off,
            _ => Mode::Unknown,
        }
    };
    result.rncore = if !supported_podfile && package.pointer("/dependencies/react-native").is_some()
    {
        Mode::Unknown
    } else {
        runner
            .env_var("RCT_USE_PREBUILT_RNCORE")
            .as_deref()
            .map(inherited_mode)
            .unwrap_or_else(|| {
                if selected.is_some_and(|c| c.build_react_native_from_source == Some(true))
                    || properties
                        .as_ref()
                        .filter(|_| !generated)
                        .and_then(|p| p.get("ios.buildReactNativeFromSource"))
                        .and_then(Value::as_str)
                        == Some("true")
                {
                    Mode::Off
                } else if !package
                    .get("dependencies")
                    .is_some_and(|deps| deps.get("react-native").is_some())
                {
                    Mode::Off
                } else if supported_podfile {
                    let version = package_root(app, "react-native")
                        .and_then(|root| json_at(&root, "package.json"))
                        .and_then(|p| p.get("version")?.as_str().map(str::to_owned))
                        .or_else(|| {
                            package
                                .pointer("/dependencies/react-native")?
                                .as_str()
                                .map(str::to_owned)
                        });
                    match version.as_deref().and_then(SwiftVersion::parse) {
                        Some(version)
                            if version
                                >= SwiftVersion::parse("0.84").expect("constant version") =>
                        {
                            Mode::On
                        }
                        Some(_) => Mode::Off,
                        None => Mode::Unknown,
                    }
                } else {
                    Mode::Unknown
                }
            })
    };
    result.jsi = if let Some(root) = package_root(app, "expo-modules-jsi") {
        let spec = read_at(&root, Path::new("apple/ExpoModulesJSI.podspec"), 64 * 1024);
        if spec.is_some_and(|s| {
            let normalized = s
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('#'))
                .collect::<Vec<_>>()
                .join("\n");
            sha256_hex(normalized.as_bytes())
                == "64fd74976d70e116c17eebbd6484bdbb39bcb04028ceff17fce5df2d4ccfdc88"
        }) {
            Mode::On
        } else {
            Mode::Unknown
        }
    } else if package_absent(app, "expo-modules-jsi") {
        Mode::Off
    } else {
        Mode::Unknown
    };
    result
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Linkage {
    pub expo: Mode,
    pub jsi: Mode,
    pub digest: Option<String>,
    expo_applicable: bool,
}

impl Linkage {
    pub fn inspect(app: &Path) -> Self {
        let mut result = Self::default();
        result.expo_applicable = package_root(app, "expo-modules-core").is_some()
            || app
                .join("ios/Pods/Local Podspecs/ExpoModulesCore.podspec.json")
                .exists();
        let mut evidence = Vec::new();
        for (i, (_, module)) in PACKAGES.iter().enumerate() {
            let path = format!("ios/Pods/Local Podspecs/{module}.podspec.json");
            let Some(spec) = json_at(app, &path) else {
                continue;
            };
            if spec.get("name").and_then(Value::as_str) != Some(module) {
                continue;
            }
            let support_path =
                format!("ios/Pods/Target Support Files/{module}/{module}.debug.xcconfig");
            let Some(support) = read_at(app, Path::new(&support_path), 64 * 1024) else {
                continue;
            };
            let mut framework = Vec::new();
            collect_strings(
                spec.get("vendored_frameworks").unwrap_or(&Value::Null),
                &mut framework,
            );
            let vendored = framework
                .iter()
                .any(|f| f.ends_with(&format!("{module}.xcframework")));
            let source = spec.get("source_files").is_some();
            let mode = if vendored && support.contains("XCFrameworkIntermediates") {
                Mode::On
            } else if source
                && framework.is_empty()
                && !support.contains("XCFrameworkIntermediates")
                && support.contains("PODS_TARGET_SRCROOT")
            {
                Mode::Off
            } else {
                Mode::Unknown
            };
            if i == 0 {
                result.expo = mode
            } else {
                result.jsi = mode
            }
            evidence.push((spec, support));
        }
        if !evidence.is_empty() || !result.expo_applicable {
            result.digest = Some(sha256_hex(
                &serde_json::to_vec(&evidence).expect("JSON evidence"),
            ));
        }
        result
    }

    pub fn matches(&self, requested: &RequestedModes) -> bool {
        requested.complete()
            && ((self.expo != Mode::Unknown && self.expo == requested.expo)
                || (!self.expo_applicable && requested.expo == Mode::Off))
            && (requested.jsi == Mode::Off || self.jsi == requested.jsi)
    }
}

fn collect_strings<'a>(value: &'a Value, into: &mut Vec<&'a str>) {
    match value {
        Value::String(s) => into.push(s),
        Value::Array(items) => {
            for item in items {
                collect_strings(item, into)
            }
        }
        _ => {}
    }
}

pub fn inspect(runner: &mut dyn Runner, app: &Path, compiler: CompilerIdentity) -> Observation {
    inspect_packages(runner, app, compiler, &PACKAGES)
}

pub(crate) fn inspect_for_doctor(
    runner: &mut dyn Runner,
    app: &Path,
    compiler: CompilerIdentity,
    mode: Mode,
) -> Observation {
    inspect_packages(
        runner,
        app,
        compiler,
        if mode == Mode::Off {
            &PACKAGES[1..]
        } else {
            &PACKAGES
        },
    )
}

fn inspect_packages(
    runner: &mut dyn Runner,
    app: &Path,
    compiler: CompilerIdentity,
    packages: &[(&'static str, &'static str)],
) -> Observation {
    let mut observation = Observation {
        compiler,
        ..Default::default()
    };
    let started = Instant::now();
    let mut visited = 0;
    let mut headers = 0;
    for &(package, module) in packages {
        let mut expected_slices = BTreeSet::new();
        let mut seen_slices = BTreeSet::new();
        let mut framework_found = false;
        let Some(root) = package_root(app, package) else {
            if !package_absent(app, package) {
                observation.incomplete = true;
            }
            continue;
        };
        let Ok(file) = File::open(&root) else {
            observation.incomplete = true;
            continue;
        };
        let mut pending = vec![(file, PathBuf::new(), None::<PathBuf>)];
        while let Some((dir, relative, slice)) = pending.pop() {
            if visited >= 256 || headers >= 32 || started.elapsed() >= Duration::from_secs(2) {
                observation.incomplete = true;
                break;
            }
            let Ok(entries) = std::fs::read_dir(root.join(&relative)) else {
                observation.incomplete = true;
                continue;
            };
            for entry in entries {
                visited += 1;
                if visited > 256 || started.elapsed() >= Duration::from_secs(2) {
                    observation.incomplete = true;
                    break;
                }
                let Ok(entry) = entry else {
                    observation.incomplete = true;
                    continue;
                };
                let name = entry.file_name();
                let path = relative.join(&name);
                let Ok(kind) = entry.file_type() else {
                    observation.incomplete = true;
                    continue;
                };
                if kind.is_symlink() {
                    observation.incomplete = true;
                    continue;
                }
                if kind.is_dir() {
                    if path.components().count() > 12 {
                        observation.incomplete = true;
                        continue;
                    }
                    let Some(child) = open_child(&dir, &name, true) else {
                        observation.incomplete = true;
                        continue;
                    };
                    if path.extension().is_some_and(|ext| ext == "xcframework") {
                        framework_found = true;
                        let Some(plist) =
                            read_bytes(&root, &path.join("Info.plist"), 64 * 1024, false)
                        else {
                            observation.incomplete = true;
                            continue;
                        };
                        let remaining = Duration::from_secs(2)
                            .saturating_sub(started.elapsed())
                            .as_secs();
                        if remaining == 0 {
                            observation.incomplete = true;
                            continue;
                        }
                        let decoded = runner.run_private(
                            &CmdSpec::new(
                                "expo-xcframework-plist",
                                "/usr/bin/plutil",
                                &["-convert", "json", "-o", "-", "--", "-"],
                                remaining,
                            ),
                            &plist,
                        );
                        if decoded.stdout().len() > 64 * 1024 {
                            observation.incomplete = true;
                            continue;
                        }
                        let value = decoded
                            .clean()
                            .then(|| serde_json::from_str::<Value>(decoded.stdout()).ok())
                            .flatten();
                        let Some(libraries) = value
                            .as_ref()
                            .and_then(|p| p.get("AvailableLibraries"))
                            .and_then(Value::as_array)
                        else {
                            observation.incomplete = true;
                            continue;
                        };
                        if libraries.len() > 32 {
                            observation.incomplete = true;
                            continue;
                        }
                        for library in libraries {
                            if library.get("SupportedPlatform").and_then(Value::as_str)
                                == Some("ios")
                                && library
                                    .get("SupportedPlatformVariant")
                                    .and_then(Value::as_str)
                                    == Some("simulator")
                            {
                                let Some(id) = library
                                    .get("LibraryIdentifier")
                                    .and_then(Value::as_str)
                                    .filter(|s| {
                                        !s.is_empty()
                                            && s.bytes().all(|b| {
                                                b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
                                            })
                                    })
                                else {
                                    observation.incomplete = true;
                                    continue;
                                };
                                if !expected_slices.insert(path.join(id)) {
                                    observation.incomplete = true;
                                    continue;
                                }
                                if let Some(slice_dir) =
                                    open_child(&child, std::ffi::OsStr::new(id), true)
                                {
                                    let slice_path = path.join(id);
                                    pending.push((slice_dir, slice_path.clone(), Some(slice_path)));
                                } else {
                                    observation.incomplete = true;
                                }
                            }
                        }
                    } else {
                        pending.push((child, path, slice.clone()));
                    }
                } else if kind.is_file()
                    && slice.is_some()
                    && path.extension().is_some_and(|e| e == "swiftinterface")
                {
                    let name = name.to_string_lossy();
                    if name.ends_with(".private.swiftinterface")
                        || name.ends_with(".package.swiftinterface")
                    {
                        continue;
                    }
                    if relative.file_name().is_none_or(|name| {
                        name != std::ffi::OsStr::new(&format!("{module}.swiftmodule"))
                    }) || relative
                        .parent()
                        .and_then(Path::file_name)
                        .is_none_or(|name| name != "Modules")
                        || relative
                            .parent()
                            .and_then(Path::parent)
                            .and_then(Path::file_name)
                            .is_none_or(|name| {
                                name != std::ffi::OsStr::new(&format!("{module}.framework"))
                            })
                    {
                        continue;
                    }
                    headers += 1;
                    let version = read_bounded(&root, &path, 16 * 1024, true).and_then(|text| {
                        let mut headers = text
                            .lines()
                            .filter_map(|line| line.strip_prefix("// swift-compiler-version: "));
                        let header = headers.next()?;
                        if headers.next().is_some() {
                            return None;
                        }
                        SwiftVersion::from_compiler(header)
                    });
                    match version {
                        Some(swift) => {
                            seen_slices.insert(slice.clone().expect("simulator slice"));
                            observation.interfaces.push(Interface { package, swift });
                        }
                        None => observation.incomplete = true,
                    }
                    if headers >= 32 {
                        observation.incomplete = true;
                        break;
                    }
                }
            }
            pending.sort_by_key(|(_, relative, slice)| {
                if slice.is_some() {
                    3
                } else if relative
                    .components()
                    .any(|c| matches!(c.as_os_str().to_str(), Some("ios" | "apple" | "Products")))
                {
                    2
                } else {
                    0
                }
            });
        }
        if (framework_found && expected_slices.is_empty())
            || !expected_slices.is_subset(&seen_slices)
        {
            observation.incomplete = true;
        }
    }
    if started.elapsed() >= Duration::from_secs(2) {
        observation.incomplete = true;
    }
    observation
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::MockRunner;
    use std::os::unix::fs::DirBuilderExt;

    #[test]
    fn generated_modes_stay_stable_across_pod_regeneration_and_both_env_transitions() {
        let root = std::env::temp_dir().join(format!(
            "qaren-modes-{}-{}",
            std::process::id(),
            crate::timefmt::epoch_ms()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"expo":"56.0.0","react-native":"0.84.0"}}"#,
        )
        .unwrap();
        let mut runner = MockRunner::new();
        for env in ["0", "1", "0"] {
            runner
                .environment
                .insert("EXPO_USE_PRECOMPILED_MODULES".into(), env.into());
            let before = requested_modes_for_build(&runner, &root, None, true);
            assert_eq!(before.expo, inherited_mode(env));
            std::fs::create_dir_all(root.join("ios")).unwrap();
            std::fs::write(
                root.join("ios/Podfile"),
                include_str!("../../tests/fixtures/ios-standard-podfile.txt"),
            )
            .unwrap();
            std::fs::write(root.join("ios/Podfile.properties.json"), r#"{"EXPO_USE_PRECOMPILED_MODULES":"false","ios.buildReactNativeFromSource":"true"}"#).unwrap();
            let after = requested_modes_for_build(&runner, &root, None, true);
            assert_eq!(before, after);
            assert_eq!(after.rncore, Mode::On);
            std::fs::remove_dir_all(root.join("ios")).unwrap();
        }
        let untouched = requested_modes_for_build(&runner, &root, None, true);
        assert_eq!(untouched.expo, Mode::Off);
        std::fs::write(root.join("app.json"), r#"{"expo":{"plugins":[["expo-build-properties",{"ios":{"buildReactNativeFromSource":true}}]]}}"#).unwrap();
        assert_eq!(
            requested_modes_for_build(&runner, &root, None, true).rncore,
            Mode::Off
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
