import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import WebSocket, { WebSocketServer } from 'ws';
import { metroOrigin } from '../ws-origin.js';

import { logger } from '../logger.js';

/**
 * Phase 134.4 (deepsec HIGH): generate a per-multiplexer capability
 * token that consumers must include in the WebSocket upgrade path.
 * 32 bytes of crypto.randomBytes → 43 char base64url string. Never
 * logged, never exposed in error messages.
 */
export function generateCapabilityToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Pure verification helper. Returns true iff the request path is
 * exactly `/<expectedToken>`. Uses timingSafeEqual on equal-length
 * buffers to avoid leaking the token via response-timing side
 * channels. Fails closed on missing/empty/non-string inputs and on
 * empty expectedToken (never accept an unauthenticated multiplexer).
 */
export function verifyConsumerPath(reqUrl: unknown, expectedToken: string): boolean {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) return false;
  if (typeof reqUrl !== 'string' || reqUrl.length === 0) return false;
  if (!reqUrl.startsWith('/')) return false;
  const submitted = reqUrl.slice(1);
  if (submitted.length !== expectedToken.length) return false;
  const a = Buffer.from(submitted);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * CDP Multiplexer proxy (M1 / Phase 90 Tier 1).
 *
 * Hermes accepts ONLY ONE CDP connection. When a user opens React Native DevTools
 * (or any second debugger) while the MCP is connected, the MCP's WebSocket gets
 * evicted with close code 1006. This module is the compatibility layer that lets
 * both coexist on RN versions that don't support native multi-debugger (RN < 0.85).
 *
 * Id rewriting strategy:
 *   consumer sends a message with some id
 *   proxy allocates a fresh upstream id, records the mapping, forwards upstream
 *   hermes replies with that upstream id
 *   proxy looks up the mapping, restores the original consumer id, forwards back
 *
 * Events (no id field) broadcast to all consumers.
 */

export interface MultiplexerOptions {
  /** WebSocket URL to the target Hermes instance, e.g. ws://127.0.0.1:8081/inspector/debug?targetId=... */
  hermesUrl: string;
  /** Bind host for the consumer-facing server. Default: 127.0.0.1 (loopback only). */
  host?: string;
  /** Bind port. Default: 0 (random ephemeral). */
  port?: number;
  /** Logger tag. Default: 'CDP.proxy' */
  logTag?: string;
  /** Max size of the hermesBuffer (messages enqueued during CONNECTING). Default: 1000. Drop-oldest on overflow. */
  hermesBufferMaxSize?: number;
  /** Max age for routing entries before the sweeper drops them. Default: 60000 ms. */
  routingTimeoutMs?: number;
}

type RoutingEntry = { consumerId: number; consumerOriginalId: number; createdAt: number };

const HERMES_BUFFER_MAX_DEFAULT = 1000;
const ROUTING_TIMEOUT_MS_DEFAULT = 60_000;

export class CDPMultiplexer {
  private readonly opts: Required<MultiplexerOptions>;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private hermesWs: WebSocket | null = null;
  private consumers = new Map<number, WebSocket>();
  private nextConsumerId = 1;
  private upstreamSeq = 1;
  private routingTable = new Map<number, RoutingEntry>();
  private hermesBuffer: string[] = [];
  private state: 'stopped' | 'starting' | 'running' | 'stopping' = 'stopped';
  private boundPort: number | null = null;
  /**
   * Phase 134.4: per-instance capability token. Required in the
   * WebSocket upgrade path. Never logged. Exposed via `token` getter
   * so the caller can include it in the URL it hands to DevTools.
   */
  private readonly capabilityToken: string = generateCapabilityToken();

  /** Phase 134.4: the capability token for this multiplexer instance. */
  get token(): string {
    return this.capabilityToken;
  }
  private routingSweeper: NodeJS.Timeout | null = null;

  constructor(opts: MultiplexerOptions) {
    this.opts = {
      hermesUrl: opts.hermesUrl,
      host: opts.host ?? '127.0.0.1',
      port: opts.port ?? 0,
      logTag: opts.logTag ?? 'CDP.proxy',
      hermesBufferMaxSize: opts.hermesBufferMaxSize ?? HERMES_BUFFER_MAX_DEFAULT,
      routingTimeoutMs: opts.routingTimeoutMs ?? ROUTING_TIMEOUT_MS_DEFAULT,
    };
  }

  get port(): number | null {
    return this.boundPort;
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  get consumerCount(): number {
    return this.consumers.size;
  }

  /** Test-only: current size of the routing table (how many pending upstream requests). */
  get routingTableSize(): number {
    return this.routingTable.size;
  }

  /** Test-only: current size of the CONNECTING-window buffer. */
  get hermesBufferSize(): number {
    return this.hermesBuffer.length;
  }

  async start(): Promise<number> {
    if (this.state !== 'stopped') {
      throw new Error(`CDPMultiplexer cannot start from state '${this.state}'`);
    }
    this.state = 'starting';

    try {
      const port = await this.startConsumerServer();
      await this.connectHermes();
      this.startRoutingSweeper();
      this.state = 'running';
      logger.info(this.opts.logTag, `multiplexer running on ${this.opts.host}:${port}`);
      return port;
    } catch (err) {
      this.state = 'stopping';
      await this.cleanup();
      this.state = 'stopped';
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') return;
    this.state = 'stopping';
    await this.cleanup();
    this.state = 'stopped';
    logger.info(this.opts.logTag, 'multiplexer stopped');
  }

  private startConsumerServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer();
      this.wss = new WebSocketServer({
        server: this.httpServer,
        // Phase 134.4 (deepsec HIGH): reject any upgrade that doesn't
        // include the capability token in the path. Any sibling
        // process that learned the loopback port (or a browser tab
        // scanning local ports) is refused before reaching
        // onConsumerConnect / onConsumerMessage. Token comparison
        // uses timingSafeEqual to avoid leaking the secret via
        // timing side channels.
        verifyClient: (info, callback) => {
          if (verifyConsumerPath(info.req.url, this.capabilityToken)) {
            callback(true);
            return;
          }
          logger.warn(this.opts.logTag, 'rejected upgrade: missing or invalid capability token');
          callback(false, 401, 'Unauthorized');
        },
      });

      this.wss.on('connection', (ws) => this.onConsumerConnect(ws));
      this.wss.on('error', (err) => {
        logger.warn(
          this.opts.logTag,
          `WebSocketServer error: ${err instanceof Error ? err.message : err}`,
        );
      });

      this.httpServer.once('error', reject);
      this.httpServer.listen(this.opts.port, this.opts.host, () => {
        const addr = this.httpServer?.address() as AddressInfo | null;
        if (!addr) {
          reject(new Error('httpServer.address() returned null after listen'));
          return;
        }
        this.boundPort = addr.port;
        resolve(addr.port);
      });
    });
  }

  private connectHermes(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.hermesUrl, {
        headers: { Origin: metroOrigin(this.opts.hermesUrl) },
      });
      this.hermesWs = ws;

      const onOpen = (): void => {
        ws.off('error', onError);
        for (const msg of this.hermesBuffer) ws.send(msg);
        this.hermesBuffer = [];
        logger.info(this.opts.logTag, `connected to upstream Hermes at ${this.opts.hermesUrl}`);
        resolve();
      };
      const onError = (err: Error): void => {
        ws.off('open', onOpen);
        reject(err);
      };

      ws.once('open', onOpen);
      ws.once('error', onError);
      ws.on('message', (data) => this.onHermesMessage(data));
      ws.on('close', (code, reason) => this.onHermesClose(code, reason.toString()));
      ws.on('error', (err) => {
        logger.warn(this.opts.logTag, `upstream WS error: ${err.message}`);
      });
    });
  }

  private onConsumerConnect(ws: WebSocket): void {
    const consumerId = this.nextConsumerId++;
    this.consumers.set(consumerId, ws);
    logger.info(
      this.opts.logTag,
      `consumer ${consumerId} connected (total: ${this.consumers.size})`,
    );

    ws.on('message', (data) => this.onConsumerMessage(consumerId, data));
    ws.on('close', () => {
      this.consumers.delete(consumerId);
      for (const [upstreamId, entry] of this.routingTable) {
        if (entry.consumerId === consumerId) this.routingTable.delete(upstreamId);
      }
      logger.info(
        this.opts.logTag,
        `consumer ${consumerId} disconnected (remaining: ${this.consumers.size})`,
      );
    });
    ws.on('error', (err) => {
      logger.warn(this.opts.logTag, `consumer ${consumerId} WS error: ${err.message}`);
    });
  }

  private onConsumerMessage(consumerId: number, data: WebSocket.RawData): void {
    const raw = data.toString();
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      logger.warn(this.opts.logTag, `consumer ${consumerId} sent non-JSON, dropping`);
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      logger.warn(this.opts.logTag, `consumer ${consumerId} sent non-object, dropping`);
      return;
    }

    const m = msg as Record<string, unknown>;
    const consumerOriginalId = typeof m.id === 'number' ? m.id : null;

    if (consumerOriginalId !== null) {
      const upstreamId = this.upstreamSeq++;
      this.routingTable.set(upstreamId, { consumerId, consumerOriginalId, createdAt: Date.now() });
      m.id = upstreamId;
    }

    this.sendToHermes(JSON.stringify(m));
  }

  private onHermesMessage(data: WebSocket.RawData): void {
    const raw = data.toString();
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      logger.warn(this.opts.logTag, 'upstream sent non-JSON, dropping');
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      logger.warn(this.opts.logTag, 'upstream sent non-object, dropping');
      return;
    }

    const m = msg as Record<string, unknown>;
    const upstreamId = typeof m.id === 'number' ? m.id : null;

    if (upstreamId === null) {
      this.broadcastToConsumers(raw);
      return;
    }

    const route = this.routingTable.get(upstreamId);
    if (!route) {
      // No routing entry for this upstream id — a late reply after the entry was
      // swept, or an id-space collision. Log it (debug) so it isn't silent.
      logger.debug(this.opts.logTag, `dropping Hermes reply with unrouted id=${upstreamId}`);
      return;
    }
    this.routingTable.delete(upstreamId);

    m.id = route.consumerOriginalId;
    const rewritten = JSON.stringify(m);

    const consumerWs = this.consumers.get(route.consumerId);
    if (consumerWs && consumerWs.readyState === WebSocket.OPEN) {
      consumerWs.send(rewritten);
    }
  }

  private onHermesClose(code: number, reason: string): void {
    logger.warn(this.opts.logTag, `upstream Hermes closed (code=${code}, reason='${reason}')`);
    for (const ws of this.consumers.values()) {
      try {
        ws.close(1011, 'upstream closed');
      } catch {
        /* ignore */
      }
    }
    this.consumers.clear();
    this.routingTable.clear();
  }

  private sendToHermes(rawMessage: string): void {
    if (!this.hermesWs) {
      logger.warn(this.opts.logTag, 'sendToHermes called with no upstream WS');
      return;
    }
    if (this.hermesWs.readyState === WebSocket.CONNECTING) {
      if (this.hermesBuffer.length >= this.opts.hermesBufferMaxSize) {
        this.hermesBuffer.shift();
        logger.warn(
          this.opts.logTag,
          `hermesBuffer exceeded cap (${this.opts.hermesBufferMaxSize}), dropping oldest`,
        );
      }
      this.hermesBuffer.push(rawMessage);
      return;
    }
    if (this.hermesWs.readyState !== WebSocket.OPEN) {
      logger.warn(
        this.opts.logTag,
        `upstream WS not open (state=${this.hermesWs.readyState}), dropping`,
      );
      return;
    }
    this.hermesWs.send(rawMessage);
  }

  private startRoutingSweeper(): void {
    if (this.routingSweeper) return;
    const timeoutMs = this.opts.routingTimeoutMs;
    const sweepMs = Math.max(500, Math.floor(timeoutMs / 2));
    this.routingSweeper = setInterval(() => {
      const cutoff = Date.now() - timeoutMs;
      let dropped = 0;
      for (const [upstreamId, entry] of this.routingTable) {
        if (entry.createdAt < cutoff) {
          this.routingTable.delete(upstreamId);
          dropped++;
        }
      }
      if (dropped > 0) {
        logger.warn(this.opts.logTag, `routing sweeper dropped ${dropped} expired entries`);
      }
    }, sweepMs);
    this.routingSweeper.unref?.();
  }

  private stopRoutingSweeper(): void {
    if (this.routingSweeper) {
      clearInterval(this.routingSweeper);
      this.routingSweeper = null;
    }
  }

  private broadcastToConsumers(rawMessage: string): void {
    for (const ws of this.consumers.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(rawMessage);
        } catch {
          /* one consumer failing should not abort the others */
        }
      }
    }
  }

  private async cleanup(): Promise<void> {
    this.stopRoutingSweeper();
    if (this.hermesWs) {
      try {
        this.hermesWs.close(1000, 'proxy stopping');
      } catch {
        /* ignore */
      }
      this.hermesWs = null;
    }
    for (const ws of this.consumers.values()) {
      try {
        ws.close(1001, 'proxy stopping');
      } catch {
        /* ignore */
      }
    }
    this.consumers.clear();
    this.routingTable.clear();
    this.hermesBuffer = [];

    if (this.wss) {
      try {
        this.wss.close();
      } catch {
        /* ignore */
      }
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = null;
    }
    this.boundPort = null;
  }
}

/**
 * Parse an RN version object or string into a semver triple. Returns null if the shape is unrecognized.
 */
export function parseRNVersion(
  raw: unknown,
): { major: number; minor: number; patch: number } | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'string') {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  }

  if (typeof raw === 'object') {
    const v = raw as { major?: unknown; minor?: unknown; patch?: unknown };
    if (typeof v.major === 'number' && typeof v.minor === 'number' && typeof v.patch === 'number') {
      return { major: v.major, minor: v.minor, patch: v.patch };
    }
  }

  return null;
}

/**
 * RN greater than or equal to 0.85 has native multi-debugger support via metro-bridge's
 * supportsMultipleDebuggers flag, so the proxy is redundant. Returns true when the
 * version is 0.85+ (no proxy needed). Unknown / unparseable versions return false
 * (conservative default: use proxy).
 */
export function supportsNativeMultiDebugger(rnVersion: unknown): boolean {
  const parsed = parseRNVersion(rnVersion);
  if (!parsed) return false;
  if (parsed.major > 0) return true;
  return parsed.minor >= 85;
}
