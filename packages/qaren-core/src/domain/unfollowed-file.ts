import { execFileSync } from 'node:child_process';
import { lstatSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  listVerifiedDirectory,
  readFileFromVerifiedDirectory,
} from '../lifecycle/process-birth.js';

export interface VerifiedDirectoryIdentity {
  dev: string;
  ino: string;
}

export interface UnfollowedFileIdentity {
  path: string;
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface UnfollowedFileSnapshot {
  directoryPath: string;
  directoryIdentity: VerifiedDirectoryIdentity;
  fileIdentities: Map<string, UnfollowedFileIdentity>;
}

export function createUnfollowedFileSnapshot(
  directoryPath: string,
  directoryIdentity: VerifiedDirectoryIdentity,
): UnfollowedFileSnapshot {
  return { directoryPath, directoryIdentity, fileIdentities: new Map() };
}

const UNFOLLOWED_READER_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const UNFOLLOWED_READER_BATCH_BYTES = 24 * 1024 * 1024;
const UNFOLLOWED_READER_BATCH_FILES = 16;
const UNFOLLOWED_READER_FRAME_BYTES = 9;

const UNFOLLOWED_READER_SCRIPT = String.raw`
const { closeSync, constants, fstatSync, openSync, readSync, realpathSync, writeSync } = require('node:fs');
const { join } = require('node:path');
const request = JSON.parse(process.argv[1]);
const opened = [];
let directory = -1;
const closeAll = () => {
  for (const entry of opened) if (entry.fd >= 0) closeSync(entry.fd);
  if (directory >= 0) closeSync(directory);
};
const matches = (stat, identity) =>
  stat.isFile() &&
  String(stat.dev) === identity.dev &&
  String(stat.ino) === identity.ino &&
  String(stat.size) === identity.size &&
  String(stat.mtimeNs) === identity.mtimeNs &&
  String(stat.ctimeNs) === identity.ctimeNs;
try {
  directory = openSync(
    request.directoryPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  const directoryStat = fstatSync(directory, { bigint: true });
  if (
    !directoryStat.isDirectory() ||
    String(directoryStat.dev) !== request.directoryIdentity.dev ||
    String(directoryStat.ino) !== request.directoryIdentity.ino
  ) {
    throw new Error('directory changed');
  }
  let batchBytes = 0;
  for (const entry of request.entries) {
    if (!entry.identity) {
      opened.push({ fd: -1, size: 0, identity: null });
      batchBytes += 9;
      continue;
    }
    const path = join(request.directoryPath, entry.relativePath);
    if (realpathSync.native(path) !== path) throw new Error('path followed a link');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd, { bigint: true });
    if (!matches(stat, entry.identity)) {
      closeSync(fd);
      throw new Error('file changed');
    }
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      closeSync(fd);
      throw new Error('invalid size');
    }
    batchBytes += 9 + size;
    if (batchBytes > ${UNFOLLOWED_READER_BATCH_BYTES}) {
      closeSync(fd);
      throw new Error('batch too large');
    }
    opened.push({ fd, size, identity: entry.identity });
  }
  for (const entry of opened) {
    const frame = Buffer.alloc(9);
    if (entry.fd < 0) {
      frame[0] = 1;
      writeSync(1, frame);
      continue;
    }
    frame.writeBigUInt64BE(BigInt(entry.size), 1);
    writeSync(1, frame);
    const buffer = Buffer.allocUnsafe(Math.min(16384, Math.max(entry.size, 1)));
    let offset = 0;
    while (offset < entry.size) {
      const count = readSync(entry.fd, buffer, 0, Math.min(buffer.length, entry.size - offset), offset);
      if (count <= 0) throw new Error('short read');
      writeSync(1, buffer, 0, count);
      offset += count;
    }
    if (!matches(fstatSync(entry.fd, { bigint: true }), entry.identity)) {
      throw new Error('file changed during read');
    }
  }
  closeAll();
} catch {
  closeAll();
  process.exit(10);
}
`;

function identityFromStat(path: string, stat: BigIntStats): UnfollowedFileIdentity {
  return {
    path,
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameIdentity(left: UnfollowedFileIdentity, right: UnfollowedFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function captureUnfollowedFileIdentities(
  snapshot: UnfollowedFileSnapshot,
  relativePaths: readonly string[],
): UnfollowedFileIdentity[] {
  const identities: UnfollowedFileIdentity[] = [];
  try {
    for (const relativePath of relativePaths) {
      const path = join(snapshot.directoryPath, relativePath);
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('changed');
      const captured = identityFromStat(path, stat);
      const existing = snapshot.fileIdentities.get(relativePath);
      if (existing && !sameIdentity(existing, captured)) throw new Error('changed');
      const selected = existing ?? captured;
      snapshot.fileIdentities.set(relativePath, selected);
      identities.push(selected);
    }
  } catch {
    throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
  }
  return identities;
}

export function assertUnfollowedFileSnapshotUnchanged(snapshot: UnfollowedFileSnapshot): void {
  try {
    for (const identity of snapshot.fileIdentities.values()) {
      const stat = lstatSync(identity.path, { bigint: true });
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        !sameIdentity(identity, identityFromStat(identity.path, stat))
      ) {
        throw new Error('changed');
      }
    }
  } catch {
    throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
  }
}

export function selectExistingUnfollowedSnapshotFiles(
  snapshot: UnfollowedFileSnapshot,
  relativePaths: readonly string[],
): string[] {
  assertUnfollowedFileSnapshotUnchanged(snapshot);
  const existing: string[] = [];
  try {
    for (const relativePath of relativePaths) {
      const path = join(snapshot.directoryPath, relativePath);
      let stat: BigIntStats;
      try {
        stat = lstatSync(path, { bigint: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('changed');
      const captured = identityFromStat(path, stat);
      const selected = snapshot.fileIdentities.get(relativePath);
      if (selected && !sameIdentity(selected, captured)) throw new Error('changed');
      snapshot.fileIdentities.set(relativePath, selected ?? captured);
      existing.push(relativePath);
    }
  } catch {
    throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
  }
  assertUnfollowedFileSnapshotUnchanged(snapshot);
  return existing;
}

export function readUnfollowedSnapshotFiles(
  snapshot: UnfollowedFileSnapshot,
  relativePaths: readonly string[],
  readFiles: typeof readUnfollowedFiles = readUnfollowedFiles,
): string[] {
  assertUnfollowedFileSnapshotUnchanged(snapshot);
  const identities = captureUnfollowedFileIdentities(snapshot, relativePaths);
  const contents = readFiles(
    snapshot.directoryPath,
    snapshot.directoryIdentity,
    relativePaths,
    identities,
  );
  assertUnfollowedFileSnapshotUnchanged(snapshot);
  if (contents.length !== relativePaths.length || contents.some((entry) => entry == null)) {
    throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
  }
  return contents as string[];
}

export function readUnfollowedFile(
  directoryPath: string,
  identity: VerifiedDirectoryIdentity,
  relativePath: string,
): string {
  try {
    return readFileFromVerifiedDirectory(directoryPath, identity, relativePath).toString('utf8');
  } catch (err) {
    throw new Error(
      `Refusing inherited action symlink at ${directoryPath}/${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function readUnfollowedFiles(
  directoryPath: string,
  identity: VerifiedDirectoryIdentity,
  relativePaths: readonly string[],
  expectedIdentities?: readonly UnfollowedFileIdentity[],
): Array<string | null> {
  try {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error(
        `Verified directory reads are unavailable on ${process.platform}/${process.arch}.`,
      );
    }
    if (expectedIdentities && expectedIdentities.length !== relativePaths.length) {
      throw new Error('Selected file identities did not match the requested paths.');
    }
    const entries = relativePaths.map((relativePath, index) => {
      if (
        isAbsolute(relativePath) ||
        relativePath
          .split('/')
          .some((component) => !component || component === '.' || component === '..')
      ) {
        throw new Error(`Invalid relative path: ${relativePath}.`);
      }
      if (expectedIdentities) {
        const selected = expectedIdentities[index];
        if (!selected || selected.path !== join(directoryPath, relativePath)) {
          throw new Error(`Selected file identity did not match ${relativePath}.`);
        }
        return { relativePath, identity: selected };
      }
      const path = join(directoryPath, relativePath);
      try {
        const stat = lstatSync(path, { bigint: true });
        return {
          relativePath,
          identity: stat.isSymbolicLink() || !stat.isFile() ? null : identityFromStat(path, stat),
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          return { relativePath, identity: null };
        throw err;
      }
    });
    const contents: Array<string | null> = [];
    let batch: typeof entries = [];
    let batchBytes = 0;
    const flush = (): void => {
      if (batch.length === 0) return;
      const output = execFileSync(
        process.execPath,
        [
          '--no-warnings',
          '--input-type=commonjs',
          '-e',
          UNFOLLOWED_READER_SCRIPT,
          JSON.stringify({ directoryPath, directoryIdentity: identity, entries: batch }),
        ],
        {
          maxBuffer: UNFOLLOWED_READER_MAX_BUFFER_BYTES,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 10_000,
        },
      );
      let offset = 0;
      for (const entry of batch) {
        if (offset + UNFOLLOWED_READER_FRAME_BYTES > output.length) {
          throw new Error(`Verified directory batch was truncated before ${entry.relativePath}.`);
        }
        const status = output[offset];
        const length = output.readBigUInt64BE(offset + 1);
        offset += UNFOLLOWED_READER_FRAME_BYTES;
        if (length > BigInt(Number.MAX_SAFE_INTEGER) || offset + Number(length) > output.length) {
          throw new Error(`Verified directory batch was malformed at ${entry.relativePath}.`);
        }
        const end = offset + Number(length);
        if (status === 0) contents.push(output.toString('utf8', offset, end));
        else if (status === 1 && length === 0n) contents.push(null);
        else throw new Error(`Verified directory batch refused ${entry.relativePath}.`);
        offset = end;
      }
      if (offset !== output.length) throw new Error('Verified directory batch had trailing data.');
      batch = [];
      batchBytes = 0;
    };
    for (const entry of entries) {
      const size = entry.identity ? Number(entry.identity.size) : 0;
      const framedBytes = UNFOLLOWED_READER_FRAME_BYTES + size;
      if (!Number.isSafeInteger(size) || framedBytes > UNFOLLOWED_READER_BATCH_BYTES) {
        throw new Error(
          `Verified directory entry exceeds the safe batch size: ${entry.relativePath}.`,
        );
      }
      if (
        batch.length > 0 &&
        (batch.length >= UNFOLLOWED_READER_BATCH_FILES ||
          batchBytes + framedBytes > UNFOLLOWED_READER_BATCH_BYTES)
      ) {
        flush();
      }
      batch.push(entry);
      batchBytes += framedBytes;
    }
    flush();
    return contents;
  } catch (err) {
    throw new Error(
      `Refusing replaced learned-action corpus at ${directoryPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function listUnfollowedDirectory(
  directoryPath: string,
  identity: VerifiedDirectoryIdentity,
): string[] {
  try {
    return listVerifiedDirectory(directoryPath, identity);
  } catch (err) {
    throw new Error(
      `Refusing replaced learned-action corpus at ${directoryPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
