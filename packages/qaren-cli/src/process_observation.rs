use serde::Serialize;
use std::ffi::OsString;
use std::io::Write;

pub const HELPER_ARG: &str = "--internal-process-observation";
const ARGV_ARG: &str = "--argv";
const INSPECT_IOS_PATHS_ARG: &str = "--inspect-ios-paths";
// Keeps the helper's JSON inside the caller's 32 KiB output buffer even when escaped.
const ARGV_LIMIT: usize = 8 * 1024;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Birth {
    pub seconds: u64,
    pub micros: u64,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Observation {
    v: u8,
    pub pid: i32,
    pub birth: Birth,
    pub executable: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
    #[serde(rename = "iosPathInspection", skip_serializing_if = "Option::is_none")]
    pub ios_path_inspection: Option<IosPathInspection>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct IosPathInspection {
    status: &'static str,
    #[serde(rename = "unresolvedPath")]
    unresolved_path: &'static str,
}

// Stop at argc: the remaining bytes are environment, not inspection evidence.
#[cfg(any(test, target_os = "macos"))]
fn parse_procargs(buffer: &[u8]) -> Option<Vec<String>> {
    Some(
        procargs_fields(buffer, Some(ARGV_LIMIT))?
            .into_iter()
            .map(str::to_owned)
            .collect(),
    )
}

#[cfg(any(test, target_os = "macos"))]
fn procargs_fields(buffer: &[u8], limit: Option<usize>) -> Option<Vec<&str>> {
    let argc = i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?);
    if !(1..=4096).contains(&argc) {
        return None;
    }
    let mut rest = &buffer[4..];
    rest = &rest[rest.iter().position(|byte| *byte == 0)?..];
    rest = &rest[rest.iter().position(|byte| *byte != 0)?..];
    let mut argv = Vec::with_capacity(argc as usize);
    let mut total = 0;
    for _ in 0..argc {
        let end = rest.iter().position(|byte| *byte == 0)?;
        total += end;
        if limit.is_some_and(|limit| total > limit) {
            return None;
        }
        argv.push(std::str::from_utf8(&rest[..end]).ok()?);
        rest = &rest[end + 1..];
    }
    Some(argv)
}

#[cfg(any(test, target_os = "macos"))]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IosPathPatterns {
    exact: Vec<String>,
    prefix: String,
    word_extension: String,
    suffixes: Vec<String>,
    containers: Vec<String>,
    java: String,
    java_entrypoint: String,
}

#[cfg(any(test, target_os = "macos"))]
fn ios_path_patterns() -> Option<&'static IosPathPatterns> {
    static PATTERNS: std::sync::OnceLock<Option<IosPathPatterns>> = std::sync::OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            // Embed the screen child's specification, not a second list of driver names.
            let source = include_str!("../../qaren-core/src/runners/external-runner-detect.ts");
            let json = source
                .split_once("export const IOS_PATH_PATTERN_SPEC = String.raw`")?
                .1
                .split_once('`')?
                .0;
            serde_json::from_str(json).ok()
        })
        .as_ref()
}

#[cfg(any(test, target_os = "macos"))]
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\x0b' | '\x0c' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

#[cfg(any(test, target_os = "macos"))]
fn ascii_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

#[cfg(any(test, target_os = "macos"))]
fn has_unresolved_ios_path(command: &str) -> Option<bool> {
    let patterns = ios_path_patterns()?;
    let command = command.to_ascii_lowercase();
    let has_java = command.split(js_space).any(|word| {
        word.strip_prefix(&patterns.java_entrypoint)
            .is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix
                        .chars()
                        .all(|c| ascii_word(c) || c == '.' || c == '$')
            })
    });
    let mut components = command.split('/').skip(1).peekable();
    while let Some(component) = components.next() {
        if component.starts_with(&patterns.prefix)
            || (components.peek().is_some()
                && patterns
                    .containers
                    .iter()
                    .any(|part| component.contains(part)))
        {
            return Some(true);
        }
        let extension_end = component
            .strip_prefix(&patterns.word_extension)
            .and_then(|suffix| {
                let length = suffix.chars().take_while(|c| ascii_word(*c)).count();
                (length > 0).then_some(patterns.word_extension.len() + length)
            });
        for (end, c) in component
            .char_indices()
            .chain(std::iter::once((component.len(), '\0')))
        {
            if end != component.len() && !js_space(c) && c != '"' && c != '\'' {
                continue;
            }
            let candidate = &component[..end];
            if patterns.exact.iter().any(|name| name == candidate)
                || extension_end == Some(end)
                || patterns
                    .suffixes
                    .iter()
                    .any(|suffix| candidate.ends_with(suffix))
                || (has_java && candidate == patterns.java)
            {
                return Some(true);
            }
            if js_space(c) {
                break;
            }
        }
    }
    Some(false)
}

#[cfg(any(test, target_os = "macos"))]
fn inspect_ios_paths(buffer: &[u8]) -> Option<IosPathInspection> {
    let rest = buffer.get(4..)?;
    let path_end = rest.iter().position(|byte| *byte == 0)?;
    let path = std::str::from_utf8(&rest[..path_end]).ok()?;
    if !valid_path(path) {
        return None;
    }
    let argv = procargs_fields(buffer, None)?;
    let command = format!("{path} {}", argv.join(" "));
    Some(IosPathInspection {
        status: "complete",
        unresolved_path: if has_unresolved_ios_path(&command)? {
            "present"
        } else {
            "absent"
        },
    })
}

#[cfg(any(test, target_os = "macos"))]
fn valid_path(path: &str) -> bool {
    path.starts_with('/') && path.len() < 4096 && !path.chars().any(char::is_control)
}

#[cfg(any(test, target_os = "macos"))]
fn valid_birth(seconds: u64, micros: u64) -> bool {
    seconds > 0 && micros < 1_000_000
}

pub fn run_helper(args: &[OsString]) -> u8 {
    let with_argv = args.len() == 3 && args[2] == ARGV_ARG;
    let inspect_paths = args.len() == 3 && args[2] == INSPECT_IOS_PATHS_ARG;
    let observation = if (args.len() == 2 || with_argv || inspect_paths) && args[0] == HELPER_ARG {
        args[1]
            .to_str()
            .and_then(|pid| pid.parse::<i32>().ok())
            .filter(|pid| *pid > 0)
            .and_then(|pid| observe_mode(pid, with_argv, inspect_paths))
    } else {
        None
    };
    let (line, exit) = match observation {
        Some(observation) => (serde_json::to_string(&observation).unwrap(), 0),
        None => (r#"{"v":1,"status":"unknown"}"#.to_string(), 4),
    };
    if writeln!(std::io::stdout().lock(), "{line}").is_err() {
        return 4;
    }
    exit
}

pub fn observe(pid: i32, with_argv: bool) -> Option<Observation> {
    observe_mode(pid, with_argv, false)
}

#[cfg(not(target_os = "macos"))]
fn observe_mode(_pid: i32, _with_argv: bool, _inspect_paths: bool) -> Option<Observation> {
    None
}

#[cfg(target_os = "macos")]
fn observe_mode(pid: i32, with_argv: bool, inspect_paths: bool) -> Option<Observation> {
    observe_with(
        pid,
        with_argv,
        inspect_paths,
        || identity(pid),
        || executable_path(pid),
        || arguments(pid),
    )
}

#[cfg(any(test, target_os = "macos"))]
fn observe_with(
    pid: i32,
    with_argv: bool,
    inspect_paths: bool,
    mut identity: impl FnMut() -> Option<Birth>,
    mut executable_path: impl FnMut() -> Option<String>,
    mut arguments: impl FnMut() -> Option<Vec<u8>>,
) -> Option<Observation> {
    if pid <= 0 {
        return None;
    }
    let first = identity()?;
    let first_path = executable_path()?;
    let buffer = if with_argv || inspect_paths {
        Some(arguments()?)
    } else {
        None
    };
    let argv = if with_argv {
        Some(parse_procargs(buffer.as_ref()?)?)
    } else {
        None
    };
    let ios_path_inspection = if inspect_paths {
        Some(inspect_ios_paths(buffer.as_ref()?)?)
    } else {
        None
    };
    let second = identity()?;
    let second_path = executable_path()?;
    let third = identity()?;
    if first != second || second != third || first_path != second_path {
        return None;
    }
    Some(Observation {
        v: 1,
        pid,
        birth: first,
        executable: first_path,
        argv,
        ios_path_inspection,
    })
}

#[cfg(target_os = "macos")]
fn arguments(pid: i32) -> Option<Vec<u8>> {
    let mut argmax: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&mut argmax as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 || size != std::mem::size_of::<libc::c_int>() || argmax <= 0 {
        return None;
    }
    let mut buffer = vec![0u8; argmax as usize];
    let mut size = buffer.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 || size > buffer.len() {
        return None;
    }
    buffer.truncate(size);
    Some(buffer)
}

#[cfg(target_os = "macos")]
fn identity(pid: i32) -> Option<Birth> {
    use std::mem::{size_of, MaybeUninit};
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = size_of::<libc::proc_bsdinfo>();
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as libc::c_int,
        )
    };
    if read != size as libc::c_int {
        return None;
    }
    let info = unsafe { info.assume_init() };
    if !valid_info(pid, &info) {
        return None;
    }
    Some(Birth {
        seconds: info.pbi_start_tvsec,
        micros: info.pbi_start_tvusec,
    })
}

#[cfg(target_os = "macos")]
fn valid_info(pid: i32, info: &libc::proc_bsdinfo) -> bool {
    info.pbi_pid == pid as u32
        && info.pbi_status != libc::SZOMB
        && info.pbi_status != 0
        && valid_birth(info.pbi_start_tvsec, info.pbi_start_tvusec)
}

#[cfg(target_os = "macos")]
fn executable_path(pid: i32) -> Option<String> {
    let mut buffer = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let len = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if len <= 0 || len as usize >= buffer.len() {
        return None;
    }
    let len = len as usize;
    let end = buffer[..=len].iter().position(|byte| *byte == 0)?;
    if end != len && end + 1 != len {
        return None;
    }
    let path = std::str::from_utf8(&buffer[..end]).ok()?;
    valid_path(path).then(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_birth_and_paths() {
        assert!(!valid_birth(0, 12));
        assert!(!valid_birth(1, 1_000_000));
        assert!(valid_birth(1, 999_999));
        for path in [
            "",
            "relative",
            "/line\nbreak",
            "/nul\0byte",
            "/tab\t",
            &"/a".repeat(4096),
        ] {
            assert!(!valid_path(path));
        }
        assert!(valid_path(
            "/Applications/Test App.app/Contents/MacOS/テスト"
        ));
    }

    #[test]
    fn invalid_pids_never_produce_evidence() {
        for with_argv in [false, true] {
            assert!(observe(0, with_argv).is_none());
            assert!(observe(-1, with_argv).is_none());
        }
    }

    fn procargs(argc: i32, path: &str, padding: usize, args: &[&str], env: &[&str]) -> Vec<u8> {
        let mut buffer = argc.to_ne_bytes().to_vec();
        buffer.extend_from_slice(path.as_bytes());
        buffer.extend(std::iter::repeat_n(0u8, padding));
        for part in args.iter().chain(env) {
            buffer.extend_from_slice(part.as_bytes());
            buffer.push(0);
        }
        buffer
    }

    #[test]
    fn procargs_reads_exactly_argc_strings_and_never_the_environment() {
        let args = [
            "xcodebuild",
            "-destination",
            "platform=iOS Simulator,id=AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB",
        ];
        let buffer = procargs(
            3,
            "/usr/bin/xcodebuild",
            3,
            &args,
            &["TYPESAFE_API_KEY=secret", "HOME=/Users/x"],
        );
        let parsed = parse_procargs(&buffer).unwrap();
        assert_eq!(parsed, args);
        assert!(!format!("{parsed:?}").contains("secret"));
    }

    #[test]
    fn procargs_fail_closed_on_malformed_or_oversized_buffers() {
        assert_eq!(parse_procargs(&[1, 0]), None);
        assert_eq!(parse_procargs(&procargs(0, "/bin/x", 1, &[], &[])), None);
        assert_eq!(
            parse_procargs(&procargs(3, "/bin/x", 1, &["a", "b"], &[])),
            None
        );
        let big = "x".repeat(ARGV_LIMIT + 1);
        assert_eq!(
            parse_procargs(&procargs(1, "/bin/x", 1, &[&big], &[])),
            None
        );
        let mut invalid = procargs(1, "/bin/x", 1, &["ok"], &[]);
        let at = invalid.len() - 2;
        invalid[at] = 0xff;
        assert_eq!(parse_procargs(&invalid), None);
    }

    #[test]
    fn quote_heavy_non_paths_have_bounded_inspection_cost() {
        let command = format!(
            "/usr/local/bin/node -e /maestro.{}+{}",
            "x".repeat(7500),
            "\"".repeat(7500)
        );
        let buffer = procargs(3, "/bin/node", 1, &["node", "-e", &command], &[]);
        let started = std::time::Instant::now();
        for _ in 0..4 {
            assert_eq!(
                inspect_ios_paths(&buffer).unwrap().unresolved_path,
                "absent"
            );
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "quote-heavy inspection took {elapsed:?}"
        );
    }

    #[test]
    fn shared_path_fixtures_match_before_and_beyond_display_and_argv_limits() {
        let fixtures: Vec<(String, bool)> = serde_json::from_str(include_str!(
            "../../qaren-core/test/unit/qa/ios-path-patterns.json"
        ))
        .unwrap();
        for (command, expected) in fixtures {
            assert_eq!(
                has_unresolved_ios_path(&command),
                Some(expected),
                "{command}"
            );
            let deep = format!("/bin/node -e {} {command}", "x".repeat(30_001));
            assert_eq!(has_unresolved_ios_path(&deep), Some(expected), "{command}");
            let buffer = procargs(3, "/bin/node", 3, &["node", "-e", &deep], &[]);
            let inspection = inspect_ios_paths(&buffer).unwrap();
            assert_eq!(
                inspection.unresolved_path,
                if expected { "present" } else { "absent" }
            );
            assert!(
                parse_procargs(&buffer).is_none(),
                "exact argv cap is unchanged"
            );
        }
    }

    #[test]
    fn inspection_validates_all_arguments_even_after_a_match_and_ignores_environment() {
        let valid = procargs(3, "/bin/node", 3, &["node", "-e", "/tmp/XCTRunner"], &[]);
        let mut invalid_utf8 = valid.clone();
        let last = invalid_utf8.len() - 2;
        invalid_utf8[last] = 0xff;
        let mut truncated = valid.clone();
        truncated.pop();
        let mut truncated_after_match =
            procargs(4, "/bin/node", 1, &["node", "-e", "/tmp/XCTRunner"], &[]);
        truncated_after_match.extend_from_slice(b"no-terminator");
        for invalid in [
            vec![],
            vec![1, 0],
            1i32.to_ne_bytes().to_vec(),
            procargs(0, "/bin/node", 1, &[], &[]),
            procargs(-1, "/bin/node", 1, &["node"], &[]),
            procargs(4097, "/bin/node", 1, &["node"], &[]),
            procargs(4, "/bin/node", 1, &["node", "-e", "program"], &[]),
            procargs(1, "relative", 1, &["node"], &[]),
            procargs(1, "/bin/node", 0, &[], &[]),
            invalid_utf8,
            truncated,
            truncated_after_match,
        ] {
            assert!(inspect_ios_paths(&invalid).is_none());
        }
        let mut buffer = procargs(
            4,
            "/bin/node",
            3,
            &["node", "-e", "program", ""],
            &["PRIVATE_CANARY=/tmp/XCTRunner maestro.cli.AppKt"],
        );
        buffer.extend_from_slice(b"INVALID_ENV=\xff\0");
        assert_eq!(
            inspect_ios_paths(&buffer).unwrap().unresolved_path,
            "absent"
        );
        assert!(inspect_ios_paths(&valid).is_some());
    }

    #[test]
    fn complete_inspection_is_content_free_and_does_not_scale_output_with_argv() {
        for size in [200, 35_112, 256 * 1024] {
            let program = format!("PRIVATE_PROGRAM_CANARY{}", "x".repeat(size));
            let buffer = procargs(
                3,
                "/bin/node",
                1,
                &["node", "-e", &program],
                &["PRIVATE_ENV_CANARY=/tmp/WebDriverAgent"],
            );
            let observation = observe_with(
                42,
                false,
                true,
                || {
                    Some(Birth {
                        seconds: 1,
                        micros: 0,
                    })
                },
                || Some("/bin/node".into()),
                || Some(buffer.clone()),
            )
            .unwrap();
            let json = serde_json::to_string(&observation).unwrap();
            assert_eq!(
                json,
                r#"{"v":1,"pid":42,"birth":{"seconds":1,"micros":0},"executable":"/bin/node","iosPathInspection":{"status":"complete","unresolvedPath":"absent"}}"#
            );
            assert!(json.len() < 512);
            assert!(!json.contains("CANARY"));
            assert!(observation.argv.is_none());
        }
    }

    #[test]
    fn inspection_refuses_unreadable_arguments_and_identity_changes_on_either_side() {
        let buffer = procargs(3, "/bin/node", 1, &["node", "-e", "program"], &[]);
        for (births, paths, readable) in [
            (
                [Some(1), Some(2), Some(2)],
                [Some("/bin/node"), Some("/bin/node")],
                true,
            ),
            (
                [Some(1), Some(1), Some(2)],
                [Some("/bin/node"), Some("/bin/node")],
                true,
            ),
            (
                [None, Some(1), Some(1)],
                [Some("/bin/node"), Some("/bin/node")],
                true,
            ),
            (
                [Some(1), None, Some(1)],
                [Some("/bin/node"), Some("/bin/node")],
                true,
            ),
            (
                [Some(1), Some(1), None],
                [Some("/bin/node"), Some("/bin/node")],
                true,
            ),
            (
                [Some(1), Some(1), Some(1)],
                [Some("/bin/node"), Some("/bin/python")],
                true,
            ),
            ([Some(1), Some(1), Some(1)], [None, Some("/bin/node")], true),
            ([Some(1), Some(1), Some(1)], [Some("/bin/node"), None], true),
            (
                [Some(1), Some(1), Some(1)],
                [Some("/bin/node"), Some("/bin/node")],
                false,
            ),
        ] {
            let mut births = births.into_iter();
            let mut paths = paths.into_iter();
            assert!(observe_with(
                42,
                false,
                true,
                || births
                    .next()
                    .flatten()
                    .map(|seconds| Birth { seconds, micros: 0 }),
                || paths.next().flatten().map(str::to_owned),
                || readable.then(|| buffer.clone())
            )
            .is_none());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn identity_rejects_reused_pid_zombie_and_invalid_birth() {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        info.pbi_pid = 42;
        info.pbi_status = libc::SRUN;
        info.pbi_start_tvsec = 123;
        info.pbi_start_tvusec = 999_999;
        assert!(valid_info(42, &info));
        assert!(!valid_info(43, &info));
        info.pbi_status = libc::SZOMB;
        assert!(!valid_info(42, &info));
        info.pbi_status = libc::SRUN;
        info.pbi_start_tvusec = 1_000_000;
        assert!(!valid_info(42, &info));
    }
}
