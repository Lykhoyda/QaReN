mod common;

#[test]
fn temp_repo_is_removed_when_dropped() {
    let repo = common::temp_repo();
    let path = repo.to_path_buf();
    assert!(path.join("test-app/package.json").is_file());
    drop(repo);
    assert!(!path.exists(), "{} was left behind", path.display());
}
