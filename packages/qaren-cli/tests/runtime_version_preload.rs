// Runs QaReN's runtime-version preload in real Node against a fake expo / @expo/cli install.
use qaren::adapters::metro;
use qaren::expo_updates::{write_preload, PIN_FILE, RESOLVED_MARKER};
use std::path::{Path, PathBuf};
use std::process::Command;

const MIDDLEWARE: &str = "build/src/start/server/middleware";

fn write(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

// A CLI copy whose resolver answers `original:<label>:<platform>` through a non-configurable getter.
fn cli(dir: &Path, label: &str, export: &str) {
    write(&dir.join("package.json"), r#"{"name":"@expo/cli"}"#);
    write(
        &dir.join(MIDDLEWARE)
            .join("resolveRuntimeVersionWithExpoUpdatesAsync.js"),
        &format!(
            r#""use strict";
Object.defineProperty(exports, "__esModule", {{ value: true }});
Object.defineProperty(exports, "{export}", {{ enumerable: true, get: () => resolve }});
Object.defineProperty(exports, "other", {{ enumerable: true, get: () => "kept" }});
async function resolve({{ platform }}) {{ return "original:{label}:" + platform; }}
"#
        ),
    );
    write(
        &dir.join(MIDDLEWARE)
            .join("ExpoGoManifestHandlerMiddleware.js"),
        r#"const r = require("./resolveRuntimeVersionWithExpoUpdatesAsync");
module.exports = (platform) => (0, r.resolveRuntimeVersionWithExpoUpdatesAsync)({ projectRoot: ".", platform });
module.exports.other = r.other;
"#,
    );
}

struct Fixture {
    app: PathBuf,
    run_dir: PathBuf,
    store_cli: PathBuf,
}

// pnpm's isolated layout: `node_modules/expo` links into the store, where @expo/cli is expo's sibling;
// a hoisted duplicate CLI at the app's top level must stay untouched.
fn fixture(name: &str) -> Fixture {
    let root = std::env::temp_dir().join(format!("qaren-preload-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let app = root.join("app");
    let store = app.join("node_modules/.pnpm/expo@1.0.0/node_modules");
    write(&store.join("expo/package.json"), r#"{"name":"expo"}"#);
    let store_cli = store.join("@expo/cli");
    cli(
        &store_cli,
        "store",
        "resolveRuntimeVersionWithExpoUpdatesAsync",
    );
    std::os::unix::fs::symlink(store.join("expo"), app.join("node_modules/expo")).unwrap();
    cli(
        &app.join("node_modules/@expo/cli"),
        "hoisted",
        "resolveRuntimeVersionWithExpoUpdatesAsync",
    );
    // A space in the run directory exercises the quoted --require path.
    let run_dir = root.join("runs/run one");
    std::fs::create_dir_all(&run_dir).unwrap();
    Fixture {
        app,
        run_dir,
        store_cli,
    }
}

fn node() -> bool {
    Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

// Loads the middleware the way the dev server does, under the composed NODE_OPTIONS.
fn serve(fx: &Fixture, cli_dir: &Path, extra_require: Option<&Path>) -> serde_json::Value {
    let preload = write_preload(&fx.run_dir, &fx.app).expect("preload written");
    let mut options = metro::dev_server_node_options(None, Some(&preload));
    if let Some(first) = extra_require {
        options = format!("--require \"{}\" {options}", first.display());
    }
    let output = Command::new("node")
        .arg("-e")
        .arg(
            r#"const mw = require(process.argv[1]);
const call = async (p) => { try { return await mw(p); } catch { return "error"; } };
(async () => console.log(JSON.stringify({ ios: await call("ios"), android: await call("android"), other: mw.other })))();"#,
        )
        .arg(cli_dir.join(MIDDLEWARE).join("ExpoGoManifestHandlerMiddleware.js"))
        .env("NODE_OPTIONS", options)
        .current_dir(std::env::temp_dir())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn pin(fx: &Fixture, body: &str) {
    std::fs::write(fx.run_dir.join(PIN_FILE), body).unwrap();
}

#[test]
fn pnpm_workspace_node_options_preserve_the_runtime_pin() {
    use std::os::unix::fs::PermissionsExt;

    let fx = fixture("pnpm");
    write(
        &fx.app.join("package.json"),
        r#"{"name":"pin-fixture","private":true,"packageManager":"pnpm@11.5.2"}"#,
    );
    if Command::new("pnpm")
        .arg("--version")
        .current_dir(&fx.app)
        .output()
        .is_err()
    {
        std::fs::remove_dir_all(fx.app.parent().unwrap()).unwrap();
        return;
    }
    write(
        &fx.app.join("pnpm-workspace.yaml"),
        "nodeOptions: --max-old-space-size=${HEAP}\nverifyDepsBeforeRun: never\n",
    );
    let configured = Command::new("pnpm")
        .args(["config", "get", "node-options"])
        .env("HEAP", "4096")
        .current_dir(&fx.app)
        .output()
        .unwrap();
    assert!(configured.status.success(), "{configured:?}");
    let base = String::from_utf8(configured.stdout).unwrap();
    assert_eq!(base.trim(), "--max-old-space-size=4096");
    let expo = fx.app.join("node_modules/.bin/expo");
    write(
        &expo,
        &format!(
            r#"#!/usr/bin/env node
const mw = require({});
mw("ios").then(value => console.log(JSON.stringify({{ value, options: process.env.NODE_OPTIONS, npmOptions: process.env.npm_config_node_options }})));
"#,
            serde_json::Value::from(fx.store_cli.join(MIDDLEWARE).join("ExpoGoManifestHandlerMiddleware.js").to_str().unwrap())
        ),
    );
    std::fs::set_permissions(&expo, std::fs::Permissions::from_mode(0o755)).unwrap();
    pin(&fx, r#"{"platform":"ios","value":"abc123"}"#);
    let preload = write_preload(&fx.run_dir, &fx.app).unwrap();
    let spec = metro::start_spec(&fx.app, 8791, true, false, Some(&preload), Some(base.trim()));
    let output = Command::new(&spec.program)
        .args(&spec.args)
        .envs(spec.env.iter().cloned())
        .env("HEAP", "4096")
        .current_dir(&fx.app)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let served: serde_json::Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
    // F3 requires the embedded pin plus the project's options in the actual dev-server child.
    assert_eq!(served["value"], "abc123");
    let expected = format!(
        "--max-old-space-size=4096 --dns-result-order=ipv4first --require \"{}\"",
        preload.display()
    );
    assert_eq!(served["options"], expected);
    assert_eq!(served["npmOptions"], expected);
    assert!(fx.run_dir.join(RESOLVED_MARKER).exists());
    std::fs::remove_dir_all(fx.app.parent().unwrap()).unwrap();
}

#[test]
fn the_pinned_platform_is_served_and_attested_by_pid_everything_else_delegates() {
    if !node() {
        return;
    }
    let fx = fixture("serve");
    let served = serve(&fx, &fx.store_cli, None);
    assert_eq!(served["ios"], "original:store:ios", "no pin file yet");
    assert!(!fx.run_dir.join(RESOLVED_MARKER).exists());
    pin(&fx, r#"{"platform":"ios","value":"abc123"}"#);
    let served = serve(&fx, &fx.store_cli, None);
    assert_eq!(served["ios"], "abc123");
    assert_eq!(served["android"], "original:store:android");
    assert_eq!(served["other"], "kept");
    let marker = std::fs::read_to_string(fx.run_dir.join(RESOLVED_MARKER)).unwrap();
    let (pid, platform) = marker.trim().split_once(' ').unwrap();
    assert!(pid.parse::<u32>().is_ok());
    assert_eq!(platform, "ios");
    // The hoisted duplicate is not the app's expo's own CLI.
    let hoisted = serve(&fx, &fx.app.join("node_modules/@expo/cli"), None);
    assert_eq!(hoisted["ios"], "original:hoisted:ios");
}

#[test]
fn malformed_pins_and_a_failed_marker_never_break_the_resolver() {
    if !node() {
        return;
    }
    let fx = fixture("malformed");
    let long = format!(r#"{{"platform":"ios","value":"{}"}}"#, "a".repeat(257));
    for body in [
        "not json",
        r#"{"platform":"ios","value":""}"#,
        r#"{"platform":"ios"}"#,
        r#"{"platform":"ios","value":"1.0\n"}"#,
        long.as_str(),
    ] {
        pin(&fx, body);
        assert_eq!(
            serve(&fx, &fx.store_cli, None)["ios"],
            "original:store:ios",
            "{body}"
        );
    }
    // An unreadable pin delegates too.
    std::fs::remove_file(fx.run_dir.join(PIN_FILE)).unwrap();
    std::fs::create_dir(fx.run_dir.join(PIN_FILE)).unwrap();
    assert_eq!(serve(&fx, &fx.store_cli, None)["ios"], "original:store:ios");
    std::fs::remove_dir(fx.run_dir.join(PIN_FILE)).unwrap();
    // A marker that cannot be appended still serves the pin.
    pin(&fx, r#"{"platform":"ios","value":"abc123"}"#);
    std::fs::create_dir(fx.run_dir.join(RESOLVED_MARKER)).unwrap();
    assert_eq!(serve(&fx, &fx.store_cli, None)["ios"], "abc123");
}

#[test]
fn an_absent_module_a_different_export_or_an_earlier_load_leaves_the_resolver_alone() {
    if !node() {
        return;
    }
    let fx = fixture("noop");
    pin(&fx, r#"{"platform":"ios","value":"abc123"}"#);
    // Middleware loaded first by an inherited preload: its importers hold the original exports.
    let early = fx.run_dir.join("early.cjs");
    let middleware = fx
        .store_cli
        .join(MIDDLEWARE)
        .join("ExpoGoManifestHandlerMiddleware.js");
    write(
        &early,
        &format!(
            "require({});\n",
            serde_json::Value::from(middleware.to_str().unwrap())
        ),
    );
    assert_eq!(
        serve(&fx, &fx.store_cli, Some(&early))["ios"],
        "original:store:ios"
    );
    // A CLI whose resolver export moved is left untouched.
    cli(&fx.store_cli, "renamed", "resolveRuntimeVersionAsync");
    let served = serve(&fx, &fx.store_cli, None);
    assert_eq!(served["other"], "kept");
    assert_eq!(
        served["ios"], "error",
        "the original module's own behavior, not a pin"
    );
    // An export whose getter throws leaves the module untouched instead of aborting Node's startup.
    cli(
        &fx.store_cli,
        "store",
        "resolveRuntimeVersionWithExpoUpdatesAsync",
    );
    let resolver = fx
        .store_cli
        .join(MIDDLEWARE)
        .join("resolveRuntimeVersionWithExpoUpdatesAsync.js");
    let source = std::fs::read_to_string(&resolver).unwrap();
    std::fs::write(
        &resolver,
        format!("{source}Object.defineProperty(exports, \"lazy\", {{ enumerable: true, get() {{ throw new Error(\"lazy\"); }} }});\n"),
    )
    .unwrap();
    assert_eq!(serve(&fx, &fx.store_cli, None)["ios"], "original:store:ios");
    // No expo installation at all: the preload is a no-op.
    std::fs::remove_file(fx.app.join("node_modules/expo")).unwrap();
    cli(
        &fx.store_cli,
        "store",
        "resolveRuntimeVersionWithExpoUpdatesAsync",
    );
    assert_eq!(serve(&fx, &fx.store_cli, None)["ios"], "original:store:ios");
    assert!(!fx.run_dir.join(RESOLVED_MARKER).exists());
}
