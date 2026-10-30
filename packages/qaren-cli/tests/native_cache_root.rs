mod common;

use qaren::buildplan::*;
use qaren::exec::MockRunner;
use std::ffi::{CString, OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{symlink, DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const KEY: &str = "ios/com.example.fixture/rnfp1-abcd";

#[cfg(target_os = "macos")]
#[test]
fn the_host_volume_probe_is_read_only_and_uses_one_volume_identity() {
    let fixture = common::temp_repo();
    let a = anchor_native_cache(&fixture.join("a/cache")).unwrap();
    let b = anchor_native_cache(&fixture.join("b/cache")).unwrap();
    assert_eq!(a.mount_hash, b.mount_hash);
    assert_eq!(a.mount_hash.len(), 64);
    assert!(!fixture.join("a").exists());
    assert!(!fixture.join("b").exists());
    let absent = PathBuf::from(format!(
        "/Volumes/qaren-unmounted-fixture-{}/cache",
        std::process::id()
    ));
    assert!(matches!(
        anchor_native_cache(&absent),
        Err(CacheAvailability::VolumeUnmounted)
    ));
    assert!(!absent.exists());
}

#[test]
fn mounted_missing_root_is_read_only_until_descriptor_creation() {
    let fixture = common::temp_repo();
    let path = fixture.join("missing/cache");
    let anchor = anchor_native_cache_with(&path, common::fixture_mount).unwrap();
    assert_eq!(anchor.availability, CacheAvailability::RootAbsent);
    assert!(!path.exists());
    open_native_store_root_from_anchor(&anchor).unwrap();
    assert_eq!(
        anchor_native_cache_with(&path, common::fixture_mount)
            .unwrap()
            .availability,
        CacheAvailability::Present
    );
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn changed_or_unknown_mount_identity_never_creates_a_cache_root() {
    let fixture = common::temp_repo();
    let path = fixture.join("absent/cache");
    let mut anchor = anchor_native_cache_with(&path, common::fixture_mount).unwrap();
    anchor.mount_hash = "f".repeat(64);
    assert!(open_native_store_root_from_anchor(&anchor).is_err());
    assert!(!fixture.join("absent").exists());
    fn unavailable(_: &std::fs::File, _: &Path) -> Result<String, CacheAvailability> {
        Err(CacheAvailability::VolumeUnmounted)
    }
    assert!(matches!(
        anchor_native_cache_with(&path, unavailable),
        Err(CacheAvailability::VolumeUnmounted)
    ));
    assert!(!fixture.join("absent").exists());
}

#[test]
fn a_replaced_ancestor_never_receives_fallback_cache_bytes() {
    let fixture = common::temp_repo();
    let parent = fixture.join("mounted");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&parent)
        .unwrap();
    let path = parent.join("cache");
    let anchor = anchor_native_cache_with(&path, common::fixture_mount).unwrap();
    std::fs::rename(&parent, fixture.join("detached")).unwrap();
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&parent)
        .unwrap();
    assert!(open_native_store_root_from_anchor(&anchor).is_err());
    assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 0);
}

#[test]
fn last_success_is_private_atomic_read_only_history_and_survives_root_loss() {
    use qaren::ios_toolchain::{CompilerIdentity, Mode, RequestedModes, SwiftVersion};
    let fixture = common::temp_repo();
    let state = fixture.join("runtime-state");
    let cache = fixture.join("cache");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&cache)
        .unwrap();
    let record = LastSuccess {
        schema: 1,
        fingerprint: format!("rnfp1:{}", "a".repeat(64)),
        parts: std::collections::BTreeMap::from([("toolchain.swift".into(), "b".repeat(64))]),
        compiler: CompilerIdentity {
            xcode: Some("27.0/27A1".into()),
            swift: SwiftVersion::parse("6.4"),
            xcode_hash: Some("c".repeat(64)),
            swift_hash: Some("d".repeat(64)),
        },
        requested: RequestedModes {
            expo: Mode::On,
            rncore: Mode::Off,
            jsi: Mode::Off,
        },
        mount_hash: common::fixture_mount(&std::fs::File::open(&cache).unwrap(), &cache).unwrap(),
        completed_at: "2026-10-30T00:00:00Z".into(),
        artifact_sha256: "e".repeat(64),
    };
    assert!(LastSuccess::load(&state, &cache, "ios", "com.example.fixture").is_none());
    assert!(!state.exists());
    record
        .save_with_probe(
            &state,
            &cache,
            "ios",
            "com.example.fixture",
            common::fixture_mount,
        )
        .unwrap();
    std::fs::rename(&cache, fixture.join("detached-cache")).unwrap();
    assert_eq!(
        LastSuccess::load(&state, &cache, "ios", "com.example.fixture")
            .unwrap()
            .fingerprint,
        record.fingerprint
    );
    let directory = state.join("native-cache").join(qaren::VERSION);
    let file = std::fs::read_dir(&directory)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let bytes = std::fs::read(&file).unwrap();
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!String::from_utf8_lossy(&bytes).contains("com.example.fixture"));
    assert!(!String::from_utf8_lossy(&bytes).contains(&cache.to_string_lossy().to_string()));
    assert!(LastSuccess::load(&state, &cache, "ios", "different-app").is_none());
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    std::fs::write(&file, "{broken").unwrap();
    assert!(LastSuccess::load(&state, &cache, "ios", "com.example.fixture").is_none());
    std::fs::remove_file(&file).unwrap();
    symlink(fixture.join("foreign"), &file).unwrap();
    assert!(record
        .save_with_probe(
            &state,
            &cache,
            "ios",
            "com.example.fixture",
            common::fixture_mount
        )
        .is_err());
    assert!(!fixture.join("foreign").exists());
}

fn entry(root: &Path) -> NativeStoreEntry {
    open_native_store_root(root, true)
        .unwrap()
        .unwrap()
        .entry(Path::new(KEY), true)
        .unwrap()
        .unwrap()
}

fn source(fixture: &Path, name: &str) -> PathBuf {
    let path = fixture.join(format!("{name}.app"));
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("binary"), name).unwrap();
    std::fs::set_permissions(path.join("binary"), std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn seed(entry: &NativeStoreEntry, source: &Path, generation: &str) -> StoreRecord {
    StoreRecord {
        artifact: entry
            .copy_app(
                &MockRunner::new(),
                source,
                OsStr::new(generation),
                &hash_artifact(source).unwrap(),
            )
            .unwrap()
            .retain(),
        built_at: "fixture".into(),
        candidate_sha: "a".repeat(40),
    }
}

fn record_file(entry: &NativeStoreEntry, bytes: &[u8]) {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(entry.path().join(STORE_RECORD))
        .unwrap();
    file.write_all(bytes).unwrap();
}

#[test]
fn fixed_uid_default_and_exact_override_are_pure_os_paths() {
    assert_eq!(
        resolve_native_cache_root(None, 501).unwrap(),
        Path::new("/private/var/tmp/qaren-native-cache-501")
    );
    assert_ne!(
        resolve_native_cache_root(None, 501).unwrap(),
        resolve_native_cache_root(None, 502).unwrap()
    );
    for bad in [
        "",
        "relative",
        "~/.cache",
        "/",
        "///",
        "/private/./cache",
        "/private/cache/.",
        "/private/../cache",
        "/private/cache/..",
        "/cache\0bad",
    ] {
        let error = resolve_native_cache_root(Some(OsStr::new(bad)), 501).unwrap_err();
        assert_eq!(error, "native cache root: invalid absolute path");
    }
    let raw = OsString::from_vec(b"/private/cache-\xff".to_vec());
    assert_eq!(
        resolve_native_cache_root(Some(&raw), 501).unwrap_err(),
        "native cache root: path must be valid UTF-8"
    );
}

#[test]
fn missing_reads_create_nothing_and_overrides_partition_the_store() {
    let fixture = common::temp_repo();
    let a = fixture.join("a");
    let b = fixture.join("b");
    assert!(open_native_store_root(&a, false).unwrap().is_none());
    assert!(!a.exists());
    let e = entry(&a);
    let record = seed(&e, &source(&fixture, "fixture"), "run");
    assert!(publish_store_record(&e, &record).unwrap());
    assert!(open_native_store_root(&b, false).unwrap().is_none());
    assert!(!b.exists());
    assert_eq!(
        e.artifact_status(&record.artifact).unwrap(),
        ArtifactStatus::Verified
    );
    for path in [&a, e.path(), record.artifact.path.as_path()] {
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    assert_eq!(
        std::fs::metadata(record.artifact.path.join("binary"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(e.path().join(STORE_RECORD))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn roots_and_ancestors_reject_links_traversal_and_foreign_writes_without_repair() {
    for case in [
        "root-link",
        "ancestor-link",
        "root-mode",
        "parent-mode",
        "traversal",
    ] {
        let fixture = common::temp_repo();
        let private = fixture.join("private");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&private)
            .unwrap();
        let root = match case {
            "root-link" => {
                symlink(&private, fixture.join("link")).unwrap();
                fixture.join("link")
            }
            "ancestor-link" => {
                symlink(&private, fixture.join("link")).unwrap();
                fixture.join("link/cache")
            }
            "root-mode" => {
                std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o755)).unwrap();
                private.clone()
            }
            "parent-mode" => {
                std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o777)).unwrap();
                private.join("cache")
            }
            _ => fixture.join("private/../cache"),
        };
        assert!(open_native_store_root(&root, false).is_err(), "{case}");
        assert!(open_native_store_root(&root, true).is_err(), "{case}");
        assert!(!private.join("cache").exists());
        assert!(!fixture.join("cache").exists());
    }
}

#[test]
fn untrusted_manifest_objects_are_bounded_nonblocking_and_value_free() {
    for case in [
        "malformed",
        "oversized",
        "fifo",
        "symlink",
        "mode",
        "directory",
        "traversal",
    ] {
        let fixture = common::temp_repo();
        let e = entry(&fixture.join("store"));
        let path = e.path().join(STORE_RECORD);
        match case {
            "malformed" => record_file(&e, b"private-manifest-canary"),
            "oversized" => record_file(&e, &vec![b'x'; 65537]),
            "fifo" => {
                let path = CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            }
            "symlink" => {
                std::fs::write(fixture.join("canary"), b"private-manifest-canary").unwrap();
                symlink(fixture.join("canary"), &path).unwrap();
            }
            "directory" => std::fs::DirBuilder::new().mode(0o700).create(&path).unwrap(),
            "mode" => { record_file(&e, b"{}"); std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap(); }
            _ => record_file(&e, br#"{"path":"../escape.app","sha256":"x","kind":"app_bundle","built_at":"fixture","candidate_sha":"x"}"#),
        }
        let error = load_store_record(&e).unwrap_err();
        assert!(
            !error.contains("canary") && !error.contains(&fixture.to_string_lossy().to_string()),
            "{error}"
        );
        let src = source(&fixture, "source");
        let record = seed(&e, &src, "run");
        assert!(publish_store_record(&e, &record).is_err(), "{case}");
    }
}

#[test]
fn private_bundle_checks_reject_links_special_files_and_permissive_descendants() {
    for case in ["link", "fifo", "file-mode", "dir-mode", "intermediate-link"] {
        let fixture = common::temp_repo();
        let e = entry(&fixture.join("store"));
        let record = seed(&e, &source(&fixture, "source"), "run");
        let binary = record.artifact.path.join("binary");
        match case {
            "link" => {
                std::fs::remove_file(&binary).unwrap();
                symlink(fixture.join("secret"), &binary).unwrap();
            }
            "fifo" => {
                std::fs::remove_file(&binary).unwrap();
                let path = CString::new(binary.as_os_str().as_encoded_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            }
            "file-mode" => {
                std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o644)).unwrap()
            }
            "dir-mode" => std::fs::set_permissions(
                &record.artifact.path,
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap(),
            _ => {
                let run = e.path().join("run");
                std::fs::rename(&run, e.path().join("moved")).unwrap();
                symlink(e.path().join("moved"), &run).unwrap();
            }
        }
        assert!(e.check_artifact(&record.artifact).is_err(), "{case}");
        assert!(e.artifact_status(&record.artifact).is_err(), "{case}");
    }
}

#[test]
fn corruption_removal_and_generation_collisions_never_replace_the_winner() {
    let fixture = common::temp_repo();
    let e = entry(&fixture.join("store"));
    let src = source(&fixture, "source");
    let record = seed(&e, &src, "run");
    assert!(publish_store_record(&e, &record).unwrap());
    let bytes = std::fs::read(e.path().join(STORE_RECORD)).unwrap();
    assert!(e
        .copy_app(
            &MockRunner::new(),
            &src,
            OsStr::new("run"),
            &hash_artifact(&src).unwrap()
        )
        .is_err());
    std::fs::write(record.artifact.path.join("binary"), "changed").unwrap();
    assert!(e.check_artifact(&record.artifact).unwrap());
    assert_eq!(
        e.artifact_status(&record.artifact).unwrap(),
        ArtifactStatus::Mismatch
    );
    let other = seed(&e, &src, "other-run");
    assert!(!publish_store_record(&e, &other).unwrap());
    assert_eq!(std::fs::read(e.path().join(STORE_RECORD)).unwrap(), bytes);
    std::fs::remove_dir_all(&record.artifact.path).unwrap();
    assert!(!e.check_artifact(&record.artifact).unwrap());
    assert_eq!(
        e.artifact_status(&record.artifact).unwrap(),
        ArtifactStatus::MissingFile
    );
}

#[test]
fn anchored_handles_refuse_rebound_roots_and_entries() {
    for replace in ["root", "entry"] {
        let fixture = common::temp_repo();
        let root = fixture.join("store");
        let e = entry(&root);
        let record = seed(&e, &source(&fixture, "source"), "run");
        let original = if replace == "root" {
            root.clone()
        } else {
            e.path().into()
        };
        let moved = fixture.join("moved");
        std::fs::rename(&original, &moved).unwrap();
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&original)
            .unwrap();
        assert!(e.recheck().is_err());
        assert!(publish_store_record(&e, &record).is_err());
        assert!(!original.join(STORE_RECORD).exists());
        assert!(!moved.join(STORE_RECORD).exists());
    }
}

fn barrier(path: &Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while !path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "fixture barrier timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[test]
fn real_publisher_child() {
    let Some(fixture) = std::env::var_os("QAREN_TEST_PUBLISH_FIXTURE") else {
        return;
    };
    let fixture = PathBuf::from(fixture);
    let role = std::env::var("QAREN_TEST_PUBLISH_ROLE").unwrap();
    let e = entry(&fixture.join("store"));
    let record = seed(&e, &source(&fixture, &role), &role);
    std::fs::write(fixture.join(format!("ready-{role}")), b"").unwrap();
    barrier(&fixture.join("go"));
    let won = publish_store_record(&e, &record).unwrap();
    std::fs::write(
        fixture.join(format!("result-{role}")),
        if won { "won" } else { "lost" },
    )
    .unwrap();
}

#[test]
fn two_real_publishers_expose_only_a_complete_immutable_winner() {
    let fixture = common::temp_repo();
    let children: Vec<_> = ["a", "b"]
        .into_iter()
        .map(|role| {
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "real_publisher_child", "--nocapture"])
                .env("QAREN_TEST_PUBLISH_FIXTURE", &fixture)
                .env("QAREN_TEST_PUBLISH_ROLE", role)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for role in ["a", "b"] {
        barrier(&fixture.join(format!("ready-{role}")));
    }
    let e = entry(&fixture.join("store"));
    assert!(load_store_record(&e).unwrap().is_none());
    std::fs::write(fixture.join("go"), b"").unwrap();
    let mut seen = None;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while !fixture.join("result-a").exists() || !fixture.join("result-b").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "publication barrier timed out"
        );
        if let Some(record) = load_store_record(&e).unwrap() {
            assert_eq!(
                e.artifact_status(&record.artifact).unwrap(),
                ArtifactStatus::Verified
            );
            if let Some(previous) = &seen {
                assert_eq!(&record, previous);
            }
            seen = Some(record);
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    for child in children {
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let results: Vec<_> = ["a", "b"]
        .map(|r| std::fs::read_to_string(fixture.join(format!("result-{r}"))).unwrap())
        .into();
    assert_eq!(results.iter().filter(|r| *r == "won").count(), 1);
    let bytes = std::fs::read(e.path().join(STORE_RECORD)).unwrap();
    assert!(load_store_record(&e).unwrap().is_some());
    assert_eq!(std::fs::read(e.path().join(STORE_RECORD)).unwrap(), bytes);
}

#[test]
fn non_utf8_override_is_refused_before_cache_access() {
    let fixture = common::temp_repo();
    let path = fixture.join(OsString::from_vec(b"cache-\xff".to_vec()));
    let reason = "native cache root: path must be valid UTF-8";
    assert_eq!(
        resolve_native_cache_root(Some(path.as_os_str()), unsafe { libc::geteuid() }).unwrap_err(),
        reason
    );
    for create in [false, true] {
        assert_eq!(open_native_store_root(&path, create).err().unwrap(), reason);
        assert!(!path.exists());
    }
}

#[test]
fn non_utf8_derived_paths_are_refused_before_copy_or_publication() {
    let fixture = common::temp_repo();
    let root = fixture.join("store");
    let store = open_native_store_root(&root, true).unwrap().unwrap();
    let raw = OsString::from_vec(b"private-path-\xff".to_vec());
    let reason = "native cache root: path must be valid UTF-8";
    assert_eq!(store.entry(Path::new(&raw), true).err().unwrap(), reason);
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    let e = entry(&root);
    for (src, generation) in [
        (fixture.join("source.app"), raw.clone()),
        (
            fixture.join(OsString::from_vec(b"source-\xff.app".to_vec())),
            "run".into(),
        ),
    ] {
        assert_eq!(
            e.copy_app(&MockRunner::new(), &src, &generation, "unused")
                .err()
                .unwrap(),
            reason
        );
        assert_eq!(std::fs::read_dir(e.path()).unwrap().count(), 0);
    }
    let record = StoreRecord {
        artifact: CachedArtifact {
            path: e.path().join(raw).join("source.app"),
            sha256: "a".repeat(64),
            kind: ArtifactKind::AppBundle,
        },
        built_at: "fixture".into(),
        candidate_sha: "a".repeat(40),
    };
    assert_eq!(publish_store_record(&e, &record).unwrap_err(), reason);
    assert_eq!(std::fs::read_dir(e.path()).unwrap().count(), 0);
}

#[cfg(target_os = "macos")]
#[test]
fn darwin_acl_allow_and_inheritance_refuse_while_deny_only_remains_private() {
    for (acl, accepted) in [
        ("everyone allow read", false),
        ("everyone allow read,file_inherit,directory_inherit", false),
        ("everyone deny delete", true),
    ] {
        let fixture = common::temp_repo();
        let path = fixture.join("store");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
        let output = Command::new("/bin/chmod")
            .args(["+a", acl])
            .arg(&path)
            .output()
            .unwrap();
        assert!(output.status.success(), "fixture ACL setup failed");
        assert_eq!(open_native_store_root(&path, false).is_ok(), accepted);
        let output = Command::new("/bin/chmod")
            .arg("-N")
            .arg(&path)
            .output()
            .unwrap();
        assert!(output.status.success(), "fixture ACL cleanup failed");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn linux_present_posix_acl_is_rejected_even_with_private_mode() {
    let fixture = common::temp_repo();
    let path = fixture.join("store");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&path)
        .unwrap();
    let mut acl = 2u32.to_le_bytes().to_vec();
    for (tag, permissions, uid) in [
        (1u16, 7u16, u32::MAX),
        (2, 4, unsafe { libc::geteuid() } + 1),
        (4, 0, u32::MAX),
        (16, 0, u32::MAX),
        (32, 0, u32::MAX),
    ] {
        acl.extend(tag.to_le_bytes());
        acl.extend(permissions.to_le_bytes());
        acl.extend(uid.to_le_bytes());
    }
    let name = CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(
        unsafe {
            libc::setxattr(
                name.as_ptr(),
                c"system.posix_acl_access".as_ptr(),
                acl.as_ptr().cast(),
                acl.len(),
                0,
            )
        },
        0
    );
    assert!(open_native_store_root(&path, false).is_err());
}

#[test]
fn temporary_name_collision_child() {
    let Some(fixture) = std::env::var_os("QAREN_TEST_TEMP_COLLISION") else {
        return;
    };
    let fixture = PathBuf::from(fixture);
    let e = entry(&fixture.join("store"));
    let record = seed(&e, &source(&fixture, "source"), "run");
    let collision = e
        .path()
        .join(format!(".artifact.json.{}.1", std::process::id()));
    std::fs::write(&collision, "collision-canary").unwrap();
    assert!(publish_store_record(&e, &record).is_err());
    assert_eq!(
        std::fs::read_to_string(collision).unwrap(),
        "collision-canary"
    );
    assert!(!e.path().join(STORE_RECORD).exists());
}

#[test]
fn temporary_metadata_collision_is_never_truncated_or_deleted() {
    let fixture = common::temp_repo();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "temporary_name_collision_child", "--nocapture"])
        .env("QAREN_TEST_TEMP_COLLISION", &fixture)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
