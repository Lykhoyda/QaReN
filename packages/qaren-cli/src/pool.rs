use crate::adapters::ios;
use crate::failure::{Failure, FailureCode};
use crate::scenario::IosSpec;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const POOL_SCHEMA: &str = "qaren-pool/1";

// Proof that QaReN created this simulator for the pool; a simulator without one is never touched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PoolMember {
    pub schema: String,
    pub udid: String,
    pub name: String,
    pub device_type: String,
    pub runtime: String,
    pub created_by_run: String,
    pub created_at: String,
}

pub fn default_cap(spec: &IosSpec) -> u32 {
    spec.max_devices.unwrap_or(1)
}

pub fn creation_lock_name() -> &'static str {
    "create-ios"
}

fn ios_dir(pool_root: &Path) -> PathBuf {
    pool_root.join("ios")
}

pub fn record_path(pool_root: &Path, udid: &str) -> PathBuf {
    ios_dir(pool_root).join(format!("{udid}.json"))
}

fn invalid(path: &Path, detail: impl std::fmt::Display) -> Failure {
    Failure::new(
        "device",
        FailureCode::RunRecordInvalid,
        format!("pool record {} is unreadable: {detail}", path.display()),
        format!(
            "inspect {}; delete it only after deleting its simulator with `xcrun simctl delete <UDID>`",
            path.display()
        ),
    )
}

// Members sorted by UDID; a malformed record refuses instead of being guessed at.
pub fn load_all(pool_root: &Path) -> Result<Vec<PoolMember>, Failure> {
    let dir = ios_dir(pool_root);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(invalid(&dir, e)),
    };
    let mut members = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| invalid(&dir, e))?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        // Hidden names are in-flight temporaries of `write`.
        let Some(stem) = file_name
            .strip_suffix(".json")
            .filter(|_| !file_name.starts_with('.'))
        else {
            continue;
        };
        let path = entry.path();
        let raw = std::fs::read_to_string(&path).map_err(|e| invalid(&path, e))?;
        let member: PoolMember = serde_json::from_str(&raw).map_err(|e| invalid(&path, e))?;
        if member.schema != POOL_SCHEMA
            || ios::canonical_udid(&member.udid).as_deref() != Some(member.udid.as_str())
            || member.udid != stem
            || member.name.trim().is_empty()
        {
            return Err(invalid(
                &path,
                "schema, canonical UUID, file name or simulator name does not match",
            ));
        }
        members.push(member);
    }
    members.sort_by(|a, b| a.udid.cmp(&b.udid));
    Ok(members)
}

pub fn write(pool_root: &Path, member: &PoolMember) -> Result<(), Failure> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = record_path(pool_root, &member.udid);
    let tmp = ios_dir(pool_root).join(format!(".{}.json.tmp", member.udid));
    let result = std::fs::create_dir_all(ios_dir(pool_root))
        .and_then(|_| {
            std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(&tmp)
        })
        .and_then(|mut file| {
            file.write_all(
                serde_json::to_string_pretty(member)
                    .unwrap_or_default()
                    .as_bytes(),
            )?;
            file.sync_all()
        })
        .and_then(|_| std::fs::rename(&tmp, &path));
    result.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        Failure::new(
            "allocate",
            FailureCode::RunRecordUpdateFailed,
            format!("cannot write pool record {}: {e}", path.display()),
            "check ~/.qaren directory permissions",
        )
    })
}

// Members whose UDID the inventory still shows; `inventory_json` must come from a clean strict read.
pub fn present(members: &[PoolMember], inventory_json: &str) -> Vec<PoolMember> {
    members
        .iter()
        .filter(|m| {
            !matches!(
                ios::parse_sim_presence(inventory_json, &m.udid),
                ios::SimPresence::Absent
            )
        })
        .cloned()
        .collect()
}

// UDIDs are never reissued, so a record whose simulator is proven gone can be dropped.
pub fn prune(pool_root: &Path, members: &[PoolMember], kept: &[PoolMember]) -> Result<(), Failure> {
    for member in members.iter().filter(|m| !kept.contains(m)) {
        let path = record_path(pool_root, &member.udid);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(Failure::new(
                    "allocate",
                    FailureCode::RunRecordUpdateFailed,
                    format!("cannot remove pool record {}: {e}", path.display()),
                    "check ~/.qaren directory permissions",
                ))
            }
        }
    }
    Ok(())
}

// The exact member, with the record's name and the record's and scenario's device type and runtime.
pub fn proven(member: &PoolMember, inventory_json: &str, spec: &IosSpec) -> Option<ios::Simulator> {
    ios::parse_selected_sim(inventory_json, &member.udid).filter(|sim| {
        sim.name == member.name
            && sim.device_type == member.device_type
            && sim.runtime == member.runtime
            && member.device_type == spec.device_type
            && member.runtime == spec.runtime
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
    const TYPE: &str = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
    const RUNTIME: &str = "com.apple.CoreSimulator.SimRuntime.iOS-26-4";

    fn member(udid: &str) -> PoolMember {
        PoolMember {
            schema: POOL_SCHEMA.into(),
            udid: udid.into(),
            name: "qaren-pool-run".into(),
            device_type: TYPE.into(),
            runtime: RUNTIME.into(),
            created_by_run: "run".into(),
            created_at: "2026-10-22T00:00:00Z".into(),
        }
    }

    fn spec() -> IosSpec {
        IosSpec {
            device_type: TYPE.into(),
            runtime: RUNTIME.into(),
            max_devices: None,
        }
    }

    fn inventory(name: &str, device_type: &str, runtime: &str) -> String {
        serde_json::json!({"devices": {runtime: [{
            "udid": A, "name": name, "state": "Shutdown", "isAvailable": true,
            "deviceTypeIdentifier": device_type,
        }]}})
        .to_string()
    }

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qaren-pool-unit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn records_round_trip_private_and_a_malformed_record_refuses() {
        let root = temp_root();
        assert!(load_all(&root).unwrap().is_empty());
        write(&root, &member(A)).unwrap();
        assert_eq!(load_all(&root).unwrap(), vec![member(A)]);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(record_path(&root, A))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);

        std::fs::write(record_path(&root, A), "{not json").unwrap();
        let failure = load_all(&root).unwrap_err();
        assert_eq!(failure.code, FailureCode::RunRecordInvalid);
        assert!(failure.detail.to_string().contains(&format!("{A}.json")));

        let mut renamed = member(A);
        renamed.udid = "AAAABBBB-1111-2222-3333-444455556666".into();
        std::fs::write(
            record_path(&root, A),
            serde_json::to_string(&renamed).unwrap(),
        )
        .unwrap();
        assert_eq!(
            load_all(&root).unwrap_err().code,
            FailureCode::RunRecordInvalid
        );
    }

    #[test]
    fn only_a_proven_absent_member_is_pruned() {
        let root = temp_root();
        write(&root, &member(A)).unwrap();
        let members = load_all(&root).unwrap();

        let unparseable = present(&members, "not json");
        assert_eq!(
            unparseable, members,
            "an unreadable inventory proves nothing"
        );
        prune(&root, &members, &unparseable).unwrap();
        assert!(record_path(&root, A).exists());

        let kept = present(&members, &inventory("qaren-pool-run", TYPE, RUNTIME));
        assert_eq!(kept, members);

        let gone = present(&members, r#"{"devices":{}}"#);
        assert!(gone.is_empty());
        prune(&root, &members, &gone).unwrap();
        assert!(!record_path(&root, A).exists());
    }

    #[test]
    fn proof_needs_name_device_type_and_runtime_to_match_record_and_scenario() {
        let m = member(A);
        let ok = inventory("qaren-pool-run", TYPE, RUNTIME);
        assert_eq!(proven(&m, &ok, &spec()).unwrap().udid, A);
        assert!(proven(&m, &inventory("Company", TYPE, RUNTIME), &spec()).is_none());
        assert!(proven(
            &m,
            &inventory(
                "qaren-pool-run",
                "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
                RUNTIME
            ),
            &spec()
        )
        .is_none());
        assert!(proven(
            &m,
            &inventory(
                "qaren-pool-run",
                TYPE,
                "com.apple.CoreSimulator.SimRuntime.iOS-26-5"
            ),
            &spec()
        )
        .is_none());
        let mut other = spec();
        other.runtime = "com.apple.CoreSimulator.SimRuntime.iOS-26-5".into();
        assert!(proven(&m, &ok, &other).is_none());
    }
}
