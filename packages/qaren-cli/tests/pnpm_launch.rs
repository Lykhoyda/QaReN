mod common;

use qaren::adapters::pnpm::{group_probe_spec, source, GROUP_OK};
use qaren::exec::{MockRunner, RealRunner, Runner};
use std::os::unix::fs::{symlink, PermissionsExt};

#[test]
fn exec_probe_accepts_preserved_groups_and_refuses_bootstrap_group_changes() {
    for body in [
        "shift; exec \"$@\"",
        "shift; set -m; \"$@\" & child=$!; wait \"$child\"",
    ] {
        let root = common::temp_repo();
        let bin = root.join("bin with spaces");
        std::fs::create_dir(&bin).unwrap();
        let launcher = bin.join("pnpm");
        std::fs::write(&launcher, format!("#!/bin/bash\n{body}\n")).unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let spec = group_probe_spec(&root).env("PATH", bin.to_str().unwrap());
        let output = RealRunner::new().run(&spec);
        if body.contains("set -m") {
            assert!(!output.ok(), "{output:?}");
            assert_ne!(output.stdout, GROUP_OK);
        } else {
            assert!(output.ok(), "{output:?}");
            assert_eq!(output.stdout, GROUP_OK);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn source_reports_first_executable_path_entry_and_its_resolved_target() {
    let root = common::temp_repo();
    let bin = root.join("bin");
    let target = root.join("corepack/dist/pnpm.js");
    std::fs::create_dir(&bin).unwrap();
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, "#!/usr/bin/env node\n").unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
    symlink(&target, bin.join("pnpm")).unwrap();
    let mut runner = MockRunner::new();
    runner
        .environment
        .insert("PATH".into(), format!("{}:/usr/bin", bin.display()));
    assert_eq!(source(&runner), Some((bin.join("pnpm"), target)));
    std::fs::remove_dir_all(root).unwrap();
}
