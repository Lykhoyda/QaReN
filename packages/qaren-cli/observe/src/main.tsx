import { useEffect, useMemo, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentEvent, Family, MirrorState } from './types';
import { CSS, FAMILIES } from './theme';
import { appOf, latestByFamily, latestByTool, routeOf } from './derive';
import { useEventStream } from './hooks/useEventStream';
import { Header } from './components/Header';
import { FilterBar } from './components/FilterBar';
import { Timeline } from './components/Timeline';
import { DevicePane } from './components/DevicePane';
import { StatePane } from './components/StatePane';

const RENDER_ROWS = 250;

function App(): JSX.Element {
  const { events, conn, liveShotSeq, liveRoute, e2eProgress, e2eDoneCount, mirror } =
    useEventStream();
  const [selected, setSelected] = useState<number | null>(null);
  // Latch typed refusals across probe retries: only a frame-backed
  // 'streaming' (or another terminal status) replaces them.
  const [latchedRefusal, setLatchedRefusal] = useState<MirrorState | null>(null);
  useEffect(() => {
    if (!mirror) {
      setLatchedRefusal(null);
      return;
    }
    if (mirror.status === 'error' && mirror.code) setLatchedRefusal(mirror);
    else if (mirror.status !== 'starting') setLatchedRefusal(null);
  }, [mirror]);
  const effectiveMirror = latchedRefusal ?? mirror;
  const [activeFamilies, setActiveFamilies] = useState<ReadonlySet<Family>>(new Set(FAMILIES));
  const [search, setSearch] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);

  const toggleFamily = (f: Family): void => {
    setActiveFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const counts = useMemo(() => {
    const c = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as Record<Family, number>;
    for (const e of events) c[e.family] = (c[e.family] ?? 0) + 1;
    return c;
  }, [events]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (e: AgentEvent): boolean => {
      if (!activeFamilies.has(e.family)) return false;
      if (errorsOnly && e.ok) return false;
      if (q && !e.tool.toLowerCase().includes(q) && !e.summary.toLowerCase().includes(q))
        return false;
      return true;
    };
    const out = events.filter(match);
    return out.length > RENDER_ROWS ? out.slice(out.length - RENDER_ROWS) : out;
  }, [events, activeFamilies, search, errorsOnly]);

  // Only cdp_navigation_state carries a nav-state payload; the family fallback
  // (cdp_navigate/cdp_nav_graph) is for header route derivation, not the panel.
  const navStateEv = latestByTool(events, ['cdp_navigation_state']);
  const navEv = navStateEv ?? latestByFamily(events, 'navigation');
  const storeEv = latestByTool(events, ['cdp_store_state']);
  const treeEv = latestByTool(events, ['cdp_component_tree']);
  const shotEv = latestByTool(events, ['device_screenshot']);
  const route = liveRoute ?? routeOf(navEv) ?? null;
  const app = appOf(events);

  return (
    <div className="app">
      <Header
        conn={conn}
        app={app}
        route={route ?? undefined}
        events={events}
        mirror={effectiveMirror}
      />
      <div className="panes">
        <div className="pane left">
          <FilterBar
            counts={counts}
            active={activeFamilies}
            onToggleFamily={toggleFamily}
            search={search}
            onSearch={setSearch}
            errorsOnly={errorsOnly}
            onErrorsOnly={setErrorsOnly}
          />
          <Timeline
            events={filtered}
            totalCount={events.length}
            selected={selected}
            onSelect={setSelected}
          />
        </div>
        <DevicePane
          mirror={effectiveMirror}
          liveShotSeq={liveShotSeq}
          fallbackSeq={shotEv && shotEv.ok ? shotEv.seq : null}
          route={route}
        />
        <StatePane
          navEv={navStateEv}
          storeEv={storeEv}
          treeEv={treeEv}
          liveRoute={liveRoute}
          e2eProgress={e2eProgress}
          e2eDoneCount={e2eDoneCount}
        />
      </div>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
