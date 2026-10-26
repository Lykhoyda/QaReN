// The Metro inspector proxy guards WebSocket upgrades with TWO origin gates, and
// Node's `ws` sends no Origin by default:
//   1. @react-native/dev-middleware (RN 0.85+) — a CSRF defense that 401s any
//      handshake whose Origin hostname is not loopback (localhost / 127.0.0.1 /
//      0.0.0.0 / [::]).
//   2. Expo SDK 56 createDebugMiddleware — a SECOND check (`isMatchingOrigin`)
//      requiring the Origin host to equal the dev server's serverBaseUrl host,
//      which resolves to `127.0.0.1` (from server.address()). A mismatch is
//      force-closed via socket.terminate() → a 1006 abnormal close right after
//      connect, before any CDP frame is relayed (the B178 "zero frames" wedge).
// `127.0.0.1` clears BOTH gates (loopback AND host-match), and also bare RN
// (which has only gate 1). `localhost` clears gate 1 but trips Expo's gate 2, so
// we must spell loopback as 127.0.0.1 here. (B177 + B178)
export function metroOrigin(wsUrl: string): string {
  try {
    const { port } = new URL(wsUrl);
    return `http://127.0.0.1:${port || '8081'}`;
  } catch {
    return 'http://127.0.0.1:8081';
  }
}
