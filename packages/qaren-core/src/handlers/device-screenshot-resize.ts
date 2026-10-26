import { execFile as execFileCb } from '../domain/cancellation.js';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';

const execFile = promisify(execFileCb);

export interface Dimensions {
  width: number;
  height: number;
}

export interface ResizeOpts {
  /** Maximum image width in pixels. 0 disables resize entirely. Default 1200. */
  maxWidth?: number;
  /** JPEG compression quality 1-100. Only applied to .jpg/.jpeg files. Default 85. */
  quality?: number;
}

export type ResizeReason =
  | 'sips-unavailable'
  | 'maxWidth-zero'
  | 'already-smaller'
  | 'no-dimensions'
  | 'sips-failed';

export interface ResizeResult {
  resized: boolean;
  path: string;
  reason?: ResizeReason;
  originalDims?: Dimensions;
  newDims?: Dimensions;
  originalBytes?: number;
  newBytes?: number;
}

/**
 * B120 / GH #36: defaults validated against a live iPhone 17 Pro screenshot
 * (native 1206×2622, ~193 KB JPEG). Empirical measurements:
 *   maxWidth=1200 → 181 KB (−7%, near no-op on modern iPhones)
 *   maxWidth=1000 → 144 KB (−25%)
 *   maxWidth=800  → 105 KB (−46%)  ← matches the issue's suggested default
 *   maxWidth=600  →  68 KB (−65%)
 * Picked 800 to match the issue's suggestion and produce meaningful savings
 * even on devices whose native width is already close to 1200. Still leaves
 * text labels at ~35-40 px tall — comfortably readable for any agent task.
 * Set maxWidth=0 to disable when full-resolution capture is required (visual
 * diffing, pixel comparisons).
 */
export const DEFAULT_MAX_WIDTH = 800;
export const DEFAULT_QUALITY = 85;

let sipsAvailable: boolean | null = null;

export interface ResizeDeps {
  exec?: typeof execFile;
  fileSize?: (path: string) => number | undefined;
}

const defaultFileSize = (path: string): number | undefined => {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
};

async function checkSipsAvailable(deps: ResizeDeps): Promise<boolean> {
  if (sipsAvailable !== null) return sipsAvailable;
  const runner = deps.exec ?? execFile;
  try {
    await runner('sips', ['--version'], { timeout: 1500 });
    sipsAvailable = true;
  } catch {
    sipsAvailable = false;
  }
  return sipsAvailable;
}

/** Test-only: reset the cached `sips --version` probe. */
export function resetSipsProbeForTesting(): void {
  sipsAvailable = null;
}

export function parseSipsDimensions(stdout: string): Dimensions | null {
  // sips -g pixelWidth -g pixelHeight <path> output:
  //   /path/to/file.jpg
  //     pixelWidth: 1179
  //     pixelHeight: 2556
  const wMatch = stdout.match(/pixelWidth:\s*(\d+)/);
  const hMatch = stdout.match(/pixelHeight:\s*(\d+)/);
  if (!wMatch || !hMatch) return null;
  return { width: parseInt(wMatch[1], 10), height: parseInt(hMatch[1], 10) };
}

async function getDimensions(path: string, deps: ResizeDeps): Promise<Dimensions | null> {
  const runner = deps.exec ?? execFile;
  try {
    const { stdout } = await runner('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], {
      timeout: 5000,
      encoding: 'utf8',
    });
    return parseSipsDimensions(stdout);
  } catch {
    return null;
  }
}

export function buildSipsResizeArgs(
  path: string,
  maxWidth: number,
  quality: number | undefined,
): string[] {
  const args = ['--resampleWidth', String(maxWidth)];
  // B121 follow-up: when the requested path has a .jpg/.jpeg extension we MUST
  // emit `-s format jpeg`. Without it, sips preserves the input format — and
  // the fast-runner path produces PNG bytes (XCUIScreen.screenshot.pngRepresentation)
  // even when the caller asked for .jpg. The result was PNG bytes living in a
  // .jpg file with `formatOptions` silently no-op'd (PNG ignores it), dropping
  // savings from ~46% to ~12% under fast-runner. The format flag is idempotent
  // when input is already JPEG (daemon path), so it's safe to apply unconditionally
  // for .jpg/.jpeg outputs.
  if (/\.jpe?g$/i.test(path)) {
    args.push('-s', 'format', 'jpeg');
    if (quality !== undefined) {
      args.push('-s', 'formatOptions', String(quality));
    }
  }
  args.push(path);
  return args;
}

/**
 * Downscale an image at `path` in place via macOS `sips`. Returns details about
 * what happened (or why no resize was performed). Never throws — degraded
 * environments (Linux, missing sips, unreadable file) return `resized: false`
 * with a reason, so the screenshot is still usable.
 */
export async function resizeWithSips(
  path: string,
  opts: ResizeOpts = {},
  deps: ResizeDeps = {},
): Promise<ResizeResult> {
  const maxWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH;

  if (maxWidth <= 0) {
    return { resized: false, path, reason: 'maxWidth-zero' };
  }

  if (!(await checkSipsAvailable(deps))) {
    return { resized: false, path, reason: 'sips-unavailable' };
  }

  const originalDims = await getDimensions(path, deps);
  if (!originalDims) {
    return { resized: false, path, reason: 'no-dimensions' };
  }

  if (originalDims.width <= maxWidth) {
    return { resized: false, path, reason: 'already-smaller', originalDims };
  }

  const fileSize = deps.fileSize ?? defaultFileSize;
  const originalBytes = fileSize(path);

  const runner = deps.exec ?? execFile;
  const quality = opts.quality ?? DEFAULT_QUALITY;
  try {
    await runner('sips', buildSipsResizeArgs(path, maxWidth, quality), { timeout: 10_000 });
  } catch {
    return { resized: false, path, reason: 'sips-failed', originalDims, originalBytes };
  }

  const newDims = await getDimensions(path, deps);
  const newBytes = fileSize(path);

  return {
    resized: true,
    path,
    originalDims,
    newDims: newDims ?? undefined,
    originalBytes,
    newBytes,
  };
}
