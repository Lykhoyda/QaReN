use crate::exec::Runner;
use crate::redact::OutputText;
use crate::runrecord::{probe_pid_identity, PidIdentity, PidLiveness};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

include!("lock_protocol.rs");

pub const CACHE_SCHEMA: &str = "qaren-native-cache/2";
pub const PREWARM_SCHEMA: &str = "qaren-deps-prewarm/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    AppBundle,
    Apk,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedArtifact {
    pub path: PathBuf,
    pub sha256: String,
    pub kind: ArtifactKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeCacheState {
    pub schema: String,
    pub platform: String,
    pub app_id: String,
    pub worktree_root: PathBuf,
    pub fingerprint: String,
    pub built_at: String,
    pub candidate_sha: String,
    pub lockfile_sha256: String,
    #[serde(default)]
    pub generated_native_dirs: Vec<String>,
    // Android only: its build stays in this worktree; iOS builds live in the machine store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<CachedArtifact>,
    #[serde(default)]
    pub fingerprint_parts: BTreeMap<String, String>,
}

// The machine store's record for one fingerprint; written once, never rewritten.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreRecord {
    #[serde(flatten)]
    pub artifact: CachedArtifact,
    pub built_at: String,
    pub candidate_sha: String,
}

pub const STORE_RECORD: &str = "artifact.json";

pub fn store_dir(store_root: &Path, platform: &str, app_id: &str, fingerprint: &str) -> PathBuf {
    debug_assert!(fingerprint
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == ':'));
    store_root
        .join(platform)
        .join(app_id)
        .join(fingerprint.replace(':', "-"))
}

pub fn resolve_native_cache_root(
    explicit: Option<&std::ffi::OsStr>,
    effective_uid: u32,
) -> Result<PathBuf, String> {
    use std::os::unix::ffi::OsStrExt;
    let Some(value) = explicit else {
        return Ok(PathBuf::from(format!(
            "/private/var/tmp/qaren-native-cache-{effective_uid}"
        )));
    };
    if value.to_str().is_none() {
        return Err("native cache root: path must be valid UTF-8".into());
    }
    let bytes = value.as_bytes();
    if bytes.first() != Some(&b'/')
        || bytes.contains(&0)
        || !bytes.iter().any(|b| *b != b'/')
        || bytes.split(|b| *b == b'/').any(|c| c == b"." || c == b"..")
    {
        return Err("native cache root: invalid absolute path".into());
    }
    Ok(PathBuf::from(value))
}

use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::sync::atomic::{AtomicU64, Ordering};

static STORE_NONCE: AtomicU64 = AtomicU64::new(0);
const ROOT_UNSAFE: &str = "native cache root: unsafe or uninspectable directory";
const ENTRY_UNSAFE: &str = "native cache entry: unsafe or uninspectable object";
const RECORD_INVALID: &str = "native cache entry: invalid record";
const TREE_LIMIT: usize = 100_000;

pub struct NativeStoreRoot {
    dir: StoreDirectory,
}

pub struct NativeStoreEntry {
    root: StoreDirectory,
    dir: StoreDirectory,
    relative: PathBuf,
}

struct StoreDirectory {
    file: File,
    path: PathBuf,
}

fn store_name(value: &OsStr) -> Result<CString, String> {
    if value.is_empty() || value.as_bytes().contains(&b'/') || value == "." || value == ".." {
        return Err(ENTRY_UNSAFE.into());
    }
    CString::new(value.as_bytes()).map_err(|_| ENTRY_UNSAFE.into())
}

fn descriptor_stat(file: &File) -> Result<libc::stat, String> {
    let mut stat = std::mem::MaybeUninit::uninit();
    if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(ENTRY_UNSAFE.into());
    }
    Ok(unsafe { stat.assume_init() })
}

fn checked_object(file: &File, directory: bool, private: bool) -> Result<libc::stat, String> {
    let stat = descriptor_stat(file)?;
    let uid = unsafe { libc::geteuid() };
    let mode = stat.st_mode as u32;
    let expected = if directory {
        libc::S_IFDIR
    } else {
        libc::S_IFREG
    } as u32;
    if mode & libc::S_IFMT as u32 != expected
        || (stat.st_uid != uid && (private || stat.st_uid != 0))
        || mode & 0o6000 != 0
        || (private && (mode & 0o077 != 0 || mode & 0o1000 != 0))
        || (private && directory && mode & 0o777 != 0o700)
        || (private && !directory && mode & 0o400 == 0)
        || (!private && mode & 0o022 != 0 && !(stat.st_uid == 0 && mode & 0o1000 != 0))
    {
        return Err(ENTRY_UNSAFE.into());
    }
    check_store_acl(file, directory)?;
    Ok(stat)
}

#[cfg(target_os = "macos")]
fn check_store_acl(file: &File, _directory: bool) -> Result<(), String> {
    use libc::{c_int, c_void};
    unsafe extern "C" {
        fn acl_get_fd_np(fd: c_int, acl_type: c_int) -> *mut c_void;
        fn acl_valid(acl: *mut c_void) -> c_int;
        fn acl_get_entry(acl: *mut c_void, entry_id: c_int, entry: *mut *mut c_void) -> c_int;
        fn acl_get_tag_type(entry: *mut c_void, tag: *mut c_int) -> c_int;
        fn acl_free(object: *mut c_void) -> c_int;
    }
    struct Acl(*mut c_void);
    impl Drop for Acl {
        fn drop(&mut self) {
            unsafe {
                acl_free(self.0);
            }
        }
    }
    let raw = unsafe { acl_get_fd_np(file.as_raw_fd(), 0x100) };
    if raw.is_null() {
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            Ok(())
        } else {
            Err(ENTRY_UNSAFE.into())
        };
    }
    let acl = Acl(raw);
    if unsafe { acl_valid(acl.0) } != 0 {
        return Err(ENTRY_UNSAFE.into());
    }
    for index in 0..=128 {
        let mut entry = std::ptr::null_mut();
        let result = unsafe { acl_get_entry(acl.0, if index == 0 { 0 } else { -1 }, &mut entry) };
        if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
            return Ok(());
        }
        let mut tag = 0;
        if result != 0
            || index == 128
            || entry.is_null()
            || unsafe { acl_get_tag_type(entry, &mut tag) } != 0
            || tag != 2
        {
            return Err(ENTRY_UNSAFE.into());
        }
    }
    Err(ENTRY_UNSAFE.into())
}

#[cfg(target_os = "linux")]
fn check_store_acl(file: &File, directory: bool) -> Result<(), String> {
    for name in [c"system.posix_acl_access", c"system.posix_acl_default"] {
        if !directory && name == c"system.posix_acl_default" {
            continue;
        }
        let result =
            unsafe { libc::fgetxattr(file.as_raw_fd(), name.as_ptr(), std::ptr::null_mut(), 0) };
        if result != -1 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ENODATA) {
            return Err(ENTRY_UNSAFE.into());
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn check_store_acl(_file: &File, _directory: bool) -> Result<(), String> {
    Err(ENTRY_UNSAFE.into())
}

fn store_mutation_allowed() -> Result<(), String> {
    let uid = unsafe { libc::geteuid() };
    if uid == 0 || uid != unsafe { libc::getuid() } {
        Err("native cache root: privileged mutation unsupported".into())
    } else {
        Ok(())
    }
}

impl StoreDirectory {
    fn duplicate(&self) -> Result<Self, String> {
        Ok(Self {
            file: self.file.try_clone().map_err(|_| ENTRY_UNSAFE)?,
            path: self.path.clone(),
        })
    }

    fn child(&self, name: &OsStr, create: bool, private: bool) -> Result<Option<Self>, String> {
        let name_c = store_name(name)?;
        let open = || unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name_c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        let mut fd = open();
        if fd < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            if !create {
                return Ok(None);
            }
            store_mutation_allowed()?;
            if unsafe { libc::mkdirat(self.file.as_raw_fd(), name_c.as_ptr(), 0o700) } != 0
                && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
            {
                return Err(ENTRY_UNSAFE.into());
            }
            fd = open();
        }
        if fd < 0 {
            return Err(ENTRY_UNSAFE.into());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        checked_object(&file, true, private)?;
        Ok(Some(Self {
            file,
            path: self.path.join(name),
        }))
    }

    fn create_child(&self, name: &OsStr) -> Result<Self, String> {
        store_mutation_allowed()?;
        let name_c = store_name(name)?;
        if unsafe { libc::mkdirat(self.file.as_raw_fd(), name_c.as_ptr(), 0o700) } != 0 {
            return Err(ENTRY_UNSAFE.into());
        }
        self.child(name, false, true)?
            .ok_or_else(|| ENTRY_UNSAFE.into())
    }

    fn open_file(&self, name: &OsStr, create: Option<u32>) -> Result<Option<File>, String> {
        let name = store_name(name)?;
        let flags = libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        let fd = if let Some(mode) = create {
            store_mutation_allowed()?;
            unsafe {
                libc::openat(
                    self.file.as_raw_fd(),
                    name.as_ptr(),
                    flags | libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                    mode as libc::c_uint,
                )
            }
        } else {
            unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), flags | libc::O_RDONLY) }
        };
        if fd < 0 {
            return if create.is_none()
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT)
            {
                Ok(None)
            } else {
                Err(ENTRY_UNSAFE.into())
            };
        }
        let file = unsafe { File::from_raw_fd(fd) };
        checked_object(&file, false, true)?;
        Ok(Some(file))
    }

    fn names(&self) -> Result<Vec<OsString>, String> {
        struct Listing(*mut libc::DIR);
        impl Drop for Listing {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(ENTRY_UNSAFE.into());
        }
        let raw = unsafe { libc::fdopendir(fd) };
        if raw.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err(ENTRY_UNSAFE.into());
        }
        let listing = Listing(raw);
        let mut names = Vec::new();
        loop {
            #[cfg(target_os = "macos")]
            unsafe {
                *libc::__error() = 0;
            }
            #[cfg(target_os = "linux")]
            unsafe {
                *libc::__errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(listing.0) };
            if entry.is_null() {
                if std::io::Error::last_os_error().raw_os_error() != Some(0) {
                    return Err(ENTRY_UNSAFE.into());
                }
                break;
            }
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            names.push(OsString::from_vec(bytes.to_vec()));
            if names.len() > TREE_LIMIT {
                return Err(ENTRY_UNSAFE.into());
            }
        }
        names.sort();
        Ok(names)
    }

    fn unlink(&self, name: &OsStr, directory: bool) -> Result<(), String> {
        let name = store_name(name)?;
        if unsafe {
            libc::unlinkat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                if directory { libc::AT_REMOVEDIR } else { 0 },
            )
        } != 0
        {
            return Err(ENTRY_UNSAFE.into());
        }
        Ok(())
    }

    fn remove_owned_child(&self, name: &OsStr) -> Result<(), String> {
        let child = self.child(name, false, true)?.ok_or(ENTRY_UNSAFE)?;
        for name in child.names()? {
            if child.child(&name, false, true).is_ok_and(|d| d.is_some()) {
                child.remove_owned_child(&name)?;
            } else {
                child.open_file(&name, None)?.ok_or(ENTRY_UNSAFE)?;
                child.unlink(&name, false)?;
            }
        }
        self.unlink(name, true)
    }
}

pub fn open_native_store_root(
    path: &Path,
    create: bool,
) -> Result<Option<NativeStoreRoot>, String> {
    resolve_native_cache_root(Some(path.as_os_str()), unsafe { libc::geteuid() })?;
    if create {
        store_mutation_allowed()?;
    }
    let file = File::open("/").map_err(|_| ROOT_UNSAFE)?;
    checked_object(&file, true, false).map_err(|_| ROOT_UNSAFE)?;
    let mut dir = StoreDirectory {
        file,
        path: PathBuf::from("/"),
    };
    let parts: Vec<_> = path
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(n) => Some(n),
            _ => None,
        })
        .collect();
    let mut sticky_parent = false;
    for (index, name) in parts.iter().enumerate() {
        let private = sticky_parent || index == parts.len() - 1;
        let Some(next) = dir.child(name, create, private).map_err(|_| ROOT_UNSAFE)? else {
            return Ok(None);
        };
        let stat = descriptor_stat(&next.file).map_err(|_| ROOT_UNSAFE)?;
        sticky_parent = stat.st_mode as u32 & 0o1000 != 0;
        dir = next;
    }
    Ok(Some(NativeStoreRoot { dir }))
}

impl NativeStoreRoot {
    pub fn entry(&self, relative: &Path, create: bool) -> Result<Option<NativeStoreEntry>, String> {
        resolve_native_cache_root(Some(self.dir.path.join(relative).as_os_str()), unsafe {
            libc::geteuid()
        })?;
        if relative.as_os_str().is_empty()
            || !relative
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            return Err(ENTRY_UNSAFE.into());
        }
        let mut dir = self.dir.duplicate()?;
        for name in relative.iter() {
            let Some(child) = dir.child(name, create, true)? else {
                return Ok(None);
            };
            dir = child;
        }
        Ok(Some(NativeStoreEntry {
            root: self.dir.duplicate()?,
            dir,
            relative: relative.into(),
        }))
    }
}

impl NativeStoreEntry {
    pub fn path(&self) -> &Path {
        &self.dir.path
    }

    pub fn recheck(&self) -> Result<(), String> {
        let root = open_native_store_root(&self.root.path, false)?.ok_or(ENTRY_UNSAFE)?;
        let entry = root.entry(&self.relative, false)?.ok_or(ENTRY_UNSAFE)?;
        for (a, b) in [
            (&self.root.file, &root.dir.file),
            (&self.dir.file, &entry.dir.file),
        ] {
            let a = descriptor_stat(a)?;
            let b = descriptor_stat(b)?;
            if a.st_dev != b.st_dev || a.st_ino != b.st_ino {
                return Err(ENTRY_UNSAFE.into());
            }
        }
        Ok(())
    }

    pub fn artifact_status(&self, artifact: &CachedArtifact) -> Result<ArtifactStatus, String> {
        if !self.check_artifact(artifact)? {
            return Ok(ArtifactStatus::MissingFile);
        }
        match hash_artifact(&artifact.path) {
            Ok(hash) if hash == artifact.sha256 => Ok(ArtifactStatus::Verified),
            Ok(_) => Ok(ArtifactStatus::Mismatch),
            Err(_) => Ok(ArtifactStatus::Mismatch),
        }
    }

    pub fn check_artifact(&self, artifact: &CachedArtifact) -> Result<bool, String> {
        self.recheck()?;
        let relative = artifact
            .path
            .strip_prefix(self.path())
            .map_err(|_| ENTRY_UNSAFE)?;
        if relative.extension() != Some(OsStr::new("app"))
            || !relative
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            return Err(ENTRY_UNSAFE.into());
        }
        let mut dir = self.dir.duplicate()?;
        for name in relative.iter() {
            let Some(child) = dir.child(name, false, true)? else {
                return Ok(false);
            };
            dir = child;
        }
        validate_private_tree(&dir, 0, &mut { TREE_LIMIT })?;
        self.recheck()?;
        Ok(true)
    }
}

fn validate_private_tree(
    dir: &StoreDirectory,
    depth: usize,
    remaining: &mut usize,
) -> Result<(), String> {
    if depth > 128 {
        return Err(ENTRY_UNSAFE.into());
    }
    for name in dir.names()? {
        *remaining = remaining.checked_sub(1).ok_or(ENTRY_UNSAFE)?;
        if let Ok(Some(child)) = dir.child(&name, false, true) {
            validate_private_tree(&child, depth + 1, remaining)?;
        } else {
            dir.open_file(&name, None)?.ok_or(ENTRY_UNSAFE)?;
        }
    }
    Ok(())
}

pub fn load_store_record(entry: &NativeStoreEntry) -> Result<Option<StoreRecord>, String> {
    entry.recheck()?;
    let Some(file) = entry.dir.open_file(OsStr::new(STORE_RECORD), None)? else {
        return Ok(None);
    };
    let stat = descriptor_stat(&file)?;
    if stat.st_size < 0 || stat.st_size > 65536 || stat.st_mode as u32 & 0o777 != 0o600 {
        return Err(RECORD_INVALID.into());
    }
    let mut raw = Vec::new();
    file.take(65537)
        .read_to_end(&mut raw)
        .map_err(|_| RECORD_INVALID)?;
    if raw.len() > 65536 {
        return Err(RECORD_INVALID.into());
    }
    let mut record: StoreRecord = serde_json::from_slice(&raw).map_err(|_| RECORD_INVALID)?;
    let relative = &record.artifact.path;
    if relative.as_os_str().is_empty()
        || !relative
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        return Err(RECORD_INVALID.into());
    }
    record.artifact.path = entry.path().join(relative);
    Ok(Some(record))
}

pub fn publish_store_record(
    entry: &NativeStoreEntry,
    record: &StoreRecord,
) -> Result<bool, String> {
    resolve_native_cache_root(Some(record.artifact.path.as_os_str()), unsafe {
        libc::geteuid()
    })?;
    store_mutation_allowed()?;
    entry.recheck()?;
    if let Some(existing) = load_store_record(entry)? {
        entry.check_artifact(&existing.artifact)?;
        return Ok(false);
    }
    let mut on_disk = record.clone();
    let relative = record
        .artifact
        .path
        .strip_prefix(entry.path())
        .map_err(|_| ENTRY_UNSAFE)?;
    if relative.as_os_str().is_empty()
        || !relative
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        return Err(ENTRY_UNSAFE.into());
    }
    on_disk.artifact.path = relative.into();
    let tmp = OsString::from(format!(
        ".{STORE_RECORD}.{}.{}",
        std::process::id(),
        STORE_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    let body = serde_json::to_vec_pretty(&on_disk).map_err(|_| RECORD_INVALID)?;
    if body.len() > 65536 {
        return Err(RECORD_INVALID.into());
    }
    let mut file = entry
        .dir
        .open_file(&tmp, Some(0o600))?
        .ok_or(ENTRY_UNSAFE)?;
    let result = (|| {
        file.write_all(&body).map_err(|_| ENTRY_UNSAFE)?;
        let from = store_name(&tmp)?;
        let linked = unsafe {
            libc::linkat(
                entry.dir.file.as_raw_fd(),
                from.as_ptr(),
                entry.dir.file.as_raw_fd(),
                c"artifact.json".as_ptr(),
                0,
            )
        };
        if linked == 0 {
            return Ok(true);
        }
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
            let winner = load_store_record(entry)?.ok_or(ENTRY_UNSAFE)?;
            entry.check_artifact(&winner.artifact)?;
            return Ok(false);
        }
        Err(ENTRY_UNSAFE.into())
    })();
    let _ = entry.dir.unlink(&tmp, false);
    result
}

pub struct NativeStoreCopy {
    entry: NativeStoreEntry,
    staging: OsString,
    generation: OsString,
    committed: bool,
    pub artifact: CachedArtifact,
}

impl NativeStoreEntry {
    pub fn copy_app(
        &self,
        runner: &dyn Runner,
        src: &Path,
        generation: &OsStr,
        expected: &str,
    ) -> Result<NativeStoreCopy, String> {
        store_name(generation)?;
        let name = src
            .file_name()
            .filter(|_| src.extension() == Some(OsStr::new("app")))
            .ok_or(ENTRY_UNSAFE)?;
        let artifact_path = resolve_native_cache_root(
            Some(self.path().join(generation).join(name).as_os_str()),
            unsafe { libc::geteuid() },
        )?;
        self.recheck()?;
        let staging = OsString::from(format!(
            ".staging-{}-{}",
            std::process::id(),
            STORE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let stage = self.dir.create_child(&staging)?;
        let mut copy = NativeStoreCopy {
            entry: NativeStoreEntry {
                root: self.root.duplicate()?,
                dir: self.dir.duplicate()?,
                relative: self.relative.clone(),
            },
            staging,
            generation: generation.into(),
            committed: false,
            artifact: CachedArtifact {
                path: artifact_path,
                sha256: expected.into(),
                kind: ArtifactKind::AppBundle,
            },
        };
        let dest = stage.create_child(name)?;
        let src_name = CString::new(src.as_os_str().as_bytes()).map_err(|_| ENTRY_UNSAFE)?;
        let fd = unsafe {
            libc::open(
                src_name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(ENTRY_UNSAFE.into());
        }
        let source = StoreDirectory {
            file: unsafe { File::from_raw_fd(fd) },
            path: src.into(),
        };
        copy_app_tree(runner, &source, &dest, 0, &mut { TREE_LIMIT })?;
        validate_private_tree(&dest, 0, &mut { TREE_LIMIT })?;
        if hash_artifact(&dest.path).map_err(|_| ENTRY_UNSAFE)? != expected {
            return Err("native cache entry: copy hash mismatch".into());
        }
        crate::cancel::ensure_running(runner, "native_cache").map_err(|e| e.detail.to_string())?;
        let final_dir = self.dir.create_child(generation)?;
        copy.committed = true;
        let name_c = store_name(name)?;
        if unsafe {
            libc::renameat(
                stage.file.as_raw_fd(),
                name_c.as_ptr(),
                final_dir.file.as_raw_fd(),
                name_c.as_ptr(),
            )
        } != 0
        {
            return Err(ENTRY_UNSAFE.into());
        }
        Ok(copy)
    }
}

impl NativeStoreCopy {
    pub fn retain(mut self) -> CachedArtifact {
        let artifact = self.artifact.clone();
        self.committed = false;
        artifact
    }
}

impl Drop for NativeStoreCopy {
    fn drop(&mut self) {
        let _ = self.entry.dir.remove_owned_child(&self.staging);
        if self.committed {
            let _ = self.entry.dir.remove_owned_child(&self.generation);
        }
    }
}

fn copy_app_tree(
    runner: &dyn Runner,
    source: &StoreDirectory,
    dest: &StoreDirectory,
    depth: usize,
    remaining: &mut usize,
) -> Result<(), String> {
    if depth > 128 {
        return Err(ENTRY_UNSAFE.into());
    }
    for name in source.names()? {
        *remaining = remaining.checked_sub(1).ok_or(ENTRY_UNSAFE)?;
        crate::cancel::ensure_running(runner, "native_cache").map_err(|e| e.detail.to_string())?;
        let name_c = store_name(&name)?;
        let fd = unsafe {
            libc::openat(
                source.file.as_raw_fd(),
                name_c.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(ENTRY_UNSAFE.into());
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        let stat = descriptor_stat(&file)?;
        match stat.st_mode & libc::S_IFMT {
            libc::S_IFDIR => {
                let child = dest.create_child(&name)?;
                copy_app_tree(
                    runner,
                    &StoreDirectory {
                        file,
                        path: source.path.join(&name),
                    },
                    &child,
                    depth + 1,
                    remaining,
                )?;
            }
            libc::S_IFREG => {
                let mut target = dest
                    .open_file(&name, Some(0o600 | (stat.st_mode as u32 & 0o100)))?
                    .ok_or(ENTRY_UNSAFE)?;
                let mut buffer = [0; 65536];
                loop {
                    crate::cancel::ensure_running(runner, "native_cache")
                        .map_err(|e| e.detail.to_string())?;
                    let count = file.read(&mut buffer).map_err(|_| ENTRY_UNSAFE)?;
                    if count == 0 {
                        break;
                    }
                    target
                        .write_all(&buffer[..count])
                        .map_err(|_| ENTRY_UNSAFE)?;
                }
            }
            _ => return Err(ENTRY_UNSAFE.into()),
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepsPrewarm {
    pub schema: String,
    pub worktree_root: PathBuf,
    pub project_root: PathBuf,
    pub lockfile_sha256: String,
    pub at: String,
}

pub fn cache_dir(worktree_root: &Path) -> PathBuf {
    worktree_root.join(".qaren").join("native-cache")
}

pub fn state_path(worktree_root: &Path, platform: &str, app_id: &str) -> PathBuf {
    // Both components are grammar-validated upstream (platform from the enum,
    // app_id as dot-separated [A-Za-z0-9_-] segments), so neither can carry a
    // path separator or `..`.
    debug_assert!(platform.chars().all(|c| c.is_ascii_lowercase()));
    debug_assert!(!app_id.contains('/') && !app_id.contains(".."));
    cache_dir(worktree_root).join(format!("{platform}-{app_id}.json"))
}

pub fn prewarm_path(worktree_root: &Path) -> PathBuf {
    cache_dir(worktree_root).join("deps-prewarm.json")
}

#[derive(Debug, Clone)]
pub enum StateStatus {
    Missing,
    Invalid(String),
    Loaded(Box<NativeCacheState>),
}

pub fn load_state(worktree_root: &Path, platform: &str, app_id: &str) -> StateStatus {
    let path = state_path(worktree_root, platform, app_id);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return StateStatus::Missing,
        Err(e) => return StateStatus::Invalid(format!("cannot read {}: {e}", path.display())),
    };
    match serde_json::from_str::<NativeCacheState>(&raw) {
        Ok(state) if state.schema == CACHE_SCHEMA => StateStatus::Loaded(Box::new(state)),
        Ok(state) => StateStatus::Invalid(format!(
            "{} carries schema {:?}, expected {CACHE_SCHEMA}",
            path.display(),
            state.schema
        )),
        Err(e) => StateStatus::Invalid(format!("{} does not parse: {e}", path.display())),
    }
}

pub fn save_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NONCE: AtomicU64 = AtomicU64::new(0);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    let body = serde_json::to_string_pretty(value)
        .map_err(|e| std::io::Error::other(format!("serialize: {e}")))?;
    let saved = std::fs::write(&tmp, body).and_then(|()| std::fs::rename(&tmp, path));
    if saved.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    saved
}

pub fn load_prewarm(worktree_root: &Path) -> Option<DepsPrewarm> {
    let raw = std::fs::read_to_string(prewarm_path(worktree_root)).ok()?;
    let record: DepsPrewarm = serde_json::from_str(&raw).ok()?;
    (record.schema == PREWARM_SCHEMA && record.worktree_root == worktree_root).then_some(record)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildDecision {
    Reuse,
    Incremental,
    Clean,
}

impl BuildDecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            BuildDecision::Reuse => "reuse",
            BuildDecision::Incremental => "incremental",
            BuildDecision::Clean => "clean",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildPlan {
    pub decision: BuildDecision,
    pub fingerprint: String,
    pub reason: OutputText,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<OutputText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<CachedArtifact>,
    // Clean over a generated (git-ignored) native dir must regenerate it via
    // `expo prebuild --clean`; a git-visible native dir is candidate input and
    // is never deleted.
    #[serde(default)]
    pub regenerate_native_dir: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactStatus {
    Verified,
    Mismatch,
    MissingFile,
}

pub struct DecisionInputs<'a> {
    pub platform: &'a str,
    pub app_id: &'a str,
    pub worktree_root: &'a Path,
    pub candidate_sha: &'a str,
    pub fingerprint: &'a str,
    pub fingerprint_parts: &'a BTreeMap<String, String>,
    pub fingerprint_complete: bool,
    pub incompleteness: &'a [String],
    pub expo_unavailable: Option<&'a str>,
    pub scheme: Option<&'a str>,
    pub force_clean: bool,
    pub native_dir_exists: bool,
    pub native_dir_in_candidate: bool,
}

fn sha_evidence(built: &str, current: &str) -> String {
    if built == current {
        format!("recorded build and current candidate are the same sha {current}")
    } else {
        format!(
            "recorded build was of candidate {built}; current candidate {current} serves fresh JS via Metro, native compatibility proven by fingerprint, never by sha"
        )
    }
}

pub fn decide(
    inputs: &DecisionInputs,
    state: &StateStatus,
    store: Option<(StoreRecord, ArtifactStatus)>,
) -> BuildPlan {
    let regenerate = inputs.native_dir_exists && !inputs.native_dir_in_candidate;
    let clean = |reason: String, evidence: Vec<String>| BuildPlan {
        decision: BuildDecision::Clean,
        fingerprint: inputs.fingerprint.to_string(),
        reason: OutputText::from_output(&reason),
        evidence: evidence
            .iter()
            .map(|text| OutputText::from_output(text))
            .collect(),
        artifact: None,
        regenerate_native_dir: regenerate,
    };
    if inputs.force_clean {
        return clean(
            "scenario build.strategy=clean mandates a clean native build".to_string(),
            Vec::new(),
        );
    }
    let kind_ok = |a: &CachedArtifact| {
        matches!(
            (inputs.platform, a.kind),
            ("ios", ArtifactKind::AppBundle) | ("android", ArtifactKind::Apk)
        )
    };
    // A verified iOS build of this exact fingerprint needs nothing from this worktree's state.
    if let (Some((record, ArtifactStatus::Verified)), true, Some(scheme), "ios") = (
        &store,
        inputs.fingerprint_complete,
        inputs.scheme,
        inputs.platform,
    ) {
        if kind_ok(&record.artifact) {
            let mut evidence = match state {
                StateStatus::Missing => {
                    vec!["no native cache state recorded for this worktree/app".to_string()]
                }
                StateStatus::Invalid(reason) => {
                    vec![format!(
                        "native cache state is unreadable or invalid: {reason}"
                    )]
                }
                StateStatus::Loaded(state) if state.worktree_root != inputs.worktree_root => {
                    vec![format!(
                        "native cache state is bound to a different worktree: recorded {}, current {}",
                        state.worktree_root.display(),
                        inputs.worktree_root.display()
                    )]
                }
                StateStatus::Loaded(_) => Vec::new(),
            };
            evidence.extend([
                format!(
                    "native fingerprint {} matches the stored build",
                    inputs.fingerprint
                ),
                sha_evidence(&record.candidate_sha, inputs.candidate_sha),
                format!(
                    "artifact from machine store {} verified against recorded sha256 {}",
                    record.artifact.path.display(),
                    record.artifact.sha256
                ),
                format!("dev client launch scheme {scheme:?} is configured"),
            ]);
            return BuildPlan {
                decision: BuildDecision::Reuse,
                fingerprint: inputs.fingerprint.to_string(),
                reason: OutputText::from_output("native inputs are unchanged and the cached dev client is content-verified; reusing it with fresh candidate JS via Metro"),
                evidence: evidence
                    .iter()
                    .map(|text| OutputText::from_output(text))
                    .collect(),
                artifact: Some(record.artifact.clone()),
                regenerate_native_dir: false,
            };
        }
    }
    let state =
        match state {
            StateStatus::Missing => return clean(
                "no native cache state recorded for this worktree/app; compatibility is unprovable"
                    .to_string(),
                Vec::new(),
            ),
            StateStatus::Invalid(reason) => {
                return clean(
                    "native cache state is unreadable or invalid; compatibility is unprovable"
                        .to_string(),
                    vec![reason.clone()],
                )
            }
            StateStatus::Loaded(state) => state,
        };
    if state.worktree_root != inputs.worktree_root {
        return clean(
            "native cache state is bound to a different worktree; refusing cross-worktree reuse"
                .to_string(),
            vec![format!(
                "recorded worktree {}, current {}",
                state.worktree_root.display(),
                inputs.worktree_root.display()
            )],
        );
    }
    if state.platform != inputs.platform || state.app_id != inputs.app_id {
        return clean(
            "native cache state is bound to a different platform/app".to_string(),
            vec![format!(
                "recorded {}/{}, current {}/{}",
                state.platform, state.app_id, inputs.platform, inputs.app_id
            )],
        );
    }
    // Parts this run could not compute, or the recorded build did not record, are unknown, not changed.
    let changed: Vec<&str> = state
        .fingerprint_parts
        .keys()
        .chain(inputs.fingerprint_parts.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|part| {
            state.fingerprint_parts.get(*part) != inputs.fingerprint_parts.get(*part)
                && state.fingerprint_parts.contains_key(*part)
                && (inputs.expo_unavailable.is_none()
                    || inputs.fingerprint_parts.contains_key(*part))
        })
        .map(String::as_str)
        .collect();
    let unrecorded: Vec<&str> = inputs
        .fingerprint_parts
        .keys()
        .filter(|part| !state.fingerprint_parts.contains_key(*part))
        .map(String::as_str)
        .collect();
    let uncomparable = match inputs.expo_unavailable {
        _ if !changed.is_empty() => None,
        Some(cause) => Some(format!(
            "Expo fingerprint unavailable: {cause}; the native fingerprint cannot be compared with the recorded build"
        )),
        None if !unrecorded.is_empty() => Some(format!(
            "the recorded build has no value for {}; the native fingerprint cannot be compared with it",
            unrecorded.join(", ")
        )),
        None => None,
    };
    // A generated native dir that qaren's own builds did not create carries
    // caches of unprovable origin; only a clean regeneration is trustworthy.
    let platform_dir_proven = !inputs.native_dir_exists
        || inputs.native_dir_in_candidate
        || state
            .generated_native_dirs
            .iter()
            .any(|d| d == inputs.platform);
    let incremental = |reason: String, mut evidence: Vec<String>| {
        if !platform_dir_proven {
            evidence.push(format!(
                "the generated {}/ dir was not created by a recorded qaren build",
                inputs.platform
            ));
            return clean(
                "existing generated native dir has no recorded qaren provenance; requiring a clean regeneration"
                    .to_string(),
                evidence,
            );
        }
        if regenerate && state.fingerprint != inputs.fingerprint {
            return clean(
                format!(
                    "{}; regenerating the generated native dir via expo prebuild --clean, which deletes it with its installed native dependencies and build outputs",
                    uncomparable.as_deref().unwrap_or("native inputs changed")
                ),
                evidence,
            );
        }
        if regenerate && !inputs.fingerprint_complete {
            return clean(
                format!(
                    "native fingerprint matches, but {}; regenerating the generated native dir via expo prebuild --clean instead of reuse, which deletes it with its installed native dependencies and build outputs",
                    inputs
                        .incompleteness
                        .first()
                        .map(String::as_str)
                        .unwrap_or("its input set is unprovably complete")
                ),
                evidence,
            );
        }
        BuildPlan {
            decision: BuildDecision::Incremental,
            fingerprint: inputs.fingerprint.to_string(),
            reason: OutputText::from_output(&reason),
            evidence: evidence
                .iter()
                .map(|text| OutputText::from_output(text))
                .collect(),
            artifact: None,
            regenerate_native_dir: false,
        }
    };
    // The candidate SHA binds evidence; the fingerprint proves native
    // compatibility. A SHA delta with an identical fingerprint is the
    // JS-only-change case reuse exists for — the comparison is always recorded.
    let sha_evidence = sha_evidence(&state.candidate_sha, inputs.candidate_sha);
    if state.fingerprint == inputs.fingerprint {
        let match_evidence = format!(
            "native fingerprint {} matches the recorded build",
            state.fingerprint
        );
        if !inputs.fingerprint_complete {
            let mut evidence = vec![match_evidence, sha_evidence];
            evidence.extend(inputs.incompleteness.iter().cloned());
            return incremental(
                format!(
                    "native fingerprint matches, but {}; refusing cached reuse",
                    inputs
                        .incompleteness
                        .first()
                        .map(String::as_str)
                        .unwrap_or("its input set is unprovably complete")
                ),
                evidence,
            );
        }
        // A cached artifact of the wrong kind for the platform indicates a
        // corrupt cache state; it can never authorize reuse.
        if store.as_ref().is_some_and(|(r, _)| !kind_ok(&r.artifact)) {
            return incremental(
                "cached artifact kind does not match the platform; refusing it and using a keyed incremental build"
                    .to_string(),
                vec![match_evidence, sha_evidence],
            );
        }
        match store {
            Some((record, ArtifactStatus::Verified)) => match inputs.scheme {
                Some(scheme) => BuildPlan {
                    decision: BuildDecision::Reuse,
                    fingerprint: inputs.fingerprint.to_string(),
                    reason: OutputText::from_output("native inputs are unchanged and the cached dev client is content-verified; reusing it with fresh candidate JS via Metro"),
                    evidence: [
                        match_evidence,
                        sha_evidence,
                        format!(
                            "cached artifact {} verified against recorded sha256 {}",
                            record.artifact.path.display(),
                            record.artifact.sha256
                        ),
                        format!("dev client launch scheme {scheme:?} is configured"),
                    ]
                    .iter()
                    .map(|text| OutputText::from_output(text))
                    .collect(),
                    artifact: Some(record.artifact),
                    regenerate_native_dir: false,
                },
                None => incremental(
                    "fingerprint matches but candidate.dev_client_scheme is not configured, so a cached dev client cannot be launched; using a keyed incremental build"
                        .to_string(),
                    vec![match_evidence, sha_evidence],
                ),
            },
            Some((record, ArtifactStatus::Mismatch)) => incremental(
                "cached artifact content no longer matches its recorded sha256; refusing the stale binary and using a keyed incremental build"
                    .to_string(),
                vec![
                    match_evidence,
                    sha_evidence,
                    format!("artifact {} failed content verification", record.artifact.path.display()),
                ],
            ),
            Some((record, ArtifactStatus::MissingFile)) => incremental(
                "recorded cached artifact is missing on disk; using a keyed incremental build"
                    .to_string(),
                vec![
                    match_evidence,
                    sha_evidence,
                    format!("artifact {} not found", record.artifact.path.display()),
                ],
            ),
            None => incremental(
                "fingerprint matches but no verified cached artifact is available; using a keyed incremental build"
                    .to_string(),
                vec![match_evidence, sha_evidence],
            ),
        }
    } else {
        let mut evidence = vec![
            format!(
                "recorded fingerprint {}, current {}",
                state.fingerprint, inputs.fingerprint
            ),
            sha_evidence,
        ];
        if !changed.is_empty() {
            evidence.push(format!("native inputs changed: {}", changed.join(", ")));
        }
        if !unrecorded.is_empty() {
            evidence.push(format!(
                "recorded build has no value for: {}",
                unrecorded.join(", ")
            ));
        }
        if let Some(cause) = inputs.expo_unavailable {
            evidence.push(format!("Expo fingerprint unavailable: {cause}"));
        }
        let reason = match &uncomparable {
            Some(uncomparable) => format!(
                "{uncomparable}; caches keyed to this exact worktree/app remain valid for an incremental compile"
            ),
            None => "native inputs changed since the recorded build; caches keyed to this exact worktree/app remain valid for an incremental compile".to_string(),
        };
        incremental(reason, evidence)
    }
}

// Deterministic content identity for a cached artifact: a plain sha256 for a
// file (apk), a sorted path+content manifest hash for a bundle directory
// (.app). Symlinks hash their link text, matching the fingerprint convention.
pub fn hash_artifact(path: &Path) -> Result<String, String> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
    if meta.is_file() {
        let bytes =
            std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        return Ok(crate::candidate::sha256_hex(&bytes));
    }
    if !meta.is_dir() {
        return Err(format!(
            "{} is neither a file nor a directory",
            path.display()
        ));
    }
    let mut entries: Vec<(String, String)> = Vec::new();
    walk_artifact(path, path, &mut entries)?;
    entries.sort();
    let mut manifest = String::new();
    for (rel, hash) in &entries {
        manifest.push_str(rel);
        manifest.push('\0');
        manifest.push_str(hash);
        manifest.push('\n');
    }
    Ok(crate::candidate::sha256_hex(manifest.as_bytes()))
}

fn walk_artifact(
    base: &Path,
    dir: &Path,
    entries: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let listed =
        std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    for entry in listed {
        let entry = entry.map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
        let path = entry.path();
        let rel = path
            .strip_prefix(base)
            .map_err(|_| format!("{} escaped its base", path.display()))?
            .to_string_lossy()
            .into_owned();
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&path)
                .map_err(|e| format!("cannot read symlink {}: {e}", path.display()))?;
            entries.push((
                rel,
                crate::candidate::sha256_hex(format!("symlink:{}", target.display()).as_bytes()),
            ));
        } else if meta.is_dir() {
            walk_artifact(base, &path, entries)?;
        } else {
            let bytes =
                std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            entries.push((rel, crate::candidate::sha256_hex(&bytes)));
        }
    }
    Ok(())
}

pub fn copy_artifact(runner: &dyn Runner, src: &Path, dest: &Path) -> Result<(), String> {
    use std::io::{Read, Write};
    crate::cancel::ensure_running(runner, "native_cache").map_err(|e| e.detail.to_string())?;
    let meta = std::fs::symlink_metadata(src)
        .map_err(|e| format!("cannot stat {}: {e}", src.display()))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(src)
            .map_err(|e| format!("cannot read symlink {}: {e}", src.display()))?;
        std::os::unix::fs::symlink(&target, dest)
            .map_err(|e| format!("cannot recreate symlink {}: {e}", dest.display()))?;
        return Ok(());
    }
    if meta.is_file() {
        let copied = (|| -> std::io::Result<()> {
            let mut source = std::fs::File::open(src)?;
            let mut target = std::fs::File::create(dest)?;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                if let Some(reason) = runner.cancellation() {
                    return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, reason));
                }
                let bytes = source.read(&mut buffer)?;
                if bytes == 0 {
                    break;
                }
                target.write_all(&buffer[..bytes])?;
            }
            target.set_permissions(meta.permissions())
        })();
        copied.map_err(|e| format!("cannot copy {} to {}: {e}", src.display(), dest.display()))?;
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(dest)
            .map_err(|e| format!("cannot create {}: {e}", dest.display()))?;
        let listed =
            std::fs::read_dir(src).map_err(|e| format!("cannot list {}: {e}", src.display()))?;
        for entry in listed {
            let entry = entry.map_err(|e| format!("cannot list {}: {e}", src.display()))?;
            copy_artifact(runner, &entry.path(), &dest.join(entry.file_name()))?;
        }
        return Ok(());
    }
    Err(format!("{} is not a copyable artifact", src.display()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockHolder {
    pub holder: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<PidIdentity>,
    pub at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockPolicy {
    // Device claims: any existing claim is a structured refusal, even a stale
    // one — a dead holder's resources may still be live.
    Strict,
    // Build serialization: a claim whose recorded holder is provably dead may
    // be adopted; it only guards compile concurrency, not device ownership.
    AdoptDead,
}

#[derive(Debug)]
pub enum LockOutcome {
    Claimed {
        adopted_stale: bool,
    },
    Contended {
        holder: Option<LockHolder>,
        liveness: Option<PidLiveness>,
        detail: String,
    },
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseOutcome {
    Removed,
    Absent,
    // Held by someone else: under persist-before-claim plus Strict/no-adopt
    // policies this proves the caller's claim never succeeded.
    Foreign(String),
    Refused(String),
    Unresolved(String),
}
