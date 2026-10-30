use std::path::Component;

pub const MACHINE_LOCKS_ENV: &str = "QAREN_MACHINE_LOCKS";
pub const LOCK_ROOT_ADVICE: &str =
    "set an absolute QAREN_LOCK_ROOT to a private directory, or set QAREN_MACHINE_LOCKS=0, then re-run";

const HOLDER_LIMIT: usize = 64 * 1024;
const LINK_BOUND: u32 = 40;
static STAGING_NONCE: AtomicU64 = AtomicU64::new(1);

pub fn lock_root_next_action(detail: &str) -> Option<&'static str> {
    if detail.contains("QAREN_MACHINE_LOCKS must be") {
        Some("unset QAREN_MACHINE_LOCKS or set it to 1 or 0")
    } else if detail.contains("QAREN_LOCK_ROOT must") {
        Some("set QAREN_LOCK_ROOT to an absolute path without . or .. segments, or unset it")
    } else if detail.contains("machine lock root") && detail.contains("HOME") {
        Some("set HOME to an absolute path, or set an absolute QAREN_LOCK_ROOT to a private directory")
    } else if detail.contains("QAREN_LOCK_ROOT") || detail.contains("machine lock root") {
        Some(LOCK_ROOT_ADVICE)
    } else {
        None
    }
}

pub fn machine_lock_parent() -> Result<&'static Path, String> {
    #[cfg(target_os = "macos")]
    {
        return Ok(Path::new("/private/var/tmp"));
    }
    #[cfg(target_os = "linux")]
    {
        return Ok(Path::new("/run/lock"));
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err("machine lock root is unsupported on this operating system".to_string())
    }
}

pub fn resolve_lock_root(explicit: Option<&OsStr>) -> Result<PathBuf, String> {
    let Some(raw) = explicit else {
        return machine_lock_parent().map(Path::to_path_buf);
    };
    absolute_lock_override(raw)
}

pub fn machine_locks_enabled(value: Option<&OsStr>) -> Result<bool, String> {
    match value {
        None => Ok(true),
        Some(raw) if raw.is_empty() || raw == OsStr::new("1") => Ok(true),
        Some(raw) if raw == OsStr::new("0") => Ok(false),
        Some(_) => Err("QAREN_MACHINE_LOCKS must be unset, 1 or 0".to_string()),
    }
}

pub fn configured_lock_root(
    explicit: Option<&OsStr>,
    machine: Option<&OsStr>,
    home: Option<&OsStr>,
) -> Result<PathBuf, String> {
    if machine_locks_enabled(machine)? {
        return resolve_lock_root(explicit);
    }
    if let Some(raw) = explicit {
        return absolute_lock_override(raw);
    }
    let Some(home) = home.filter(|raw| !raw.is_empty() && !raw.as_bytes().contains(&0)) else {
        return Err("HOME is not an absolute path".to_string());
    };
    if !Path::new(home).is_absolute() {
        return Err("HOME is not an absolute path".to_string());
    }
    if has_dot_segment(home) {
        return Err("HOME must not contain . or .. path segments".to_string());
    }
    Ok(PathBuf::from(home).join(".qaren").join("locks"))
}

pub fn host_lock_root(
    explicit: Option<&OsStr>,
    machine: Option<&OsStr>,
    home: Option<&OsStr>,
) -> Result<PathBuf, String> {
    let (root, warning) = select_lock_root(explicit, machine, home, || {
        probe_machine_parent(machine_lock_parent(), caller_privileged())
    })?;
    if let Some(warning) = warning {
        eprintln!("qaren: {warning}");
    }
    Ok(root)
}

#[derive(Debug)]
pub enum MachineParent {
    Usable(PathBuf),
    Unavailable(String),
    Failed(String),
}

// Only an Unavailable parent lets the implicit default degrade to per-home locks; QAREN_MACHINE_LOCKS=1 always refuses.
pub fn select_lock_root(
    explicit: Option<&OsStr>,
    machine: Option<&OsStr>,
    home: Option<&OsStr>,
    probe: impl FnOnce() -> MachineParent,
) -> Result<(PathBuf, Option<String>), String> {
    if explicit.is_some() || !machine_locks_enabled(machine)? {
        return configured_lock_root(explicit, machine, home).map(|root| (root, None));
    }
    let refuse = |detail: &str| format!("machine lock root is unusable: {detail}");
    let reason = match probe() {
        MachineParent::Usable(parent) => return Ok((parent, None)),
        MachineParent::Failed(detail) => return Err(refuse(&detail)),
        MachineParent::Unavailable(reason) => reason,
    };
    if machine.is_some_and(|raw| !raw.is_empty()) {
        return Err(refuse(&reason));
    }
    let root = configured_lock_root(None, Some(OsStr::new("0")), home)
        .map_err(|error| format!("machine lock root is unusable ({reason}) and {error}"))?;
    let warning = format!(
        "machine-wide device locks are unavailable ({reason}); using per-home locks at {}. Machine locks need an unprivileged caller and a root-owned sticky operating-system lock parent; QAREN_MACHINE_LOCKS=1 refuses instead of falling back",
        root.display()
    );
    Ok((root, Some(warning)))
}

pub fn probe_machine_parent(parent: Result<&Path, String>, privileged: bool) -> MachineParent {
    let parent = match parent {
        Ok(parent) => parent,
        Err(reason) => return MachineParent::Unavailable(reason),
    };
    if privileged {
        return MachineParent::Unavailable(
            "the caller is root, setuid or holds Linux capabilities".to_string(),
        );
    }
    let root = match open_lock_root(parent, false) {
        Ok(OpenRoot::Ready(root)) => root,
        Ok(OpenRoot::Missing { canonical }) => {
            return MachineParent::Unavailable(format!(
                "lock parent {} is missing",
                canonical.display()
            ));
        }
        Err(WalkError::Missing(detail) | WalkError::Unsafe(detail)) => {
            return MachineParent::Unavailable(detail);
        }
        Err(error) => return MachineParent::Failed(error.detail()),
    };
    let staging = fresh_name("probe", "rename");
    let probe = match mkdir_exclusive(&root, OsStr::new(&staging)) {
        Ok(probe) => probe,
        Err(MkdirExclusive::Exists) => {
            return MachineParent::Failed(format!("lock probe name {staging} already exists"));
        }
        Err(MkdirExclusive::Error(detail)) => return MachineParent::Failed(detail),
    };
    let renamed = fresh_name("probe", "renamed");
    let outcome = rename_lock_noreplace(&root, &staging, &renamed);
    let left = if outcome.is_ok() { &renamed } else { &staging };
    let _ = unlink_same(&root, OsStr::new(left), &probe);
    match outcome {
        Ok(()) => MachineParent::Usable(parent.to_path_buf()),
        Err(error) => rename_probe_outcome(error),
    }
}

fn rename_probe_outcome(error: i32) -> MachineParent {
    if rename_is_unsupported(error) {
        MachineParent::Unavailable(rename_error(error))
    } else {
        MachineParent::Failed(rename_error(error))
    }
}

fn absolute_lock_override(raw: &OsStr) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.as_bytes().contains(&0) {
        return Err("QAREN_LOCK_ROOT must be an absolute path".to_string());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("QAREN_LOCK_ROOT must be an absolute path".to_string());
    }
    if has_dot_segment(raw) {
        return Err("QAREN_LOCK_ROOT must not contain . or ..".to_string());
    }
    Ok(path)
}

fn has_dot_segment(raw: &OsStr) -> bool {
    raw.as_bytes()
        .split(|byte| *byte == b'/')
        .any(|segment| segment == b"." || segment == b"..")
}

pub fn canonical_lock_root(path: &Path) -> Result<PathBuf, String> {
    match open_lock_root(path, false).map_err(WalkError::detail)? {
        OpenRoot::Ready(dir) => Ok(dir.canonical),
        OpenRoot::Missing { canonical } => Ok(canonical),
    }
}

pub fn existing_lock_root(path: &Path) -> Result<PathBuf, String> {
    match open_lock_root(path, false).map_err(WalkError::detail)? {
        OpenRoot::Ready(dir) => Ok(dir.canonical),
        OpenRoot::Missing { .. } => Err("cannot resolve lock root".to_string()),
    }
}

pub fn lock_dir(lock_root: &Path, name: &str) -> PathBuf {
    lock_root.join(name)
}

pub fn claim_lock(
    runner: &mut dyn Runner,
    lock_root: &Path,
    name: &str,
    holder: &LockHolder,
    policy: LockPolicy,
) -> LockOutcome {
    claim_lock_until(runner, lock_root, name, holder, policy, None)
}

pub(crate) fn claim_lock_until(
    runner: &mut dyn Runner,
    lock_root: &Path,
    name: &str,
    holder: &LockHolder,
    policy: LockPolicy,
    deadline_ms: Option<u64>,
) -> LockOutcome {
    let euid = effective_uid();
    let root = match open_lock_root(lock_root, true) {
        Ok(OpenRoot::Ready(dir)) => dir,
        Ok(OpenRoot::Missing { canonical }) => {
            return LockOutcome::Error(format!("cannot resolve lock root {}", canonical.display()));
        }
        Err(error) => return LockOutcome::Error(error.detail()),
    };
    if let Err(error) = validate_component(&root, OsStr::new(name)) {
        return LockOutcome::Error(error);
    }
    let leaf = root.canonical.join(name);
    let mut adopted_stale = false;
    for _ in 0..2 {
        if deadline_ms.is_some_and(|deadline| runner.monotonic_ms() >= deadline) {
            return LockOutcome::Contended {
                holder: read_owned_holder_at(&root, OsStr::new(name), euid),
                liveness: None,
                detail: "the build-lock wait budget was exhausted".into(),
            };
        }
        match publish_claim(&root, name, holder, euid) {
            Ok(()) => return LockOutcome::Claimed { adopted_stale },
            Err(PublishFault::Exists) => {}
            Err(PublishFault::Error(detail)) => return LockOutcome::Error(detail),
        }
        match classify_leaf(&root, OsStr::new(name), euid) {
            Leaf::Absent => continue,
            Leaf::Untrusted => {
                return contended_untrusted(&leaf);
            }
            Leaf::Denied => {
                return LockOutcome::Contended {
                    holder: None,
                    liveness: None,
                    detail: format!(
                        "lock {} exists but its holder record is unreadable",
                        leaf.display()
                    ),
                };
            }
            Leaf::Failed(detail) => return LockOutcome::Error(detail),
            Leaf::Owned(claim) => {
                let existing = read_owned_holder(&claim, euid);
                let liveness = existing
                    .as_ref()
                    .and_then(|held| held.identity.as_ref())
                    .map(|identity| {
                        crate::runrecord::probe_pid_identity_until(runner, identity, deadline_ms)
                    });
                if policy == LockPolicy::AdoptDead
                    && existing.is_some()
                    && matches!(
                        liveness,
                        Some(PidLiveness::Dead) | Some(PidLiveness::AliveForeign)
                    )
                {
                    let expected = existing.clone().expect("holder is present");
                    match take_leaf(&root, OsStr::new(name), &claim, "stale", euid, |held| {
                        held.holder == expected.holder
                            && held.run_id == expected.run_id
                            && held.at == expected.at
                    }) {
                        Take::Removed => {
                            adopted_stale = true;
                            continue;
                        }
                        Take::Lost => continue,
                        Take::Restored(isolated) => {
                            return LockOutcome::Contended {
                                holder: isolated.or_else(|| {
                                    read_owned_holder_at(&root, OsStr::new(name), euid)
                                }),
                                liveness: None,
                                detail: format!(
                                    "lock {} was re-claimed while adopting a stale holder",
                                    leaf.display()
                                ),
                            };
                        }
                        Take::Preserved { holder, path } => {
                            return LockOutcome::Contended {
                                holder,
                                liveness: None,
                                detail: format!(
                                    "a foreign lock replaced the stale one mid-adoption and was preserved at {}; resolve it manually",
                                    path.display()
                                ),
                            };
                        }
                        Take::Error(detail) => return LockOutcome::Error(detail),
                    }
                }
                return LockOutcome::Contended {
                    holder: existing.clone(),
                    liveness,
                    detail: contention_detail(&leaf, &existing, liveness),
                };
            }
        }
    }
    LockOutcome::Error(format!(
        "lock {} kept reappearing during stale adoption",
        leaf.display()
    ))
}

pub fn read_holder(dir: &Path) -> Option<LockHolder> {
    let euid = effective_uid();
    let parent = dir.parent()?;
    let name = dir.file_name()?;
    let OpenRoot::Ready(root) = open_lock_root(parent, false).ok()? else {
        return None;
    };
    read_owned_holder_at(&root, name, euid)
}

pub fn release_lock(dir: &Path, expected_holder: &str, expected_run_id: &str) -> ReleaseOutcome {
    let euid = effective_uid();
    let Some(parent) = dir.parent() else {
        return ReleaseOutcome::Refused(format!(
            "lock path {} has no parent directory; refusing",
            dir.display()
        ));
    };
    let Some(name) = dir.file_name() else {
        return ReleaseOutcome::Refused(format!(
            "lock path {} has no final component; refusing",
            dir.display()
        ));
    };
    if parent.as_os_str().is_empty() {
        return ReleaseOutcome::Refused(format!(
            "lock path {} has no parent directory; refusing",
            dir.display()
        ));
    }
    let root = match open_lock_root(parent, false) {
        Ok(OpenRoot::Ready(root)) => root,
        Ok(OpenRoot::Missing { .. }) => return ReleaseOutcome::Absent,
        Err(WalkError::Unsafe(detail)) => return ReleaseOutcome::Refused(detail),
        Err(error) => return ReleaseOutcome::Unresolved(error.detail()),
    };
    if let Err(error) = validate_component(&root, name) {
        return ReleaseOutcome::Refused(error);
    }
    let leaf = root.canonical.join(name);
    let claim = match classify_leaf(&root, name, euid) {
        Leaf::Absent => return ReleaseOutcome::Absent,
        Leaf::Untrusted => {
            return ReleaseOutcome::Refused(format!(
                "lock path {} is not a trusted same-user claim; not guessing ownership",
                leaf.display()
            ));
        }
        Leaf::Denied | Leaf::Failed(_) => {
            return ReleaseOutcome::Unresolved(format!(
                "lock {} cannot be inspected",
                leaf.display()
            ));
        }
        Leaf::Owned(claim) => claim,
    };
    let Some(held) = read_owned_holder(&claim, euid) else {
        return ReleaseOutcome::Refused(format!(
            "lock {} has no readable holder record; not guessing ownership",
            leaf.display()
        ));
    };
    if held.holder != expected_holder || held.run_id != expected_run_id {
        return ReleaseOutcome::Foreign(format!(
            "lock {} is held by {:?} (run {:?}), not {:?}",
            leaf.display(),
            held.holder,
            held.run_id,
            expected_holder
        ));
    }
    match take_leaf(&root, name, &claim, "release", euid, |current| {
        current.holder == expected_holder && current.run_id == expected_run_id
    }) {
        Take::Removed => ReleaseOutcome::Removed,
        Take::Lost => ReleaseOutcome::Absent,
        Take::Restored(isolated) => {
            let described = isolated
                .as_ref()
                .map(|held| format!("held by {:?} (run {:?})", held.holder, held.run_id))
                .unwrap_or_else(|| "with no readable holder record".to_string());
            if isolated.is_some() {
                ReleaseOutcome::Foreign(format!(
                    "lock {} is {described}, not {:?}",
                    leaf.display(),
                    expected_holder
                ))
            } else {
                ReleaseOutcome::Refused(format!(
                    "lock {} has no readable holder record; not guessing ownership",
                    leaf.display()
                ))
            }
        }
        Take::Preserved { holder, path } => {
            let described = holder
                .as_ref()
                .map(|held| format!("held by {:?} (run {:?})", held.holder, held.run_id))
                .unwrap_or_else(|| "with no readable holder record".to_string());
            ReleaseOutcome::Unresolved(format!(
                "foreign lock {described} was taken for release and could not be restored; it is preserved at {}",
                path.display()
            ))
        }
        Take::Error(detail) => ReleaseOutcome::Unresolved(detail),
    }
}

fn contended_untrusted(leaf: &Path) -> LockOutcome {
    LockOutcome::Contended {
        holder: None,
        liveness: None,
        detail: format!(
            "lock {} is not a trusted same-user claim; QAREN_MACHINE_LOCKS=0 or an absolute QAREN_LOCK_ROOT selects a private root",
            leaf.display()
        ),
    }
}

fn contention_detail(
    leaf: &Path,
    holder: &Option<LockHolder>,
    liveness: Option<PidLiveness>,
) -> String {
    match (holder, liveness) {
        (Some(held), Some(PidLiveness::AliveMatching)) => format!(
            "lock {} is held by {} (holder process alive)",
            leaf.display(),
            held.holder
        ),
        (Some(held), _) => format!(
            "lock {} is held by {} (holder liveness not proven)",
            leaf.display(),
            held.holder
        ),
        (None, _) => format!(
            "lock {} exists but its holder record is unreadable",
            leaf.display()
        ),
    }
}

fn effective_uid() -> u32 {
    unsafe { libc::geteuid() as u32 }
}

pub fn caller_privileged() -> bool {
    let uid = unsafe { libc::getuid() } as u32;
    !caller_may_mutate(uid, effective_uid()) || capabilities_clear().is_err()
}

fn caller_may_mutate(uid: u32, euid: u32) -> bool {
    euid != 0 && uid == euid
}

#[cfg(target_os = "linux")]
fn capabilities_clear() -> Result<(), String> {
    let text = std::fs::read_to_string("/proc/self/status")
        .map_err(|_| "cannot prove Linux capabilities are clear".to_string())?;
    let line = text
        .lines()
        .find(|line| line.starts_with("CapEff:"))
        .ok_or_else(|| "cannot prove Linux capabilities are clear".to_string())?;
    let value = line.split_whitespace().nth(1).unwrap_or("");
    if value.is_empty() || !value.chars().all(|symbol| symbol == '0') {
        return Err("elevated Linux capabilities are unsupported".to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn capabilities_clear() -> Result<(), String> {
    Ok(())
}

#[derive(Debug)]
struct OpenDir {
    file: File,
    dev: u64,
    ino: u64,
    uid: u32,
    mode: u32,
    canonical: PathBuf,
}

impl OpenDir {
    fn fd(&self) -> i32 {
        self.file.as_raw_fd()
    }
}

enum OpenRoot {
    Ready(OpenDir),
    Missing { canonical: PathBuf },
}

#[derive(Debug)]
enum WalkError {
    Unsafe(String),
    Denied(String),
    Missing(String),
    Failed(String),
}

impl WalkError {
    fn detail(self) -> String {
        match self {
            WalkError::Unsafe(detail)
            | WalkError::Denied(detail)
            | WalkError::Missing(detail)
            | WalkError::Failed(detail) => detail,
        }
    }
}

enum Leaf {
    Absent,
    Denied,
    Untrusted,
    Failed(String),
    Owned(OpenDir),
}

enum PublishFault {
    Exists,
    Error(String),
}

enum Take {
    Removed,
    Lost,
    Restored(Option<LockHolder>),
    Preserved {
        holder: Option<LockHolder>,
        path: PathBuf,
    },
    Error(String),
}

#[derive(Debug)]
enum RemoveFault {
    Preserved,
    Error(String),
}

fn open_lock_root(path: &Path, create: bool) -> Result<OpenRoot, WalkError> {
    let euid = effective_uid();
    let mut pending = components_of(path)?;
    let mut index = 0usize;
    let mut links = 0u32;
    let mut current = open_slash(euid)?;
    while index < pending.len() {
        let name = pending[index].clone();
        let remaining = pending[index + 1..].to_vec();
        match lookup(&current, &name)? {
            Lookup::Missing => {
                let canonical = join_rest(&current.canonical, &pending[index..]);
                if blocks_machine_parent(&current.canonical, &pending[index..]) {
                    let machine = machine_lock_parent().unwrap_or(Path::new(&canonical));
                    return Err(WalkError::Missing(format!(
                        "lock parent {} is not available and was not created",
                        machine.display()
                    )));
                }
                if !parent_allows_private_create(&current, euid) {
                    return Err(WalkError::Missing(format!(
                        "cannot create lock root {}",
                        canonical.display()
                    )));
                }
                if !create {
                    return Ok(OpenRoot::Missing { canonical });
                }
                let created = create_private_component(&current, &name, euid)?;
                let last = remaining.is_empty();
                if last && !final_root_trusted(&created, euid) {
                    let _ = unlink_same(&current, &name, &created);
                    return Err(WalkError::Unsafe(format!(
                        "lock root {} is not a private directory or a root-owned sticky directory",
                        created.canonical.display()
                    )));
                }
                if !last && !ancestor_trusted(&created, euid) {
                    let _ = unlink_same(&current, &name, &created);
                    return Err(WalkError::Unsafe(format!(
                        "lock path {} is not a trusted ancestor",
                        created.canonical.display()
                    )));
                }
                current = created;
                index += 1;
            }
            Lookup::Symlink(target) => {
                if !os_alias_parent(&current) {
                    return Err(WalkError::Unsafe(format!(
                        "lock path symlink {} is not an operating-system alias",
                        current.canonical.join(&name).display()
                    )));
                }
                links += 1;
                if links > LINK_BOUND {
                    return Err(WalkError::Failed(
                        "lock path exceeded the symlink bound".to_string(),
                    ));
                }
                let mut restarted = link_components(&current.canonical, &target)?;
                restarted.extend(remaining);
                pending = restarted;
                index = 0;
                current = open_slash(euid)?;
            }
            Lookup::Directory(next) => {
                let last = remaining.is_empty();
                if last && !final_root_trusted(&next, euid) {
                    return Err(WalkError::Unsafe(format!(
                        "lock root {} is not a private directory or a root-owned sticky directory",
                        next.canonical.display()
                    )));
                }
                if !last && !ancestor_trusted(&next, euid) {
                    return Err(WalkError::Unsafe(format!(
                        "lock path {} is not a trusted ancestor",
                        next.canonical.display()
                    )));
                }
                current = next;
                index += 1;
            }
        }
    }
    if !final_root_trusted(&current, euid) {
        return Err(WalkError::Unsafe(
            "lock root is not a private directory or a root-owned sticky directory".to_string(),
        ));
    }
    Ok(OpenRoot::Ready(current))
}

enum Lookup {
    Missing,
    Symlink(OsString),
    Directory(OpenDir),
}

fn lookup(parent: &OpenDir, name: &OsStr) -> Result<Lookup, WalkError> {
    let c_name = c_component(name).map_err(WalkError::Failed)?;
    let snap = match stat_at(parent.fd(), &c_name, true) {
        Ok(meta) => meta,
        Err(error) if error.raw == libc::ENOENT => return Ok(Lookup::Missing),
        Err(error) if error.raw == libc::EACCES || error.raw == libc::EPERM => {
            return Err(WalkError::Denied(format!(
                "cannot inspect {}",
                parent.canonical.join(name).display()
            )));
        }
        Err(error) => {
            return Err(WalkError::Failed(format!(
                "cannot inspect {}: {}",
                parent.canonical.join(name).display(),
                error.message
            )));
        }
    };
    if is_link(snap.mode) {
        return read_link(parent, &c_name).map(Lookup::Symlink);
    }
    if !is_dir(snap.mode) {
        return Err(WalkError::Unsafe(format!(
            "lock path {} is not a directory",
            parent.canonical.join(name).display()
        )));
    }
    open_directory(parent, name, &c_name, &snap).map(Lookup::Directory)
}

fn open_directory(
    parent: &OpenDir,
    name: &OsStr,
    c_name: &CStr,
    snap: &Meta,
) -> Result<OpenDir, WalkError> {
    clear_errno();
    let fd = unsafe {
        libc::openat(
            parent.fd(),
            c_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        let raw = last_errno();
        let detail = format!(
            "cannot open {}: {}",
            parent.canonical.join(name).display(),
            errno_message(raw)
        );
        return Err(if raw == libc::EACCES || raw == libc::EPERM {
            WalkError::Denied(detail)
        } else {
            WalkError::Failed(detail)
        });
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let meta = match fstat_file(&file) {
        Ok(meta) => meta,
        Err(error) => {
            return Err(WalkError::Failed(format!(
                "cannot inspect {}: {}",
                parent.canonical.join(name).display(),
                error.message
            )));
        }
    };
    if meta.dev != snap.dev || meta.ino != snap.ino || meta.uid != snap.uid || !is_dir(meta.mode) {
        return Err(WalkError::Failed(format!(
            "lock path {} changed while opening",
            parent.canonical.join(name).display()
        )));
    }
    if let Err(error) = acl_acceptable(file.as_raw_fd(), true) {
        return Err(WalkError::Unsafe(format!(
            "lock path {} {}",
            parent.canonical.join(name).display(),
            error
        )));
    }
    Ok(OpenDir {
        file,
        dev: meta.dev,
        ino: meta.ino,
        uid: meta.uid,
        mode: meta.mode,
        canonical: child_canonical(&parent.canonical, name),
    })
}

fn open_slash(euid: u32) -> Result<OpenDir, WalkError> {
    clear_errno();
    let fd = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(WalkError::Failed(format!(
            "cannot open /: {}",
            errno_message(last_errno())
        )));
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let meta = fstat_file(&file)
        .map_err(|error| WalkError::Failed(format!("cannot inspect /: {}", error.message)))?;
    if !is_dir(meta.mode) {
        return Err(WalkError::Failed("/ is not a directory".to_string()));
    }
    acl_acceptable(file.as_raw_fd(), true)
        .map_err(|error| WalkError::Unsafe(format!("lock path / {error}")))?;
    let dir = OpenDir {
        file,
        dev: meta.dev,
        ino: meta.ino,
        uid: meta.uid,
        mode: meta.mode,
        canonical: PathBuf::from("/"),
    };
    if !ancestor_trusted(&dir, euid) {
        return Err(WalkError::Unsafe(
            "lock path / is not a trusted ancestor".to_string(),
        ));
    }
    Ok(dir)
}

fn create_private_component(
    parent: &OpenDir,
    name: &OsStr,
    euid: u32,
) -> Result<OpenDir, WalkError> {
    validate_component(parent, name).map_err(WalkError::Failed)?;
    let c_name = c_component(name).map_err(WalkError::Failed)?;
    clear_errno();
    let rc = unsafe { libc::mkdirat(parent.fd(), c_name.as_ptr(), 0o700) };
    if rc != 0 {
        let raw = last_errno();
        if raw == libc::EEXIST {
            return accept_existing_private(parent, name, euid);
        }
        return Err(WalkError::Failed(format!(
            "cannot create {}: {}",
            parent.canonical.join(name).display(),
            errno_message(raw)
        )));
    }
    let created = match lookup(parent, name) {
        Ok(Lookup::Directory(dir)) => dir,
        other => {
            discard_created_directory(parent, name);
            return match other {
                Ok(Lookup::Missing) | Err(_) => Err(WalkError::Failed(format!(
                    "cannot open created lock directory {}",
                    parent.canonical.join(name).display()
                ))),
                Ok(Lookup::Symlink(_)) => Err(WalkError::Unsafe(format!(
                    "created lock directory {} is not a directory",
                    parent.canonical.join(name).display()
                ))),
                Ok(Lookup::Directory(_)) => unreachable!("directory was returned above"),
            };
        }
    };
    if created.uid != euid || created.mode & 0o777 != 0o700 {
        let _ = unlink_same(parent, name, &created);
        return Err(WalkError::Failed(format!(
            "created lock directory {} is not a private 0700 directory",
            created.canonical.display()
        )));
    }
    Ok(created)
}

fn accept_existing_private(
    parent: &OpenDir,
    name: &OsStr,
    euid: u32,
) -> Result<OpenDir, WalkError> {
    match lookup(parent, name)? {
        Lookup::Directory(dir)
            if dir.uid == euid && dir.mode & 0o022 == 0 && final_root_trusted(&dir, euid) =>
        {
            Ok(dir)
        }
        Lookup::Directory(dir) => Err(WalkError::Unsafe(format!(
            "lock path {} is not a private directory",
            dir.canonical.display()
        ))),
        Lookup::Missing => Err(WalkError::Failed(format!(
            "cannot open {}",
            parent.canonical.join(name).display()
        ))),
        Lookup::Symlink(_) => Err(WalkError::Unsafe(format!(
            "lock path {} is not a directory",
            parent.canonical.join(name).display()
        ))),
    }
}

fn blocks_machine_parent(parent: &Path, missing: &[OsString]) -> bool {
    let Ok(machine) = machine_lock_parent() else {
        return false;
    };
    if missing.is_empty() {
        return false;
    }
    let next = child_canonical(parent, &missing[0]);
    let prospective = join_rest(parent, missing);
    prospective == machine
        || next == machine
        || machine.starts_with(&next)
        || ((prospective == machine || prospective.starts_with(machine))
            && !parent.starts_with(machine))
}

fn parent_allows_private_create(parent: &OpenDir, euid: u32) -> bool {
    let private = parent.uid == euid && parent.mode & 0o022 == 0;
    private || shared_sticky(parent)
}

fn os_alias_parent(parent: &OpenDir) -> bool {
    parent.uid == 0 && parent.mode & 0o022 == 0
}

fn ancestor_trusted(dir: &OpenDir, euid: u32) -> bool {
    if dir.uid == 0 && dir.mode & 0o022 == 0 {
        return true;
    }
    shared_sticky(dir) || (dir.uid == euid && dir.mode & 0o022 == 0)
}

fn final_root_trusted(dir: &OpenDir, euid: u32) -> bool {
    shared_sticky(dir) || (dir.uid == euid && dir.mode & 0o022 == 0)
}

fn shared_sticky(dir: &OpenDir) -> bool {
    dir.uid == 0 && sticky(dir.mode) && other_search_write(dir.mode)
}

fn sticky(mode: u32) -> bool {
    mode & (libc::S_ISVTX as u32) != 0
}

fn other_search_write(mode: u32) -> bool {
    mode & 0o007 & 0o003 == 0o003
}

fn classify_leaf(root: &OpenDir, name: &OsStr, euid: u32) -> Leaf {
    let Ok(c_name) = c_component(name) else {
        return Leaf::Failed("lock name is not a single path component".to_string());
    };
    let snap = match stat_at(root.fd(), &c_name, true) {
        Ok(meta) => meta,
        Err(error) if error.raw == libc::ENOENT => return Leaf::Absent,
        Err(error) if error.raw == libc::EACCES || error.raw == libc::EPERM => return Leaf::Denied,
        Err(error) => return Leaf::Failed(error.message),
    };
    if is_link(snap.mode) || !is_dir(snap.mode) || !owned_private(snap.uid, snap.mode, euid) {
        return Leaf::Untrusted;
    }
    match open_directory(root, name, &c_name, &snap) {
        Ok(dir)
            if dir.dev == snap.dev
                && dir.ino == snap.ino
                && owned_private(dir.uid, dir.mode, euid) =>
        {
            Leaf::Owned(dir)
        }
        Ok(_) => Leaf::Untrusted,
        Err(WalkError::Denied(_)) => Leaf::Denied,
        Err(WalkError::Unsafe(_)) => Leaf::Untrusted,
        Err(WalkError::Missing(detail) | WalkError::Failed(detail)) => Leaf::Failed(detail),
    }
}

fn owned_private(uid: u32, mode: u32, euid: u32) -> bool {
    uid == euid && mode & 0o022 == 0
}

fn publish_claim(
    root: &OpenDir,
    name: &str,
    holder: &LockHolder,
    euid: u32,
) -> Result<(), PublishFault> {
    let staging = fresh_name("claim", name);
    let created = match mkdir_exclusive(root, OsStr::new(&staging)) {
        Ok(dir) => dir,
        Err(MkdirExclusive::Exists) => {
            return Err(PublishFault::Error(format!(
                "lock staging name {staging} already exists"
            )));
        }
        Err(MkdirExclusive::Error(detail)) => return Err(PublishFault::Error(detail)),
    };
    if let Err(error) = write_holder(&created, "holder.json", holder, euid) {
        let _ = remove_owned_lock(root, &staging, &created);
        return Err(PublishFault::Error(error));
    }
    match rename_lock_noreplace(root, &staging, name) {
        Ok(()) => Ok(()),
        Err(error) if rename_is_collision(error) => {
            let _ = remove_owned_lock(root, &staging, &created);
            Err(PublishFault::Exists)
        }
        Err(error) => {
            let _ = remove_owned_lock(root, &staging, &created);
            Err(PublishFault::Error(rename_error(error)))
        }
    }
}

fn take_leaf(
    root: &OpenDir,
    name: &OsStr,
    claim: &OpenDir,
    purpose: &str,
    euid: u32,
    same: impl Fn(&LockHolder) -> bool,
) -> Take {
    let leaf = name.to_string_lossy();
    let tombstone = fresh_name(purpose, &leaf);
    if let Err(error) = validate_component(root, OsStr::new(&tombstone)) {
        return Take::Error(error);
    }
    let before = match fstat_file(&claim.file) {
        Ok(meta) => meta,
        Err(error) => return Take::Error(error.message),
    };
    match rename_lock_noreplace(root, &leaf, &tombstone) {
        Ok(()) => {}
        Err(error) if rename_is_collision(error) || error == libc::ENOENT => return Take::Lost,
        Err(error) => return Take::Error(rename_error(error)),
    }
    let moved = match classify_leaf(root, OsStr::new(&tombstone), euid) {
        Leaf::Owned(dir) => dir,
        _ => {
            return Take::Preserved {
                holder: None,
                path: root.canonical.join(&tombstone),
            };
        }
    };
    if moved.dev != before.dev || moved.ino != before.ino || moved.uid != before.uid {
        return Take::Preserved {
            holder: None,
            path: moved.canonical,
        };
    }
    let isolated = read_owned_holder(&moved, euid);
    if isolated.as_ref().is_some_and(&same) {
        return match remove_owned_lock(root, &tombstone, &moved) {
            Ok(()) => Take::Removed,
            Err(RemoveFault::Preserved) => Take::Preserved {
                holder: isolated,
                path: moved.canonical.clone(),
            },
            Err(RemoveFault::Error(detail)) => Take::Error(detail),
        };
    }
    match rename_lock_noreplace(root, &tombstone, &leaf) {
        Ok(()) => Take::Restored(isolated),
        Err(error) if rename_is_collision(error) || rename_is_unsupported(error) => {
            Take::Preserved {
                holder: isolated,
                path: root.canonical.join(tombstone),
            }
        }
        Err(_) => Take::Preserved {
            holder: isolated,
            path: root.canonical.join(tombstone),
        },
    }
}

fn remove_owned_lock(root: &OpenDir, name: &str, claim: &OpenDir) -> Result<(), RemoveFault> {
    let names = list_names(claim).map_err(RemoveFault::Error)?;
    let mut holder = false;
    for entry in &names {
        if entry == "." || entry == ".." {
            continue;
        }
        if entry == "holder.json" {
            holder = true;
            continue;
        }
        return Err(RemoveFault::Preserved);
    }
    if holder && !plain_holder(claim) {
        return Err(RemoveFault::Preserved);
    }
    if holder {
        let c_name = c_component(OsStr::new("holder.json")).map_err(RemoveFault::Error)?;
        clear_errno();
        if unsafe { libc::unlinkat(claim.fd(), c_name.as_ptr(), 0) } != 0 {
            return Err(RemoveFault::Error(format!(
                "cannot remove lock holder: {}",
                errno_message(last_errno())
            )));
        }
    }
    unlink_same(root, OsStr::new(name), claim)
}

fn plain_holder(claim: &OpenDir) -> bool {
    let Ok(c_name) = c_component(OsStr::new("holder.json")) else {
        return false;
    };
    let Ok(meta) = stat_at(claim.fd(), &c_name, true) else {
        return false;
    };
    is_reg(meta.mode) && meta.nlink == 1 && meta.uid == claim.uid && meta.mode & 0o022 == 0
}

fn unlink_same(root: &OpenDir, name: &OsStr, claim: &OpenDir) -> Result<(), RemoveFault> {
    let Ok(c_name) = c_component(name) else {
        return Err(RemoveFault::Error(
            "lock name is not a single path component".to_string(),
        ));
    };
    let Ok(meta) = stat_at(root.fd(), &c_name, true) else {
        return Err(RemoveFault::Preserved);
    };
    if meta.dev != claim.dev || meta.ino != claim.ino || meta.uid != claim.uid || !is_dir(meta.mode)
    {
        return Err(RemoveFault::Preserved);
    }
    clear_errno();
    if unsafe { libc::unlinkat(root.fd(), c_name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        return Err(RemoveFault::Error(format!(
            "cannot remove lock {}: {}",
            root.canonical.join(name).display(),
            errno_message(last_errno())
        )));
    }
    Ok(())
}

fn list_names(dir: &OpenDir) -> Result<Vec<OsString>, String> {
    let dup = unsafe { libc::dup(dir.fd()) };
    if dup < 0 {
        return Err(format!(
            "cannot list lock directory: {}",
            errno_message(last_errno())
        ));
    }
    clear_errno();
    let handle = unsafe { libc::fdopendir(dup) };
    if handle.is_null() {
        let raw = last_errno();
        unsafe { libc::close(dup) };
        return Err(format!(
            "cannot list lock directory: {}",
            errno_message(raw)
        ));
    }
    let mut names = Vec::new();
    loop {
        clear_errno();
        let entry = unsafe { libc::readdir(handle) };
        if entry.is_null() {
            let raw = last_errno();
            unsafe { libc::closedir(handle) };
            if raw != 0 {
                return Err(format!(
                    "cannot list lock directory: {}",
                    errno_message(raw)
                ));
            }
            return Ok(names);
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        names.push(OsStr::from_bytes(name.to_bytes()).to_os_string());
    }
}

fn read_owned_holder_at(root: &OpenDir, name: &OsStr, euid: u32) -> Option<LockHolder> {
    let claim = match classify_leaf(root, name, euid) {
        Leaf::Owned(claim) => claim,
        _ => return None,
    };
    read_owned_holder(&claim, euid)
}

fn read_owned_holder(claim: &OpenDir, euid: u32) -> Option<LockHolder> {
    let c_name = c_component(OsStr::new("holder.json")).ok()?;
    clear_errno();
    let fd = unsafe {
        libc::openat(
            claim.fd(),
            c_name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return None;
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let meta = fstat_file(&file).ok()?;
    if !is_reg(meta.mode)
        || meta.uid != euid
        || meta.mode & 0o022 != 0
        || meta.nlink != 1
        || acl_acceptable(file.as_raw_fd(), false).is_err()
    {
        return None;
    }
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = file.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        if buffer.len() + read > HOLDER_LIMIT {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    serde_json::from_slice(&buffer).ok()
}

// The gated work starts only after this, so a holder without a group proves none ever ran.
pub fn record_holder_group(
    dir: &Path,
    expected_holder: &str,
    expected_run_id: &str,
    pgid: i32,
) -> Result<(), String> {
    let euid = effective_uid();
    let (Some(parent), Some(name)) = (dir.parent(), dir.file_name()) else {
        return Err(format!(
            "lock path {} has no parent directory",
            dir.display()
        ));
    };
    let root = match open_lock_root(parent, false).map_err(WalkError::detail)? {
        OpenRoot::Ready(root) => root,
        OpenRoot::Missing { .. } => return Err(format!("lock {} is missing", dir.display())),
    };
    let Leaf::Owned(claim) = classify_leaf(&root, name, euid) else {
        return Err(format!(
            "lock {} is not a trusted same-user claim",
            dir.display()
        ));
    };
    let mut held = read_owned_holder(&claim, euid)
        .filter(|held| held.holder == expected_holder && held.run_id == expected_run_id)
        .ok_or_else(|| {
            format!(
                "lock {} is not held by run {expected_run_id}",
                dir.display()
            )
        })?;
    held.group = Some(pgid);
    let staged = fresh_name("holder", "json");
    let c_staged = c_component(OsStr::new(&staged))?;
    let c_holder = c_component(OsStr::new("holder.json"))?;
    let written = write_holder(&claim, &staged, &held, euid).and_then(|()| {
        clear_errno();
        if unsafe { libc::renameat(claim.fd(), c_staged.as_ptr(), claim.fd(), c_holder.as_ptr()) }
            == 0
        {
            Ok(())
        } else {
            Err(format!(
                "cannot record lock holder group: {}",
                errno_message(last_errno())
            ))
        }
    });
    if written.is_err() {
        unsafe { libc::unlinkat(claim.fd(), c_staged.as_ptr(), 0) };
    }
    written
}

fn write_holder(dir: &OpenDir, name: &str, holder: &LockHolder, euid: u32) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(holder)
        .map_err(|error| format!("cannot record lock holder: {error}"))?;
    let c_name = c_component(OsStr::new(name))?;
    clear_errno();
    let fd = unsafe {
        libc::openat(
            dir.fd(),
            c_name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(format!(
            "cannot record lock holder: {}",
            errno_message(last_errno())
        ));
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let meta = fstat_file(&file).map_err(|fault| fault.message)?;
    if meta.uid != euid || meta.mode & 0o777 != 0o600 || !is_reg(meta.mode) || meta.nlink != 1 {
        return Err("lock holder was not created as a private file".to_string());
    }
    acl_acceptable(file.as_raw_fd(), false)?;
    file.write_all(&bytes)
        .map_err(|error| format!("cannot record lock holder: {error}"))
}

fn mkdir_exclusive(parent: &OpenDir, name: &OsStr) -> Result<OpenDir, MkdirExclusive> {
    validate_component(parent, name).map_err(MkdirExclusive::Error)?;
    let c_name = c_component(name).map_err(MkdirExclusive::Error)?;
    clear_errno();
    if unsafe { libc::mkdirat(parent.fd(), c_name.as_ptr(), 0o700) } != 0 {
        let raw = last_errno();
        if raw == libc::EEXIST {
            return Err(MkdirExclusive::Exists);
        }
        return Err(MkdirExclusive::Error(format!(
            "cannot stage lock {}: {}",
            parent.canonical.join(name).display(),
            errno_message(raw)
        )));
    }
    match lookup(parent, name) {
        Ok(Lookup::Directory(dir)) if dir.uid == effective_uid() && dir.mode & 0o777 == 0o700 => {
            Ok(dir)
        }
        Ok(Lookup::Directory(dir)) => {
            let _ = unlink_same(parent, name, &dir);
            Err(MkdirExclusive::Error(format!(
                "created lock directory {} is not a private 0700 directory",
                dir.canonical.display()
            )))
        }
        other => {
            discard_created_directory(parent, name);
            Err(match other {
                Err(error) => MkdirExclusive::Error(error.detail()),
                Ok(_) => MkdirExclusive::Error(format!(
                    "cannot open staging directory {}",
                    parent.canonical.join(name).display()
                )),
            })
        }
    }
}

fn discard_created_directory(parent: &OpenDir, name: &OsStr) {
    let Ok(c_name) = c_component(name) else {
        return;
    };
    let Ok(meta) = stat_at(parent.fd(), &c_name, true) else {
        return;
    };
    if !is_dir(meta.mode) || meta.uid != effective_uid() {
        return;
    }
    clear_errno();
    unsafe {
        libc::unlinkat(parent.fd(), c_name.as_ptr(), libc::AT_REMOVEDIR);
    }
}

#[derive(Debug)]
enum MkdirExclusive {
    Exists,
    Error(String),
}

fn fresh_name(purpose: &str, name: &str) -> String {
    let nonce = STAGING_NONCE.fetch_add(1, Ordering::Relaxed);
    format!(
        ".{purpose}-{name}-{}-{}-{nonce}",
        std::process::id(),
        crate::timefmt::epoch_ms()
    )
}

fn validate_component(parent: &OpenDir, name: &OsStr) -> Result<(), String> {
    c_component(name)?;
    let limit = name_limit(parent.fd())?;
    if name.len() > limit {
        return Err(format!(
            "lock name {} exceeds NAME_MAX ({limit})",
            Path::new(name).display()
        ));
    }
    Ok(())
}

fn name_limit(fd: i32) -> Result<usize, String> {
    clear_errno();
    let limit = unsafe { libc::fpathconf(fd, libc::_PC_NAME_MAX) };
    if limit <= 0 {
        return Err("cannot prove NAME_MAX for the lock directory".to_string());
    }
    Ok(limit as usize)
}

fn c_component(name: &OsStr) -> Result<CString, String> {
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || bytes.contains(&0)
        || bytes.contains(&b'/')
        || name == "."
        || name == ".."
    {
        return Err("lock name is not a single path component".to_string());
    }
    CString::new(bytes.to_vec()).map_err(|_| "lock name is not a single path component".to_string())
}

fn components_of(path: &Path) -> Result<Vec<OsString>, WalkError> {
    if !path.is_absolute() {
        return Err(WalkError::Unsafe(
            "lock root is not an absolute path".to_string(),
        ));
    }
    if path
        .as_os_str()
        .as_bytes()
        .split(|byte| *byte == b'/')
        .any(|segment| segment == b"." || segment == b"..")
    {
        return Err(WalkError::Unsafe(
            "lock root must not contain . or ..".to_string(),
        ));
    }
    let mut names = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                c_component(name).map_err(WalkError::Failed)?;
                names.push(name.to_os_string());
            }
            Component::CurDir | Component::ParentDir => {
                return Err(WalkError::Unsafe(
                    "lock root must not contain . or ..".to_string(),
                ));
            }
            Component::Prefix(_) => {
                return Err(WalkError::Unsafe(
                    "lock root prefix is unsupported".to_string(),
                ));
            }
        }
    }
    Ok(names)
}

fn link_components(parent: &Path, target: &OsStr) -> Result<Vec<OsString>, WalkError> {
    if target.is_empty() || target.as_bytes().contains(&0) {
        return Err(WalkError::Failed(
            "lock path symlink target is unacceptable".to_string(),
        ));
    }
    let target_path = Path::new(target);
    if target_path.is_absolute() {
        return components_of(target_path);
    }
    let mut names = components_of(parent)?;
    for component in target_path.components() {
        match component {
            Component::Normal(name) => {
                c_component(name).map_err(WalkError::Failed)?;
                names.push(name.to_os_string());
            }
            _ => {
                return Err(WalkError::Failed(
                    "lock path symlink target is unacceptable".to_string(),
                ));
            }
        }
    }
    Ok(names)
}

fn read_link(parent: &OpenDir, name: &CStr) -> Result<OsString, WalkError> {
    let mut buffer = vec![0u8; 4096];
    clear_errno();
    let read = unsafe {
        libc::readlinkat(
            parent.fd(),
            name.as_ptr(),
            buffer.as_mut_ptr() as *mut libc::c_char,
            buffer.len(),
        )
    };
    if read < 0 {
        return Err(WalkError::Failed(format!(
            "cannot read lock path symlink: {}",
            errno_message(last_errno())
        )));
    }
    if read as usize >= buffer.len() {
        return Err(WalkError::Failed(
            "lock path symlink target was truncated".to_string(),
        ));
    }
    buffer.truncate(read as usize);
    Ok(OsStr::from_bytes(&buffer).to_os_string())
}

fn child_canonical(parent: &Path, name: &OsStr) -> PathBuf {
    if parent == Path::new("/") {
        Path::new("/").join(name)
    } else {
        parent.join(name)
    }
}

fn join_rest(parent: &Path, names: &[OsString]) -> PathBuf {
    names.iter().fold(parent.to_path_buf(), |path, name| {
        child_canonical(&path, name)
    })
}

struct Meta {
    dev: u64,
    ino: u64,
    uid: u32,
    mode: u32,
    nlink: u64,
}

struct StatFault {
    raw: i32,
    message: String,
}

fn stat_at(dirfd: i32, name: &CStr, nofollow: bool) -> Result<Meta, StatFault> {
    let mut raw: libc::stat = unsafe { std::mem::zeroed() };
    let flags = if nofollow {
        libc::AT_SYMLINK_NOFOLLOW
    } else {
        0
    };
    clear_errno();
    if unsafe { libc::fstatat(dirfd, name.as_ptr(), &mut raw, flags) } != 0 {
        let code = last_errno();
        return Err(StatFault {
            raw: code,
            message: errno_message(code),
        });
    }
    Ok(meta_from(&raw))
}

fn fstat_file(file: &File) -> Result<Meta, StatFault> {
    let mut raw: libc::stat = unsafe { std::mem::zeroed() };
    clear_errno();
    if unsafe { libc::fstat(file.as_raw_fd(), &mut raw) } != 0 {
        let code = last_errno();
        return Err(StatFault {
            raw: code,
            message: errno_message(code),
        });
    }
    Ok(meta_from(&raw))
}

fn meta_from(raw: &libc::stat) -> Meta {
    Meta {
        dev: raw.st_dev as u64,
        ino: raw.st_ino as u64,
        uid: raw.st_uid as u32,
        mode: raw.st_mode as u32,
        nlink: raw.st_nlink as u64,
    }
}

fn is_dir(mode: u32) -> bool {
    mode & (libc::S_IFMT as u32) == libc::S_IFDIR as u32
}

fn is_link(mode: u32) -> bool {
    mode & (libc::S_IFMT as u32) == libc::S_IFLNK as u32
}

fn is_reg(mode: u32) -> bool {
    mode & (libc::S_IFMT as u32) == libc::S_IFREG as u32
}

fn rename_lock_noreplace(root: &OpenDir, from: &str, to: &str) -> Result<(), i32> {
    let from = c_component(OsStr::new(from)).map_err(|_| libc::EINVAL)?;
    let to = c_component(OsStr::new(to)).map_err(|_| libc::EINVAL)?;
    clear_errno();
    let rc = rename_call(root.fd(), &from, &to);
    if rc == 0 {
        Ok(())
    } else if rc == i32::MIN {
        Err(libc::ENOTSUP)
    } else {
        Err(last_errno())
    }
}

#[cfg(target_os = "macos")]
fn rename_call(dirfd: i32, from: &CStr, to: &CStr) -> i32 {
    unsafe { libc::renameatx_np(dirfd, from.as_ptr(), dirfd, to.as_ptr(), libc::RENAME_EXCL) }
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn rename_call(dirfd: i32, from: &CStr, to: &CStr) -> i32 {
    unsafe {
        libc::renameat2(
            dirfd,
            from.as_ptr(),
            dirfd,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    }
}

#[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
fn rename_call(_dirfd: i32, _from: &CStr, _to: &CStr) -> i32 {
    i32::MIN
}

fn rename_is_collision(error: i32) -> bool {
    error == libc::EEXIST
}

fn rename_is_unsupported(error: i32) -> bool {
    if error == libc::ENOSYS || error == libc::EINVAL || error == libc::ENOTSUP {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        const DISTINCT: bool = libc::EOPNOTSUPP != libc::ENOTSUP;
        return DISTINCT && error == libc::EOPNOTSUPP;
    }
    #[cfg(not(target_os = "macos"))]
    {
        error == libc::EOPNOTSUPP
    }
}

fn rename_error(error: i32) -> String {
    if rename_is_unsupported(error) {
        format!(
            "exclusive lock rename is unsupported ({})",
            errno_message(error)
        )
    } else {
        format!("cannot rename lock: {}", errno_message(error))
    }
}

fn acl_acceptable(fd: i32, directory: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = directory;
        return macos_acl_acceptable(fd);
    }
    #[cfg(target_os = "linux")]
    {
        return linux_acl_absent(fd, directory);
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (fd, directory);
        Err("lock path ACL is not acceptable".to_string())
    }
}

#[cfg(target_os = "macos")]
fn macos_acl_acceptable(fd: i32) -> Result<(), String> {
    let acl = AclGuard::fetch(fd)?;
    let Some(acl) = acl else {
        return Ok(());
    };
    clear_errno();
    if unsafe { acl_valid(acl.0) } != 0 {
        return Err("ACL is not acceptable".to_string());
    }
    let mut entry: AclEntry = std::ptr::null_mut();
    let mut entry_id = ACL_FIRST_ENTRY;
    let mut count = 0usize;
    loop {
        clear_errno();
        let rc = unsafe { acl_get_entry(acl.0, entry_id, &mut entry) };
        if rc == 0 {
            if entry.is_null() {
                return Err("ACL is not acceptable".to_string());
            }
            let mut tag: AclTag = 0;
            clear_errno();
            if unsafe { acl_get_tag_type(entry, &mut tag) } != 0 || !acl_tag_acceptable(tag) {
                return Err("ACL is not acceptable".to_string());
            }
            count += 1;
            if count > ACL_MAX_ENTRIES {
                return Err("ACL is not acceptable".to_string());
            }
            entry_id = ACL_NEXT_ENTRY;
            continue;
        }
        if rc == -1 && last_errno() == libc::EINVAL {
            return Ok(());
        }
        return Err("ACL is not acceptable".to_string());
    }
}

fn acl_tag_acceptable(tag: i32) -> bool {
    tag == 2
}

#[cfg(target_os = "macos")]
struct AclGuard(*mut std::ffi::c_void);

#[cfg(target_os = "macos")]
impl AclGuard {
    fn fetch(fd: i32) -> Result<Option<Self>, String> {
        clear_errno();
        let acl = unsafe { acl_get_fd_np(fd, ACL_TYPE_EXTENDED) };
        if acl.is_null() {
            let raw = last_errno();
            if raw == libc::ENOENT || raw == libc::ENOTSUP || raw == libc::EOPNOTSUPP {
                return Ok(None);
            }
            return Err("ACL is not acceptable".to_string());
        }
        Ok(Some(Self(acl)))
    }
}

#[cfg(target_os = "macos")]
impl Drop for AclGuard {
    fn drop(&mut self) {
        unsafe {
            acl_free(self.0);
        }
    }
}

#[cfg(target_os = "macos")]
const ACL_TYPE_EXTENDED: i32 = 0x100;
#[cfg(target_os = "macos")]
const ACL_FIRST_ENTRY: i32 = 0;
#[cfg(target_os = "macos")]
const ACL_NEXT_ENTRY: i32 = -1;
#[cfg(target_os = "macos")]
const ACL_MAX_ENTRIES: usize = 128;

#[cfg(target_os = "macos")]
type Acl = *mut std::ffi::c_void;
#[cfg(target_os = "macos")]
type AclEntry = *mut std::ffi::c_void;
#[cfg(target_os = "macos")]
type AclTag = i32;

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn acl_get_fd_np(fd: i32, acl_type: i32) -> Acl;
    fn acl_valid(acl: Acl) -> i32;
    fn acl_get_entry(acl: Acl, entry_id: i32, entry: *mut AclEntry) -> i32;
    fn acl_get_tag_type(entry: AclEntry, tag: *mut AclTag) -> i32;
    fn acl_free(object: *mut std::ffi::c_void) -> i32;
}

#[cfg(target_os = "linux")]
fn linux_acl_absent(fd: i32, directory: bool) -> Result<(), String> {
    xattr_absent(fd, "system.posix_acl_access")?;
    if directory {
        xattr_absent(fd, "system.posix_acl_default")?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn xattr_absent(fd: i32, name: &str) -> Result<(), String> {
    let c_name = CString::new(name).map_err(|_| "lock path ACL is not acceptable".to_string())?;
    clear_errno();
    let rc = unsafe { libc::fgetxattr(fd, c_name.as_ptr(), std::ptr::null_mut(), 0) };
    if rc >= 0 {
        return Err("ACL is not acceptable".to_string());
    }
    let raw = last_errno();
    if raw == libc::ENODATA || raw == libc::ENOTSUP || raw == libc::EOPNOTSUPP {
        return Ok(());
    }
    Err("ACL is not acceptable".to_string())
}

fn clear_errno() {
    unsafe {
        #[cfg(target_os = "macos")]
        {
            *libc::__error() = 0;
        }
        #[cfg(not(target_os = "macos"))]
        {
            *libc::__errno_location() = 0;
        }
    }
}

fn last_errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn errno_message(raw: i32) -> String {
    std::io::Error::from_raw_os_error(raw).to_string()
}

#[cfg(test)]
mod lock_protocol_tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::fs::DirBuilderExt;

    #[test]
    fn caller_privilege_and_rename_errno_stay_closed() {
        assert!(caller_may_mutate(501, 501));
        assert!(!caller_may_mutate(0, 0));
        assert!(!caller_may_mutate(501, 0));
        assert!(!caller_may_mutate(501, 502));
        assert!(rename_is_collision(libc::EEXIST));
        assert!(!rename_is_collision(libc::ENOENT));
        assert!(rename_is_unsupported(libc::ENOSYS));
        assert!(rename_is_unsupported(libc::ENOTSUP));
        assert!(rename_is_unsupported(libc::EINVAL));
        assert!(!rename_is_unsupported(libc::EEXIST));
        assert!(!rename_is_unsupported(libc::EACCES));
        assert!(acl_tag_acceptable(2));
        assert!(!acl_tag_acceptable(1));
        assert!(!acl_tag_acceptable(0));
    }

    #[test]
    fn machine_root_is_the_default_and_zero_keeps_per_home_roots() {
        let home = OsStr::new("/tmp/qaren-home-a");
        let other = OsStr::new("/tmp/qaren-home-b");
        let off = Some(OsStr::new("0"));
        let legacy = configured_lock_root(None, off, Some(home)).unwrap();
        assert_eq!(legacy, PathBuf::from("/tmp/qaren-home-a/.qaren/locks"));
        assert_ne!(
            legacy,
            configured_lock_root(None, off, Some(other)).unwrap()
        );
        let machine = machine_lock_parent().unwrap().to_path_buf();
        assert_eq!(resolve_lock_root(None).unwrap(), machine);
        for value in [None, Some(OsStr::new("")), Some(OsStr::new("1"))] {
            assert_eq!(
                configured_lock_root(None, value, Some(home)).unwrap(),
                machine
            );
            assert_eq!(configured_lock_root(None, value, None).unwrap(), machine);
        }
        assert!(configured_lock_root(None, Some(OsStr::new("true")), Some(home)).is_err());
        assert!(configured_lock_root(None, off, None).is_err());
        assert!(configured_lock_root(Some(OsStr::new("relative/locks")), off, Some(home)).is_err());
        assert!(
            configured_lock_root(Some(OsStr::new("relative/locks")), None, Some(home)).is_err()
        );
        assert!(configured_lock_root(Some(OsStr::new("")), None, Some(home)).is_err());
        let dotted = OsStr::new("/tmp/../tmp/locks");
        assert!(configured_lock_root(Some(dotted), off, Some(home)).is_err());
        assert!(configured_lock_root(None, off, Some(OsStr::new("/tmp/./home"))).is_err());
        assert!(configured_lock_root(Some(dotted), None, Some(home)).is_err());
        assert!(configured_lock_root(Some(dotted), Some(OsStr::new("1")), Some(home)).is_err());
        let mut nul = b"/tmp/locks".to_vec();
        nul.insert(4, 0);
        let raw = OsString::from_vec(nul);
        assert!(resolve_lock_root(Some(&raw)).is_err());
        #[cfg(target_os = "macos")]
        assert_eq!(machine, PathBuf::from("/private/var/tmp"));
        #[cfg(target_os = "linux")]
        assert_eq!(machine, PathBuf::from("/run/lock"));
    }

    #[test]
    fn only_an_unsupported_rename_lets_the_default_fall_back() {
        let home = Some(OsStr::new("/tmp/qaren-rename-home"));
        for errno in [libc::ENOTSUP, libc::ENOSYS, libc::EINVAL] {
            let (root, warning) =
                select_lock_root(None, None, home, || rename_probe_outcome(errno)).unwrap();
            assert_eq!(root, PathBuf::from("/tmp/qaren-rename-home/.qaren/locks"));
            assert!(warning
                .unwrap()
                .contains("exclusive lock rename is unsupported"));
            let refused = select_lock_root(None, Some(OsStr::new("1")), home, || {
                rename_probe_outcome(errno)
            })
            .unwrap_err();
            assert!(
                refused.starts_with("machine lock root is unusable"),
                "{refused}"
            );
        }
        for errno in [libc::EACCES, libc::EPERM, libc::EIO, libc::ENOSPC] {
            let refused =
                select_lock_root(None, None, home, || rename_probe_outcome(errno)).unwrap_err();
            assert!(refused.contains("cannot rename lock"), "{refused}");
        }
    }

    #[test]
    fn every_lock_root_refusal_names_a_working_next_action() {
        let home = Some(OsStr::new("/tmp/qaren-advice-home"));
        let on = Some(OsStr::new("1"));
        for probe in [
            MachineParent::Failed("cannot stage lock: Permission denied".into()),
            MachineParent::Unavailable(
                "the caller is root, setuid or holds Linux capabilities".into(),
            ),
        ] {
            let refused = select_lock_root(None, on, home, || probe).unwrap_err();
            let advice = lock_root_next_action(&refused).unwrap();
            assert!(advice.contains("QAREN_MACHINE_LOCKS=0") && advice.contains("QAREN_LOCK_ROOT"));
        }
        let invalid = configured_lock_root(None, Some(OsStr::new("true")), home).unwrap_err();
        assert_eq!(
            lock_root_next_action(&invalid),
            Some("unset QAREN_MACHINE_LOCKS or set it to 1 or 0")
        );
        let homeless = select_lock_root(None, None, None, || {
            MachineParent::Unavailable("lock parent /run/lock is missing".into())
        })
        .unwrap_err();
        assert!(lock_root_next_action(&homeless)
            .unwrap()
            .starts_with("set HOME"));
        assert_eq!(
            lock_root_next_action("cannot create native cache root"),
            None
        );
    }

    #[test]
    fn exclusive_mkdir_does_not_replace_an_existing_directory() {
        let root_path = std::env::temp_dir().join(format!(
            "qaren-mkdir-{}-{}",
            std::process::id(),
            crate::timefmt::epoch_ms()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&root_path)
            .unwrap();
        let root = match open_lock_root(&root_path, false).unwrap() {
            OpenRoot::Ready(dir) => dir,
            OpenRoot::Missing { .. } => panic!("fixture directory is missing"),
        };
        let first = mkdir_exclusive(&root, OsStr::new("leaf")).unwrap();
        let inode = first.ino;
        let error = mkdir_exclusive(&root, OsStr::new("leaf")).unwrap_err();
        assert!(matches!(error, MkdirExclusive::Exists));
        let again = match lookup(&root, OsStr::new("leaf")).unwrap() {
            Lookup::Directory(dir) => dir,
            Lookup::Missing => panic!("existing directory was not kept"),
            Lookup::Symlink(_) => panic!("existing directory became a symlink"),
        };
        assert_eq!(again.ino, inode);
        unlink_same(&root, OsStr::new("leaf"), &again).unwrap();
        drop(root);
        std::fs::remove_dir(&root_path).unwrap();
    }

    #[test]
    fn foreign_metadata_is_untrusted_without_a_holder_read() {
        assert!(owned_private(501, 0o755, 501));
        assert!(owned_private(501, 0o700, 501));
        assert!(!owned_private(0, 0o755, 501));
        assert!(!owned_private(502, 0o700, 501));
        assert!(!owned_private(501, 0o775, 501));
        assert!(!owned_private(501, 0o707, 501));
        assert!(!owned_private(501, 0o666, 501));
    }
}
