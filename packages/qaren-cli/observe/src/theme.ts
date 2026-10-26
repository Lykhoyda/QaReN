import type { Family } from './types';

export const FAMILIES: Family[] = [
  'interaction',
  'introspection',
  'navigation',
  'lifecycle',
  'testing',
  'other',
];

export const FAMILY_COLOR: Record<Family, string> = {
  interaction: '#7aa2f7',
  introspection: '#9ece6a',
  navigation: '#e0af68',
  lifecycle: '#bb9af7',
  testing: '#f7768e',
  other: '#787c99',
};

// Tokyo Night tokens
// bg #16161e | surface #1a1b26 | raised #1f2335 | selected #283457 | border #2a2b3d
// text #c0caf5 | soft #a9b1d6 | muted #787c99 | dim #565f89
// blue #7aa2f7 | cyan #7dcfff | green #9ece6a | yellow #e0af68 | purple #bb9af7 | red #f7768e

export const CSS = `
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: #16161e; color: #c0caf5;
  font: 13px/1.45 -apple-system, system-ui, sans-serif;
}
pre, .mono, .tool, .dur, .summ, .time, .reg-testid { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
button { font: inherit; }
.app { display: flex; flex-direction: column; height: 100%; }

/* ── Header ─────────────────────────────────────────────── */
.header {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 8px 16px; background: #1a1b26; border-bottom: 1px solid #2a2b3d;
}
.brand { display: flex; align-items: baseline; gap: 8px; }
.brand strong { font-size: 14px; letter-spacing: 0.3px; }
.brand span { color: #565f89; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
.conn-pill {
  display: inline-flex; align-items: center; gap: 6px;
  background: #1f2335; border: 1px solid #2a2b3d; border-radius: 999px;
  padding: 2px 10px; font-size: 11px; color: #a9b1d6;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #787c99; flex: none; }
.dot.open { background: #9ece6a; box-shadow: 0 0 6px #9ece6a66; }
.dot.connecting { background: #e0af68; }
.dot.error { background: #f7768e; }
.chip {
  background: #1f2335; border: 1px solid #2a2b3d; border-radius: 6px;
  padding: 2px 8px; font-size: 11px; color: #a9b1d6; max-width: 260px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chip.route { color: #9ece6a; }
.chip b { color: #565f89; font-weight: 600; margin-right: 5px; text-transform: uppercase; font-size: 10px; }
.hstats { margin-left: auto; display: flex; align-items: center; gap: 14px; }
.stat { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.2; }
.stat .v { font-weight: 700; font-size: 13px; }
.stat .k { color: #565f89; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
.stat .v.bad { color: #f7768e; }

/* ── Panes ──────────────────────────────────────────────── */
.panes { display: flex; flex: 1; min-height: 0; }
.pane { display: flex; flex-direction: column; min-width: 0; border-right: 1px solid #2a2b3d; }
.pane.left { flex: 0 0 33%; min-width: 380px; }
/* The mirror is a portrait phone screen capped at ~100vh height, so width
   beyond ~400px is dead space — the state pane absorbs the surplus instead. */
.pane.center { flex: 0 1 400px; min-width: 280px; }
.pane.right { flex: 1 1 26%; min-width: 340px; border-right: none; }
.pane-head {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; background: #1a1b26; border-bottom: 1px solid #2a2b3d;
  font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: #a9b1d6;
}

/* ── Filter bar ─────────────────────────────────────────── */
.filterbar {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 8px 10px; background: #1a1b26; border-bottom: 1px solid #2a2b3d;
}
.fchip {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  background: #1f2335; color: #a9b1d6; border: 1px solid #2a2b3d;
  border-radius: 999px; padding: 2px 10px; font-size: 11px;
}
.fchip .fdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.fchip .n { color: #565f89; }
.fchip.off { opacity: 0.35; }
.fchip.errors.on { border-color: #f7768e; color: #f7768e; }
.search {
  flex: 1; min-width: 130px; background: #1f2335; border: 1px solid #2a2b3d;
  border-radius: 6px; color: #c0caf5; padding: 4px 10px; font: inherit; font-size: 12px;
}
.search::placeholder { color: #565f89; }
.search:focus { outline: none; border-color: #7aa2f7; }

/* ── Timeline ───────────────────────────────────────────── */
.timeline-wrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.timeline { flex: 1; overflow: auto; padding: 4px 0; }
.row {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 12px; cursor: pointer; white-space: nowrap;
}
.row:hover { background: #1f2335; }
.row.sel { background: #283457; }
.row.err { box-shadow: inset 2px 0 0 #f7768e; }
.time { color: #565f89; font-size: 11px; flex: none; }
.fam { color: #16161e; border-radius: 3px; padding: 0 5px; font-size: 10px; font-weight: 700; text-transform: uppercase; flex: none; }
.tool { color: #7dcfff; flex: none; }
.summ { color: #a9b1d6; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.ghost { color: #16161e; background: #e0af68; border-radius: 3px; padding: 0 4px; font-size: 10px; font-weight: 700; flex: none; }
.ok { flex: none; } .ok.pass { color: #9ece6a; } .ok.fail { color: #f7768e; }
.dur { color: #565f89; font-size: 11px; flex: none; }
.dur.slow { color: #e0af68; font-weight: 700; }
.detail { background: #13141c; border-top: 1px solid #2a2b3d; border-bottom: 1px solid #2a2b3d; padding: 8px 12px; }
.dlabel { color: #787c99; text-transform: uppercase; font-size: 10px; margin: 6px 0 2px; letter-spacing: 0.5px; }
.detail pre, .state pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.detail pre.errtext { color: #f7768e; }
.jump {
  position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
  background: #283457; color: #c0caf5; border: 1px solid #7aa2f7; border-radius: 999px;
  padding: 5px 14px; cursor: pointer; font-size: 12px; font-weight: 600;
  box-shadow: 0 4px 14px #00000088;
}
.jump:hover { background: #3b4261; }
.count-note { padding: 4px 12px; color: #565f89; font-size: 11px; border-top: 1px solid #1f2335; }

/* ── Device pane ────────────────────────────────────────── */
.screen { flex: 1; overflow: auto; display: flex; align-items: center; justify-content: center; padding: 16px; }
.device-frame {
  background: #101018; border: 1px solid #2a2b3d; border-radius: 22px;
  padding: 10px; box-shadow: 0 8px 30px #00000066; max-width: 100%; max-height: 100%;
}
.device-frame img { display: block; max-width: 100%; max-height: calc(100vh - 160px); border-radius: 14px; }
.route-chip {
  margin-left: auto; background: #1f2335; color: #9ece6a; border: 1px solid #2a2b3d;
  border-radius: 999px; padding: 1px 10px; font-size: 11px; font-weight: 600; text-transform: none; letter-spacing: 0;
}
.mirror-footer {
  flex: none; padding: 3px 12px; text-align: center; font-size: 11px; color: #565f89;
  background: #1a1b26; border-top: 1px solid #2a2b3d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mirror-banner {
  flex: none; padding: 5px 12px; font-size: 11px; line-height: 1.45;
  color: #e0af68; background: #1a1b26; border-bottom: 1px solid #2a2b3d;
}

/* ── Tabs / state pane ──────────────────────────────────── */
.tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 7px 10px; background: #1a1b26; border-bottom: 1px solid #2a2b3d; }
.tab {
  background: #1f2335; color: #a9b1d6; border: 1px solid #2a2b3d; border-radius: 6px;
  padding: 3px 10px; cursor: pointer;
}
.tab.on { background: #283457; color: #c0caf5; border-color: #7aa2f7; }
.state { flex: 1; overflow: auto; padding: 10px 12px; }
.state-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.trunc { color: #e0af68; font-size: 11px; margin-bottom: 6px; }
.liveroute { color: #9ece6a; font-weight: 600; margin-bottom: 8px; word-break: break-all; }
.state-live-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.state-refresh-btn {
  background: #283457; color: #c0caf5; border: 1px solid #7aa2f7; border-radius: 6px;
  padding: 3px 10px; cursor: pointer; font-size: 12px;
}
.state-refresh-btn:hover:not(:disabled) { background: #3b4261; }
.state-refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.state-live-at { color: #9ece6a; font-size: 11px; }
.state-live-err { color: #f7768e; font-size: 12px; margin-top: 8px; }
.mirror-hint { color: #e0af68; }

/* ── Empty states ───────────────────────────────────────── */
.empty { color: #565f89; padding: 14px; }
.empty-guide { margin: auto; max-width: 320px; text-align: center; line-height: 1.6; }
.empty-guide .empty-title { color: #a9b1d6; font-weight: 600; margin-bottom: 6px; font-size: 14px; }
.device-blocked { border: 1px solid #f7768e55; border-radius: 10px; padding: 16px; }
.device-blocked .empty-title { color: #f7768e; }
.device-blocked-code { color: #f7768e; font-size: 11px; margin-bottom: 6px; }
.device-blocked-reason { color: #f7768e; margin-bottom: 8px; }
.device-blocked-hint { color: #e0af68; }
.state-live-recovery { color: #e0af68; font-size: 12px; margin-top: 6px; }

/* ── E2E panel (run history + suite results) ───────────── */
/* The right pane is ~340-450px wide; tables cannot shrink below their
   column content, so results, history, and actions render as stacked
   rows that truncate/wrap instead. */
.reg-container { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto; padding: 10px; gap: 10px; }
.reg-panel, .actions-panel, .reg-history { background: #1a1b26; border: 1px solid #2a2b3d; border-radius: 8px; overflow: hidden; flex: none; }
.reg-header { display: flex; align-items: center; gap: 10px; padding: 12px; flex-wrap: wrap; }
.reg-run-btn {
  background: #283457; color: #c0caf5; border: 1px solid #7aa2f7; border-radius: 6px;
  padding: 6px 18px; cursor: pointer; font-weight: 600;
}
.reg-run-btn:hover:not(:disabled) { background: #3b4261; }
.reg-run-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.reg-progress { color: #e0af68; font-size: 12px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reg-verdict { font-weight: 700; border-radius: 6px; padding: 3px 12px; font-size: 13px; }
.reg-verdict.pass { background: #1a2d1a; color: #9ece6a; border: 1px solid #9ece6a; }
.reg-verdict.fail { background: #2d1a1a; color: #f7768e; border: 1px solid #f7768e; }
.reg-verdict.none { background: #1f2335; color: #787c99; border: 1px solid #565f89; }
.reg-empty-hint { color: #787c99; font-size: 12px; font-style: italic; }
.reg-testid { color: #7dcfff; }
.reg-pass { color: #9ece6a; font-weight: 600; }
.reg-fail { color: #f7768e; font-weight: 600; }
.reg-none { color: #787c99; font-weight: 600; }
.reg-badge { border-radius: 3px; padding: 1px 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; flex: none; }
.reg-badge-pass { background: #1a2d1a; color: #9ece6a; }
.reg-badge-regression { background: #2d1a1a; color: #f7768e; }
.reg-badge-infra { background: #2d2a1a; color: #e0af68; }
.reg-badge-skipped { background: #1f2335; color: #787c99; }
.result-list { border-top: 1px solid #2a2b3d; }
.result-row { display: flex; align-items: center; gap: 7px; padding: 5px 12px; font-size: 12px; }
.result-row + .result-row, .errx + .result-row { border-top: 1px solid #1f2335; }
.result-row.newly-failing { background: #2d1a1a; }
.result-mark { flex: none; }
.result-id { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-ms { color: #565f89; font-size: 11px; flex: none; }
.errx {
  color: #f7768e; font-size: 11px; white-space: pre-wrap; word-break: break-word;
  padding: 0 12px 5px 31px;
}
.hist-item + .hist-item { border-top: 1px solid #1f2335; }
.hist-toggle {
  display: flex; align-items: center; gap: 7px; width: 100%;
  background: none; border: none; color: inherit; text-align: left;
  padding: 7px 12px; cursor: pointer; font-size: 12px;
}
.hist-toggle:hover { background: #1f2335; }
.hist-caret { color: #565f89; font-size: 10px; flex: none; }
.hist-id { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-time { color: #565f89; font-size: 11px; flex: none; }
.hist-totals { font-size: 11px; flex: none; }
.hist-verdict { font-size: 11px; flex: none; }
.hist-body { background: #13141c; border-top: 1px solid #1f2335; padding-bottom: 5px; }
.hist-body .result-row { padding-left: 12px; }
.hist-meta { color: #787c99; font-size: 11px; padding: 7px 12px 4px; }

/* ── Actions panel ──────────────────────────────────────── */
.action-item { padding: 9px 12px; }
.action-item + .action-item { border-top: 1px solid #1f2335; }
.action-top { display: flex; align-items: center; gap: 7px; }
.action-id { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.action-intent {
  color: #787c99; font-size: 12px; line-height: 1.4; margin-top: 3px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.actions-params { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
.param-input {
  background: #1f2335; border: 1px solid #2a2b3d; border-radius: 4px; color: #c0caf5;
  padding: 3px 8px; font-size: 11px; font-family: ui-monospace, "SF Mono", Menlo, monospace;
  flex: 1 1 90px; min-width: 0;
}
.param-input::placeholder { color: #565f89; }
.param-input:focus { outline: none; border-color: #7aa2f7; }
.param-input.missing { border-color: #f7768e; }
.actions-mutates { background: #2d2a1a; color: #e0af68; border-radius: 3px; padding: 1px 4px; font-size: 10px; font-weight: 700; flex: none; }
.actions-status-active { background: #1a2d1a; color: #9ece6a; }
.actions-status-experimental { background: #2d2a1a; color: #e0af68; }
.actions-status-deprecated { background: #1f2335; color: #787c99; }
.actions-run-btn {
  background: #283457; color: #c0caf5; border: 1px solid #2a2b3d; border-radius: 4px;
  padding: 3px 12px; cursor: pointer; font-size: 11px; flex: none;
}
.actions-run-btn:hover:not(:disabled) { background: #3b4261; border-color: #7aa2f7; }
.actions-run-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.action-result { margin-top: 6px; font-size: 11px; }
.actions-result-ok { color: #9ece6a; font-weight: 600; cursor: pointer; }
.actions-result-fail { color: #f7768e; cursor: pointer; word-break: break-word; }
.action-output {
  margin: 6px 0 0; background: #13141c; border: 1px solid #1f2335; border-radius: 6px;
  padding: 8px 10px; font-size: 11px; white-space: pre-wrap; word-break: break-word;
  max-height: 240px; overflow: auto;
}
`;
