import { useEffect, useRef, useState } from 'react';
import { observeUrl } from '../authority';
import type { AgentEvent, Conn, E2eProgress, MirrorState } from '../types';

const MAX_EVENTS = 500;

const MIRROR_STATUSES = ['starting', 'streaming', 'error', 'idle', 'disabled'] as const;

export interface EventStream {
  events: AgentEvent[];
  conn: Conn;
  liveShotSeq: number | null;
  liveRoute: string | null;
  e2eProgress: E2eProgress | null;
  /** Increments on every e2e-done SSE message — watch it to refetch run history. */
  e2eDoneCount: number;
  mirror: MirrorState | null;
}

export function useEventStream(): EventStream {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [conn, setConn] = useState<Conn>('connecting');
  const [liveShotSeq, setLiveShotSeq] = useState<number | null>(null);
  const [liveRoute, setLiveRoute] = useState<string | null>(null);
  const [e2eProgress, setE2eProgress] = useState<E2eProgress | null>(null);
  const [e2eDoneCount, setE2eDoneCount] = useState(0);
  const [mirror, setMirror] = useState<MirrorState | null>(null);
  const maxSeqRef = useRef(0);

  useEffect(() => {
    const merge = (incoming: AgentEvent[]): void => {
      const fresh = incoming.filter(
        (e) => e && typeof e.seq === 'number' && e.seq > maxSeqRef.current,
      );
      if (fresh.length === 0) return;
      for (const e of fresh) if (e.seq > maxSeqRef.current) maxSeqRef.current = e.seq;
      setEvents((prev) => {
        const next = prev.concat(fresh);
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });
    };

    const es = new EventSource(observeUrl('/api/stream'));
    es.onopen = () => setConn('open');
    es.onerror = () => setConn('error');
    es.onmessage = (msg) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        return;
      }
      const type =
        parsed && typeof parsed === 'object' ? (parsed as { type?: string }).type : undefined;
      if (type === 'shutdown') {
        es.close();
        setConn('error');
        setLiveShotSeq(null);
        setLiveRoute(null);
        setMirror(null);
        return;
      }
      if (type === 'live') {
        const p = parsed as { shotSeq?: number; route?: string };
        if (typeof p.shotSeq === 'number') setLiveShotSeq(p.shotSeq);
        if (typeof p.route === 'string') setLiveRoute(p.route);
        return;
      }
      if (type === 'mirror') {
        const p = parsed as {
          status?: MirrorState['status'];
        } & Partial<MirrorState>;
        if (p.status && (MIRROR_STATUSES as readonly string[]).includes(p.status)) {
          setMirror({
            status: p.status,
            pipeline: p.pipeline,
            fps: p.fps,
            hint: p.hint,
            reason: p.reason,
            code: p.code,
          });
        }
        return;
      }
      if (type === 'e2e-progress') {
        const p = parsed as {
          completed?: number;
          total?: number;
          lastTestId?: string;
        };
        setE2eProgress({
          completed: p.completed ?? 0,
          total: p.total ?? 0,
          lastTestId: p.lastTestId ?? '',
        });
        return;
      }
      if (type === 'e2e-done') {
        setE2eProgress(null);
        setE2eDoneCount((n) => n + 1);
        return;
      }
      if (type === 'snapshot') {
        merge((parsed as { events?: AgentEvent[] }).events ?? []);
      } else {
        merge([parsed as AgentEvent]);
      }
    };
    return () => es.close();
  }, []);

  return {
    events,
    conn,
    liveShotSeq,
    liveRoute,
    e2eProgress,
    e2eDoneCount,
    mirror,
  };
}
