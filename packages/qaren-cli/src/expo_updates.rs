// The runtime version the installed app embeds, pinned for QaReN's own dev server for one run.
// Expo's dev-client manifest handler re-resolves the runtime version on every request; under the
// `fingerprint` policy that recomputes the project fingerprint each time, past the client's timeout.
use crate::exec::{CmdSpec, Runner};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PIN_FILE: &str = "runtime-version-pin.json";
pub const PRELOAD_FILE: &str = "runtime-version-pin.cjs";
pub const RESOLVED_MARKER: &str = "runtime-version-pin.resolved";
const FINGERPRINT_SENTINEL: &str = "file:fingerprint";
const MAX_VALUE_CHARS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddedPolicy {
    Literal,
    Fingerprint,
    // No runtime version key: says nothing about whether expo-updates is installed.
    Unconfigured,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PinState {
    Written,
    // The dev server's resolver returned the pinned value at least once.
    Resolved,
    None,
    Unsupported,
}

impl PinState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Written => "written",
            Self::Resolved => "resolved",
            Self::None => "none",
            Self::Unsupported => "unsupported",
        }
    }
}

// Value-free: the raw runtime version is never recorded or printed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeVersion {
    pub embedded_policy: EmbeddedPolicy,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_sha256_prefix: Option<String>,
    pub pin: PinState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl RuntimeVersion {
    fn new(embedded_policy: EmbeddedPolicy, pin: PinState, note: Option<&str>) -> Self {
        Self {
            embedded_policy,
            source: "artifact".into(),
            value_sha256_prefix: None,
            pin,
            note: note.map(str::to_string),
        }
    }

    pub fn android() -> Self {
        Self::new(
            EmbeddedPolicy::Unsupported,
            PinState::Unsupported,
            Some("Android artifacts are not read for a runtime version yet"),
        )
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Embedded {
    pub policy: EmbeddedPolicy,
    // Absent, empty, unreadable or unprintable values are not pinnable.
    pub value: Option<String>,
}

// Reads `Expo.plist` and, for the fingerprint sentinel, the `EXUpdates.bundle/fingerprint` resource
// the app itself reads; no subprocess runs when the app carries no `Expo.plist`.
pub fn read_ios(runner: &mut dyn Runner, app: &Path) -> Embedded {
    let plist = app.join("Expo.plist");
    if !plist.is_file() {
        return Embedded {
            policy: EmbeddedPolicy::Unconfigured,
            value: None,
        };
    }
    let output = runner.run_private(
        &CmdSpec::new(
            "ios-expo-plist",
            "plutil",
            &["-convert", "json", "-o", "-", &plist.to_string_lossy()],
            10,
        ),
        &[],
    );
    let unsupported = Embedded {
        policy: EmbeddedPolicy::Unsupported,
        value: None,
    };
    if !output.clean() {
        return unsupported;
    }
    let Ok(serde_json::Value::Object(config)) = serde_json::from_str(output.stdout()) else {
        return unsupported;
    };
    match config.get("EXUpdatesRuntimeVersion") {
        None => Embedded {
            policy: EmbeddedPolicy::Unconfigured,
            value: None,
        },
        Some(serde_json::Value::String(value)) if value == FINGERPRINT_SENTINEL => Embedded {
            policy: EmbeddedPolicy::Fingerprint,
            value: fingerprint_resource(app).filter(|value| pinnable(value)),
        },
        Some(serde_json::Value::String(value)) => Embedded {
            policy: EmbeddedPolicy::Literal,
            value: Some(value.clone()).filter(|value| pinnable(value)),
        },
        Some(_) => unsupported,
    }
}

// The framework bundle is the app itself for static pods and `Frameworks/EXUpdates.framework` otherwise;
// both present cannot say which one the app reads, so nothing is pinned.
fn fingerprint_resource(app: &Path) -> Option<String> {
    let found: Vec<_> = [
        app.join("EXUpdates.bundle/fingerprint"),
        app.join("Frameworks/EXUpdates.framework/EXUpdates.bundle/fingerprint"),
    ]
    .into_iter()
    .filter(|path| path.is_file())
    .collect();
    match found.as_slice() {
        [path] => std::fs::read_to_string(path).ok(),
        _ => None,
    }
}

fn pinnable(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_VALUE_CHARS
        && !value.chars().any(char::is_control)
}

// Writes the run-local pin and returns what the run record and receipt carry.
pub fn pin(run_dir: &Path, platform: &str, embedded: &Embedded) -> RuntimeVersion {
    let mut recorded = RuntimeVersion::new(embedded.policy, PinState::None, None);
    let Some(value) = &embedded.value else {
        if embedded.policy != EmbeddedPolicy::Unconfigured {
            recorded.pin = PinState::Unsupported;
        }
        return recorded;
    };
    recorded.value_sha256_prefix = Some(crate::candidate::sha256_hex(value.as_bytes())[..8].into());
    let body = serde_json::json!({ "platform": platform, "value": value }).to_string();
    let staged = run_dir.join(format!("{PIN_FILE}.tmp"));
    // Renamed into place so the dev server never reads a partial pin.
    recorded.pin = match std::fs::write(&staged, body)
        .and_then(|()| std::fs::rename(&staged, run_dir.join(PIN_FILE)))
    {
        Ok(()) => PinState::Written,
        Err(_) => {
            let _ = std::fs::remove_file(&staged);
            PinState::Unsupported
        }
    };
    recorded
}

pub fn resolved(run_dir: &Path) -> bool {
    run_dir.join(RESOLVED_MARKER).is_file()
}

// Writes the preload the dev server loads with `--require`; None when it cannot be written.
pub fn write_preload(run_dir: &Path, project_root: &Path) -> Option<PathBuf> {
    let literal = |path: &Path| {
        path.to_str()
            .map(|text| serde_json::Value::from(text).to_string())
    };
    let source = PRELOAD
        .replace("__QAREN_PROJECT_ROOT__", &literal(project_root)?)
        .replace("__QAREN_RUN_DIR__", &literal(run_dir)?);
    let path = run_dir.join(PRELOAD_FILE);
    std::fs::write(&path, source).ok()?;
    Some(path)
}

// Installs a require.cache entry for the app's own @expo/cli resolver module before the manifest
// middleware imports it. The pin file is read at call time, so spawn order does not matter; every
// failure delegates to the original resolver or leaves the module untouched.
const PRELOAD: &str = r#"'use strict';
// Written by QaReN for one run; serves the runtime version the installed app embeds.
(() => {
  const fs = require('fs');
  const path = require('path');
  const Module = require('module');
  const projectRoot = __QAREN_PROJECT_ROOT__;
  const runDir = __QAREN_RUN_DIR__;
  const name = 'resolveRuntimeVersionWithExpoUpdatesAsync';
  let target;
  let original;
  try {
    const expoDir = path.dirname(require.resolve('expo/package.json', { paths: [projectRoot] }));
    const cliDir = path.dirname(require.resolve('@expo/cli/package.json', { paths: [expoDir] }));
    target = fs.realpathSync(path.join(cliDir, 'build/src/start/server/middleware', name + '.js'));
    // Already loaded by an earlier preload: its importers hold the original exports.
    if (require.cache[target]) return;
    const loaded = new Module(target, null);
    loaded.filename = target;
    loaded.paths = Module._nodeModulePaths(path.dirname(target));
    loaded.load(target);
    original = loaded.exports;
  } catch {
    return;
  }
  // Mirrors the CLI's own check: 1 to 256 characters, no control characters.
  const pinned = (platform) => {
    try {
      const pin = JSON.parse(fs.readFileSync(path.join(runDir, 'runtime-version-pin.json'), 'utf8'));
      const value = pin && pin.platform === platform ? pin.value : undefined;
      if (typeof value === 'string' && value !== '' && [...value].length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
        return value;
      }
    } catch {}
    return undefined;
  };
  try {
    if (!original || typeof original[name] !== 'function') return;
    const stub = new Module(target, null);
    stub.filename = target;
    stub.loaded = true;
    // The real export is a non-configurable getter, so the whole exports object is replaced, keeping the others.
    stub.exports = Object.assign({ __esModule: true }, original);
    stub.exports[name] = async function (options) {
      const value = pinned(options && options.platform);
      if (value === undefined) return original[name](options);
      try {
        fs.appendFileSync(path.join(runDir, 'runtime-version-pin.resolved'), process.pid + ' ' + options.platform + '\n');
      } catch {}
      return value;
    };
    require.cache[target] = stub;
  } catch {}
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner};

    fn app(dir: &Path) -> PathBuf {
        let app = dir.join("App.app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("Expo.plist"), "plist").unwrap();
        app
    }

    fn read(app: &Path, plist_json: &str) -> Embedded {
        let mut runner = MockRunner::new();
        runner.expect_run("plutil -convert json", CmdOutput::success(plist_json));
        read_ios(&mut runner, app)
    }

    #[test]
    fn a_literal_is_pinned_and_recorded_by_prefix_only() {
        let dir = tempfile_dir("literal");
        let app = app(&dir);
        let embedded = read(&app, r#"{"EXUpdatesRuntimeVersion":"1.4.0"}"#);
        assert_eq!(embedded.policy, EmbeddedPolicy::Literal);
        let recorded = pin(&dir, "ios", &embedded);
        assert_eq!(recorded.pin, PinState::Written);
        assert_eq!(
            recorded.value_sha256_prefix.as_deref(),
            Some(&crate::candidate::sha256_hex(b"1.4.0")[..8])
        );
        assert!(!serde_json::to_string(&recorded).unwrap().contains("1.4.0"));
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(PIN_FILE)).unwrap()).unwrap();
        assert_eq!(
            written,
            serde_json::json!({"platform": "ios", "value": "1.4.0"})
        );
    }

    #[test]
    fn the_fingerprint_sentinel_reads_the_resource_the_app_reads() {
        let dir = tempfile_dir("fingerprint");
        let app = app(&dir);
        let sentinel = r#"{"EXUpdatesRuntimeVersion":"file:fingerprint"}"#;
        // Missing resource: the policy is known, the value is not pinnable.
        let missing = read(&app, sentinel);
        assert_eq!(missing.policy, EmbeddedPolicy::Fingerprint);
        assert_eq!(pin(&dir, "ios", &missing).pin, PinState::Unsupported);
        let framework = app.join("Frameworks/EXUpdates.framework/EXUpdates.bundle");
        std::fs::create_dir_all(&framework).unwrap();
        std::fs::write(framework.join("fingerprint"), "framework-hash").unwrap();
        assert_eq!(
            read(&app, sentinel).value.as_deref(),
            Some("framework-hash")
        );
        // Both locations present: which one the app reads is unknown.
        std::fs::create_dir_all(app.join("EXUpdates.bundle")).unwrap();
        std::fs::write(app.join("EXUpdates.bundle/fingerprint"), "override-hash").unwrap();
        assert_eq!(read(&app, sentinel).value, None);
        // A build-time override lands in the resource, which wins over any fresh resolve.
        std::fs::remove_dir_all(app.join("Frameworks")).unwrap();
        assert_eq!(read(&app, sentinel).value.as_deref(), Some("override-hash"));
    }

    #[test]
    fn absent_empty_malformed_and_unreadable_values_are_not_pinned() {
        let dir = tempfile_dir("unpinned");
        let mut runner = MockRunner::new();
        let bare = dir.join("Bare.app");
        std::fs::create_dir_all(&bare).unwrap();
        let none = read_ios(&mut runner, &bare);
        assert!(runner.calls.is_empty(), "no Expo.plist runs no subprocess");
        assert_eq!(pin(&dir, "ios", &none).pin, PinState::None);
        let app = app(&dir);
        let absent = read(&app, r#"{"EXUpdatesURL":"https://u.example"}"#);
        assert_eq!(absent.policy, EmbeddedPolicy::Unconfigured);
        assert_eq!(pin(&dir, "ios", &absent).pin, PinState::None);
        for plist in [
            r#"{"EXUpdatesRuntimeVersion":""}"#,
            r#"{"EXUpdatesRuntimeVersion":"1.0\n"}"#,
            r#"{"EXUpdatesRuntimeVersion":7}"#,
            "not json",
        ] {
            assert_eq!(
                pin(&dir, "ios", &read(&app, plist)).pin,
                PinState::Unsupported,
                "{plist}"
            );
        }
        let mut runner = MockRunner::new();
        runner.expect_run("plutil", CmdOutput::failed(1, "bad plist"));
        assert_eq!(
            read_ios(&mut runner, &app).policy,
            EmbeddedPolicy::Unsupported
        );
        assert!(!dir.join(PIN_FILE).exists());
    }

    #[test]
    fn an_unwritable_run_directory_records_unsupported() {
        let dir = tempfile_dir("unwritable");
        let embedded = Embedded {
            policy: EmbeddedPolicy::Literal,
            value: Some("1".into()),
        };
        assert_eq!(
            pin(&dir.join("missing"), "ios", &embedded).pin,
            PinState::Unsupported
        );
        assert!(write_preload(&dir.join("missing"), &dir).is_none());
    }

    fn tempfile_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qaren-expo-updates-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
