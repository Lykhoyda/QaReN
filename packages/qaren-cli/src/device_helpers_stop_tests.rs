use super::*;
use crate::exec::{CmdOutput, PipedChild, Spawned};
use std::collections::VecDeque;
use std::time::Duration;

const SDK: &str = "/sdk/emulator";
const START: &str = "Sun Nov 15 12:34:56 2026";
fn uid() -> u32 { unsafe { libc::geteuid() } }
fn helper(pid: i64, parent: u32, owner: u32, start: &str, name: &str, folder: &str) -> String {
    ps_line_with_identity(pid, parent, owner, start, "960.0", "S", name, &format!("{folder}/{name} --grpc-uds-path /socket"))
}
fn orphan(pid: i64) -> String { helper(pid, 1, uid(), START, "netsimd", SDK) }
fn idle() -> String { ps_line(2, "0.0", "S", "idle", "/idle") }
fn emulator() -> String { ps_line(900, "0.0", "Z", "qemu-system-aarch64", "/sdk/emulator/qemu-system-aarch64 -avd Other") }

struct Expected { program: String, args: Vec<String>, output: CmdOutput }
#[derive(Default)]
struct Strict {
    script: VecDeque<Expected>,
    calls: Vec<(CmdSpec, u64)>,
    sleeps: Vec<Duration>,
    now: u64,
    command_at_limit: bool,
}
impl Strict {
    fn expect(&mut self, program: &str, args: &[&str], output: CmdOutput) {
        self.script.push_back(Expected { program: program.into(), args: args.iter().map(|s| s.to_string()).collect(), output });
    }
    fn list(&mut self, text: &str) { self.list_output(CmdOutput::success(text)); }
    fn list_output(&mut self, output: CmdOutput) { self.expect("ps", &["-axww", "-o", PROCESS_COLUMNS], output); }
    fn package(&mut self, folder: &str) {
        self.expect("/bin/sh", &["-c", PACKAGE_READ, "sh", &format!("{folder}/source.properties")], CmdOutput::success("Pkg.Path=emulator\n"));
    }
    fn signal(&mut self, kind: &str, pid: i64) { self.expect("/bin/kill", &[kind, &pid.to_string()], CmdOutput::success("")); }
    fn begin(&mut self, text: &str) { self.list(text); self.package(SDK); }
    fn term(&mut self, text: &str, pid: i64) { self.list(text); self.signal("-TERM", pid); }
    fn done(&self) {
        assert!(self.script.is_empty(), "{} expected calls not made", self.script.len());
        for (call, _) in &self.calls {
            assert_eq!(call.cwd.as_deref(), Some(Path::new("/")));
            if call.program == "/bin/kill" {
                assert_eq!(call.label, "device-helper-signal");
                assert_eq!(call.timeout_seconds, 2);
                assert_eq!(call.args.len(), 2);
                assert!(matches!(call.args[0].as_str(), "-TERM" | "-KILL"));
                assert!(call.args[1].parse::<u32>().unwrap() > 1);
            } else { assert_eq!(call.label, "device-helpers"); }
        }
    }
}
impl Runner for Strict {
    fn execute(&mut self, spec: &CmdSpec, _: bool) -> CmdOutput {
        let expected = self.script.pop_front().unwrap_or_else(|| panic!("unexpected command: {} ({})", spec.rendered(), spec.label));
        assert_eq!(spec.program, expected.program);
        assert_eq!(spec.args, expected.args);
        self.calls.push((spec.clone(), self.now));
        if self.command_at_limit { self.now += spec.timeout_seconds * 1000; }
        expected.output
    }
    fn spawn_group_unchecked(&mut self, _: &CmdSpec, _: &Path) -> std::io::Result<Spawned> { panic!("no spawn") }
    fn spawn_piped_unchecked(&mut self, _: &CmdSpec, _: &Path) -> std::io::Result<PipedChild> { panic!("no spawn") }
    fn sleep(&mut self, duration: Duration) { self.sleeps.push(duration); self.now += duration.as_millis() as u64; }
    fn now_epoch_ms(&self) -> u64 { self.now }
    fn commands_executed(&self) -> u64 { self.calls.len() as u64 }
}

#[test]
fn s1_s10_term_then_one_poll_and_only_one_pid_per_signal() {
    let text = orphan(4242); let mut r = Strict::default();
    r.begin(&text); r.term(&text, 4242); r.list(&idle());
    let scan = stop_orphans(&mut r, "macos", true);
    assert_eq!(scan.helpers[0].outcome, Outcome::StoppedTerm);
    assert_eq!(scan.helpers[0].signals, [Signal::Term]);
    r.done(); assert_eq!(r.calls.len(), 5);
}
fn kill_script(final_text: &str) -> Strict {
    let text = orphan(4242); let mut r = Strict::default();
    r.begin(&text); r.term(&text, 4242);
    for _ in 0..5 { r.list(&text); }
    r.list(&text); r.signal("-KILL", 4242); r.list(final_text); r
}
#[test]
fn s2_ignores_term_five_seconds_then_kill() {
    let mut r = kill_script(&idle());
    let scan = stop_orphans(&mut r, "macos", true);
    assert_eq!(scan.helpers[0].outcome, Outcome::StoppedKill);
    assert_eq!(scan.helpers[0].signals, [Signal::Term, Signal::Kill]); r.done();
    let times: Vec<_> = r.calls.iter().filter(|(c,_)| c.program == "/bin/kill").map(|(_,at)| *at).collect();
    assert!(times[1]-times[0] >= 5000);
    assert_eq!(r.sleeps, [vec![Duration::from_secs(1);5], vec![Duration::from_millis(300)]].concat());
}
#[test]
fn s3_survives_kill_is_reported() {
    let mut r = kill_script(&orphan(4242));
    let scan = stop_orphans(&mut r, "macos", true);
    assert_eq!(scan.helpers[0].outcome, Outcome::SurvivedKill); r.done();
}
#[test]
fn s4_emulator_appears_at_poll_three() {
    let text=orphan(4242); let live=text.clone()+&emulator(); let mut r=Strict::default();
    r.begin(&text); r.term(&text,4242);
    for n in 0..5 { r.list(if n<2 { &text } else { &live }); }
    r.list(&live);
    let scan=stop_orphans(&mut r,"macos",true);
    assert_eq!(scan.helpers[0].outcome,Outcome::LeftAlone); r.done();
}
#[test]
fn s6_pid_reuse_is_gone_without_kill() {
    let text=orphan(4242); let mut r=Strict::default(); r.begin(&text); r.term(&text,4242);
    r.list(&text.replace("12:34:56","12:34:57"));
    let scan=stop_orphans(&mut r,"macos",true);
    assert_eq!(scan.helpers[0].outcome,Outcome::StoppedTerm); r.done();
}
#[test]
fn s7_initial_timeout_is_nonfatal() {
    let mut r=Strict::default(); r.list_output(CmdOutput {timed_out:true,..Default::default()});
    assert!(stop_orphans(&mut r,"macos",true).helpers.is_empty()); r.done();
}
#[test]
fn s8_failed_or_incomplete_poll_stops_all_signals() {
    for output in [CmdOutput::failed(1,"unavailable"), CmdOutput {timed_out:true,..Default::default()},CmdOutput::success(&(orphan(4242)+"one two three four five six seven eight nine\n"))] {
        let text=orphan(4242); let mut r=Strict::default();r.begin(&text);r.term(&text,4242);r.list_output(output);
        let scan=stop_orphans(&mut r,"macos",true);assert_eq!(scan.helpers[0].outcome,Outcome::Unknown);r.done();
    }
}
#[test]
fn s9_four_terms_before_a_shared_wait_and_fifth_is_only_listed() {
    for count in [2,5] {
        let text=(0..count).map(|n|orphan(4242+n)).collect::<String>();let mut r=Strict::default();r.begin(&text);
        for n in 0..count.min(4) {r.term(&text,4242+n);}
        for _ in 0..5 {r.list(&text);}
        for n in 0..count.min(4) {r.list(&text);r.signal("-KILL",4242+n);}
        r.list(&idle());
        let scan=stop_orphans(&mut r,"macos",true);
        assert!(scan.helpers[..count.min(4) as usize].iter().all(|f|f.outcome==Outcome::StoppedKill));
        if count==5 {assert_eq!(scan.helpers[4].outcome,Outcome::Listed);}
        r.done();assert_eq!(r.sleeps.iter().filter(|d| **d==Duration::from_secs(1)).count(),5);
        let first_sleep_list=2+count.min(4) as usize*2;
        assert!(r.calls[..first_sleep_list].iter().all(|(_,at)|*at==0));
    }
}
#[test]
fn s11_u9_signal_false_lists_without_connections_or_signals() {
    let mut r=Strict::default();r.begin(&orphan(4242));
    let scan=stop_orphans(&mut r,"macos",false);
    assert_eq!(scan.helpers[0].outcome,Outcome::Listed);r.done();assert_eq!(r.calls.len(),2);
}
#[test]
fn s12_deadline_is_checked_before_every_command_and_sleep() {
    let text=(0..4).map(|n|helper(4242+n,1,uid(),START,"netsimd",&format!("/sdk{n}/emulator"))).collect::<String>();
    let mut r=Strict{command_at_limit:true,..Default::default()};r.list(&text);
    for n in 0..4 {r.package(&format!("/sdk{n}/emulator"));}
    r.list(&text);r.signal("-TERM",4242);
    let scan=stop_orphans(&mut r,"macos",true);
    assert!(scan.helpers.iter().all(|f|f.outcome==Outcome::Unknown));r.done();
    assert!(r.calls.iter().all(|(_,at)|*at<15000));assert!(r.sleeps.is_empty());
}
#[test]
fn s13_stop_entry_rejects_every_unsafe_first_list() {
    for text in [orphan(4242)+"one two three four five six seven eight nine\n",helper(4242,900,uid(),START,"netsimd",SDK),helper(4242,1,uid()+1,START,"netsimd",SDK),orphan(4242)+&emulator()] {
        let mut r=Strict::default();r.begin(&text);
        let scan=stop_orphans(&mut r,"macos",true);assert_eq!(scan.helpers[0].outcome,Outcome::Listed);r.done();
        assert!(r.calls.iter().all(|(c,_)|c.label!="device-helper-signal"));
    }
}
#[test]
fn s14a_emulator_starts_during_four_package_reads() {
    let text=(0..4).map(|n|helper(4242+n,1,uid(),START,"netsimd",&format!("/sdk{n}/emulator"))).collect::<String>();
    let live=text.clone()+&emulator();let mut r=Strict::default();r.list(&text);
    for n in 0..4 {r.package(&format!("/sdk{n}/emulator"));}
    for _ in 0..4 {r.list(&live);}
    let scan=stop_orphans(&mut r,"macos",true);assert!(scan.helpers.iter().all(|f|f.outcome==Outcome::LeftAlone));r.done();
}
#[test]
fn s14b_second_identity_changes_before_its_term() {
    let text=orphan(4242)+&orphan(4243);let changed=text.replace("4243 1", "4243 1").replacen("12:34:56 2026 netsimd", "12:34:57 2026 netsimd", 2);
    let mut r=Strict::default();r.begin(&text);r.term(&text,4242);r.list(&changed);r.list(&idle());
    let scan=stop_orphans(&mut r,"macos",true);assert_eq!(scan.helpers[0].outcome,Outcome::StoppedTerm);assert_eq!(scan.helpers[1].outcome,Outcome::LeftAlone);r.done();
}
#[test]
fn s14c_new_parented_network_helper_prevents_crash_reporter_kill() {
    let text=helper(4243,1,uid(),START,"crashpad_handler",SDK);
    let changed=text.clone()+&helper(4242,900,uid(),START,"netsimd",SDK);
    let mut r=Strict::default();r.begin(&text);r.term(&text,4243);for _ in 0..5 {r.list(&text);}r.list(&changed);
    let scan=stop_orphans(&mut r,"macos",true);assert_eq!(scan.helpers[0].outcome,Outcome::LeftAlone);r.done();
}
#[test]
fn s14d_owner_changes_before_kill() {
    let text=orphan(4242);let changed=helper(4242,1,uid()+1,START,"netsimd",SDK);
    let mut r=Strict::default();r.begin(&text);r.term(&text,4242);for _ in 0..5 {r.list(&text);}r.list(&changed);
    let scan=stop_orphans(&mut r,"macos",true);assert_eq!(scan.helpers[0].outcome,Outcome::LeftAlone);r.done();
}
