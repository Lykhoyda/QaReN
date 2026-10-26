import { createWriteStream, mkdirSync, existsSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { redactApiKey } from './util/redact.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const configuredLevel: LogLevel = (process.env.LOG_LEVEL ??
  process.env.QAREN_LOG_LEVEL ??
  'warn') as LogLevel;

function resolveLogPath(): string | null {
  // The read-only MCP contract probe must not create a log directory or file,
  // even when the parent environment requested debug/info logging.
  if (process.argv.includes('--diagnostic-contract-probe')) return null;
  if (configuredLevel !== 'debug' && configuredLevel !== 'info') return null;

  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) {
    try {
      if (!existsSync(pluginData)) mkdirSync(pluginData, { recursive: true });
      return join(pluginData, 'cdp-bridge.log');
    } catch {
      /* fall through */
    }
  }

  const fallbackDir = join(homedir(), '.claude', 'logs');
  try {
    if (!existsSync(fallbackDir)) mkdirSync(fallbackDir, { recursive: true });
    return join(fallbackDir, 'qaren-core.log');
  } catch {
    /* fall through */
  }

  return join(tmpdir(), 'qaren-core.log');
}

const logFilePath = resolveLogPath();

// Append via a buffered WriteStream rather than appendFileSync so logging never
// blocks the event loop on the hot path (writeLog runs per tool call at
// debug/info). A single stream preserves write order; errors are swallowed
// (best-effort logging). File-backed streams don't keep the process alive.
let logStream: WriteStream | null = null;
function getLogStream(): WriteStream | null {
  if (!logFilePath) return null;
  if (!logStream) {
    try {
      logStream = createWriteStream(logFilePath, { flags: 'a' });
      logStream.on('error', () => {
        /* disk error — drop best-effort logs */
      });
    } catch {
      return null;
    }
  }
  return logStream;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel];
}

function formatMessage(level: LogLevel, tag: string, msg: string): string {
  const ts = new Date().toISOString();
  return redactApiKey(`${ts} [${level.toUpperCase()}] [${tag}] ${msg}`);
}

function writeLog(level: LogLevel, tag: string, msg: string): void {
  if (!shouldLog(level)) return;
  const formatted = formatMessage(level, tag, msg);

  if (level === 'error' || level === 'warn') {
    console.error(formatted);
  } else if (configuredLevel === 'debug' || configuredLevel === 'info') {
    console.error(formatted);
  }

  const stream = getLogStream();
  if (stream) {
    try {
      stream.write(formatted + '\n');
    } catch {
      /* best-effort */
    }
  }
}

export const logger = {
  debug: (tag: string, msg: string) => writeLog('debug', tag, msg),
  info: (tag: string, msg: string) => writeLog('info', tag, msg),
  warn: (tag: string, msg: string) => writeLog('warn', tag, msg),
  error: (tag: string, msg: string) => writeLog('error', tag, msg),
  get logFilePath(): string | null {
    return logFilePath;
  },
  get level(): LogLevel {
    return configuredLevel;
  },
};
