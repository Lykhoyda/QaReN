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

const RESOLVE_PACKAGE: &str = r#"
const path = require('node:path');
const roots = [process.argv[1]];
try {
  roots.push(path.dirname(require.resolve('expo/package.json', {paths: roots})));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
let root = null;
for (const context of roots) {
  try {
    const resolved = path.dirname(require.resolve(process.argv[2] + '/package.json', {paths: [context]}));
    if (root !== null && root !== resolved) throw new Error('ambiguous package resolution');
    root = resolved;
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
}
process.stdout.write(JSON.stringify(root));
"#;

fn resolved_package_root(
    runner: &mut dyn Runner,
    app: &Path,
    package: &str,
) -> Result<Option<PathBuf>, ()> {
    if let Some(root) = package_root(app, package) {
        return Ok(Some(root));
    }
    let node = runner
        .env_var("QAREN_NODE")
        .filter(|node| !node.is_empty())
        .unwrap_or_else(|| "node".into());
    let output = runner.run_private(
        &CmdSpec::new(
            "expo-module-resolve",
            &node,
            &["-e", RESOLVE_PACKAGE, &app.to_string_lossy(), package],
            2,
        )
        .cwd(app),
        &[],
    );
    if output.exit_code() != Some(0) || output.timed_out() || output.stdout().len() > 16 * 1024 {
        return Err(());
    }
    let root: Option<PathBuf> = serde_json::from_str(output.stdout()).map_err(|_| ())?;
    root.map(|root| {
        if !root.is_absolute() {
            return Err(());
        }
        std::fs::canonicalize(root).map_err(|_| ())
    })
    .transpose()
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
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NativeBuildConfig {
    pub precompiled_modules: Option<bool>,
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
            if let Some(value) = ios.get("usePrecompiledModules") {
                let value = value.as_bool()?;
                if selected.precompiled_modules.is_some_and(|old| old != value) {
                    return None;
                }
                selected.precompiled_modules = Some(value);
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
        && properties
            .as_ref()
            .and_then(|p| p.get("EXPO_USE_PRECOMPILED_MODULES"))
            .and_then(Value::as_str)
            == Some("false");
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
    result
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Linkage {
    pub expo: Mode,
}

impl Linkage {
    pub fn inspect(app: &Path) -> Self {
        let mut result = Self::default();
        for (_, module) in &PACKAGES[..1] {
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
            result.expo = mode;
        }
        result
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
    linkage: &Linkage,
) -> Observation {
    inspect_packages(
        runner,
        app,
        compiler,
        if linkage.expo == Mode::Off {
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
    let uses_expo = has_expo_dependency(app);
    for &(package, module) in packages {
        if visited >= 256 || headers >= 32 || started.elapsed() >= Duration::from_secs(2) {
            observation.incomplete = true;
            break;
        }
        let mut expected_slices = BTreeSet::new();
        let mut seen_slices = BTreeSet::new();
        let mut framework_found = false;
        let resolved = if uses_expo {
            resolved_package_root(runner, app, package)
        } else {
            Ok(package_root(app, package))
        };
        let Ok(Some(root)) = resolved else {
            if resolved.is_err() || !package_absent(app, package) {
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
    use crate::exec::{CmdOutput, MockRunner, RealRunner};

    #[test]
    fn node_resolves_hoisted_and_expo_transitive_packages_and_rejects_conflicts() {
        for layout in ["hoisted", "transitive", "conflicting"] {
            let root = std::env::temp_dir().join(format!(
                "qaren-resolve-{}-{}",
                std::process::id(),
                crate::exec::Runner::now_epoch_ms(&RealRunner::new())
            ));
            let app = root.join("apps/mobile");
            std::fs::create_dir_all(&app).unwrap();
            let expo = root.join("node_modules/.pnpm/expo@56/node_modules/expo");
            std::fs::create_dir_all(&expo).unwrap();
            std::fs::write(expo.join("package.json"), r#"{"name":"expo"}"#).unwrap();
            std::os::unix::fs::symlink(&expo, root.join("node_modules/expo")).unwrap();
            let package = if layout == "transitive" {
                expo.parent().unwrap().join("expo-modules-core")
            } else {
                root.join("node_modules/expo-modules-core")
            };
            std::fs::create_dir_all(&package).unwrap();
            std::fs::write(
                package.join("package.json"),
                r#"{"name":"expo-modules-core"}"#,
            )
            .unwrap();
            if layout == "conflicting" {
                let other = expo.parent().unwrap().join("expo-modules-core");
                std::fs::create_dir_all(&other).unwrap();
                std::fs::write(
                    other.join("package.json"),
                    r#"{"name":"expo-modules-core"}"#,
                )
                .unwrap();
            }
            assert_eq!(
                resolved_package_root(&mut RealRunner::new(), &app, "expo-modules-core"),
                if layout == "conflicting" {
                    Err(())
                } else {
                    Ok(Some(package.canonicalize().unwrap()))
                }
            );
            assert_eq!(
                resolved_package_root(
                    &mut RealRunner::new(),
                    &app,
                    &format!("qaren-test-absent-{}", std::process::id())
                ),
                Ok(None)
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn failed_or_invalid_resolution_is_unknown() {
        for output in [
            CmdOutput::failed(1, "private resolver error"),
            CmdOutput {
                timed_out: true,
                ..CmdOutput::success("null")
            },
            CmdOutput::success("not json"),
            CmdOutput::success(r#""relative/path""#),
            CmdOutput::success(&" ".repeat(16 * 1024 + 1)),
        ] {
            let mut runner = MockRunner::new();
            runner
                .environment
                .insert("QAREN_NODE".into(), "/selected/bin/node".into());
            runner.expect_run("/selected/bin/node -e", output);
            assert_eq!(
                resolved_package_root(&mut runner, Path::new("/missing-app"), "expo-modules-core"),
                Err(())
            );
            assert_eq!(runner.calls[0].label, "expo-module-resolve");
            assert_eq!(runner.calls[0].timeout_seconds, 2);
            assert_eq!(runner.calls[0].program, "/selected/bin/node");
            assert_eq!(
                runner.calls[0].cwd.as_deref(),
                Some(Path::new("/missing-app"))
            );
        }
    }
}
