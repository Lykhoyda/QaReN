import { useEffect, useState, type JSX } from 'react';
import { observeUrl } from '../authority';
import { authorityRecoveryHint } from '../authority-hints';
import type { MirrorState } from '../types';

interface DevicePaneProps {
  mirror: MirrorState | null;
  liveShotSeq: number | null;
  /** seq of the latest device_screenshot event, used before any live frame exists. */
  fallbackSeq: number | null;
  route: string | null;
}

const MAX_MIRROR_RETRIES = 3;

export function DevicePane({
  mirror,
  liveShotSeq,
  fallbackSeq,
  route,
}: DevicePaneProps): JSX.Element {
  // Nonce busts the browser's connection cache on retry; attempts cap avoids
  // hammering a dead endpoint (mirror disabled / persistent capture error).
  const [nonce, setNonce] = useState(1);
  const [attempts, setAttempts] = useState(0);

  // A fresh starting/streaming status is the server telling us the pipeline is
  // (re)alive — re-arm the <img> retry budget. A pushed 'error' status is
  // authoritative even with zero client-side onError failures yet (e.g. the
  // manager's resolveTarget failed on the very first attach) — route it
  // through the same `attempts` budget so mirrorBroken has a single source of
  // truth that the re-arm effects below can reset.
  useEffect(() => {
    if (mirror?.status === 'starting' || mirror?.status === 'streaming') {
      setAttempts(0);
      setNonce((n) => n + 1);
    } else if (mirror?.status === 'error') {
      setAttempts(MAX_MIRROR_RETRIES);
    }
  }, [mirror?.status]);

  const mirrorBroken = attempts >= MAX_MIRROR_RETRIES;

  // A new live screenshot proves a device/CDP target now exists — if the tab
  // opened before any session did, the first attach fails with no future
  // status push to re-arm on (the manager only retries in response to a fresh
  // attach), so a live frame arriving is the signal that retrying may now
  // succeed.
  useEffect(() => {
    if (mirrorBroken && liveShotSeq != null) {
      setAttempts(0);
      setNonce((n) => n + 1);
    }
  }, [liveShotSeq]);

  // Belt-and-suspenders: while broken, retry every 15s regardless of other
  // signals. A failed attach is cheap (the manager's resolveTarget failure
  // ends the request immediately — no process spawned), so slow polling costs
  // nothing and guarantees recovery even if no live-screenshot event ever
  // fires (e.g. the agent only takes fallback screenshots).
  useEffect(() => {
    if (!mirrorBroken) return;
    const id = setInterval(() => {
      setAttempts(0);
      setNonce((n) => n + 1);
    }, 15000);
    return () => clearInterval(id);
  }, [mirrorBroken]);

  // The server states this on stream open when no MirrorManager is configured,
  // so the endpoint is a permanent 404 — never probe it.
  const mirrorDisabled = mirror?.status === 'disabled';
  const useMirror = !mirrorBroken && !mirrorDisabled;

  // A typed authority refusal is an explicit blocked state that replaces the
  // mirror and any stale screenshot (App latches it across probe retries).
  const blocked = mirror?.status === 'error' && mirror.code ? mirror : null;

  const fallbackSrc =
    liveShotSeq != null
      ? observeUrl(`/api/live-screenshot/${liveShotSeq}`)
      : fallbackSeq != null
        ? observeUrl(`/api/screenshot/${fallbackSeq}`)
        : null;

  const onMirrorError = (): void => {
    // mirror === null means no {type:'mirror'} SSE status has ever arrived —
    // the endpoint is almost certainly disabled/absent (404) or the backend
    // predates mirror support, and nothing will ever push a status to re-arm
    // the retry budget. Retrying a permanent 404 only delays the fallback
    // screenshot, so skip straight to the fallback instead of burning the
    // retry timers.
    if (mirror === null) {
      setAttempts(MAX_MIRROR_RETRIES);
      return;
    }
    setAttempts((a) => a + 1);
    if (attempts + 1 < MAX_MIRROR_RETRIES) {
      setTimeout(() => setNonce((n) => n + 1), 2000);
    }
  };

  // The blocked panel already carries the code, reason and recovery path;
  // repeating them in the footer buries the one actionable step.
  const statusLine = blocked
    ? null
    : mirror?.status === 'streaming'
      ? `mirror: ${mirror.pipeline}${mirror.fps ? ` ~${mirror.fps}fps` : ''}`
      : mirror?.status === 'error'
        ? `mirror off: ${mirror.reason ?? 'error'}`
        : mirror?.status === 'starting'
          ? 'mirror: connecting…'
          : mirrorDisabled
            ? 'mirror: disabled'
            : null;

  // A hint on a *streaming* status is the backend saying the pipeline works
  // but a better one is available (simctl fallback → install idb); that is
  // advice, not a failure, so it gets the header banner. Hints on error
  // statuses stay in the footer next to the failure reason.
  const streamingHint = mirror?.status === 'streaming' ? mirror.hint : undefined;
  const footerHint = blocked || mirror?.status === 'streaming' ? undefined : mirror?.hint;

  return (
    <div className="pane center" data-testid="device-pane">
      <div className="pane-head">
        Device
        {route && <span className="route-chip">{route}</span>}
      </div>
      {streamingHint && <div className="mirror-banner">{streamingHint}</div>}
      <div className="screen">
        {blocked ? (
          <>
            <div className="empty empty-guide device-blocked" data-testid="device-blocked">
              <div className="empty-title">Device blocked</div>
              <div className="mono device-blocked-code">{blocked.code}</div>
              {blocked.reason && <div className="device-blocked-reason">{blocked.reason}</div>}
              {authorityRecoveryHint(blocked.code) && (
                <div className="device-blocked-hint">{authorityRecoveryHint(blocked.code)}</div>
              )}
            </div>
            {/* Hidden probe: keeps re-attaching (15s retry loop) so a later
                authority bind pushes a fresh status and clears the blocked
                state without a manual reload. */}
            {useMirror && (
              <img
                style={{ display: 'none' }}
                src={observeUrl(`/api/device/mirror?t=${nonce}`)}
                alt=""
                onError={onMirrorError}
              />
            )}
          </>
        ) : useMirror ? (
          <div className="device-frame">
            <img
              data-testid="device-mirror"
              src={observeUrl(`/api/device/mirror?t=${nonce}`)}
              alt="live device mirror"
              onError={onMirrorError}
            />
          </div>
        ) : fallbackSrc ? (
          <div className="device-frame">
            <img src={fallbackSrc} alt="device screenshot" data-testid="device-screenshot" />
          </div>
        ) : (
          <div className="empty empty-guide">
            <div className="empty-title">No screenshot yet</div>
            <div>The screen appears here automatically after the agent interacts with the app.</div>
            <div>Nothing showing? Check the connection with cdp_status.</div>
          </div>
        )}
      </div>
      {(statusLine || footerHint) && (
        <div className="mirror-footer">
          {statusLine}
          {footerHint ? <span className="mirror-hint"> — {footerHint}</span> : null}
        </div>
      )}
    </div>
  );
}
