pub mod actions;
pub mod adapters;
pub mod buildplan;
pub mod cancel;
pub mod candidate;
pub mod client;
pub mod commands;
pub mod config;
pub mod core;
pub mod events;
pub mod exec;
pub mod failure;
pub mod fingerprint;
pub mod flow;
pub mod github;
pub mod handoff;
pub mod host_capacity;
pub mod ios_toolchain;
pub mod lease;
pub mod native;
pub mod native_suite;
pub mod pool;
pub mod process_observation;
pub mod progress;
pub mod publish;
pub mod receipt;
pub mod recipes;
pub mod record;
pub mod redact;
pub mod report;
pub mod run;
pub mod runrecord;
pub mod scenario;
pub mod timefmt;
pub mod watch;
pub mod worktree;

// Source builds set QAREN_VERSION to <release>-dev.<commit> so they never share a release's runtime.
pub const VERSION: &str = match option_env!("QAREN_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

// QAREN_HOME moves runs, state and runtimes; device locks and the native cache never follow it.
pub fn qaren_home(
    qaren_home: Option<&std::ffi::OsStr>,
    home: Option<&std::ffi::OsStr>,
) -> Result<std::path::PathBuf, String> {
    match qaren_home.filter(|value| !value.is_empty()) {
        Some(value) if std::path::Path::new(value).is_absolute() => Ok(value.into()),
        Some(_) => Err("QAREN_HOME is not an absolute path".to_string()),
        None => match home.filter(|value| !value.is_empty()) {
            Some(value) if std::path::Path::new(value).is_absolute() => {
                Ok(std::path::Path::new(value).join(".qaren"))
            }
            _ => Err("HOME is not an absolute path".to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::qaren_home;
    use std::ffi::OsStr;
    use std::path::Path;

    #[test]
    fn qaren_home_defaults_to_home_and_takes_only_an_absolute_override() {
        let home = Some(OsStr::new("/home-a"));
        assert_eq!(qaren_home(None, home).unwrap(), Path::new("/home-a/.qaren"));
        assert_eq!(
            qaren_home(Some(OsStr::new("")), home).unwrap(),
            Path::new("/home-a/.qaren")
        );
        assert_eq!(
            qaren_home(Some(OsStr::new("/side")), home).unwrap(),
            Path::new("/side")
        );
        assert_eq!(
            qaren_home(Some(OsStr::new("/side")), None).unwrap(),
            Path::new("/side")
        );
        assert!(qaren_home(Some(OsStr::new("side")), home)
            .unwrap_err()
            .contains("QAREN_HOME"));
        assert!(qaren_home(None, Some(OsStr::new("rel")))
            .unwrap_err()
            .contains("HOME"));
        assert!(qaren_home(None, None).is_err());
    }
}
