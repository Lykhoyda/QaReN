#!/usr/bin/env node
// Runs a test command with a private, empty temp folder and removes that folder afterwards.
// A run that passes but leaves an entry there fails with TEST_TMP_LEFTOVER. Two tool caches are
// not entries: see TOOL_CACHES.
//
//   node scripts/test-tmp-guard.mts -- cargo test --manifest-path packages/qaren-cli/Cargo.toml --locked
//
// Exit code: the command's own when it fails (128 + signal number when a signal ended it, 127
// when it could not start); 1 for a refusal of the guard itself (TEST_TMP_SETUP,
// TEST_TMP_UNREADABLE, TEST_TMP_LEFTOVER, TEST_TMP_NOT_REMOVED); 2 for a usage error; 0 otherwise.
//
// SIGINT, SIGTERM and SIGHUP are passed on to the command, and the guard then waits for it to
// exit before it removes the folder. A guard that is killed outright leaves its folder.
import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';

// Directories that Node and package managers keep in the temp folder under one fixed name, so
// they cannot pile up: Node's module compile cache and the v8-compile-cache package's folder
// for the current user.
const TOOL_CACHES = ['node-compile-cache', `v8-compile-cache-${process.getuid?.() ?? ''}`];
const SHOWN = 20;
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const NEXT_LEFTOVER =
  'next: make the test that creates each entry remove it, then rerun. ' +
  'In packages/qaren-cli create the folder with crate::test_tmp::TestDir::new (src) or common::temp_dir (tests) ' +
  'and keep the returned owner bound until the test ends. ' +
  "In packages/qaren-core add import '<path to>/test/helpers/private-tmp.ts' as the first import of the test file. " +
  'To find the test, run one test file or one cargo target through this command.';

function isToolCache(root: string, name: string): boolean {
  if (!TOOL_CACHES.includes(name)) return false;
  try {
    return lstatSync(join(root, name)).isDirectory();
  } catch {
    return false;
  }
}

// The names left in the folder, or the reason they could not be read. A folder the command
// removed itself holds nothing. A file or symlink in its place is unreadable; a symlink is never
// followed.
function inspect(root: string): { left: string[] } | { unreadable: string } {
  try {
    if (!lstatSync(root).isDirectory()) {
      return { unreadable: `${root} is no longer a directory` };
    }
    chmodSync(root, 0o700);
    return {
      left: readdirSync(root)
        .filter((name) => !isToolCache(root, name))
        .sort(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { left: [] };
    return { unreadable: String(error) };
  }
}

// A test may leave a folder it made read-only; removal needs it writable again.
function makeWritable(path: string): void {
  if (!lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}

// Removes the folder; returns why it could not, or null.
function remove(root: string): string | null {
  const attempt = () =>
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    attempt();
    return null;
  } catch {
    try {
      makeWritable(root);
      attempt();
      return null;
    } catch (error) {
      return String(error);
    }
  }
}

// One line, whatever the names contain.
function printable(text: string): string {
  return Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? '?' : character;
  }).join('');
}

function describe(left: string[]): string {
  const shown = left.slice(0, SHOWN).map(printable).join(', ');
  return left.length > SHOWN ? `${shown} (and ${left.length - SHOWN} more)` : shown;
}

function refuse(message: string): number {
  console.error(message);
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::error title=Test temp folder::${message.replaceAll('%', '%25')}`);
  }
  return 1;
}

async function main(): Promise<number> {
  const separator = process.argv.indexOf('--');
  const command = separator === -1 ? [] : process.argv.slice(separator + 1);
  if (command.length === 0) {
    console.error('usage: node scripts/test-tmp-guard.mts -- <command> [arguments]');
    return 2;
  }

  let root: string;
  try {
    root = mkdtempSync(join(tmpdir(), 'qaren-tmp-'));
  } catch (error) {
    return refuse(
      printable(
        `TEST_TMP_SETUP: cannot create a temp folder in ${tmpdir()}: ${String(error)}; the command was not run; next: point TMPDIR at a folder this user can write to, then rerun`,
      ),
    );
  }

  let status = 1;
  let inspected: ReturnType<typeof inspect> = { left: [] };
  let notRemoved: string | null = null;
  try {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, TMPDIR: root },
    });
    for (const signal of FORWARDED) process.on(signal, () => child.kill(signal));
    status = await new Promise<number>((resolve) => {
      child.on('error', (error) => {
        console.error(
          printable(
            `TEST_TMP_NOT_STARTED: cannot start ${command[0]}: ${error.message}; next: check the command name and PATH`,
          ),
        );
        resolve(127);
      });
      child.on('exit', (code, signal) =>
        resolve(signal ? 128 + constants.signals[signal] : (code ?? 1)),
      );
    });
  } finally {
    inspected = inspect(root);
    notRemoved = remove(root);
  }

  const kept =
    notRemoved === null ? '' : `; the folder ${root} could not be removed: ${notRemoved}`;
  if (status !== 0) {
    if ('unreadable' in inspected) {
      console.error(
        printable(
          `test-tmp-guard: the command failed and its temp folder could not be read: ${inspected.unreadable}${kept}`,
        ),
      );
    } else if (inspected.left.length > 0) {
      console.error(
        printable(
          `test-tmp-guard: the command failed and left ${inspected.left.length} entries in its temp folder: `,
        ) +
          describe(inspected.left) +
          printable(kept),
      );
    } else if (notRemoved !== null) {
      console.error(printable(`test-tmp-guard: the command failed${kept}`));
    }
    return status;
  }
  if ('unreadable' in inspected) {
    return refuse(
      printable(
        `TEST_TMP_UNREADABLE: the command passed but its temp folder could not be read: ${inspected.unreadable}${kept}; next: a test replaced or locked the folder TMPDIR names; make it leave that folder in place, then rerun`,
      ),
    );
  }
  if (inspected.left.length > 0) {
    return refuse(
      `TEST_TMP_LEFTOVER: the command passed but left ${inspected.left.length} entries in its temp folder: ${describe(inspected.left)}${printable(kept)}; ${NEXT_LEFTOVER}`,
    );
  }
  if (notRemoved !== null) {
    return refuse(
      printable(
        `TEST_TMP_NOT_REMOVED: the command passed and left nothing, but the folder ${root} could not be removed: ${notRemoved}; next: remove that folder once nothing uses it, and make the test stop changing the permissions of the folder that holds its TMPDIR`,
      ),
    );
  }
  return 0;
}

process.exitCode = await main();
