use super::*;
use crate::candidate::sha256_hex;
use crate::ios_toolchain::{CompilerIdentity, RequestedModes};

pub const CACHE_VOLUME_FIX: &str = "remount the configured cache volume or explicitly set QAREN_NATIVE_CACHE_ROOT to a mounted private absolute directory, then re-run qaren doctor --json and retry the original command";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheAvailability {
    Present,
    RootAbsent,
    VolumeUnmounted,
    Uninspectable,
}

pub type MountProbe = fn(&File, &Path) -> Result<String, CacheAvailability>;

pub struct NativeCacheAnchor {
    ancestor: StoreDirectory,
    remaining: PathBuf,
    intended: PathBuf,
    pub mount_hash: String,
    pub availability: CacheAvailability,
    probe: MountProbe,
}

#[cfg(target_os = "macos")]
pub fn mounted_filesystem_identity(
    file: &File,
    intended: &Path,
) -> Result<String, CacheAvailability> {
    fn bytes(value: &[libc::c_char]) -> Option<Vec<u8>> {
        let end = value.iter().position(|b| *b == 0)?;
        Some(value[..end].iter().map(|b| *b as u8).collect())
    }
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(CacheAvailability::Uninspectable);
    }
    let stat = unsafe { stat.assume_init() };
    let mounted_on = bytes(&stat.f_mntonname).ok_or(CacheAvailability::Uninspectable)?;
    let mounted_from = bytes(&stat.f_mntfromname).ok_or(CacheAvailability::Uninspectable)?;
    let mut components = intended.components();
    let boundary = if components.next() == Some(std::path::Component::RootDir)
        && components
            .next()
            .is_some_and(|c| c.as_os_str() == "Volumes")
    {
        components
            .next()
            .map(|name| Path::new("/Volumes").join(name))
    } else {
        None
    };
    if boundary
        .as_ref()
        .is_some_and(|path| path.as_os_str().as_bytes() != mounted_on)
    {
        return Err(CacheAvailability::VolumeUnmounted);
    }
    let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if !(1..=4096).contains(&count) {
        return Err(CacheAvailability::Uninspectable);
    }
    let mut mounts: Vec<std::mem::MaybeUninit<libc::statfs>> =
        Vec::with_capacity(count as usize + 16);
    mounts.resize_with(count as usize + 16, std::mem::MaybeUninit::uninit);
    let found = unsafe {
        libc::getfsstat(
            mounts.as_mut_ptr().cast(),
            (mounts.len() * std::mem::size_of::<libc::statfs>()) as i32,
            libc::MNT_NOWAIT,
        )
    };
    if found < 1 || found as usize >= mounts.len() {
        return Err(CacheAvailability::Uninspectable);
    }
    let matching = mounts[..found as usize].iter().any(|mount| {
        let mount = unsafe { mount.assume_init_ref() };
        bytes(&mount.f_mntonname).as_ref() == Some(&mounted_on)
            && bytes(&mount.f_mntfromname).as_ref() == Some(&mounted_from)
    });
    if !matching {
        return Err(CacheAvailability::VolumeUnmounted);
    }
    let volume_path = PathBuf::from(OsString::from_vec(mounted_on.clone()));
    let volume =
        open_existing_ancestor(&volume_path).map_err(|_| CacheAvailability::Uninspectable)?;
    let mut observed = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(volume.file.as_raw_fd(), observed.as_mut_ptr()) } != 0 {
        return Err(CacheAvailability::Uninspectable);
    }
    let observed = unsafe { observed.assume_init() };
    let fsid = |stat: &libc::statfs| unsafe {
        std::slice::from_raw_parts(
            (&stat.f_fsid as *const libc::fsid_t).cast::<u8>(),
            std::mem::size_of::<libc::fsid_t>(),
        )
        .to_vec()
    };
    if fsid(&stat) != fsid(&observed) {
        return Err(CacheAvailability::VolumeUnmounted);
    }
    #[repr(C)]
    struct VolumeUuid {
        length: u32,
        uuid: [u8; 16],
    }
    let mut attributes = libc::attrlist {
        bitmapcount: 5,
        reserved: 0,
        commonattr: 0,
        volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_UUID,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut identity = VolumeUuid {
        length: 0,
        uuid: [0; 16],
    };
    let result = unsafe {
        libc::fgetattrlist(
            volume.file.as_raw_fd(),
            (&mut attributes as *mut libc::attrlist).cast(),
            (&mut identity as *mut VolumeUuid).cast(),
            std::mem::size_of::<VolumeUuid>(),
            0,
        )
    };
    if result != 0
        || identity.length as usize != std::mem::size_of::<VolumeUuid>()
        || identity.uuid == [0; 16]
    {
        return Err(CacheAvailability::Uninspectable);
    }
    Ok(sha256_hex(
        &serde_json::to_vec(&("qaren-native-volume/1", mounted_on, identity.uuid))
            .expect("mount identity"),
    ))
}

#[cfg(not(target_os = "macos"))]
pub fn mounted_filesystem_identity(
    _file: &File,
    _intended: &Path,
) -> Result<String, CacheAvailability> {
    Err(CacheAvailability::Uninspectable)
}

pub fn anchor_native_cache(path: &Path) -> Result<NativeCacheAnchor, CacheAvailability> {
    anchor_native_cache_with(path, mounted_filesystem_identity)
}

pub fn anchor_native_cache_with(
    path: &Path,
    probe: MountProbe,
) -> Result<NativeCacheAnchor, CacheAvailability> {
    resolve_native_cache_root(Some(path.as_os_str()), unsafe { libc::geteuid() })
        .map_err(|_| CacheAvailability::Uninspectable)?;
    let file = File::open("/").map_err(|_| CacheAvailability::Uninspectable)?;
    checked_object(&file, true, false).map_err(|_| CacheAvailability::Uninspectable)?;
    let mut ancestor = StoreDirectory {
        file,
        path: PathBuf::from("/"),
    };
    let parts: Vec<_> = path.iter().filter(|name| *name != "/").collect();
    let mut sticky = false;
    let mut remaining = PathBuf::new();
    for (i, name) in parts.iter().enumerate() {
        match ancestor
            .child(name, false, sticky || i + 1 == parts.len())
            .map_err(|_| CacheAvailability::Uninspectable)?
        {
            Some(dir) => {
                sticky = descriptor_stat(&dir.file)
                    .map_err(|_| CacheAvailability::Uninspectable)?
                    .st_mode as u32
                    & 0o1000
                    != 0;
                ancestor = dir;
            }
            None => {
                for name in &parts[i..] {
                    remaining.push(name);
                }
                break;
            }
        }
    }
    let mount_hash = probe(&ancestor.file, path)?;
    if unsafe {
        libc::faccessat(
            ancestor.file.as_raw_fd(),
            c".".as_ptr(),
            libc::W_OK | libc::X_OK,
            libc::AT_EACCESS,
        )
    } != 0
    {
        return Err(CacheAvailability::Uninspectable);
    }
    let availability = if remaining.as_os_str().is_empty() {
        CacheAvailability::Present
    } else {
        CacheAvailability::RootAbsent
    };
    Ok(NativeCacheAnchor {
        ancestor,
        remaining,
        intended: path.into(),
        mount_hash,
        availability,
        probe,
    })
}

impl NativeCacheAnchor {
    pub fn recheck(&self) -> Result<(), String> {
        let current =
            anchor_native_cache_with(&self.intended, self.probe).map_err(|_| ROOT_UNSAFE)?;
        let expected = descriptor_stat(&self.ancestor.file)?;
        let opened = open_existing_ancestor(&self.ancestor.path)?;
        let actual = descriptor_stat(&opened.file)?;
        if self.mount_hash != current.mount_hash
            || expected.st_dev != actual.st_dev
            || expected.st_ino != actual.st_ino
        {
            return Err(ROOT_UNSAFE.into());
        }
        Ok(())
    }
}

fn open_existing_ancestor(path: &Path) -> Result<StoreDirectory, String> {
    let mut dir = StoreDirectory {
        file: File::open("/").map_err(|_| ROOT_UNSAFE)?,
        path: "/".into(),
    };
    for name in path.iter().filter(|name| *name != "/") {
        dir = dir.child(name, false, false)?.ok_or(ROOT_UNSAFE)?;
    }
    Ok(dir)
}

pub fn open_native_store_root_from_anchor(
    anchor: &NativeCacheAnchor,
) -> Result<NativeStoreRoot, String> {
    store_mutation_allowed()?;
    anchor.recheck()?;
    create_from_pinned_anchor(anchor)
}

fn create_from_pinned_anchor(anchor: &NativeCacheAnchor) -> Result<NativeStoreRoot, String> {
    let mut dir = anchor.ancestor.duplicate()?;
    for name in &anchor.remaining {
        dir = dir.child(name, true, true)?.ok_or(ROOT_UNSAFE)?;
        if (anchor.probe)(&dir.file, &anchor.intended).ok().as_ref() != Some(&anchor.mount_hash) {
            return Err(ROOT_UNSAFE.into());
        }
    }
    anchor.recheck()?;
    let root = NativeStoreRoot { dir };
    let readback = open_native_store_root(&anchor.intended, false)?.ok_or(ROOT_UNSAFE)?;
    let a = descriptor_stat(&root.dir.file)?;
    let b = descriptor_stat(&readback.dir.file)?;
    if a.st_dev != b.st_dev || a.st_ino != b.st_ino {
        return Err(ROOT_UNSAFE.into());
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};

    fn mounted(file: &File, _: &Path) -> Result<String, CacheAvailability> {
        Ok(sha256_hex(
            &file
                .metadata()
                .map_err(|_| CacheAvailability::Uninspectable)?
                .dev()
                .to_le_bytes(),
        ))
    }

    #[test]
    fn dropout_after_validation_before_mkdir_stays_on_the_pinned_filesystem() {
        let base = std::env::temp_dir().join(format!(
            "qaren-anchor-race-{}-{}",
            std::process::id(),
            STORE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&base)
            .unwrap();
        let base = base.canonicalize().unwrap();
        let parent = base.join("mounted");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&parent)
            .unwrap();
        let anchor = anchor_native_cache_with(&parent.join("cache"), mounted).unwrap();
        anchor.recheck().unwrap();
        std::fs::rename(&parent, base.join("detached")).unwrap();
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&parent)
            .unwrap();
        assert!(create_from_pinned_anchor(&anchor).is_err());
        assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 0);
        assert!(base.join("detached/cache").is_dir());
        std::fs::remove_dir_all(base).unwrap();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastSuccess {
    pub schema: u32,
    pub fingerprint: String,
    pub parts: BTreeMap<String, String>,
    pub compiler: CompilerIdentity,
    pub requested: RequestedModes,
    pub mount_hash: String,
    pub completed_at: String,
    pub artifact_sha256: String,
}

fn history_key(root: &Path, platform: &str, app_id: &str) -> String {
    format!(
        "{}.json",
        sha256_hex(&serde_json::to_vec(&(root, platform, app_id)).expect("cache history key"))
    )
}

impl LastSuccess {
    pub fn load(state: &Path, root: &Path, platform: &str, app_id: &str) -> Option<Self> {
        let dir = open_native_store_root(&state.join("native-cache").join(crate::VERSION), false)
            .ok()??;
        let file = dir
            .dir
            .open_file(OsStr::new(&history_key(root, platform, app_id)), None)
            .ok()??;
        let mut bytes = Vec::new();
        file.take(65537).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 65536 {
            return None;
        }
        let record: Self = serde_json::from_slice(&bytes).ok()?;
        let hash = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
        let normalized_xcode = record.compiler.xcode.as_ref().is_some_and(|s| {
            s.len() <= 65
                && s.split('/').count() == 2
                && s.split('/').all(|s| {
                    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
                })
        });
        (record.schema == 1
            && normalized_xcode
            && record.compiler.complete()
            && record.compiler.xcode_hash.as_deref().is_some_and(hash)
            && record.compiler.swift_hash.as_deref().is_some_and(hash)
            && record.requested.complete()
            && hash(&record.mount_hash)
            && hash(&record.artifact_sha256)
            && record.fingerprint.strip_prefix("rnfp1:").is_some_and(hash)
            && record.parts.iter().all(|(key, value)| {
                matches!(
                    key.as_str(),
                    "rnfp"
                        | "expo"
                        | "toolchain"
                        | "toolchain.xcode"
                        | "toolchain.swift"
                        | "toolchain.expo-mode"
                        | "toolchain.rncore-mode"
                        | "toolchain.jsi-mode"
                ) && value.rsplit(':').next().is_some_and(|s| {
                    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_hexdigit())
                })
            }))
        .then_some(record)
    }

    pub fn save(
        &self,
        state: &Path,
        root: &Path,
        platform: &str,
        app_id: &str,
    ) -> Result<(), String> {
        self.save_with_probe(state, root, platform, app_id, mounted_filesystem_identity)
    }

    pub fn save_with_probe(
        &self,
        state: &Path,
        root: &Path,
        platform: &str,
        app_id: &str,
        probe: MountProbe,
    ) -> Result<(), String> {
        let path = state.join("native-cache").join(crate::VERSION);
        let anchor = anchor_native_cache_with(&path, probe).map_err(|_| ROOT_UNSAFE)?;
        let dir = open_native_store_root_from_anchor(&anchor)?;
        let key = history_key(root, platform, app_id);
        let _ = dir.dir.open_file(OsStr::new(&key), None)?;
        let temp = format!(
            ".history-{}-{}",
            std::process::id(),
            STORE_NONCE.fetch_add(1, Ordering::Relaxed)
        );
        let mut file = dir
            .dir
            .open_file(OsStr::new(&temp), Some(0o600))?
            .ok_or(ENTRY_UNSAFE)?;
        let bytes = serde_json::to_vec(self).map_err(|_| RECORD_INVALID)?;
        let result = (|| {
            file.write_all(&bytes).map_err(|_| ENTRY_UNSAFE)?;
            file.sync_all().map_err(|_| ENTRY_UNSAFE)?;
            let from = store_name(OsStr::new(&temp))?;
            let to = store_name(OsStr::new(&key))?;
            if unsafe {
                libc::renameat(
                    dir.dir.file.as_raw_fd(),
                    from.as_ptr(),
                    dir.dir.file.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err(ENTRY_UNSAFE.into());
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = dir.dir.unlink(OsStr::new(&temp), false);
        }
        result
    }
}
