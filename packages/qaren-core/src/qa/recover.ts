import type { Screen } from './screen.js';
import type { Reason } from './untrusted.js';
import type { ActResult } from './walker.js';

export interface LoginMarker {
  id?: string;
  text?: string;
}

export type LoginReplay =
  | 'pass'
  | 'fail'
  | { fail: Reason }
  | { refuse: { code: string; message: string } };

export interface RecoverDeps {
  dialog(): Promise<ActResult>;
  hideDevMenu(): Promise<ActResult>;
  replayLogin?(): Promise<LoginReplay>;
}

export type Recovery =
  | { handled: 'dialog' | 'dev-menu' | 'dev-fab' | 'login' }
  | { fail: Reason }
  | { refuse: { code: string; message: string } };

// Deterministic, in this order; undefined means nothing applies and the original failure stands.
export async function recover(
  screen: Screen,
  deps: RecoverDeps,
  marker?: LoginMarker,
): Promise<Recovery | undefined> {
  if (screen.front === 'dialog') {
    const accepted = await deps.dialog();
    return accepted.ok
      ? { handled: 'dialog' }
      : {
          fail: `the system dialog in front could not be accepted: ${accepted.error ?? 'not dispatched'}`,
        };
  }
  if (screen.front === 'dev-menu' || screen.front === 'dev-fab') {
    const hidden = await deps.hideDevMenu();
    return hidden.ok && hidden.executed !== false
      ? { handled: screen.front }
      : { fail: `the dev menu in front could not be hidden: ${hidden.error ?? 'not dispatched'}` };
  }
  if (!deps.replayLogin || !marker || !loginWall(screen, marker)) return undefined;
  const replayed = await deps.replayLogin();
  if (replayed === 'pass') return { handled: 'login' };
  return replayed === 'fail' ? { fail: 'the login block did not pass' } : replayed;
}

function loginWall(screen: Screen, marker: LoginMarker): boolean {
  return screen.elements.some(
    (e) =>
      !e.offscreen &&
      ((marker.id !== undefined && e.testID === marker.id) ||
        (marker.text !== undefined && e.label === marker.text)),
  );
}
