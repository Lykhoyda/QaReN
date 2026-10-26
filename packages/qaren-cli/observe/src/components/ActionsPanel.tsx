import { useState, type JSX } from 'react';
import { observeFetch } from '../authority';
import type { ActionRunState, ActionSummary } from '../types';
import { csrfToken } from '../derive';

interface ActionsPanelProps {
  actions: ActionSummary[];
  error?: string | null;
}

export function ActionsPanel({ actions, error }: ActionsPanelProps): JSX.Element {
  const [states, setStates] = useState<Record<string, ActionRunState>>({});
  const [paramValues, setParamValues] = useState<Record<string, Record<string, string>>>({});
  const [openOutput, setOpenOutput] = useState<string | null>(null);

  const setParam = (actionId: string, key: string, value: string): void => {
    setParamValues((prev) => ({ ...prev, [actionId]: { ...prev[actionId], [key]: value } }));
  };

  const run = async (a: ActionSummary): Promise<void> => {
    setStates((prev) => ({ ...prev, [a.id]: { running: true } }));
    try {
      const r = await observeFetch('/api/e2e/actions/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ actionId: a.id, params: paramValues[a.id] ?? {} }),
      });
      const result = (await r.json()) as ActionRunState['result'];
      setStates((prev) => ({ ...prev, [a.id]: { running: false, result } }));
      if (result && (!result.ok || result.output)) setOpenOutput(a.id);
    } catch {
      setStates((prev) => ({
        ...prev,
        [a.id]: { running: false, result: { ok: false, error: 'network error' } },
      }));
    }
  };

  return (
    <div className="reg-container">
      <div className="actions-panel">
        <div className="pane-head">Actions</div>
        {error ? (
          <div className="empty empty-guide" data-testid="actions-unavailable">
            <div className="empty-title">Actions unavailable</div>
            <div>{error}</div>
          </div>
        ) : actions.length === 0 ? (
          <div className="empty empty-guide">
            <div className="empty-title">No learned actions</div>
            <div>Save a verified flow with cdp_record_test_save_as_action and it appears here.</div>
          </div>
        ) : (
          actions.map((a) => {
            const st = states[a.id];
            const missing = st?.result?.missingParams ?? [];
            return (
              <ActionItem
                key={a.id}
                action={a}
                state={st}
                missing={missing}
                values={paramValues[a.id] ?? {}}
                onParam={(k, v) => setParam(a.id, k, v)}
                onRun={() => void run(a)}
                outputOpen={openOutput === a.id}
                onToggleOutput={() => setOpenOutput(openOutput === a.id ? null : a.id)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

interface ActionItemProps {
  action: ActionSummary;
  state?: ActionRunState;
  missing: string[];
  values: Record<string, string>;
  onParam: (key: string, value: string) => void;
  onRun: () => void;
  outputOpen: boolean;
  onToggleOutput: () => void;
}

function ActionItem({
  action: a,
  state: st,
  missing,
  values,
  onParam,
  onRun,
  outputOpen,
  onToggleOutput,
}: ActionItemProps): JSX.Element {
  const res = st?.result;
  return (
    <div className="action-item" data-testid="action-item">
      <div className="action-top">
        <span className="reg-testid action-id" title={a.id}>
          {a.id}
        </span>
        <span className={`reg-badge actions-status-${a.status}`}>{a.status}</span>
        {a.mutates && (
          <span className="actions-mutates" title="mutates state">
            M
          </span>
        )}
        <button
          className="actions-run-btn"
          data-testid="action-run"
          disabled={st?.running}
          onClick={onRun}
        >
          {st?.running ? '…' : 'Run'}
        </button>
      </div>
      <div className="action-intent" title={a.intent}>
        {a.intent}
      </div>
      {(a.params ?? []).length > 0 && (
        <div className="actions-params">
          {(a.params ?? []).map((p) => (
            <input
              key={p}
              data-testid={`action-param-${p}`}
              className={missing.includes(p) ? 'param-input missing' : 'param-input'}
              placeholder={p}
              value={values[p] ?? ''}
              onChange={(e) => onParam(p, e.target.value)}
            />
          ))}
        </div>
      )}
      {res && (
        <div className="action-result" data-testid="action-result">
          <span
            className={res.ok ? 'actions-result-ok' : 'actions-result-fail'}
            onClick={onToggleOutput}
            title="show output"
          >
            {res.ok
              ? '✓ output'
              : res.missingParams
                ? `missing: ${res.missingParams.join(', ')}`
                : (res.error ?? 'failed')}
          </span>
        </div>
      )}
      {outputOpen && res && (res.output || res.error) && (
        <pre className="action-output" data-testid="action-output">
          {res.output ?? res.error}
        </pre>
      )}
    </div>
  );
}
