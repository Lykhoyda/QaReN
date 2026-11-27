#!/usr/bin/env node
// Process fixture for tests/held_cleanup.rs (AI-763). The test copies this file, makes it executable,
// links it as `ps` first in PATH and uses it as QAREN_NODE for the real CLI it starts.
//
// Called with `--version` it is a slow node: it marks that the probe started, then answers only once
// the test creates the release file (30 s at most), and marks when it is done.
//
// Otherwise it is `ps`: it forwards every call to /bin/ps unchanged, with three exceptions the test asks for.
// - The CLI's Android-helper scan (columns with `ucomm=`) gets an empty answer, so a test never stops a
//   helper on the host.
// - The leader's birth is probed at entry, at TERM and at KILL. The KILL-step probe waits until the
//   stand-in acknowledged TERM and the test reaped the leader, as launchd reaps a held run's launcher;
//   if that does not happen within 8 s (inside the CLI's own 10 s limit for the probe) the probe fails and
//   leaves HELD_FIXTURE_ERROR; once it has happened it leaves HELD_BARRIER_DONE. The test checks both.
// - The first group listing is the CLI's escalation decision; the stand-in is released right after it.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reaped(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as { code?: string }).code === 'ESRCH';
  }
}

function slowNode(): void {
  const mark = process.env.HELD_NODE_MARK ?? '';
  const release = process.env.HELD_NODE_RELEASE ?? '';
  const done = process.env.HELD_NODE_DONE ?? '';
  writeFileSync(mark, '');
  const deadline = Date.now() + 30_000;
  while (!existsSync(release) && Date.now() < deadline) {
    pause(50);
  }
  writeFileSync(done, '');
  process.stdout.write('v24.0.0\n');
}

function ps(): void {
  const joined = args.join(' ');
  if (joined.includes('ucomm=')) {
    return;
  }
  const leader = process.env.HELD_LEADER;
  const term = process.env.HELD_TERM_FILE;
  const probes = process.env.HELD_PROBES;
  const release = process.env.HELD_RELEASE;
  if (
    leader !== undefined &&
    term !== undefined &&
    probes !== undefined &&
    args.includes('lstart=') &&
    args.includes(leader)
  ) {
    appendFileSync(probes, 'p');
    if (readFileSync(probes, 'utf8').length === 3) {
      const deadline = Date.now() + 8_000;
      while (!(existsSync(term) && reaped(Number(leader)))) {
        if (Date.now() >= deadline) {
          const message = 'fixture: the member never saw TERM or the leader was not reaped\n';
          // Durable for the test, which checks it: a failed barrier must not pass as a product outcome.
          if (process.env.HELD_FIXTURE_ERROR !== undefined) {
            writeFileSync(process.env.HELD_FIXTURE_ERROR, message);
          }
          process.stderr.write(message);
          process.exitCode = 1;
          return;
        }
        pause(5);
      }
      if (process.env.HELD_BARRIER_DONE !== undefined) {
        writeFileSync(process.env.HELD_BARRIER_DONE, '');
      }
    }
  }
  const result = spawnSync('/bin/ps', args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (release !== undefined && joined === '-A -o pid= -o pgid= -o stat=' && !existsSync(release)) {
    writeFileSync(release, 'go');
  }
  process.exitCode = result.status ?? 1;
}

if (args[0] === '--version') {
  slowNode();
} else {
  ps();
}
