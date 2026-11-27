mod common;

#[test]
fn temp_repo_is_removed_when_dropped() {
    let repo = common::temp_repo();
    let path = repo.to_path_buf();
    assert!(path.join("test-app/package.json").is_file());
    drop(repo);
    assert!(!path.exists(), "{} was left behind", path.display());
}

#[test]
fn a_new_folder_is_private_and_unique() {
    use std::os::unix::fs::PermissionsExt;
    let first = common::temp_dir("qaren-owned-test");
    let second = common::temp_dir("qaren-owned-test");
    assert_ne!(first.to_path_buf(), second.to_path_buf());
    let mode = std::fs::metadata(&first).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
}

// Runs `test` on its own thread, expects it to panic after it reported the paths it made, and
// returns those paths.
fn paths_of_a_panicking_test(
    test: impl FnOnce(std::sync::mpsc::Sender<std::path::PathBuf>) + Send + 'static,
) -> Vec<std::path::PathBuf> {
    let (seen, paths) = std::sync::mpsc::channel();
    let outcome = std::thread::spawn(move || test(seen)).join();
    assert!(outcome.is_err(), "the test body must panic");
    let paths: Vec<_> = paths.try_iter().collect();
    assert!(!paths.is_empty(), "the test body must report a path before it panics");
    paths
}

#[test]
fn a_folder_is_removed_when_its_test_panics_even_with_a_locked_directory_inside() {
    use std::os::unix::fs::PermissionsExt;
    let paths = paths_of_a_panicking_test(|seen| {
        let dir = common::temp_dir("qaren-owned-test");
        std::fs::create_dir_all(dir.join("locked")).unwrap();
        std::fs::write(dir.join("locked/file"), "x").unwrap();
        let locked = std::fs::Permissions::from_mode(0o500);
        std::fs::set_permissions(dir.join("locked"), locked).unwrap();
        seen.send(dir.to_path_buf()).unwrap();
        panic!("the test fails while it owns the folder");
    });
    for path in paths {
        assert!(!path.exists(), "{} was left behind", path.display());
    }
}

#[test]
fn a_folder_renamed_away_is_put_back_and_removed_when_its_test_panics() {
    let paths = paths_of_a_panicking_test(|seen| {
        let repo = common::temp_repo();
        let away = repo.with_extension("away");
        let _away = common::rename_away(&repo, &away);
        assert!(away.join("test-app/package.json").is_file());
        seen.send(repo.to_path_buf()).unwrap();
        seen.send(away).unwrap();
        panic!("the test fails while the folder is renamed away");
    });
    assert_eq!(paths.len(), 2);
    for path in paths {
        assert!(!path.exists(), "{} was left behind", path.display());
    }
}
