import { useEffect, useRef, useState, type JSX } from 'react';
import type { AgentEvent } from '../types';
import { FAMILY_COLOR } from '../theme';
import { fmtClock, pretty } from '../derive';

const SLOW_MS = 2000;
const BOTTOM_SLACK_PX = 48;

interface TimelineProps {
  /** Filtered events to render (already capped upstream). */
  events: AgentEvent[];
  /** Unfiltered buffer size, for the "showing X of Y" note. */
  totalCount: number;
  selected: number | null;
  onSelect: (seq: number | null) => void;
}

export function Timeline({ events, totalCount, selected, onSelect }: TimelineProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const countAtPauseRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [events, following]);

  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    if (atBottom && !following) setFollowing(true);
    if (!atBottom && following) {
      countAtPauseRef.current = events.length;
      setFollowing(false);
    }
  };

  const newCount = following ? 0 : Math.max(0, events.length - countAtPauseRef.current);

  return (
    <div className="timeline-wrap" data-testid="timeline">
      <div className="timeline" ref={ref} onScroll={onScroll}>
        {events.map((e) => (
          <div key={e.seq}>
            <div
              data-testid="timeline-row"
              className={`row ${selected === e.seq ? 'sel' : ''} ${e.ok ? '' : 'err'}`}
              onClick={() => onSelect(selected === e.seq ? null : e.seq)}
            >
              <span className="time">{fmtClock(e.ts)}</span>
              <span className="fam" style={{ background: FAMILY_COLOR[e.family] }}>
                {e.family.slice(0, 4)}
              </span>
              <span className="tool">{e.tool}</span>
              <span className="summ">{e.summary}</span>
              {e.ghost && <span className="ghost">ghost</span>}
              <span className={`ok ${e.ok ? 'pass' : 'fail'}`}>{e.ok ? '✓' : '✗'}</span>
              {e.durationMs != null && (
                <span className={e.durationMs > SLOW_MS ? 'dur slow' : 'dur'}>
                  {e.durationMs}ms
                </span>
              )}
            </div>
            {selected === e.seq && (
              <div className="detail" data-testid="timeline-detail">
                <div className="dlabel">args</div>
                <pre>{pretty(e.args)}</pre>
                {e.error && (
                  <>
                    <div className="dlabel">error</div>
                    <pre className="errtext">{pretty(e.error)}</pre>
                  </>
                )}
                {e.payload !== undefined && (
                  <>
                    <div className="dlabel">payload{e.truncated ? ' (truncated)' : ''}</div>
                    <pre>{pretty(e.payload)}</pre>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {events.length === 0 && totalCount === 0 && (
          <div className="empty empty-guide">
            <div className="empty-title">Waiting for agent activity</div>
            <div>Tool calls appear here as the agent works. Ask it to interact with the app.</div>
          </div>
        )}
        {events.length === 0 && totalCount > 0 && (
          <div className="empty">no events match the current filters</div>
        )}
      </div>
      {events.length < totalCount && (
        <div className="count-note">
          showing {events.length} of {totalCount} events
        </div>
      )}
      {!following && (
        <button className="jump" onClick={() => setFollowing(true)}>
          ↓ latest{newCount > 0 ? ` (${newCount} new)` : ''}
        </button>
      )}
    </div>
  );
}
