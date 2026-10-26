import type { AgentEvent, Family } from './types';

export function latestByTool(events: AgentEvent[], tools: string[]): AgentEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (tools.includes(events[i].tool)) return events[i];
  }
  return undefined;
}

export function latestByFamily(events: AgentEvent[], family: Family): AgentEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].family === family) return events[i];
  }
  return undefined;
}

export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function routeOf(ev: AgentEvent | undefined): string | undefined {
  if (!ev) return undefined;
  const p = ev.payload as
    | { routeName?: string; nested?: { routeName?: string; nested?: { routeName?: string } } }
    | undefined;
  const cand = p?.nested?.nested?.routeName ?? p?.nested?.routeName ?? p?.routeName;
  return typeof cand === 'string' ? cand : undefined;
}

export function appOf(events: AgentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const a = events[i].args as { appId?: unknown; bundleId?: unknown; bundle?: unknown };
    const id = a.appId ?? a.bundleId ?? a.bundle;
    if (typeof id === 'string' && id) return id;
  }
  return undefined;
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss.padStart(2, '0')}`;
}

export function csrfToken(): string {
  return (window as unknown as { __E2E_CSRF__?: string }).__E2E_CSRF__ ?? '';
}
