use qaren::exec::{log, RealRunner};
use qaren::{native_suite, process_observation};
use std::process::ExitCode;

fn main() -> ExitCode {
    let raw: Vec<_> = std::env::args_os().skip(1).collect();
    if raw
        .first()
        .is_some_and(|arg| arg == process_observation::HELPER_ARG)
    {
        return ExitCode::from(process_observation::run_helper(&raw));
    }
    if raw.len() == 1 && raw[0] == log::HELPER_ARG {
        return ExitCode::from(u8::from(log::run_helper(false).is_err()));
    }
    if raw.len() == 2 && raw[0] == log::HELPER_ARG && raw[1] == log::PAIRED_ARG {
        return ExitCode::from(u8::from(log::run_helper(true).is_err()));
    }
    let args: Vec<_> = raw.iter().map(|arg| arg.to_str().unwrap_or("")).collect();
    let mut runner = RealRunner::new();
    let (result, recovery) = match args.as_slice() {
        ["run", "--device", device] => (native_suite::run(&mut runner, device), false),
        ["recover", "--run-id", id] => (native_suite::recover(&mut runner, id), true),
        _ => {
            eprintln!("usage: native-ios-suite run --device <exact-UUID>\n       native-ios-suite recover --run-id <ID>");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(record) => {
            let passed = record.suite_exit == Some(0);
            let status = if recovery {
                "RECOVERED"
            } else if passed {
                "PASS"
            } else {
                "FAIL"
            };
            println!(
                "{}: {status}; suite exit={:?}; lease released",
                record.run_id, record.suite_exit
            );
            ExitCode::from(u8::from(!recovery && !passed))
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(4)
        }
    }
}
