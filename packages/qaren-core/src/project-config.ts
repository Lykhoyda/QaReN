import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from './util/project-root.js';
import { logger } from './logger.js';

interface AppConfig {
  expo?: {
    ios?: { bundleIdentifier?: string };
    android?: { package?: string };
    slug?: string;
  };
  ios?: { bundleIdentifier?: string };
  android?: { package?: string };
}

/**
 * Read bundle ID / package name from app.json or app.config.json.
 * Returns the platform-appropriate ID, or falls back cross-platform.
 */
export function readAppId(projectRoot: string, platform: string): string | null {
  for (const filename of ['app.json', 'app.config.json']) {
    const p = join(projectRoot, filename);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as AppConfig;
      const expo = raw.expo ?? raw;
      const iosBundleId = (expo as AppConfig['expo'])?.ios?.bundleIdentifier;
      const androidPkg = (expo as AppConfig['expo'])?.android?.package;
      if (platform === 'android') return androidPkg ?? iosBundleId ?? null;
      return iosBundleId ?? androidPkg ?? null;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolve bundle ID by finding the project root and reading app config.
 * Returns null if project root or config cannot be determined.
 */
export function resolveBundleId(platform: string): string | null {
  const projectRoot = findProjectRoot();
  if (!projectRoot) return null;
  return readAppId(projectRoot, platform);
}

/**
 * GH #262: strict per-platform app id — NO cross-platform fallback. Used by
 * recovery paths where a wrong-platform id would produce a confidently wrong
 * diagnosis (an Android package fed to iOS simctl "is not installed").
 */
export function readAppIdStrict(projectRoot: string, platform: string): string | null {
  for (const filename of ['app.json', 'app.config.json']) {
    const p = join(projectRoot, filename);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as AppConfig;
      const expo = (raw.expo ?? raw) as AppConfig['expo'];
      if (platform === 'android') return expo?.android?.package ?? null;
      return expo?.ios?.bundleIdentifier ?? null;
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveBundleIdStrict(platform: string): string | null {
  const projectRoot = findProjectRoot();
  if (!projectRoot) return null;
  return readAppIdStrict(projectRoot, platform);
}

/**
 * Read the Expo slug from app.json (used for Maestro app ID resolution).
 */
export function readExpoSlug(): string | null {
  const projectRoot = findProjectRoot();
  if (!projectRoot) return null;
  for (const filename of ['app.json', 'app.config.json']) {
    const p = join(projectRoot, filename);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as AppConfig;
      return raw.expo?.slug ?? null;
    } catch {
      continue;
    }
  }
  return null;
}

export interface RnAgentConfig {
  autoHideDevMenu?: boolean | { simulators?: boolean; devices?: boolean };
  cdp?: { autoConnect?: boolean };
}

let warnedBadConfig = false;

export function readRnAgentConfig(projectRoot?: string | null): RnAgentConfig | null {
  const root = projectRoot ?? findProjectRoot();
  if (!root) return null;
  const p = join(root, '.qaren', 'config.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as RnAgentConfig;
  } catch (err) {
    if (!warnedBadConfig) {
      warnedBadConfig = true;
      logger.warn(
        'CONFIG',
        `.qaren/config.json is unreadable — ignoring it: ${err instanceof Error ? err.message : err}`,
      );
    }
    return null;
  }
}

export interface AutoConnectResolution {
  enabled: boolean;
  source: 'env' | 'config' | 'default';
}

export function resolveAutoConnect(
  deps: {
    env?: string;
    readConfig?: () => RnAgentConfig | null;
  } = {},
): AutoConnectResolution {
  // Present-but-undefined `env` means "treat as unset, do NOT fall back to
  // process.env" (test seam). Only an absent key reads process.env.RN_CDP_AUTOCONNECT.
  const envRaw = 'env' in deps ? deps.env : process.env.RN_CDP_AUTOCONNECT;
  if (envRaw === '0' || envRaw === 'false') return { enabled: false, source: 'env' };
  if (envRaw === '1' || envRaw === 'true') return { enabled: true, source: 'env' };
  const cfg = (deps.readConfig ?? readRnAgentConfig)();
  if (typeof cfg?.cdp?.autoConnect === 'boolean') {
    return { enabled: cfg.cdp.autoConnect, source: 'config' };
  }
  return { enabled: true, source: 'default' };
}

export interface AutoHideDevMenuResolution {
  simulators: boolean;
  devices: boolean;
  source: 'config' | 'default';
}

let warnedBadAutoHideDevMenu = false;

export function resolveAutoHideDevMenu(
  deps: { readConfig?: () => RnAgentConfig | null } = {},
): AutoHideDevMenuResolution {
  const raw: unknown = (deps.readConfig ?? readRnAgentConfig)()?.autoHideDevMenu;
  if (typeof raw === 'boolean') return { simulators: raw, devices: raw, source: 'config' };
  if (
    isPlainConfigObject(raw) &&
    [raw.simulators, raw.devices].every((flag) => flag === undefined || typeof flag === 'boolean')
  ) {
    return {
      simulators: raw.simulators !== false,
      devices: raw.devices !== false,
      source: 'config',
    };
  }
  if (raw !== undefined && !warnedBadAutoHideDevMenu) {
    warnedBadAutoHideDevMenu = true;
    logger.warn(
      'CONFIG',
      `.qaren/config.json autoHideDevMenu must be a boolean or { simulators, devices } booleans (got ${JSON.stringify(raw)}) — using the default (hidden)`,
    );
  }
  return { simulators: true, devices: true, source: 'default' };
}

function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
