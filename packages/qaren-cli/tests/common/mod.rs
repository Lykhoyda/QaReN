#![allow(dead_code)]

use qaren::candidate::Candidate;
use qaren::exec::{CmdOutput, MockRunner};
use qaren::runrecord::{Phase, PidIdentity, RunRecord, RUN_SCHEMA};
use qaren::scenario::Scenario;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

pub fn temp_repo() -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    // A recycled PID must not reopen a leftover tree that already contains runs.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "qaren-test-{}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst),
        nonce
    ));
    std::fs::create_dir_all(dir.join("test-app")).unwrap();
    std::fs::write(dir.join("test-app").join("package.json"), "{}").unwrap();
    std::fs::create_dir_all(dir.join("test-app/node_modules/.bin")).unwrap();
    std::fs::write(
        dir.join("test-app/node_modules/.bin/expo"),
        "mock local expo",
    )
    .unwrap();
    std::fs::set_permissions(
        dir.join("test-app/node_modules/.bin/expo"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    std::fs::write(
        dir.join("test-app").join("pnpm-lock.yaml"),
        "lockfileVersion: 9\n",
    )
    .unwrap();
    dir
}

pub fn script_tracked_file_identity(mock: &mut MockRunner, path: &str, mode: &str) {
    let oid = "a".repeat(40);
    mock.expect_run(
        "ls-tree",
        CmdOutput::success(&format!("{mode} blob {oid}\t{path}\0")),
    );
    mock.expect_run(
        "ls-files",
        CmdOutput::success(&format!("{mode} {oid} 0\t{path}\0")),
    );
}

pub const EXPO_FINGERPRINT_CLI: &str =
    "/repo/node_modules/.pnpm/@expo+fingerprint@0.19.10/node_modules/@expo/fingerprint/bin/cli.js";

pub fn script_expo_fingerprint(mock: &mut MockRunner, hash: &str, xcode: &str) {
    mock.expect_run("require.resolve", CmdOutput::success(EXPO_FINGERPRINT_CLI));
    mock.expect_run(
        "fingerprint:generate --platform ios",
        CmdOutput::success(&format!(
            "{}\n",
            serde_json::json!({"sources": [{"type": "contents", "id": "expoConfig", "contents": "{}"}], "hash": hash})
        )),
    );
    mock.expect_run("xcodebuild -version", CmdOutput::success(xcode));
}

pub fn stored_record(
    store_root: &std::path::Path,
    platform: &str,
    fingerprint: &str,
) -> Option<qaren::buildplan::StoreRecord> {
    let dir =
        qaren::buildplan::store_dir(store_root, platform, "com.rndevagent.testapp", fingerprint);
    qaren::buildplan::load_store_record(&dir).unwrap()
}

pub fn seed_store(
    store_root: &std::path::Path,
    platform: &str,
    fingerprint: &str,
    src: &std::path::Path,
    kind: qaren::buildplan::ArtifactKind,
) -> qaren::buildplan::CachedArtifact {
    use qaren::buildplan::{
        copy_artifact, hash_artifact, publish_store_record, store_dir, CachedArtifact, StoreRecord,
    };
    let dir = store_dir(store_root, platform, "com.rndevagent.testapp", fingerprint);
    let path = dir.join("seed-run").join(src.file_name().unwrap());
    copy_artifact(&MockRunner::new(), src, &path).unwrap();
    let artifact = CachedArtifact {
        sha256: hash_artifact(&path).unwrap(),
        path,
        kind,
    };
    let record = StoreRecord {
        artifact: artifact.clone(),
        built_at: "2026-10-11T00:00:00Z".to_string(),
        candidate_sha: "a".repeat(40),
    };
    assert!(publish_store_record(&dir, &record).unwrap());
    artifact
}

pub const XCODE_VERSION: &str = "Xcode 27.0\nBuild version 27A266a\n";

pub fn script_xcode(mock: &mut MockRunner) {
    mock.expect_run("xcodebuild -version", CmdOutput::success(XCODE_VERSION));
}

pub fn script_expo_fingerprint_unresolvable(mock: &mut MockRunner) {
    mock.expect_run(
        "require.resolve",
        CmdOutput::failed(
            1,
            "Error: Cannot find module '@expo/fingerprint/bin/cli.js'",
        ),
    );
}

pub fn ios_scenario_yaml(port: u16) -> String {
    format!(
        "schema: qaren/1\nname: ios-simulator\nplatform: ios\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\n  dev_client_scheme: rndatest\nmetro:\n  port: {port}\nios:\n  device_type: com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro\n  runtime: com.apple.CoreSimulator.SimRuntime.iOS-26-4\n"
    )
}

pub fn android_scenario_yaml(port: u16) -> String {
    format!(
        "schema: qaren/1\nname: nuc-android\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nmetro:\n  port: {port}\nandroid:\n  ssh_host: nuc\n  farm_path: bin/android-farm\n  slot: 1\n  adb_server_port: 15037\n"
    )
}

pub fn scenario_from(yaml: &str) -> Scenario {
    let scenario: Scenario = serde_yaml::from_str(yaml).unwrap();
    scenario.validate().unwrap();
    scenario
}

pub fn identity(pid: i32, started_at: &str) -> PidIdentity {
    PidIdentity {
        pid,
        started_at: started_at.to_string(),
        command: qaren::redact::OutputText::from_output("node metro"),
    }
}

pub fn base_record(
    repo_root: &std::path::Path,
    yaml: &str,
    run_id: &str,
    phase: Phase,
) -> RunRecord {
    let scenario = scenario_from(yaml);
    RunRecord {
        schema: RUN_SCHEMA.to_string(),
        run_id: run_id.to_string(),
        created_at: "2026-08-12T16:00:00Z".to_string(),
        scenario,
        scenario_path: repo_root.join("scenario.yaml"),
        scenario_sha256: "0".repeat(64),
        candidate: Candidate {
            repo_root: repo_root.to_path_buf(),
            project_root: repo_root.join("test-app"),
            app_id: "com.rndevagent.testapp".to_string(),
            git_sha: "b".repeat(40),
            git_dirty: false,
            lockfile_sha256: Some("c".repeat(64)),
            worktree_fingerprint: Some(qaren::candidate::worktree_fingerprint(repo_root, "").unwrap()),
        },
        phase,
        prepare: Some(identity(999, "Wed Aug 12 15:00:00 2026")),
        // Only phases reached after build planning carry a recorded plan,
        // matching what production records can actually contain.
        build: matches!(phase, Phase::Building | Phase::Ready | Phase::Cleaned).then(|| {
            qaren::buildplan::BuildPlan {
                decision: qaren::buildplan::BuildDecision::Clean,
                fingerprint: format!("rnfp1:{}", "e".repeat(64)),
                reason: qaren::redact::OutputText::from_output("no native cache state recorded for this worktree/app; compatibility is unprovable"
                        ),
                evidence: Vec::new(),
                artifact: None,
                regenerate_native_dir: false,
            }
        }),
        handoff: None,
        resources: Default::default(),
        failure: None,
        history: Vec::new(),
        terminal: None,
    }
}

pub fn ios_app_info() -> String {
    serde_json::json!({
        "CFBundleIdentifier": "com.rndevagent.testapp",
        "CFBundlePackageType": "APPL",
        "CFBundleSupportedPlatforms": ["iPhoneSimulator"],
        "CFBundleExecutable": "binary",
        "CFBundleURLTypes": [{"CFBundleURLSchemes": ["rndatest"]}]
    })
    .to_string()
}

pub fn write_ios_app(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path).unwrap();
    std::fs::write(path.join("Info.plist"), ios_app_info()).unwrap();
    std::fs::write(path.join("binary"), b"mock simulator executable").unwrap();
    std::fs::set_permissions(path.join("binary"), std::fs::Permissions::from_mode(0o755)).unwrap();
}

pub fn write_ios_workspace(root: &std::path::Path, workspace: &str) {
    let path = root.join(workspace);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("contents.xcworkspacedata"), "<Workspace/>").unwrap();
    std::fs::write(root.join("ios/Podfile"), "platform :ios, '15.0'\n").unwrap();
}

pub const IOS_NATIVE_FILES: &str = "test-app/ios/Podfile\0";

pub fn script_ios_app_verification(mock: &mut MockRunner) {
    mock.expect_run("plutil", CmdOutput::success(&ios_app_info()));
    mock.expect_run(
        "vtool -show-build",
        CmdOutput::success("Load command 9\n cmd LC_BUILD_VERSION\n platform IOSSIMULATOR\n"),
    );
    mock.expect_run("otool -L", CmdOutput::success("test.app/binary:\n"));
    mock.expect_run("nm -j -U", CmdOutput::success(IOS_LAUNCHER_SYMBOLS));
    mock.expect_run(
        "otool -v -s __TEXT __cstring",
        CmdOutput::success("0000000100012345  --initialUrl\n"),
    );
}

pub const IOS_LAUNCHER_SYMBOLS: &str = "+[EXDevLauncherController initialUrlFromProcessInfo]\n-[EXDevLauncherController start:launchOptions:]\n-[EXDevLauncherController loadApp:withProjectUrl:onSuccess:onError:]\n";

pub const IOS_BUILD_HELP: &str = "Usage\n  npx expo run:ios\nOptions\n  --no-bundler                     Skip starting the Metro bundler\n  -d, --device [device]            Device name, UDID, or \"generic\" for build-only\n  -o, --output <path>              Directory to output the built app binary\n";

pub fn script_ios_deps(mock: &mut MockRunner) {
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("expo run:ios --help", CmdOutput::success(IOS_BUILD_HELP));
}

pub fn script_finite_ios_build(mock: &mut MockRunner) {
    script_finite_ios_build_with(mock, "expo run:ios");
}

pub fn script_finite_ios_build_with(mock: &mut MockRunner, command: &str) {
    script_finite_ios_build_defaults(mock, command, CmdOutput::success(""));
}

pub fn script_finite_ios_build_defaults(mock: &mut MockRunner, command: &str, defaults: CmdOutput) {
    script_finite_ios_build_install(mock, command, defaults, |m| {
        m.expect_run("simctl install", CmdOutput::success(""))
    });
}

pub fn script_finite_ios_build_install(
    mock: &mut MockRunner,
    command: &str,
    defaults: CmdOutput,
    install: impl FnOnce(&mut MockRunner),
) {
    script_finite_ios_build_launch(mock, command, defaults, install, script_ios_launch);
}

pub fn script_finite_ios_build_launch(
    mock: &mut MockRunner,
    command: &str,
    defaults: CmdOutput,
    install: impl FnOnce(&mut MockRunner),
    launch: impl FnOnce(&mut MockRunner),
) {
    script_ios_metro_spawn(mock);
    mock.expect_spawn_piped(command, 5000, "", Some(0));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:00:00 2026"));
    mock.expect_run("ps", CmdOutput::success("qaren-build"));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    script_ios_app_verification(mock);
    script_ios_app_verification(mock);
    install(mock);
    script_ios_metro_wait_and_launch_with(mock, defaults, launch);
}

pub fn script_ios_install_and_launch(mock: &mut MockRunner) {
    script_ios_install_and_launch_with(mock, CmdOutput::success(""));
}

pub fn script_devmenu_defaults(mock: &mut MockRunner, result: CmdOutput) {
    for _ in 0..3 {
        mock.expect_run("defaults write", result.clone());
    }
}

pub fn script_ios_install_and_launch_with(mock: &mut MockRunner, defaults: CmdOutput) {
    script_ios_app_verification(mock);
    script_ios_metro_spawn(mock);
    mock.expect_run("simctl install", CmdOutput::success(""));
    script_ios_metro_wait_and_launch(mock, defaults);
}

pub fn script_ios_metro_spawn(mock: &mut MockRunner) {
    mock.expect_spawn(
        "expo start",
        qaren::exec::Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("ps", CmdOutput::success("node expo start"));
}

pub fn script_ios_metro_cleanup(mock: &mut MockRunner) {
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("ps", CmdOutput::success("S"));
    mock.expect_run("lsof", CmdOutput::success("6001"));
    mock.expect_run("ps", CmdOutput::success("6000"));
    mock.expect_run("lstart=", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("lsof", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
}

pub fn script_ios_metro_wait_and_launch(mock: &mut MockRunner, defaults: CmdOutput) {
    script_ios_metro_wait_and_launch_with(mock, defaults, script_ios_launch);
}

pub fn script_ios_launch(mock: &mut MockRunner) {
    mock.expect_run(
        "simctl launch --terminate-running-process",
        CmdOutput::success(""),
    );
}

pub fn script_ios_metro_wait_and_launch_with(
    mock: &mut MockRunner,
    defaults: CmdOutput,
    launch: impl FnOnce(&mut MockRunner),
) {
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("ps", CmdOutput::success("S"));
    mock.expect_run("lsof", CmdOutput::success("6001"));
    mock.expect_run("ps", CmdOutput::success("6000"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run("expo-platform", CmdOutput::success(""));
    script_devmenu_defaults(mock, defaults);
    launch(mock);
}

#[derive(Default)]
pub struct IosBuildRunner {
    pub inner: MockRunner,
    pub timeouts: std::collections::VecDeque<(String, u64)>,
    pub omit_app: bool,
    pub ambiguous_app: bool,
    pub workspace_mutation: Option<WorkspaceMutation>,
    pub build_log: Option<String>,
    pub build_spawn_fault: Option<BuildSpawnFault>,
    pub symlink_build_root: Option<&'static str>,
    // Answers the next app-container probe with the last installed bundle path.
    pub container_is_installed_app: bool,
    // Called before each run command, e.g. to inspect the durable record at the moment of an effect.
    pub observe: Option<Box<dyn FnMut(&qaren::exec::CmdSpec) + Send>>,
}

#[derive(Clone)]
pub enum WorkspaceMutation {
    Remove(PathBuf),
    Symlink(PathBuf),
}

#[derive(Clone, Copy)]
pub enum BuildSpawnFault {
    Error,
    ErrorWithSaveFailure,
    Interrupted,
}

impl IosBuildRunner {
    pub fn new() -> Self {
        Self::default()
    }
}

impl std::ops::Deref for IosBuildRunner {
    type Target = MockRunner;
    fn deref(&self) -> &MockRunner {
        &self.inner
    }
}

impl std::ops::DerefMut for IosBuildRunner {
    fn deref_mut(&mut self) -> &mut MockRunner {
        &mut self.inner
    }
}

struct BuildStart {
    stdin: Box<dyn std::io::Write + Send>,
    label: String,
    run_dir: PathBuf,
    output: Option<PathBuf>,
    xcode: bool,
    ambiguous_app: bool,
    workspace_mutation: Option<WorkspaceMutation>,
}

impl std::io::Write for BuildStart {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        assert_eq!(bytes, b"start\n");
        let record: RunRecord =
            serde_json::from_slice(&std::fs::read(self.run_dir.join("run.json")).unwrap()).unwrap();
        assert!(matches!(
            record.resources.build_process(),
            Some(qaren::runrecord::BuildProcess::Running {
                identity: Some(_),
                ..
            })
        ));
        if matches!(self.label.as_str(), "expo-run-ios" | "xcodebuild-ios") {
            let metro = record
                .resources
                .metro
                .as_ref()
                .expect("Metro recorded before native build starts");
            assert_eq!(metro.spawned.pgid, 6000);
            assert!(metro.identity.is_some());
        } else {
            assert!(record.resources.metro.is_none());
        }
        let lock = record.resources.build_lock.unwrap();
        assert_eq!(
            qaren::buildplan::read_holder(&lock.lock_dir)
                .unwrap()
                .run_id,
            record.run_id
        );
        if record.scenario.name == "check" || record.resources.device_borrowed {
            let lease = record
                .resources
                .lease
                .as_ref()
                .expect("check owns a device lease");
            assert_eq!(
                qaren::buildplan::read_holder(&lease.lock_dir)
                    .unwrap()
                    .run_id,
                record.run_id
            );
        }
        // The borrowed-emulator arm: prebuild generates the Gradle project, Gradle writes the debug APK.
        if record.scenario.android_emulator.is_some() {
            let android = record.candidate.project_root.join("android");
            match self.label.as_str() {
                "expo-prebuild" => {
                    std::fs::create_dir_all(&android).unwrap();
                    std::fs::write(android.join("gradlew"), "#!/bin/sh\n").unwrap();
                }
                "gradle-assemble" => {
                    let apk = android.join("app/build/outputs/apk/debug");
                    std::fs::create_dir_all(&apk).unwrap();
                    std::fs::write(apk.join("app-debug.apk"), "built apk").unwrap();
                }
                _ => {}
            }
        }
        if let Some(output) = &self.output {
            write_ios_app(&output.join("testapp.app"));
            if self.ambiguous_app {
                write_ios_app(&output.join("other.app"));
            }
        }
        if self.xcode {
            let derived = self
                .run_dir
                .join("ios-derived-data/Build/Intermediates.noindex");
            std::fs::create_dir_all(&derived).unwrap();
            std::fs::write(derived.join("compile.o"), "intermediate").unwrap();
            std::fs::write(self.run_dir.join("ios-build/libNative.a"), "library").unwrap();
        }
        if let Some(mutation) = &self.workspace_mutation {
            let path = match mutation {
                WorkspaceMutation::Remove(path) | WorkspaceMutation::Symlink(path) => path,
            };
            std::fs::remove_dir_all(path).unwrap();
            if matches!(mutation, WorkspaceMutation::Symlink(_)) {
                let replacement = path.with_extension("replacement");
                std::fs::create_dir(&replacement).unwrap();
                std::fs::write(replacement.join("contents.xcworkspacedata"), "<Workspace/>")
                    .unwrap();
                std::os::unix::fs::symlink(replacement, path).unwrap();
            }
        }
        self.stdin.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stdin.flush()
    }
}

impl qaren::exec::Runner for IosBuildRunner {
    fn env_var(&self, name: &str) -> Option<String> {
        self.inner.env_var(name)
    }
    fn adb_server_version(&self, port: u16) -> Result<u32, String> {
        self.inner.adb_server_version(port)
    }
    fn execute(&mut self, spec: &qaren::exec::CmdSpec, interruptible: bool) -> CmdOutput {
        if let Some(observe) = self.observe.as_mut() {
            observe(spec);
        }
        if self
            .timeouts
            .front()
            .is_some_and(|(label, _)| label == &spec.label)
        {
            let (_, duration_ms) = self.timeouts.pop_front().unwrap();
            assert!(duration_ms <= spec.timeout_seconds * 1000);
            self.inner.calls.push(spec.clone());
            self.inner
                .sleep(std::time::Duration::from_millis(duration_ms));
            return CmdOutput {
                timed_out: true,
                duration_ms,
                ..Default::default()
            };
        }
        if self.container_is_installed_app && spec.label == "simctl-app-container" {
            self.container_is_installed_app = false;
            let installed = self
                .inner
                .calls
                .iter()
                .rev()
                .find(|call| call.label == "simctl-install")
                .map(|call| call.args[3].clone())
                .expect("an install precedes the container probe");
            self.inner.calls.push(spec.clone());
            return CmdOutput::success(&format!("{installed}\n"));
        }
        self.inner.execute(spec, interruptible)
    }
    fn execute_private(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> qaren::exec::PrivateOutput {
        if spec.label == "ios-app-info" {
            if let Some(root) = self.symlink_build_root.take() {
                let app = PathBuf::from(spec.args.last().unwrap());
                let run_dir = app.parent().unwrap().parent().unwrap().parent().unwrap();
                let source = run_dir.join(root);
                let outside = run_dir.parent().unwrap().join("outside-build").join(root);
                std::fs::rename(&source, &outside).unwrap();
                std::os::unix::fs::symlink(&outside, &source).unwrap();
            }
        }
        self.inner.execute_private(spec, input, interruptible)
    }
    fn spawn_group_unchecked(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log: &std::path::Path,
    ) -> std::io::Result<qaren::exec::Spawned> {
        self.inner.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log: &std::path::Path,
    ) -> std::io::Result<qaren::exec::PipedChild> {
        if let Some(fault) = self
            .build_spawn_fault
            .filter(|_| matches!(spec.label.as_str(), "expo-run-ios" | "xcodebuild-ios"))
        {
            self.inner.calls.push(spec.clone());
            let run_dir = log.parent().unwrap().parent().unwrap();
            let record: RunRecord =
                serde_json::from_slice(&std::fs::read(run_dir.join("run.json")).unwrap()).unwrap();
            assert!(matches!(
                record.resources.build_process(),
                Some(qaren::runrecord::BuildProcess::SpawnPending)
            ));
            match fault {
                BuildSpawnFault::Error => {}
                BuildSpawnFault::ErrorWithSaveFailure => {
                    std::fs::create_dir(
                        run_dir.join(format!(".run.json.tmp.{}", std::process::id())),
                    )
                    .unwrap();
                }
                BuildSpawnFault::Interrupted => panic!("interrupted during build spawn"),
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "build executable unavailable",
            ));
        }
        let mut child = self.inner.spawn_piped_unchecked(spec, log)?;
        if matches!(
            spec.label.as_str(),
            "expo-run-ios" | "xcodebuild-ios" | "expo-prebuild" | "gradle-assemble"
        ) {
            let run_dir = log.parent().unwrap().parent().unwrap().to_path_buf();
            let record: RunRecord =
                serde_json::from_slice(&std::fs::read(run_dir.join("run.json")).unwrap()).unwrap();
            assert!(matches!(
                record.resources.build_process(),
                Some(qaren::runrecord::BuildProcess::SpawnPending)
            ));
            if let Some(text) = &self.build_log {
                std::fs::write(log, qaren::redact::redact_secrets(text)).unwrap();
            }
            let output = spec
                .args
                .iter()
                .position(|a| a == "--output")
                .map(|i| PathBuf::from(&spec.args[i + 1]))
                .inspect(|output| assert_eq!(output, &run_dir.join("ios-build")))
                .or_else(|| {
                    (spec.label == "xcodebuild-ios").then(|| {
                        run_dir.join("ios-derived-data/Build/Products/Debug-iphonesimulator")
                    })
                })
                .filter(|_| !self.omit_app);
            child.stdin = Box::new(BuildStart {
                stdin: child.stdin,
                label: spec.label.clone(),
                run_dir,
                output,
                xcode: spec.label == "xcodebuild-ios",
                ambiguous_app: self.ambiguous_app,
                workspace_mutation: (spec.label == "expo-prebuild")
                    .then(|| self.workspace_mutation.clone())
                    .flatten(),
            });
        }
        Ok(child)
    }
    fn sleep(&mut self, duration: std::time::Duration) {
        self.inner.sleep(duration);
    }
    fn now_epoch_ms(&self) -> u64 {
        self.inner.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.inner.commands_executed()
    }
    fn cancellation(&self) -> Option<String> {
        self.inner.cancellation()
    }
}

pub fn invalid_registry_auth_lists() -> Vec<serde_json::Value> {
    use serde_json::json;
    let mut invalid = vec![
        json!(null),
        json!("mistaken-value"),
        json!({"name": "mistaken-value"}),
        json!([12]),
        json!([true]),
        json!([{"name": "mistaken-value"}]),
        json!([null]),
    ];
    for name in [
        "",
        "space name",
        "NAME=value",
        "NAME\0TAIL",
        "${NAME}",
        "${NAME:-fallback}",
        "NAME-DASH",
        "ÜNICODE",
        "1NAME",
        "TYPESAFE_API_KEY",
        "typesafe_api_key",
        "QaReN_InPuT_SLOT",
        &"A".repeat(129),
    ] {
        invalid.push(json!([name]));
    }
    invalid.push(json!(vec!["PRIVATE_REGISTRY_TOKEN"; 65]));
    invalid
}

pub fn append_registry_config(path: &std::path::Path) {
    let raw = std::fs::read_to_string(path).unwrap();
    std::fs::write(
        path,
        format!("{raw}registryAuthEnv: [PRIVATE_REGISTRY_TOKEN]\n"),
    )
    .unwrap();
}

pub fn assert_registry_specs(calls: &[qaren::exec::CmdSpec]) {
    assert!(calls.iter().any(|spec| spec.label == "pnpm-install"));
    assert!(calls.iter().any(|spec| spec.label == "expo-prebuild"));
    for spec in calls {
        if matches!(spec.label.as_str(), "pnpm-install" | "expo-prebuild") {
            assert_eq!(
                spec.registry_auth_env,
                ["PRIVATE_REGISTRY_TOKEN"],
                "{}",
                spec.label
            );
        } else {
            assert!(spec.registry_auth_env.is_empty(), "{}", spec.label);
        }
    }
}
