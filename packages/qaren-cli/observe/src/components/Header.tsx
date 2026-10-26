import { useEffect, useState, type JSX } from 'react';
import type { AgentEvent, Conn, DeviceReadiness, MirrorState } from '../types';
import { deviceReadiness } from '../types';
import { fmtElapsed } from '../derive';

interface HeaderProps {
  conn: Conn;
  app?: string;
  route?: string;
  events: AgentEvent[];
  /** GH #791: device-mirror state — rendered as its own pill so transport liveness never masks a dead device. */
  mirror: MirrorState | null;
}

const DEVICE_DOT: Record<DeviceReadiness, string> = {
  live: 'open',
  connecting: 'connecting',
  blocked: 'error',
  off: 'error',
  disabled: '',
};

export function Header({ conn, app, route, events, mirror }: HeaderProps): JSX.Element {
  const startTs = events.length > 0 ? events[0].ts : null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (startTs == null) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [startTs]);

  const errors = events.reduce((n, e) => (e.ok ? n : n + 1), 0);
  // A dead transport means the last mirror status may be stale — never keep
  // presenting a positive device state over a disconnected stream.
  const device = conn === 'open' ? deviceReadiness(mirror) : null;

  return (
    <div className="header" data-testid="header">
      <div className="brand">
        <strong>Observe</strong>
        <span>qaren</span>
      </div>
      <span className="conn-pill" data-testid="header-conn" title="event-stream transport">
        <span className={`dot ${conn}`} />
        {conn === 'open' ? 'events live' : conn}
      </span>
      <span className="conn-pill" data-testid="header-device" title="device mirror readiness">
        <span className={device ? `dot ${DEVICE_DOT[device]}`.trim() : 'dot'} />
        device {device ?? 'waiting'}
      </span>
      {app && (
        <span className="chip" title={app}>
          <b>app</b>
          {app}
        </span>
      )}
      {route && (
        <span className="chip route" title={route} data-testid="header-route">
          <b>route</b>
          {route}
        </span>
      )}
      <div className="hstats">
        {startTs != null && (
          <span className="stat">
            <span className="v">{fmtElapsed(Date.now() - startTs)}</span>
            <span className="k">session</span>
          </span>
        )}
        <span className="stat" data-testid="header-calls">
          <span className="v">{events.length}</span>
          <span className="k">calls</span>
        </span>
        <span className="stat" data-testid="header-errors">
          <span className={errors > 0 ? 'v bad' : 'v'}>{errors}</span>
          <span className="k">errors</span>
        </span>
      </div>
    </div>
  );
}
