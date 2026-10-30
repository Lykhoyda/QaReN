use qaren::buildplan::{
    claim_lock, decide, lock_dir, release_lock, ArtifactKind, ArtifactStatus, BuildDecision,
    CachedArtifact, DecisionInputs, LockHolder, LockOutcome, LockPolicy, NativeCacheState,
    ReleaseOutcome, StateStatus, StoreRecord, CACHE_SCHEMA,
};
use qaren::exec::{CmdOutput, MockRunner};
use qaren::runrecord::PidIdentity;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static NO_PARTS: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "qaren-lock-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const FP: &str = "rnfp1:aaaa";
const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn artifact() -> CachedArtifact {
    CachedArtifact {
        path: PathBuf::from("/cache/testapp.app"),
        sha256: "f".repeat(64),
        kind: ArtifactKind::AppBundle,
    }
}

fn state(worktree: &Path, fingerprint: &str) -> NativeCacheState {
    NativeCacheState {
        schema: CACHE_SCHEMA.to_string(),
        fingerprint_parts: Default::default(),
        platform: "ios".to_string(),
        app_id: "com.rndevagent.testapp".to_string(),
        worktree_root: worktree.to_path_buf(),
        fingerprint: fingerprint.to_string(),
        built_at: "2026-08-13T00:00:00Z".to_string(),
        candidate_sha: SHA_A.to_string(),
        lockfile_sha256: "c".repeat(64),
        generated_native_dirs: vec!["ios".to_string()],
        artifact: None,
    }
}

fn stored(status: ArtifactStatus) -> Option<(StoreRecord, ArtifactStatus)> {
    Some((
        StoreRecord {
            artifact: artifact(),
            built_at: "2026-08-13T00:00:00Z".to_string(),
            candidate_sha: SHA_A.to_string(),
        },
        status,
    ))
}

fn inputs<'a>(worktree: &'a Path, fingerprint: &'a str) -> DecisionInputs<'a> {
    DecisionInputs {
        platform: "ios",
        app_id: "com.rndevagent.testapp",
        worktree_root: worktree,
        candidate_sha: SHA_B,
        fingerprint,
        fingerprint_parts: &NO_PARTS,
        fingerprint_complete: true,
        incompleteness: &[],
        expo_unavailable: None,
        scheme: Some("rndatest"),
        force_clean: false,
        native_dir_exists: true,
        native_dir_in_candidate: false,
    }
}

#[test]
fn matching_fingerprint_with_verified_artifact_and_scheme_reuses() {
    let worktree = temp_dir();
    let plan = decide(
        &inputs(&worktree, FP),
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        stored(ArtifactStatus::Verified),
    );
    assert_eq!(plan.decision, BuildDecision::Reuse);
    assert!(!plan.regenerate_native_dir);
    assert!(plan.artifact.is_some());
    // The sha comparison must be visible evidence: reuse across candidates is
    // proven by the fingerprint, never inferred from the sha.
    assert!(
        plan.evidence
            .iter()
            .any(|e| e.contains(SHA_A) && e.contains(SHA_B)),
        "evidence must record the candidate sha comparison: {:?}",
        plan.evidence
    );
}

#[test]
fn a_proven_toolchain_change_cleans_derived_outputs_for_tracked_native_source() {
    for part in ["toolchain.xcode", "toolchain.swift"] {
        let worktree = temp_dir();
        let mut old = state(&worktree, FP);
        old.fingerprint_parts.insert(part.into(), "a".repeat(64));
        let current = std::collections::BTreeMap::from([(part.into(), "b".repeat(64))]);
        let mut selected = inputs(&worktree, "rnfp1:new");
        selected.native_dir_in_candidate = true;
        selected.fingerprint_parts = &current;
        let plan = decide(&selected, &StateStatus::Loaded(Box::new(old)), None);
        assert_eq!(plan.decision, BuildDecision::Clean);
        assert!(!plan.regenerate_native_dir);
        let unrecorded = decide(
            &selected,
            &StateStatus::Loaded(Box::new(state(&worktree, FP))),
            None,
        );
        assert_eq!(unrecorded.decision, BuildDecision::Incremental);
    }
}

#[test]
fn stale_artifact_content_is_never_reused() {
    let worktree = temp_dir();
    let plan = decide(
        &inputs(&worktree, FP),
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        stored(ArtifactStatus::Mismatch),
    );
    assert_eq!(plan.decision, BuildDecision::Incremental);
    assert!(
        plan.artifact.is_none(),
        "a stale binary must never be claimed"
    );
    assert!(plan.reason.contains("stale"), "{}", plan.reason);
}

#[test]
fn missing_artifact_file_downgrades_to_incremental() {
    let worktree = temp_dir();
    let plan = decide(
        &inputs(&worktree, FP),
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        stored(ArtifactStatus::MissingFile),
    );
    assert_eq!(plan.decision, BuildDecision::Incremental);
    assert!(plan.artifact.is_none());
}

#[test]
fn wrong_platform_artifact_kind_is_never_reused() {
    let worktree = temp_dir();
    let mut wrong_kind = stored(ArtifactStatus::Verified);
    wrong_kind.as_mut().unwrap().0.artifact = CachedArtifact {
        path: PathBuf::from("/cache/app.apk"),
        sha256: "f".repeat(64),
        kind: ArtifactKind::Apk,
    };
    let plan = decide(
        &inputs(&worktree, FP),
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        wrong_kind,
    );
    assert_ne!(plan.decision, BuildDecision::Reuse);
    assert!(plan.artifact.is_none());
    assert!(plan.reason.contains("kind"), "{}", plan.reason);
}

#[test]
fn missing_scheme_downgrades_matching_fingerprint_to_incremental() {
    let worktree = temp_dir();
    let mut no_scheme = inputs(&worktree, FP);
    no_scheme.scheme = None;
    let plan = decide(
        &no_scheme,
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        stored(ArtifactStatus::Verified),
    );
    assert_eq!(plan.decision, BuildDecision::Incremental);
    assert!(plan.reason.contains("dev_client_scheme"), "{}", plan.reason);
}

#[test]
fn incomplete_matching_fingerprint_regenerates_generated_native_dir() {
    let worktree = temp_dir();
    let incompleteness = vec!["app.config.ts is a dynamic config".to_string()];
    let mut incomplete = inputs(&worktree, FP);
    incomplete.fingerprint_complete = false;
    incomplete.incompleteness = &incompleteness;
    let plan = decide(
        &incomplete,
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        stored(ArtifactStatus::Verified),
    );
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(plan.regenerate_native_dir);
    assert!(plan.artifact.is_none());
    assert!(plan
        .reason
        .contains("deletes it with its installed native dependencies and build outputs"));
    assert!(!plan.reason.contains("keeping existing build caches"));
    assert!(plan.evidence.iter().any(|e| e.contains("dynamic config")));
    assert!(!plan.reason.contains("changed"), "{}", plan.reason);
    assert!(
        plan.reason.contains("matches")
            && plan.reason.contains("app.config.ts is a dynamic config")
            && plan.reason.contains("instead of reuse"),
        "{}",
        plan.reason
    );
}

#[test]
fn changed_fingerprint_with_proven_provenance_regenerates_generated_native_dir() {
    let worktree = temp_dir();
    let plan = decide(
        &inputs(&worktree, "rnfp1:changed"),
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        None,
    );
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(plan.regenerate_native_dir);
    assert!(plan.artifact.is_none());
    assert!(plan
        .reason
        .contains("deletes it with its installed native dependencies and build outputs"));
    assert!(!plan.reason.contains("keeping existing build caches"));
    assert!(
        plan.reason.starts_with("native inputs changed"),
        "{}",
        plan.reason
    );
    assert!(
        plan.evidence
            .iter()
            .any(|e| e.contains(FP) && e.contains("rnfp1:changed")),
        "old and new fingerprints must be evidence: {:?}",
        plan.evidence
    );
}

#[test]
fn native_input_changes_regenerate_only_existing_generated_dirs_on_both_platforms() {
    let worktree = temp_dir();
    for platform in ["ios", "android"] {
        for (fingerprint, complete) in [("rnfp1:changed", true), (FP, false)] {
            for (exists, in_candidate) in [(true, false), (true, true), (false, false)] {
                let mut current = inputs(&worktree, fingerprint);
                current.platform = platform;
                current.fingerprint_complete = complete;
                current.native_dir_exists = exists;
                current.native_dir_in_candidate = in_candidate;
                let mut cached = state(&worktree, FP);
                cached.platform = platform.to_string();
                cached.generated_native_dirs = vec![platform.to_string()];
                let plan = decide(&current, &StateStatus::Loaded(Box::new(cached)), None);
                let regenerate = exists && !in_candidate;
                assert_eq!(
                    plan.decision,
                    if regenerate {
                        BuildDecision::Clean
                    } else {
                        BuildDecision::Incremental
                    },
                    "{platform}: {fingerprint}, complete={complete}, exists={exists}, in_candidate={in_candidate}"
                );
                assert_eq!(plan.regenerate_native_dir, regenerate);
                assert!(plan.artifact.is_none());
            }
        }
    }
}

#[test]
fn missing_state_mandates_clean_build() {
    let worktree = temp_dir();
    let plan = decide(&inputs(&worktree, FP), &StateStatus::Missing, None);
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(
        plan.regenerate_native_dir,
        "a generated dir must be regenerated"
    );
}

#[test]
fn corrupt_state_mandates_clean_build() {
    let worktree = temp_dir();
    let plan = decide(
        &inputs(&worktree, FP),
        &StateStatus::Invalid("bad json".to_string()),
        None,
    );
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(plan.evidence.iter().any(|e| e.contains("bad json")));
}

#[test]
fn state_bound_to_another_worktree_without_a_stored_build_mandates_clean_build() {
    let worktree = temp_dir();
    let other = temp_dir();
    let plan = decide(
        &inputs(&worktree, FP),
        &StateStatus::Loaded(Box::new(state(&other, FP))),
        None,
    );
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(
        plan.reason.contains("different worktree"),
        "{}",
        plan.reason
    );
}

#[test]
fn unproven_generated_native_dir_mandates_clean_regeneration() {
    let worktree = temp_dir();
    let mut unproven_state = state(&worktree, FP);
    unproven_state.generated_native_dirs.clear();
    let plan = decide(
        &inputs(&worktree, "rnfp1:changed"),
        &StateStatus::Loaded(Box::new(unproven_state)),
        None,
    );
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(plan.regenerate_native_dir);
    assert!(plan.reason.contains("provenance"), "{}", plan.reason);
}

#[test]
fn git_visible_native_dir_is_never_regenerated() {
    let worktree = temp_dir();
    let mut tracked = inputs(&worktree, FP);
    tracked.native_dir_in_candidate = true;
    let plan = decide(&tracked, &StateStatus::Missing, None);
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(
        !plan.regenerate_native_dir,
        "a git-visible native dir is candidate input, never deleted"
    );
}

#[test]
fn scenario_forced_clean_overrides_everything() {
    let worktree = temp_dir();
    let mut forced = inputs(&worktree, FP);
    forced.force_clean = true;
    let plan = decide(
        &forced,
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        stored(ArtifactStatus::Verified),
    );
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(
        plan.reason.contains("build.strategy=clean"),
        "{}",
        plan.reason
    );
}

fn holder(name: &str, run_id: &str, identity: Option<PidIdentity>) -> LockHolder {
    LockHolder {
        holder: name.to_string(),
        run_id: run_id.to_string(),
        identity,
        at: "2026-08-13T00:00:00Z".to_string(),
        home: None,
        qaren_home: None,
        group: None,
    }
}

#[test]
fn strict_claim_refuses_even_a_dead_holder() {
    let root = temp_dir();
    let mut mock = MockRunner::new();
    let dead = PidIdentity {
        pid: 4242,
        started_at: "Wed Aug 13 10:00:00 2026".to_string(),
        command: qaren::redact::OutputText::from_output("qaren prepare"),
    };
    assert!(matches!(
        claim_lock(
            &mut mock,
            &root,
            "usb-SER",
            &holder("a", "run-a", Some(dead.clone())),
            LockPolicy::Strict
        ),
        LockOutcome::Claimed { .. }
    ));
    // The dead-holder probe still runs for the contention detail.
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    let outcome = claim_lock(
        &mut mock,
        &root,
        "usb-SER",
        &holder("b", "run-b", None),
        LockPolicy::Strict,
    );
    assert!(
        matches!(outcome, LockOutcome::Contended { .. }),
        "a device claim is never adopted, even from a dead holder: {outcome:?}"
    );
}

#[test]
fn adopt_dead_policy_takes_over_a_dead_holder_but_not_a_live_one() {
    let root = temp_dir();
    let mut mock = MockRunner::new();
    let identity = PidIdentity {
        pid: 4242,
        started_at: "Wed Aug 13 10:00:00 2026".to_string(),
        command: qaren::redact::OutputText::from_output("qaren prepare"),
    };
    assert!(matches!(
        claim_lock(
            &mut mock,
            &root,
            "native-build-ios",
            &holder("a", "run-a", Some(identity.clone())),
            LockPolicy::AdoptDead
        ),
        LockOutcome::Claimed {
            adopted_stale: false
        }
    ));
    // Live holder: contended.
    mock.expect_run("ps", CmdOutput::success("Wed Aug 13 10:00:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    assert!(matches!(
        claim_lock(
            &mut mock,
            &root,
            "native-build-ios",
            &holder("b", "run-b", None),
            LockPolicy::AdoptDead
        ),
        LockOutcome::Contended { .. }
    ));
    // Dead holder: adopted.
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    assert!(matches!(
        claim_lock(
            &mut mock,
            &root,
            "native-build-ios",
            &holder("b", "run-b", None),
            LockPolicy::AdoptDead
        ),
        LockOutcome::Claimed {
            adopted_stale: true
        }
    ));
}

#[test]
fn release_is_bound_to_holder_and_run_id() {
    let root = temp_dir();
    let mut mock = MockRunner::new();
    assert!(matches!(
        claim_lock(
            &mut mock,
            &root,
            "usb-SER",
            &holder("qaren-run-a", "run-a", None),
            LockPolicy::Strict
        ),
        LockOutcome::Claimed { .. }
    ));
    let dir = lock_dir(&root, "usb-SER");
    assert!(matches!(
        release_lock(&dir, "qaren-run-a", "run-b"),
        ReleaseOutcome::Foreign(_)
    ));
    assert!(matches!(
        release_lock(&dir, "qaren-run-b", "run-a"),
        ReleaseOutcome::Foreign(_)
    ));
    assert!(matches!(
        release_lock(&dir, "qaren-run-a", "run-a"),
        ReleaseOutcome::Removed
    ));
    assert!(matches!(
        release_lock(&dir, "qaren-run-a", "run-a"),
        ReleaseOutcome::Absent
    ));
}

#[test]
fn release_refuses_an_unreadable_holder_record() {
    let root = temp_dir();
    let dir = lock_dir(&root, "usb-SER");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("holder.json"), "not json").unwrap();
    assert!(matches!(
        release_lock(&dir, "qaren-run-a", "run-a"),
        ReleaseOutcome::Refused(_)
    ));
    assert!(dir.exists(), "an ambiguous lock must not be touched");
}

#[test]
fn incomplete_matching_fingerprint_without_a_generated_dir_names_its_cause() {
    let worktree = temp_dir();
    let incompleteness = vec!["app.config.ts is a dynamic config".to_string()];
    let mut incomplete = inputs(&worktree, FP);
    incomplete.fingerprint_complete = false;
    incomplete.incompleteness = &incompleteness;
    incomplete.native_dir_exists = false;
    let plan = decide(
        &incomplete,
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        stored(ArtifactStatus::Verified),
    );
    assert_eq!(plan.decision, BuildDecision::Incremental);
    assert!(
        plan.reason.contains("app.config.ts is a dynamic config")
            && plan.reason.contains("refusing cached reuse"),
        "{}",
        plan.reason
    );
}

fn parts(expo: &str, toolchain: &str) -> std::collections::BTreeMap<String, String> {
    [
        ("rnfp", "rnfp1:r"),
        ("expo", expo),
        ("toolchain", toolchain),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

#[test]
fn changed_composite_names_each_changed_fingerprint_part() {
    let worktree = temp_dir();
    for (current, named) in [
        (parts("expo:b", "xcode:t"), "native inputs changed: expo"),
        (
            parts("expo:a", "xcode:u"),
            "native inputs changed: toolchain",
        ),
        (
            parts("expo:b", "xcode:u"),
            "native inputs changed: expo, toolchain",
        ),
    ] {
        let mut recorded = state(&worktree, FP);
        recorded.fingerprint_parts = parts("expo:a", "xcode:t");
        let mut changed = inputs(&worktree, "rnfp1:changed");
        changed.fingerprint_parts = &current;
        let plan = decide(&changed, &StateStatus::Loaded(Box::new(recorded)), None);
        assert_ne!(plan.decision, BuildDecision::Reuse);
        assert!(
            plan.evidence.iter().any(|e| e.as_str() == named),
            "{:?}",
            plan.evidence
        );
    }
}

#[test]
fn unavailable_expo_fingerprint_names_its_cause_not_changed_inputs() {
    let worktree = temp_dir();
    let cause = "@expo/fingerprint fingerprint:generate did not complete (exit 1)";
    let incompleteness = vec![
        "app.config.ts is a dynamic config".to_string(),
        format!("Expo fingerprint unavailable: {cause}"),
    ];
    for native_dir_exists in [true, false] {
        for (rnfp, genuine) in [("rnfp1:r", false), ("rnfp1:s", true)] {
            let current =
                std::collections::BTreeMap::from([("rnfp".to_string(), rnfp.to_string())]);
            let mut recorded = state(&worktree, FP);
            recorded.fingerprint_parts = parts("expo:a", "xcode:t");
            let recorded = StateStatus::Loaded(Box::new(recorded));
            let unavailable = DecisionInputs {
                fingerprint_parts: &current,
                fingerprint_complete: false,
                incompleteness: &incompleteness,
                expo_unavailable: Some(cause),
                native_dir_exists,
                ..inputs(&worktree, rnfp)
            };
            let plan = decide(&unavailable, &recorded, None);
            let uncaused = decide(
                &DecisionInputs {
                    expo_unavailable: None,
                    ..unavailable
                },
                &recorded,
                None,
            );
            assert_eq!(
                (plan.decision, plan.regenerate_native_dir),
                (uncaused.decision, uncaused.regenerate_native_dir)
            );
            assert_eq!(
                (plan.decision, plan.regenerate_native_dir),
                if native_dir_exists {
                    (BuildDecision::Clean, true)
                } else {
                    (BuildDecision::Incremental, false)
                }
            );
            let shown = serde_json::to_string(&plan).unwrap();
            assert!(
                shown.contains(&format!("Expo fingerprint unavailable: {cause}")),
                "{shown}"
            );
            assert_eq!(shown.contains("native inputs changed"), genuine, "{shown}");
            if genuine {
                assert!(
                    plan.evidence
                        .iter()
                        .any(|e| e.as_str() == "native inputs changed: rnfp"),
                    "{:?}",
                    plan.evidence
                );
            }
        }
    }
}

#[test]
fn a_previous_cache_schema_is_invalid_and_builds_clean_once() {
    let worktree = temp_dir();
    let mut old = serde_json::to_value(state(&worktree, FP)).unwrap();
    old["schema"] = "qaren-native-cache/1".into();
    old.as_object_mut().unwrap().remove("fingerprint_parts");
    let path = qaren::buildplan::state_path(&worktree, "ios", "com.rndevagent.testapp");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, old.to_string()).unwrap();
    let loaded = qaren::buildplan::load_state(&worktree, "ios", "com.rndevagent.testapp");
    assert!(matches!(loaded, StateStatus::Invalid(_)), "{loaded:?}");
    let plan = decide(&inputs(&worktree, FP), &loaded, None);
    assert_eq!(plan.decision, BuildDecision::Clean);
}

#[test]
fn parts_missing_from_an_incomplete_recorded_build_are_unknown_not_changed() {
    let worktree = temp_dir();
    for native_dir_exists in [true, false] {
        for (recorded_rnfp, genuine) in [("rnfp1:r", false), ("rnfp1:old", true)] {
            let mut recorded = state(&worktree, "rnfp1:incomplete");
            recorded.fingerprint_parts =
                std::collections::BTreeMap::from([("rnfp".to_string(), recorded_rnfp.to_string())]);
            let recorded = StateStatus::Loaded(Box::new(recorded));
            let current = parts("expo:a", "xcode:t");
            let plan = decide(
                &DecisionInputs {
                    fingerprint_parts: &current,
                    native_dir_exists,
                    ..inputs(&worktree, FP)
                },
                &recorded,
                None,
            );
            assert_eq!(
                (plan.decision, plan.regenerate_native_dir),
                if native_dir_exists {
                    (BuildDecision::Clean, true)
                } else {
                    (BuildDecision::Incremental, false)
                }
            );
            let shown = serde_json::to_string(&plan).unwrap();
            assert!(
                !plan
                    .evidence
                    .iter()
                    .any(|e| e.as_str().starts_with("native inputs changed")
                        && (e.as_str().contains("expo") || e.as_str().contains("toolchain"))),
                "{:?}",
                plan.evidence
            );
            assert_eq!(shown.contains("native inputs changed"), genuine, "{shown}");
            if genuine {
                assert!(
                    plan.evidence
                        .iter()
                        .any(|e| e.as_str() == "native inputs changed: rnfp"),
                    "{:?}",
                    plan.evidence
                );
            }
            assert!(
                plan.evidence
                    .iter()
                    .any(|e| e.as_str() == "recorded build has no value for: expo, toolchain"),
                "{:?}",
                plan.evidence
            );
        }
    }
}

fn has(plan: &qaren::buildplan::BuildPlan, needle: &str) -> bool {
    plan.evidence.iter().any(|e| e.contains(needle))
}

#[test]
fn a_verified_stored_build_reuses_without_worktree_state() {
    let worktree = temp_dir();
    let other = temp_dir();
    for native_dir_exists in [true, false] {
        let fresh = DecisionInputs {
            native_dir_exists,
            ..inputs(&worktree, FP)
        };
        for (state, gate) in [
            (StateStatus::Missing, "no native cache state recorded"),
            (StateStatus::Invalid("bad json".into()), "bad json"),
            (
                StateStatus::Loaded(Box::new(state(&other, FP))),
                "different worktree",
            ),
        ] {
            let plan = decide(&fresh, &state, stored(ArtifactStatus::Verified));
            assert_eq!(plan.decision, BuildDecision::Reuse, "{}", plan.reason);
            assert_eq!(plan.artifact, Some(artifact()));
            assert!(!plan.regenerate_native_dir);
            assert!(has(&plan, gate), "{:?}", plan.evidence);
            assert!(
                has(&plan, "artifact from machine store /cache/testapp.app"),
                "{:?}",
                plan.evidence
            );
            assert!(
                has(&plan, SHA_A) && has(&plan, SHA_B),
                "{:?}",
                plan.evidence
            );
        }
    }
}

#[test]
fn a_stored_build_needs_verification_completeness_and_a_scheme_to_reuse() {
    let worktree = temp_dir();
    let incompleteness = vec!["app.config.ts is a dynamic config".to_string()];
    let no_scheme = DecisionInputs {
        scheme: None,
        ..inputs(&worktree, FP)
    };
    let incomplete = DecisionInputs {
        fingerprint_complete: false,
        incompleteness: &incompleteness,
        ..inputs(&worktree, FP)
    };
    for (current, status) in [
        (&inputs(&worktree, FP), ArtifactStatus::Mismatch),
        (&inputs(&worktree, FP), ArtifactStatus::MissingFile),
        (&no_scheme, ArtifactStatus::Verified),
        (&incomplete, ArtifactStatus::Verified),
    ] {
        let fresh = decide(current, &StateStatus::Missing, stored(status));
        assert_eq!(fresh.decision, BuildDecision::Clean, "{status:?}");
        assert!(fresh.artifact.is_none());
        let warm = decide(
            current,
            &StateStatus::Loaded(Box::new(state(&worktree, FP))),
            stored(status),
        );
        assert_ne!(warm.decision, BuildDecision::Reuse, "{status:?}");
        assert!(warm.artifact.is_none());
    }
    let stale = decide(
        &inputs(&worktree, FP),
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        stored(ArtifactStatus::Mismatch),
    );
    assert_eq!(stale.decision, BuildDecision::Incremental);
    assert!(stale.reason.contains("stale"), "{}", stale.reason);
}

#[test]
fn store_records_name_their_artifact_relative_to_the_entry_and_are_written_once() {
    use qaren::buildplan::{load_store_record, publish_store_record, store_dir, STORE_RECORD};
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let fixture = std::env::temp_dir().join(format!(
        "qaren-store-record-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&fixture)
        .unwrap();
    let fixture = fixture.canonicalize().unwrap();
    let root = fixture.join("store");
    let store = qaren::buildplan::open_native_store_root(&root, true)
        .unwrap()
        .unwrap();
    let dir = store_dir(&root, "ios", "com.rndevagent.testapp", FP);
    let entry = store
        .entry(dir.strip_prefix(&root).unwrap(), true)
        .unwrap()
        .unwrap();
    for path in [dir.join("run-1"), dir.join("run-1/testapp.app")] {
        std::fs::DirBuilder::new().mode(0o700).create(path).unwrap();
    }
    let mut record = stored(ArtifactStatus::Verified).unwrap().0;
    record.artifact.path = dir.join("run-1/testapp.app");
    assert!(publish_store_record(&entry, &record).unwrap());
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join(STORE_RECORD)).unwrap()).unwrap();
    assert_eq!(raw["path"], "run-1/testapp.app");
    assert_eq!(load_store_record(&entry).unwrap(), Some(record.clone()));
    let mut second = record.clone();
    second.artifact.path = dir.join("run-2/testapp.app");
    assert!(!publish_store_record(&entry, &second).unwrap());
    assert_eq!(load_store_record(&entry).unwrap(), Some(record.clone()));
    let mut outside = record.clone();
    outside.artifact.path = root.join("elsewhere.app");
    let other = store_dir(&root, "ios", "com.rndevagent.testapp", "rnfp1:bbbb");
    let other_entry = store
        .entry(other.strip_prefix(&root).unwrap(), true)
        .unwrap()
        .unwrap();
    assert!(publish_store_record(&other_entry, &outside).is_err());
    assert!(!other.join(STORE_RECORD).exists());
    for escaping in ["../escape.app", "/abs/testapp.app"] {
        let mut raw = raw.clone();
        raw["path"] = escaping.into();
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(other.join(STORE_RECORD))
            .unwrap();
        file.write_all(raw.to_string().as_bytes()).unwrap();
        assert!(load_store_record(&other_entry).is_err(), "{escaping}");
    }
}

#[test]
fn android_reuse_still_needs_this_worktrees_state() {
    let worktree = temp_dir();
    let android = DecisionInputs {
        platform: "android",
        ..inputs(&worktree, FP)
    };
    let mut apk = stored(ArtifactStatus::Verified);
    apk.as_mut().unwrap().0.artifact.kind = ArtifactKind::Apk;
    let fresh = decide(&android, &StateStatus::Missing, apk.clone());
    assert_eq!(fresh.decision, BuildDecision::Clean, "{}", fresh.reason);
    let mut recorded = state(&worktree, FP);
    recorded.platform = "android".to_string();
    let warm = decide(&android, &StateStatus::Loaded(Box::new(recorded)), apk);
    assert_eq!(warm.decision, BuildDecision::Reuse, "{}", warm.reason);
    assert!(
        has(&warm, "cached artifact /cache/testapp.app verified"),
        "{:?}",
        warm.evidence
    );
    assert!(!has(&warm, "machine store"), "{:?}", warm.evidence);
}
