import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('SESSION_RUNTIME_ROOT_UNSAFE: runtime root must be a real directory');
  }
  chmodSync(path, 0o700);
  return path;
}

export function sessionRuntimeRoot(projectRoot: string): string {
  const configured = process.env.QAREN_SESSION_RUNTIME_ROOT;
  return configured ? privateDirectory(resolve(configured)) : join(resolve(projectRoot), '.qaren');
}

export function sessionStateDirectory(projectRoot: string): string {
  const path = join(sessionRuntimeRoot(projectRoot), 'state');
  return process.env.QAREN_SESSION_RUNTIME_ROOT ? privateDirectory(path) : path;
}

export function sessionRecordingsDirectory(projectRoot: string): string {
  const path = join(sessionRuntimeRoot(projectRoot), 'recordings');
  return process.env.QAREN_SESSION_RUNTIME_ROOT ? privateDirectory(path) : path;
}
