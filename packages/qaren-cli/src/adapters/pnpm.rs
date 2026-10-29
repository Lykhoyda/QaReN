use crate::exec::{CmdSpec, Runner};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const GROUP_OK: &str = "qaren-pnpm-group-ok\n";
pub const GROUP_FIX: &str = "select a pnpm version whose exec preserves process groups (Corepack's pnpm@11.5.2 JavaScript launcher is supported); for a bootstrap shim, put its matching installed pnpm executable first on this command's PATH, then re-run qaren doctor and qaren check";

pub fn source(runner: &dyn Runner) -> Option<(PathBuf, PathBuf)> {
    let path = runner.env_var("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let entry = dir.join("pnpm");
        let meta = std::fs::metadata(&entry).ok()?;
        if !meta.is_file() || meta.permissions().mode() & 0o111 == 0 {
            return None;
        }
        let resolved = std::fs::canonicalize(&entry).ok()?;
        Some((entry, resolved))
    })
}

pub fn source_detail(runner: &dyn Runner) -> String {
    match source(runner) {
        Some((entry, resolved)) => {
            format!(
                "pnpm at {} resolves to {}",
                entry.display(),
                resolved.display()
            )
        }
        None => "pnpm source could not be resolved on PATH".to_string(),
    }
}

pub fn group_probe_spec(project_root: &Path) -> CmdSpec {
    // No server starts: the probe exits even when a bootstrapper creates another group.
    const SCRIPT: &str = r#"QAREN_PNPM_LAUNCH_GROUP=$$
export QAREN_PNPM_LAUNCH_GROUP
exec pnpm --silent exec /bin/sh -c 'group=$(/bin/ps -o pgid= -p "$$") || exit 1
[ "$group" -eq "$QAREN_PNPM_LAUNCH_GROUP" ] || exit 1
printf "qaren-pnpm-group-ok\n"'"#;
    CmdSpec::new("pnpm-group-probe", "/bin/sh", &["-c", SCRIPT], 30)
        .cwd(project_root)
        .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
}
