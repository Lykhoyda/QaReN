// A unit test's temp folder. It is created here, private and new, and removed when its owner
// drops, which is also what happens when the test panics.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

pub(crate) struct TestDir(PathBuf);

impl TestDir {
    // Creates `<temp>/<prefix>-<pid>-<n>-<nanos>` and fails if that name exists, so the folder is
    // this owner's alone. Fill it through the returned owner.
    pub(crate) fn new(prefix: &str) -> Self {
        use std::os::unix::fs::DirBuilderExt;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "{prefix}-{}-{}-{nonce}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        TestDir(dir)
    }
}

impl std::ops::Deref for TestDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for TestDir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

// A test may have left a directory it made unreadable or read-only; removal needs it open again.
fn unlock(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if !meta.is_dir() {
        return;
    }
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            unlock(&entry.path());
        }
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        if std::fs::remove_dir_all(&self.0).is_ok() {
            return;
        }
        unlock(&self.0);
        match std::fs::remove_dir_all(&self.0) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                eprintln!("cannot remove {}: {e}", self.0.display())
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TestDir;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_new_folder_is_private_and_unique_and_is_removed_when_its_owner_drops() {
        let first = TestDir::new("qaren-test-dir");
        let second = TestDir::new("qaren-test-dir");
        assert_ne!(first.to_path_buf(), second.to_path_buf());
        let mode = std::fs::metadata(&first).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        std::fs::create_dir_all(first.join("nested")).unwrap();
        std::fs::write(first.join("nested/file"), "x").unwrap();
        let path = first.to_path_buf();
        drop(first);
        assert!(!path.exists(), "{} was left behind", path.display());
    }

    #[test]
    fn a_folder_is_removed_when_its_test_panics_even_with_a_locked_directory_inside() {
        let (seen, path) = std::sync::mpsc::channel();
        let outcome = std::thread::spawn(move || {
            let dir = TestDir::new("qaren-test-dir");
            seen.send(dir.to_path_buf()).unwrap();
            std::fs::create_dir_all(dir.join("locked")).unwrap();
            std::fs::write(dir.join("locked/file"), "x").unwrap();
            let locked = std::fs::Permissions::from_mode(0o500);
            std::fs::set_permissions(dir.join("locked"), locked).unwrap();
            panic!("the test fails while it owns the folder");
        })
        .join();
        assert!(outcome.is_err());
        let path = path.recv().unwrap();
        assert!(!path.exists(), "{} was left behind", path.display());
    }

    #[test]
    fn removal_never_follows_a_symlink_out_of_the_folder() {
        let canary = TestDir::new("qaren-test-canary");
        std::fs::create_dir_all(canary.join("inner")).unwrap();
        std::fs::write(canary.join("inner/file"), "x").unwrap();
        let locked = || std::fs::Permissions::from_mode(0o500);
        std::fs::set_permissions(canary.join("inner"), locked()).unwrap();

        let dir = TestDir::new("qaren-test-dir");
        // The symlink sits inside a locked directory: the first removal cannot reach it, so
        // `unlock` always walks past it, whatever order the filesystem lists entries in.
        std::fs::create_dir_all(dir.join("locked")).unwrap();
        std::fs::write(dir.join("locked/file"), "x").unwrap();
        std::os::unix::fs::symlink(canary.join("inner"), dir.join("locked/link")).unwrap();
        std::fs::set_permissions(dir.join("locked"), locked()).unwrap();
        let path = dir.to_path_buf();
        drop(dir);

        assert!(!path.exists(), "{} was left behind", path.display());
        let mode = std::fs::metadata(canary.join("inner")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o500, "the symlink's target was opened");
        assert!(canary.join("inner/file").exists());
    }
}
