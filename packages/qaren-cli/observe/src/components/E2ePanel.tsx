import { useEffect, useRef, useState, type JSX } from 'react';
import { observeFetch } from '../authority';
import type {
  E2eFlowResult,
  E2eProgress,
  E2eRunDetail,
  E2eRunIndexEntry,
  E2eRunResult,
} from '../types';
import { csrfToken } from '../derive';

interface E2ePanelProps {
  e2eProgress: E2eProgress | null;
  /** From useEventStream — bumps when a suite finishes anywhere (tool or UI). */
  e2eDoneCount: number;
}

export function E2ePanel({ e2eProgress, e2eDoneCount }: E2ePanelProps): JSX.Element {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<E2eRunResult | null>(null);
  const [history, setHistory] = useState<E2eRunIndexEntry[]>([]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [runDetails, setRunDetails] = useState<Record<string, E2eRunDetail | 'loading' | 'error'>>(
    {},
  );
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const historyFetchGeneration = useRef(0);

  const fetchHistory = async (): Promise<void> => {
    const generation = ++historyFetchGeneration.current;
    const fresh = (): boolean => generation === historyFetchGeneration.current;
    try {
      const r = await observeFetch('/api/e2e/runs');
      if (!fresh()) return;
      if (r.ok) {
        const runs = (await r.json()) as E2eRunIndexEntry[];
        if (!fresh()) return;
        setHistory(runs);
        setHistoryError(null);
        return;
      }
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      if (!fresh()) return;
      setHistory([]);
      setHistoryError(body?.error ?? `run history unavailable (HTTP ${r.status})`);
    } catch (e) {
      if (!fresh()) return;
      setHistory([]);
      setHistoryError(`run history unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  useEffect(() => {
    void fetchHistory();
  }, [e2eDoneCount]);

  const toggleRun = (runId: string): void => {
    const next = openRun === runId ? null : runId;
    setOpenRun(next);
    if (next && runDetails[next] === undefined) {
      setRunDetails((prev) => ({ ...prev, [next]: 'loading' }));
      observeFetch(`/api/e2e/runs/${encodeURIComponent(next)}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          const detail = (await r.json()) as E2eRunDetail;
          setRunDetails((prev) => ({ ...prev, [next]: detail }));
        })
        .catch(() => {
          setRunDetails((prev) => ({ ...prev, [next]: 'error' }));
        });
    }
  };

  const runSuite = async (): Promise<void> => {
    setRunning(true);
    setResult(null);
    setRunError(null);
    try {
      const r = await observeFetch('/api/e2e/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: '{}',
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        setRunError(body?.error ?? `run refused (HTTP ${r.status})`);
        return;
      }
      const envelope = asRunEnvelope(await r.json());
      if (envelope.ok === false) {
        const reason = envelope.error ?? 'run refused';
        setRunError(envelope.code ? `${reason} (${envelope.code})` : reason);
        return;
      }
      setResult(envelope);
      await fetchHistory();
    } catch (e) {
      setRunError(`run failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const verdict = result?.data?.verdict;
  const newlyFailing = result?.data?.newlyFailing ?? [];

  return (
    <div className="reg-container">
      <div className="reg-panel">
        <div className="reg-header">
          <button
            className="reg-run-btn"
            data-testid="e2e-run"
            disabled={running}
            onClick={() => void runSuite()}
          >
            {running ? 'Running…' : 'Run E2E Suite'}
          </button>
          {e2eProgress && (
            <span className="reg-progress mono">
              test {e2eProgress.completed}/{e2eProgress.total} · {e2eProgress.lastTestId}
            </span>
          )}
          {verdict && (
            <span
              data-testid="e2e-verdict"
              className={`reg-verdict ${verdict === 'green' ? 'pass' : verdict === 'empty' ? 'none' : 'fail'}`}
            >
              {verdict === 'green' ? 'PASS' : verdict === 'empty' ? 'NO TESTS' : 'FAIL'}
            </span>
          )}
          {verdict === 'empty' && (
            <span className="reg-empty-hint">
              No locked tests · lock one with cdp_lock_e2e_test
            </span>
          )}
        </div>
        {runError && (
          <div className="empty empty-guide" data-testid="e2e-run-unavailable">
            <div className="empty-title">Run unavailable</div>
            <div>{runError}</div>
          </div>
        )}
        {result?.data?.results && result.data.results.length > 0 && (
          <div className="result-list">
            {result.data.results.map((r) => (
              <FlowResultRow
                key={r.testId}
                result={r}
                newlyFailing={newlyFailing.includes(r.testId)}
              />
            ))}
          </div>
        )}
      </div>
      <div className="reg-history">
        <div className="pane-head">Run History</div>
        {historyError ? (
          <div className="empty empty-guide" data-testid="e2e-history-unavailable">
            <div className="empty-title">Run history unavailable</div>
            <div>{historyError}</div>
          </div>
        ) : history.length === 0 ? (
          <div className="empty">no runs yet</div>
        ) : (
          history.map((h) => (
            <HistoryItem
              key={h.runId}
              entry={h}
              open={openRun === h.runId}
              detail={runDetails[h.runId]}
              onToggle={() => toggleRun(h.runId)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// POST /api/e2e/run answers with the gate's ToolResult; unwrap it to the run envelope.
function asRunEnvelope(body: unknown): E2eRunResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const text = (record.content as { text?: string }[] | undefined)?.[0]?.text;
  let envelope = record;
  if (typeof text === 'string') {
    try {
      envelope = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, error: text };
    }
  }
  const inner = envelope.data as Record<string, unknown> | undefined;
  if (inner && typeof inner.ok === 'boolean') return inner as E2eRunResult;
  return envelope as E2eRunResult;
}

interface FlowResultRowProps {
  result: E2eFlowResult;
  newlyFailing?: boolean;
}

function FlowResultRow({ result: r, newlyFailing }: FlowResultRowProps): JSX.Element {
  return (
    <>
      <div className={newlyFailing ? 'result-row newly-failing' : 'result-row'}>
        <span className={`result-mark ${r.passed ? 'reg-pass' : 'reg-fail'}`}>
          {r.passed ? '✓' : '✗'}
        </span>
        <span className="reg-testid result-id" title={r.testId}>
          {r.testId}
        </span>
        {r.durationMs != null && <span className="result-ms mono">{r.durationMs}ms</span>}
        <span className={`reg-badge reg-badge-${r.classification}`}>{r.classification}</span>
      </div>
      {r.errorExcerpt && <div className="errx">{r.errorExcerpt}</div>}
    </>
  );
}

interface HistoryItemProps {
  entry: E2eRunIndexEntry;
  open: boolean;
  detail?: E2eRunDetail | 'loading' | 'error';
  onToggle: () => void;
}

function HistoryItem({ entry: h, open, detail, onToggle }: HistoryItemProps): JSX.Element {
  return (
    <div className="hist-item" data-testid="e2e-history-item">
      <button className="hist-toggle" data-testid="e2e-history-toggle" onClick={onToggle}>
        <span className="hist-caret">{open ? '▾' : '▸'}</span>
        <span className="reg-testid hist-id" title={h.runId}>
          {h.runId}
        </span>
        <span className="hist-time">{new Date(h.finishedAt).toLocaleTimeString()}</span>
        <span className="hist-totals mono">
          <span className="reg-pass">{h.totals.passed}✓</span>{' '}
          <span className={h.totals.failed > 0 ? 'reg-fail' : 'reg-none'}>{h.totals.failed}✗</span>
          {h.totals.skipped > 0 && <span className="reg-none"> {h.totals.skipped} skip</span>}
        </span>
        <span
          className={`hist-verdict ${
            h.verdict === 'green' ? 'reg-pass' : h.verdict === 'empty' ? 'reg-none' : 'reg-fail'
          }`}
        >
          {h.verdict === 'green' ? 'PASS' : h.verdict === 'empty' ? 'NO TESTS' : 'FAIL'}
        </span>
      </button>
      {open && (
        <div className="hist-body" data-testid="e2e-history-body">
          {detail === 'loading' || detail === undefined ? (
            <div className="empty">loading run…</div>
          ) : detail === 'error' ? (
            <div className="empty">failed to load run detail</div>
          ) : (
            <>
              <div className="hist-meta mono">
                {detail.platform} · {Math.round(detail.durationMs / 1000)}s ·{' '}
                {new Date(detail.startedAt).toLocaleTimeString()} →{' '}
                {new Date(detail.finishedAt).toLocaleTimeString()}
              </div>
              {detail.results.map((r) => (
                <FlowResultRow key={r.testId} result={r} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
