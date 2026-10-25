import { execFile, spawn } from '../domain/cancellation.js';
import { promisify } from 'node:util';

export interface AndroidExternalRunnerWarning {
  platform: 'android';
  code: 'ANDROID_UIAUTOMATOR_COMPETITOR';
  message: string;
  processLines: string[];
}

const ANDROID_ADVISORY_DRIVER = /uiautomator|agent-device|AgentDevice/i;
// A destructive reset also refuses Maestro's driver app and any other instrumentation.
const ANDROID_STRICT_DRIVER = /uiautomator|agent-device|AgentDevice|maestro|instrument/i;
const ANDROID_PS_OPTIONS = { timeout: 2_000, encoding: 'utf8' as const };

// `ps -A` rows naming a UI driver, never QaReN's own runner package.
function androidDriverLines(stdout: string, driver: RegExp): string[] {
  return stdout
    .split('\n')
    .filter((line) => driver.test(line))
    .filter((line) => !/dev\.lykhoyda\.rndevagent\.androidrunner/.test(line));
}

export async function detectAndroidExternalRunner(
  execFileImpl: typeof execFile = execFile,
  serialArgs: string[] = [],
): Promise<AndroidExternalRunnerWarning | null> {
  try {
    // Accept either a callback-style execFile (production default) or an
    // async shim (unit tests). promisify on an async function returns a
    // never-resolving Promise (Node DEP0174), so when the caller passes a
    // function that already returns a Promise, use it directly.
    const bin = 'adb';
    const argv = [...serialArgs, 'shell', 'ps', '-A'];
    const opts = ANDROID_PS_OPTIONS;
    const run =
      execFileImpl === execFile
        ? promisify(execFileImpl)
        : (execFileImpl as unknown as (
            b: string,
            a: string[],
            o: typeof opts,
          ) => Promise<{ stdout: string }>);
    const { stdout } = await run(bin, argv, opts);
    const lines = androidDriverLines(stdout, ANDROID_ADVISORY_DRIVER);

    if (lines.length === 0) return null;

    return {
      platform: 'android',
      code: 'ANDROID_UIAUTOMATOR_COMPETITOR',
      message:
        'A competing Android UIAutomator or agent-device process is running. Stop it (or opt out of the in-tree runner with RN_ANDROID_RUNNER=0) to avoid focus and input contention.',
      processLines: lines,
    };
  } catch {
    return null;
  }
}

/** Admission probe for one emulator: the detector's message when another driver holds it. */
export async function androidForeignDriverMessage(
  serial: string,
  execFileImpl: typeof execFile = execFile,
): Promise<string | undefined> {
  return (await detectAndroidExternalRunner(execFileImpl, ['-s', serial]))?.message;
}

export type AndroidStrictRunnerStatus = 'clear' | 'busy' | 'unknown';

export function isAndroidEmulatorSerial(value: string): boolean {
  return /^emulator-\d{1,5}$/.test(value);
}

/** Strict admission for a destructive reset: only a readable process table without a driver is clear. */
export async function probeAndroidExternalRunnerAdmission(
  serial: string,
  execFileImpl: typeof execFile = execFile,
): Promise<{ status: AndroidStrictRunnerStatus; matched?: string }> {
  try {
    const run =
      execFileImpl === execFile
        ? promisify(execFileImpl)
        : (execFileImpl as unknown as (
            b: string,
            a: string[],
            o: typeof ANDROID_PS_OPTIONS,
          ) => Promise<{ stdout: string }>);
    const { stdout } = await run('adb', ['-s', serial, 'shell', 'ps', '-A'], ANDROID_PS_OPTIONS);
    if (typeof stdout !== 'string' || stdout.trim() === '') return { status: 'unknown' };
    const [first] = androidDriverLines(stdout, ANDROID_STRICT_DRIVER);
    if (first === undefined) return { status: 'clear' };
    return { status: 'busy', matched: first.trim().split(/\s+/).at(-1) };
  } catch {
    return { status: 'unknown' };
  }
}

export interface IosExternalRunnerWarning {
  platform: 'ios';
  code: 'IOS_XCUITEST_COMPETITOR';
  message: string;
  processLines: string[];
}

// Validated against live `ps` (2026-06-04): identify the executable/process
// structure, not arbitrary prompt text elsewhere in argv. Long-running coding
// agents commonly carry words such as Maestro/WebDriverAgent and a simulator
// UDID in their prompt; token-scanning their complete command line self-matches.
// XCTRunner remains intentionally too generic.
function executableBasename(command: string): string {
  const executable = command.trimStart().split(/\s+/, 1)[0] ?? '';
  return executable.slice(executable.lastIndexOf('/') + 1);
}

const SHELL_WRAPPERS = /^(?:sh|bash|zsh|dash|ksh|env)$/i;
const MAESTRO_JAVA_ENTRYPOINT_RE = /(?:^|\s)maestro\.cli\.[\w.$]+(?:\s|$)/i;

// `/bin/sh /usr/local/bin/maestro test flow.yaml` — the installed CLI is
// routinely a shell wrapper, so the basename of argv[0] is the shell.
function shellWrappedMaestro(command: string): boolean {
  const tokens = command.trimStart().split(/\s+/);
  if (!SHELL_WRAPPERS.test(executableBasename(tokens[0] ?? ''))) return false;
  return tokens
    .slice(1)
    .some(
      (token) => token.startsWith('/') && /^maestro(?:\.\w+)?$/i.test(executableBasename(token)),
    );
}

export function isIosExternalRunnerProcessLine(line: string): boolean {
  const match = line.match(/^\s*\d+\s+(.+)$/);
  if (!match) return false;
  const command = match[1];
  const executable = executableBasename(command);

  if (/^maestro(?:-driver-iosUITests-Runner)?$/i.test(executable)) return true;
  if (shellWrappedMaestro(command)) return true;
  if (/^WebDriverAgent(?:Runner)?(?:-Runner)?$/i.test(executable)) return true;
  if (/^java$/i.test(executable) && MAESTRO_JAVA_ENTRYPOINT_RE.test(command)) {
    return true;
  }
  if (
    /^xcodebuild$/i.test(executable) &&
    /(?:maestro[^\s]*|WebDriverAgent[^\s]*)\.xctestrun(?:\s|$)/i.test(command)
  ) {
    return true;
  }
  return false;
}

const RN_FAST_RUNNER_RE = /RnFastRunner/i;

const IOS_PS_OPTIONS = { timeout: 2_000, encoding: 'utf8' as const };
const MAX_ADMISSION_CANDIDATES = 64;

async function readIosProcesses(
  execFileImpl: typeof execFile,
  readLine: (line: string) => void,
): Promise<{ complete: boolean; stderr?: string }> {
  let pending = '';
  let hasOutput = false;
  const consume = (chunk: string) => {
    hasOutput ||= chunk.length > 0;
    const lines = (pending + chunk).split('\n');
    pending = lines.pop()!;
    for (const line of lines) readLine(line);
  };
  // Unlimited column width keeps simulator identities in long executable paths intact.
  const argv = ['axww', '-o', 'pid=,command='];
  let stderr: string | undefined;
  if (execFileImpl !== execFile) {
    const run = execFileImpl as unknown as (
      b: string,
      a: string[],
      o: typeof IOS_PS_OPTIONS,
    ) => Promise<{ stdout: string; stderr?: string }>;
    const result = await run('ps', argv, IOS_PS_OPTIONS);
    if (typeof result.stdout !== 'string') throw new Error('Invalid iOS process scan');
    consume(result.stdout);
    stderr = result.stderr;
  } else {
    const child = spawn('ps', argv, {
      timeout: IOS_PS_OPTIONS.timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', () => {
      stderr = 'Process scan emitted diagnostics';
    });
    const completion = new Promise<Error | undefined>((resolve) => {
      child.once('error', resolve);
      child.once('close', (code, signal) =>
        resolve(
          code === 0 && signal === null
            ? undefined
            : Object.assign(new Error('iOS process scan failed'), { killed: child.killed }),
        ),
      );
    });
    try {
      for await (const chunk of child.stdout) consume(chunk);
      const failure = await completion;
      if (failure) throw failure;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await completion;
    }
  }
  if (pending) readLine(pending);
  return { complete: hasOutput && pending === '', stderr };
}

export type IosStrictRunnerStatus = 'clear' | 'busy' | 'unknown';

export function isIosSimulatorUdid(value: string): boolean {
  return (
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isIosStrictRunnerProcessLine(line: string): boolean {
  const command = line.replace(/^\s*\d+\s+/, '');
  const executable = executableBasename(command);
  // Legacy shell detection scans argv; strict admission cannot attribute those path mentions.
  if (SHELL_WRAPPERS.test(executable)) return false;
  if (isIosExternalRunnerProcessLine(line)) return true;
  if (/^(?:RnFastRunner[^/]*|XCTRunner|.*UITests-Runner)$/i.test(executable)) return true;
  return (
    /^xcodebuild$/i.test(executable) &&
    /(?:^|\s)(?:test|test-without-building)(?:\s|$)/.test(command)
  );
}

const SIMULATOR_CONTAINER = /\/CoreSimulator\/Devices\/([^/]+)\//;

// The simulators a driver targets, read only from the kernel's executable path and exact argv;
// process-table text flattens argument boundaries and can never scope a driver.
function observedDriverDevices(
  value: unknown,
  line: string,
  scanStartedAt: number,
): string[] | undefined {
  const executable = observedExecutable(value, line, scanStartedAt);
  if (!executable) return undefined;
  const inside = SIMULATOR_CONTAINER.exec(executable);
  if (inside) return isIosSimulatorUdid(inside[1]) ? [inside[1]] : undefined;
  const argv = (value as { argv?: unknown }).argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((arg) => typeof arg === 'string'))
    return undefined;
  const name = executable.slice(executable.lastIndexOf('/') + 1);
  let devices: Array<string | undefined>;
  if (name === 'xcodebuild') {
    devices = argv.flatMap((arg, i) =>
      arg === '-destination'
        ? [
            (argv[i + 1] as string | undefined)
              ?.split(',')
              .find((part) => part.startsWith('id='))
              ?.slice(3),
          ]
        : [],
    );
  } else if (
    name === 'maestro' ||
    (name === 'java' && argv.some((arg) => /^maestro\.cli\.[\w.$]+$/i.test(arg)))
  ) {
    devices = argv.flatMap((arg, i) =>
      arg === '--device'
        ? String(argv[i + 1] ?? '').split(',')
        : arg.startsWith('--device=')
          ? arg.slice('--device='.length).split(',')
          : [],
    );
  } else return undefined;
  return devices.length > 0 && devices.every((d) => d !== undefined && isIosSimulatorUdid(d))
    ? (devices as string[])
    : undefined;
}

function isUnscopedMcpControl(line: string): boolean {
  const command = line.replace(/^\s*\d+\s+/, '').trimEnd();
  return (
    /^java$/i.test(executableBasename(command)) &&
    /^\S+ -classpath \S+ maestro\.cli\.[\w.$]+ mcp$/i.test(command)
  );
}

// The kernel inspector embeds this same specification; neither predicate establishes device scope.
export const IOS_PATH_PATTERN_SPEC = String.raw`{
  "exact": ["maestro", "maestro-driver-iosuitests-runner", "webdriveragent", "webdriveragentrunner", "webdriveragent-runner", "webdriveragentrunner-runner", "xctrunner", "xcodebuild"],
  "prefix": "rnfastrunner",
  "wordExtension": "maestro.",
  "suffixes": ["uitestsrunner", "uitests-runner"],
  "containers": ["uitestsrunner.app", "uitests-runner.app", "xctrunner.app"],
  "java": "java",
  "javaEntrypoint": "maestro.cli."
}`;
const iosPathPatterns: {
  exact: string[];
  prefix: string;
  wordExtension: string;
  suffixes: string[];
  containers: string[];
  java: string;
  javaEntrypoint: string;
} = JSON.parse(IOS_PATH_PATTERN_SPEC);

export function hasUnresolvedIosPathPattern(command: string): boolean {
  command = command.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const components = command.split('/').slice(1);
  const hasMaestroJavaEntrypoint = command
    .split(/\s/)
    .some(
      (word) =>
        word.startsWith(iosPathPatterns.javaEntrypoint) &&
        /^[\w.$]+$/.test(word.slice(iosPathPatterns.javaEntrypoint.length)),
    );
  for (const [index, component] of components.entries()) {
    if (
      component.startsWith(iosPathPatterns.prefix) ||
      (index < components.length - 1 &&
        iosPathPatterns.containers.some((part) => component.includes(part)))
    )
      return true;
    const extensionLength = component.startsWith(iosPathPatterns.wordExtension)
      ? (component.slice(iosPathPatterns.wordExtension.length).match(/^\w+/)?.[0].length ?? 0)
      : 0;
    for (let end = 0; end <= component.length; end++) {
      if (end !== component.length && !/[\s"']/.test(component[end])) continue;
      if (
        iosPathPatterns.exact.some((name) => end === name.length && component.startsWith(name)) ||
        (extensionLength > 0 && end === iosPathPatterns.wordExtension.length + extensionLength) ||
        iosPathPatterns.suffixes.some((suffix) => component.endsWith(suffix, end)) ||
        (hasMaestroJavaEntrypoint &&
          end === iosPathPatterns.java.length &&
          component.startsWith(iosPathPatterns.java))
      )
        return true;
      if (/\s/.test(component[end] ?? '')) break;
    }
  }
  return false;
}

function leadingShellWord(command: string): { word: string; rest: string } | null {
  const match = /^(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s+|$)/.exec(command);
  return match
    ? { word: match[1] ?? match[2] ?? match[3], rest: command.slice(match[0].length) }
    : null;
}

function hasUnresolvedIosShellScript(command: string): boolean {
  const shell = leadingShellWord(command);
  if (!shell || !SHELL_WRAPPERS.test(executableBasename(shell.word))) return false;
  let rest = shell.rest;
  for (let options = 0; options < 16; options++) {
    if (!rest) return false;
    const next = leadingShellWord(rest);
    if (!next) return true;
    const { word } = next;
    if (word === '--') return hasUnresolvedIosPathPattern(next.rest);
    if (executableBasename(shell.word) === 'env' && /^(?:-|\w+=)/.test(word)) return true;
    if (!/^[+-]/.test(word)) return hasUnresolvedIosPathPattern(rest);
    // Command strings and stdin are not script operands; never scan their contents.
    if (/^-[a-zA-Z]*[cs][a-zA-Z]*$/.test(word) || /^--command(?:=|$)/.test(word)) return false;
    rest = next.rest;
    if (/^[+-][oO]$/.test(word)) {
      const option = leadingShellWord(rest);
      if (!option || !/^[a-zA-Z][\w-]*$/.test(option.word)) return true;
      rest = option.rest;
    } else if (
      !/^(?:[+-][aefhiklmnpruvxBCEHPT]+|--(?:noprofile|norc|posix|restricted|verbose|login))$/.test(
        word,
      )
    ) {
      return true;
    }
  }
  return true;
}

function hasUnresolvedIosExecutablePath(line: string): boolean {
  const command = line.replace(/^\s*\d+\s+/, '');
  return hasUnresolvedIosPathPattern(command) || hasUnresolvedIosShellScript(command);
}

export type ProcessIdentityObserver = (
  pid: number,
  timeoutMs: number,
  withArgv?: boolean,
  inspection?: 'ios-paths',
) => Promise<unknown>;

function observedExecutable(value: unknown, line: string, scanStartedAt: number): string | null {
  if (!value || typeof value !== 'object') return null;
  const observation = value as Record<string, unknown>;
  const match = /^\s*(\d+)\s+(.+)$/.exec(line);
  if (!match || observation.v !== 1 || observation.pid !== Number(match[1])) return null;
  if (!observation.birth || typeof observation.birth !== 'object') return null;
  const { seconds, micros } = observation.birth as Record<string, unknown>;
  if (
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    typeof micros !== 'number' ||
    !Number.isInteger(micros) ||
    micros < 0 ||
    micros >= 1_000_000 ||
    seconds * 1_000 + Math.ceil(micros / 1_000) > scanStartedAt
  )
    return null;
  const executable = observation.executable;
  if (
    typeof executable !== 'string' ||
    !executable.startsWith('/') ||
    executable.endsWith('/') ||
    Buffer.byteLength(executable) >= 4096 ||
    // eslint-disable-next-line no-control-regex -- Kernel paths must remain an unambiguous single field.
    /[\x00-\x1f\x7f\ufffd]/.test(executable)
  )
    return null;
  return executable;
}

function identityRulesOutDriver(value: unknown, line: string, scanStartedAt: number): boolean {
  const executable = observedExecutable(value, line, scanStartedAt);
  if (!executable) return false;
  const name = executable.slice(executable.lastIndexOf('/') + 1);
  const command = line.replace(/^\s*\d+\s+/, '');
  // A kernel-proven shell running a -c string is not a driver; what it starts is its own row.
  if (/^(?:sh|bash|zsh|dash|ksh)$/i.test(name)) {
    const argv0 = leadingShellWord(command)?.word;
    return (
      argv0 !== undefined &&
      executableBasename(argv0) === name &&
      !hasUnresolvedIosPathPattern(executable) &&
      !hasUnresolvedIosShellScript(command)
    );
  }
  // Kernel identity rules out interpreter prompts; argv[0] may be a versioned CLI symlink.
  return !(
    SHELL_WRAPPERS.test(name) ||
    /^(?:java|osascript)$/i.test(name) ||
    /UITests-?Runner$/i.test(name) ||
    hasUnresolvedIosPathPattern(executable)
  );
}

const XCODE_TEST_ACTIONS = new Set(['test', 'test-without-building']);

function attestedXcodeArgv(value: unknown, line: string): string[] | undefined {
  const argv = (value as { argv?: unknown }).argv;
  if (
    !Array.isArray(argv) ||
    !argv.every(
      (arg) =>
        typeof arg === 'string' &&
        arg.length > 0 &&
        // eslint-disable-next-line no-control-regex -- Attested arguments must be complete text fields.
        !/[\x00-\x1f\x7f\ufffd]/.test(arg),
    ) ||
    Buffer.byteLength(argv.join('\0')) + 1 > 8_192 ||
    line.replace(/^\s*\d+\s+/, '') !== argv.join(' ')
  )
    return undefined;
  return argv as string[];
}

function isDirectXcodeTest(argv: string[], executable: string): boolean {
  if (
    argv.length < 4 ||
    argv.length % 2 !== 0 ||
    argv[0] !== executable ||
    !XCODE_TEST_ACTIONS.has(argv[1])
  )
    return false;
  for (let i = 2; i < argv.length; i += 2) {
    if (argv[i] !== '-destination' || !argv[i + 1].startsWith('id=')) return false;
    if (!isIosSimulatorUdid(argv[i + 1].slice(3))) return false;
  }
  return true;
}

function identityProvesMcpControl(value: unknown, line: string, scanStartedAt: number): boolean {
  const executable = observedExecutable(value, line, scanStartedAt);
  if (!executable || executable.slice(executable.lastIndexOf('/') + 1) !== 'java') return false;
  const argv = (value as { argv?: unknown }).argv;
  return (
    !hasUnresolvedIosPathPattern(executable) &&
    Array.isArray(argv) &&
    argv.length === 5 &&
    argv.every(
      (arg) =>
        typeof arg === 'string' &&
        arg.length > 0 &&
        // eslint-disable-next-line no-control-regex -- Attested arguments must be complete text fields.
        !/[\x00-\x1f\x7f\ufffd]/.test(arg),
    ) &&
    Buffer.byteLength(argv.join(' ')) <= 16_384 &&
    argv[1] === '-classpath' &&
    argv[3] === 'maestro.cli.AppKt' &&
    argv[4] === 'mcp' &&
    // Kernel identity binds the real executable; argv preserves the launcher's symlink spelling.
    line.replace(/^\s*\d+\s+/, '').trimEnd() === argv.join(' ')
  );
}

// Known-pattern observation only: a clear scan is not an external coordination lease.
export async function probeIosExternalRunnerStrict(
  execFileImpl: typeof execFile = execFile,
  udid?: string,
  observeIdentity?: ProcessIdentityObserver,
): Promise<IosStrictRunnerStatus> {
  return (await probeIosExternalRunnerAdmission(execFileImpl, udid, observeIdentity)).status;
}

export type IosAdmissionProbeReason =
  | 'invalid_device'
  | 'scan_failed'
  | 'scan_timeout'
  | 'scan_output_oversize'
  | 'scan_unavailable'
  | 'scan_incomplete'
  | 'scan_stderr'
  | 'scan_oversize'
  | 'scan_corrupt'
  | 'scan_row_invalid'
  | 'scan_pid_invalid'
  | 'candidate_budget_exceeded'
  | 'deadline_exceeded'
  | 'driver_on_selected_device'
  | 'observer_unavailable'
  | 'observer_failed'
  | 'observer_timeout'
  | 'observer_stderr'
  | 'observer_output_oversize'
  | 'observer_invalid_json'
  | 'driver_identity_unproven'
  | 'executable_identity_unproven';

export interface IosAdmissionProbeEvidence {
  reason: IosAdmissionProbeReason;
  pid?: number;
  candidates?: number;
}

export interface IosAdmissionProbeResult {
  status: IosStrictRunnerStatus;
  evidence?: IosAdmissionProbeEvidence;
}

export async function probeIosExternalRunnerAdmission(
  execFileImpl: typeof execFile = execFile,
  udid?: string,
  observeIdentity?: ProcessIdentityObserver,
): Promise<IosAdmissionProbeResult> {
  const unknown = (
    reason: IosAdmissionProbeReason,
    pid?: number,
    candidates?: number,
  ): IosAdmissionProbeResult => ({
    status: 'unknown',
    evidence: {
      reason,
      ...(pid === undefined ? {} : { pid }),
      ...(candidates === undefined ? {} : { candidates }),
    },
  });
  const busy = (pid: number): IosAdmissionProbeResult => ({
    status: 'busy',
    evidence: { reason: 'driver_on_selected_device', pid },
  });
  const observationFailure = (value: unknown): IosAdmissionProbeReason | undefined => {
    const reason = (value as { observationFailure?: unknown } | null)?.observationFailure;
    return [
      'observer_failed',
      'observer_timeout',
      'observer_stderr',
      'observer_output_oversize',
      'observer_invalid_json',
    ].includes(reason as string)
      ? (reason as IosAdmissionProbeReason)
      : undefined;
  };
  const observe = async (
    pid: number,
    timeout: number,
    withArgv?: boolean,
    inspection?: 'ios-paths',
  ) => {
    try {
      return await observeIdentity!(pid, timeout, withArgv, inspection);
    } catch {
      return { observationFailure: 'observer_failed' };
    }
  };
  if (!udid || !isIosSimulatorUdid(udid)) return unknown('invalid_device');
  const scanStartedAt = Date.now();
  const deadline = performance.now() + 20_000;
  try {
    let rowFailure: IosAdmissionProbeReason | undefined;
    let corrupt = false;
    const pids = new Set<number>();
    const drivers: string[] = [];
    const unresolved: string[] = [];
    let candidates = 0;
    const { complete, stderr } = await readIosProcesses(execFileImpl, (line) => {
      // eslint-disable-next-line no-control-regex -- Corrupt process-table bytes must fail closed.
      corrupt ||= /[\x00-\x08\x0b-\x1f\x7f\ufffd]/.test(line);
      const match = /^\s*([1-9]\d*)[ \t]+(\S[^\n]*)$/.exec(line);
      if (!match) {
        rowFailure ??= 'scan_row_invalid';
        return;
      }
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pids.has(pid)) rowFailure ??= 'scan_pid_invalid';
      pids.add(pid);
      const controller = isUnscopedMcpControl(line);
      if (!controller && isIosStrictRunnerProcessLine(line)) {
        if (++candidates <= MAX_ADMISSION_CANDIDATES) drivers.push(line);
      } else if (controller || hasUnresolvedIosExecutablePath(line)) {
        if (++candidates <= MAX_ADMISSION_CANDIDATES) unresolved.push(line);
      }
    });
    if (!complete) return unknown('scan_incomplete');
    if (stderr !== undefined && stderr !== '') return unknown('scan_stderr');
    if (corrupt) return unknown('scan_corrupt');
    if (rowFailure) return unknown(rowFailure);
    if (candidates > MAX_ADMISSION_CANDIDATES)
      return unknown('candidate_budget_exceeded', undefined, candidates);
    if (performance.now() >= deadline) return unknown('deadline_exceeded');
    const target = new RegExp(`(?:^|[^a-z0-9-])${udid}(?=$|[^a-z0-9-])`, 'i');
    const selectedDriver = drivers.find((line) => target.test(line));
    if (selectedDriver) return busy(Number(/^\s*(\d+)/.exec(selectedDriver)![1]));
    if (drivers.length > 0 && !observeIdentity)
      return unknown('observer_unavailable', undefined, drivers.length);
    for (const line of drivers) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) return unknown('deadline_exceeded');
      const pid = Number(/^\s*(\d+)/.exec(line)![1]);
      const observation = await observe(pid, Math.min(1_000, remaining), true);
      if (performance.now() >= deadline) return unknown('deadline_exceeded', pid);
      const failed = observationFailure(observation);
      if (failed) return unknown(failed, pid);
      if (identityProvesMcpControl(observation, line, scanStartedAt)) continue;
      const devices = observedDriverDevices(observation, line, scanStartedAt);
      if (performance.now() >= deadline) return unknown('deadline_exceeded', pid);
      if (!devices) return unknown('driver_identity_unproven', pid);
      if (devices.some((device) => device.toLowerCase() === udid.toLowerCase())) return busy(pid);
    }
    if (performance.now() >= deadline) return unknown('deadline_exceeded');
    if (!unresolved.length) return { status: 'clear' };
    if (!observeIdentity) return unknown('observer_unavailable', undefined, unresolved.length);
    for (const line of unresolved) {
      const candidateStartedAt = performance.now();
      const candidateDeadline = Math.min(deadline, candidateStartedAt + 1_000);
      const remaining = Math.floor(deadline - candidateStartedAt);
      if (remaining <= 0) return unknown('deadline_exceeded');
      const pid = Number(/^\s*(\d+)/.exec(line)![1]);
      const controller = isUnscopedMcpControl(line);
      let observation = await observe(pid, Math.min(1_000, remaining), controller || undefined);
      if (performance.now() >= deadline) return unknown('deadline_exceeded', pid);
      let failed = observationFailure(observation);
      if (failed) return unknown(failed, pid);
      const executable = observedExecutable(observation, line, scanStartedAt);
      // Only a kernel-proven JVM needs exact argv; a long prompt naming the entrypoint would exceed its cap.
      if (
        !controller &&
        MAESTRO_JAVA_ENTRYPOINT_RE.test(line) &&
        executable?.slice(executable.lastIndexOf('/') + 1) === 'java'
      ) {
        const argvRemaining = Math.floor(candidateDeadline - performance.now());
        if (argvRemaining <= 0) return unknown('observer_timeout', pid);
        observation = await observe(pid, argvRemaining, true);
        if (performance.now() >= deadline) return unknown('deadline_exceeded', pid);
        failed = observationFailure(observation);
        if (failed) return unknown(failed, pid);
        if (performance.now() >= candidateDeadline) return unknown('observer_timeout', pid);
        if (observedExecutable(observation, line, scanStartedAt) !== executable)
          return unknown('executable_identity_unproven', pid);
      }
      if (executable?.slice(executable.lastIndexOf('/') + 1) === 'xcodebuild') {
        if (SIMULATOR_CONTAINER.test(executable))
          return unknown('executable_identity_unproven', pid);
        const argvRemaining = Math.floor(candidateDeadline - performance.now());
        if (argvRemaining <= 0) return unknown('observer_timeout', pid);
        const exact = await observe(pid, argvRemaining, true);
        if (performance.now() >= deadline) return unknown('deadline_exceeded', pid);
        const exactFailure = observationFailure(exact);
        if (exactFailure) return unknown(exactFailure, pid);
        if (performance.now() >= candidateDeadline) return unknown('observer_timeout', pid);
        if (observedExecutable(exact, line, scanStartedAt) !== executable)
          return unknown('executable_identity_unproven', pid);
        const birth = (observation as { birth: Record<string, unknown> }).birth;
        const exactBirth = (exact as { birth: Record<string, unknown> }).birth;
        const argv = attestedXcodeArgv(exact, line);
        // Without a test action xcodebuild cannot drive a simulator; argv[0] may be an alias.
        const buildOnly = argv?.every((arg) => !XCODE_TEST_ACTIONS.has(arg));
        if (
          birth.seconds !== exactBirth.seconds ||
          birth.micros !== exactBirth.micros ||
          !argv ||
          (!buildOnly && !isDirectXcodeTest(argv, executable))
        )
          return unknown('executable_identity_unproven', pid);
        if (buildOnly) {
          if (target.test(line)) return busy(pid);
          continue;
        }
        const devices = observedDriverDevices(exact, line, scanStartedAt);
        if (performance.now() >= deadline) return unknown('deadline_exceeded', pid);
        if (!devices) return unknown('executable_identity_unproven', pid);
        if (devices.some((device) => device.toLowerCase() === udid.toLowerCase())) return busy(pid);
        continue;
      }
      if (
        !(
          identityProvesMcpControl(observation, line, scanStartedAt) ||
          (!controller && identityRulesOutDriver(observation, line, scanStartedAt))
        )
      )
        return unknown('executable_identity_unproven', pid);
      if (performance.now() >= deadline) return unknown('deadline_exceeded', pid);
    }
    return { status: 'clear' };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return unknown('scan_output_oversize');
    if (failure?.killed || failure?.code === 'ETIMEDOUT') return unknown('scan_timeout');
    if (['ENOENT', 'EACCES', 'EPERM'].includes(failure?.code ?? ''))
      return unknown('scan_unavailable');
    return unknown('scan_failed');
  }
}

export async function detectIosExternalRunner(
  execFileImpl: typeof execFile = execFile,
  udid?: string,
): Promise<IosExternalRunnerWarning | null> {
  try {
    const lines: string[] = [];
    await readIosProcesses(execFileImpl, (line) => {
      if (
        isIosExternalRunnerProcessLine(line) &&
        !RN_FAST_RUNNER_RE.test(line) &&
        (!udid || line.includes(udid))
      )
        lines.push(line.trim());
    });

    if (lines.length === 0) return null;

    return {
      platform: 'ios',
      code: 'IOS_XCUITEST_COMPETITOR',
      message:
        'A foreign maestro/WebDriverAgent automation session is driving this simulator. ' +
        'Interleaving device_* with it may trigger a re-foreground of your app; CDP reads are unaffected. ' +
        '(If this is your own maestro flow, it is expected.)',
      processLines: lines,
    };
  } catch {
    return null;
  }
}

export interface ForeignRunnerNotice {
  meta: { foreignRunner: { code: string; message: string; processLines: string[] } };
  warning: string;
}

/**
 * GH#202 Phase 3: decide whether to surface a proactive foreign-runner heads-up
 * on an iOS device-session open. Returns null when there's nothing to say:
 *   - we currently hold the arbiter flow lease (the detected maestro driver is
 *     then our OWN L3 run, not a foreign session), OR
 *   - no foreign process was detected.
 * Informational only — the caller never blocks the open on this.
 */
export function foreignRunnerNotice(
  detection: IosExternalRunnerWarning | null,
  flowLeaseHeld: boolean,
): ForeignRunnerNotice | null {
  if (flowLeaseHeld) return null;
  if (!detection) return null;
  return {
    meta: {
      foreignRunner: {
        code: detection.code,
        message: detection.message,
        processLines: detection.processLines,
      },
    },
    warning: `FOREIGN_RUNNER_ACTIVE: ${detection.message}`,
  };
}
