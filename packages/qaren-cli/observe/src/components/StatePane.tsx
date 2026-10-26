import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { observeFetch } from '../authority';
import { authorityRecoveryHint } from '../authority-hints';
import type { ActionSummary, AgentEvent, E2eProgress } from '../types';
import { fmtClock, pretty } from '../derive';
import { ActionsPanel } from './ActionsPanel';
import { E2ePanel } from './E2ePanel';

type Tab = 'route' | 'store' | 'tree' | 'actions' | 'e2e';

const PAYLOAD_TABS = ['route', 'store', 'tree'] as const;
type PayloadTab = (typeof PAYLOAD_TABS)[number];

const EMPTY_HINT: Record<PayloadTab, string> = {
  route: 'no navigation state yet · run cdp_navigation_state',
  store: 'no store snapshot yet · run cdp_store_state',
  tree: 'no component tree yet · run cdp_component_tree',
};

function isPayloadTab(t: Tab): t is PayloadTab {
  return (PAYLOAD_TABS as readonly Tab[]).includes(t);
}

/** Re-activating a payload tab re-reads live state when the shown data is older than this. */
const STALE_MS = 15_000;

interface FetchedState {
  at: number;
  ok: boolean;
  payload?: unknown;
  error?: string;
  /** Typed refusal code (e.g. APP_INSTALL_IDENTITY_CHANGED) for the recovery hint. */
  code?: string;
  /** Backend-authoritative recovery path from the gate's error meta. */
  nextAction?: string;
  truncated?: boolean;
}

interface StatePaneProps {
  navEv?: AgentEvent;
  storeEv?: AgentEvent;
  treeEv?: AgentEvent;
  liveRoute: string | null;
  e2eProgress: E2eProgress | null;
  /** From useEventStream — bumps when a suite finishes anywhere (tool or UI). */
  e2eDoneCount: number;
}

export function StatePane({
  navEv,
  storeEv,
  treeEv,
  liveRoute,
  e2eProgress,
  e2eDoneCount,
}: StatePaneProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('route');
  const [actions, setActions] = useState<ActionSummary[]>([]);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const actionsFetchGeneration = useRef(0);
  // GH #579: payload tabs auto-read live state when shown empty; refresh re-reads on demand.
  const [fetched, setFetched] = useState<Partial<Record<PayloadTab, FetchedState>>>({});
  const [loading, setLoading] = useState<PayloadTab | null>(null);
  const tabEv =
    tab === 'route' ? navEv : tab === 'store' ? storeEv : tab === 'tree' ? treeEv : undefined;

  const refresh = useCallback(async (t: PayloadTab): Promise<void> => {
    // Request-time stamp: a slow read must not outrank a tool event that landed mid-flight.
    const at = Date.now();
    setLoading(t);
    try {
      const r = await observeFetch(`/api/state/${t}`);
      const env = (await r.json()) as {
        ok?: boolean;
        data?: unknown;
        error?: string;
        code?: string;
        meta?: { nextAction?: string };
        truncated?: boolean;
      };
      const next: FetchedState = env.ok
        ? { at, ok: true, payload: env.data, truncated: env.truncated }
        : {
            at,
            ok: false,
            error: env.error ?? `HTTP ${r.status}`,
            code: env.code,
            nextAction: typeof env.meta?.nextAction === 'string' ? env.meta.nextAction : undefined,
          };
      // A completion older than the stored result never overwrites it.
      setFetched((prev) => ((prev[t]?.at ?? 0) > at ? prev : { ...prev, [t]: next }));
    } catch (e) {
      const next: FetchedState = {
        at,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
      setFetched((prev) => ((prev[t]?.at ?? 0) > at ? prev : { ...prev, [t]: next }));
    } finally {
      setLoading((cur) => (cur === t ? null : cur));
    }
  }, []);

  // Only a SUCCESSFUL event suppresses the auto-read or renders as data.
  const evOk = tabEv?.ok ? tabEv : undefined;

  // Auto-read when the tab has no usable data, and on re-activation when the data is stale.
  // A recent FAILED read defers the retry to the next activation — never an immediate loop.
  const lastTabRef = useRef<Tab | null>(null);
  useEffect(() => {
    const activated = lastTabRef.current !== tab;
    lastTabRef.current = tab;
    if (!isPayloadTab(tab) || loading === tab) return;
    const f = fetched[tab];
    const newestOkAt = Math.max(evOk?.ts ?? 0, f?.ok ? f.at : 0);
    const failedRecently = f !== undefined && !f.ok && Date.now() - f.at < STALE_MS;
    if (newestOkAt === 0) {
      if (activated || !failedRecently) void refresh(tab);
    } else if (activated && Date.now() - newestOkAt > STALE_MS) {
      void refresh(tab);
    }
  }, [tab, evOk, fetched, loading, refresh]);

  useEffect(() => {
    const generation = ++actionsFetchGeneration.current;
    const fresh = (): boolean => generation === actionsFetchGeneration.current;
    const fetchActions = async (): Promise<void> => {
      try {
        const r = await observeFetch('/api/e2e/actions');
        if (!fresh()) return;
        if (r.ok) {
          const list = (await r.json()) as ActionSummary[];
          if (!fresh()) return;
          setActions(list);
          setActionsError(null);
        } else {
          const body = (await r.json().catch(() => null)) as {
            error?: string;
          } | null;
          if (!fresh()) return;
          setActions([]);
          setActionsError(body?.error ?? `actions unavailable (HTTP ${r.status})`);
        }
      } catch (e) {
        if (!fresh()) return;
        setActions([]);
        setActionsError(`actions unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void fetchActions();
  }, [e2eDoneCount]);

  // Newest successful read wins; a failed read never hides existing event data.
  const f = isPayloadTab(tab) ? fetched[tab] : undefined;
  const liveWins = f?.ok === true && (!evOk || f.at > evOk.ts);
  const liveError = f && !f.ok && !evOk ? (f.error ?? 'live read failed') : undefined;
  // The gate's own nextAction is authoritative; the static map only covers
  // refusals that carry no meta (e.g. the mirror target fence).
  const liveRecovery = liveError ? (f?.nextAction ?? authorityRecoveryHint(f?.code)) : undefined;

  return (
    <div className="pane right" data-testid="state-pane">
      <div className="tabs">
        {(['route', 'store', 'tree', 'actions', 'e2e'] as const).map((t) => (
          <button
            key={t}
            data-testid={`state-tab-${t}`}
            className={tab === t ? 'tab on' : 'tab'}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'actions' ? (
        <div className="state-panel">
          <ActionsPanel actions={actions} error={actionsError} />
        </div>
      ) : tab === 'e2e' ? (
        <div className="state-panel">
          <E2ePanel e2eProgress={e2eProgress} e2eDoneCount={e2eDoneCount} />
        </div>
      ) : (
        <div className="state">
          {isPayloadTab(tab) && (
            <div className="state-live-row">
              <button
                data-testid="state-refresh"
                className="state-refresh-btn"
                disabled={loading === tab}
                onClick={() => void refresh(tab)}
              >
                {loading === tab ? 'reading…' : '↻ read live'}
              </button>
              {liveWins && f && (
                <span className="state-live-at" data-testid="state-live-at">
                  live · {fmtClock(f.at)}
                </span>
              )}
            </div>
          )}
          {tab === 'route' && liveRoute && <div className="liveroute">live route: {liveRoute}</div>}
          {liveWins && f ? (
            <>
              {f.truncated && <div className="trunc">payload truncated</div>}
              <pre data-testid="state-live-payload">{pretty(f.payload)}</pre>
            </>
          ) : evOk ? (
            <>
              {evOk.truncated && <div className="trunc">payload truncated</div>}
              <pre>{pretty(evOk.payload)}</pre>
            </>
          ) : tab === 'route' && liveRoute ? null : isPayloadTab(tab) ? (
            <div className="empty">
              {EMPTY_HINT[tab]}
              {liveError && (
                <div className="state-live-err" data-testid="state-live-err">
                  live read failed: {liveError}
                </div>
              )}
              {liveRecovery && (
                <div className="state-live-recovery" data-testid="state-live-recovery">
                  {liveRecovery}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
