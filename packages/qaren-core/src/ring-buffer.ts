export interface RingBufferOptions<T, K> {
  indexKey?: (item: T) => K | undefined;
}

export class RingBuffer<T, K = unknown> {
  private buffer: (T | undefined)[];
  private cursor = 0;
  private count = 0;
  private readonly capacity: number;
  private readonly indexKey?: (item: T) => K | undefined;
  private readonly index: Map<K, T> | null;

  constructor(capacity: number, options?: RingBufferOptions<T, K>) {
    this.capacity = capacity;
    this.buffer = Array.from({ length: capacity });
    this.indexKey = options?.indexKey;
    this.index = options?.indexKey ? new Map() : null;
  }

  push(item: T): void {
    if (this.index && this.buffer[this.cursor] !== undefined) {
      const evicted = this.buffer[this.cursor] as T;
      const evictedKey = this.indexKey!(evicted);
      if (evictedKey !== undefined && this.index.get(evictedKey) === evicted) {
        this.index.delete(evictedKey);
      }
    }
    this.buffer[this.cursor] = item;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    if (this.index) {
      const key = this.indexKey!(item);
      if (key !== undefined) this.index.set(key, item);
    }
  }

  getLast(n: number): T[] {
    const result: T[] = [];
    const total = Math.min(n, this.count);
    for (let i = 0; i < total; i++) {
      const idx = (this.cursor - total + i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  filter(predicate: (item: T) => boolean): T[] {
    const all = this.getLast(this.count);
    return all.filter(predicate);
  }

  findLast(predicate: (item: T) => boolean): T | undefined {
    for (let i = 0; i < this.count; i++) {
      const idx = (this.cursor - 1 - i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined && predicate(item)) return item;
    }
    return undefined;
  }

  getByKey(key: K): T | undefined {
    return this.index?.get(key);
  }

  clear(): void {
    this.buffer = Array.from({ length: this.capacity });
    this.cursor = 0;
    this.count = 0;
    this.index?.clear();
  }

  get size(): number {
    return this.count;
  }
}

export const NO_DEVICE_KEY = 'noport-notarget';

/**
 * Build a stable device key from (metroPort, targetId) for `DeviceBufferManager`.
 * Falls back to a sentinel string when either is null, so events captured before
 * a target is selected still have a valid bucket.
 */
export function makeDeviceKey(
  port: number | null | undefined,
  targetId: string | null | undefined,
): string {
  return `${port ?? 'noport'}-${targetId ?? 'notarget'}`;
}

export interface DeviceBufferOptions<T, K> extends RingBufferOptions<T, K> {
  /** Per-device buffer capacity. Each device gets its own `RingBuffer` at this size. */
  capacityPerDevice: number;
  /** Maximum number of device buffers held in memory. When exceeded, the device with the oldest last-push timestamp is evicted. Default: 10. */
  maxDevices?: number;
  /** Required for cross-device aggregation (`'all'` queries) so results can be merged in chronological order. */
  timestampOf?: (item: T) => number;
}

/**
 * Per-device circular buffer manager (M4 / Phase 90 Tier 2).
 *
 * Wraps N `RingBuffer`s keyed by `${metroPort}-${targetId}` so console/network/log
 * events captured while connected to one device don't leak into queries made after
 * switching to another device. When the active device count exceeds `maxDevices`,
 * the buffer with the oldest last-push timestamp is evicted whole — bounds memory.
 *
 * Supports cross-device aggregation via `device: 'all'`: results are merged across
 * every live buffer, sorted by `timestampOf(item)` when provided.
 */
export class DeviceBufferManager<T, K = unknown> {
  private readonly buffers = new Map<string, RingBuffer<T, K>>();
  private readonly lastPush = new Map<string, number>();
  private readonly opts: {
    capacityPerDevice: number;
    maxDevices: number;
    indexKey?: (item: T) => K | undefined;
    timestampOf?: (item: T) => number;
  };

  constructor(options: DeviceBufferOptions<T, K>) {
    this.opts = {
      capacityPerDevice: options.capacityPerDevice,
      maxDevices: options.maxDevices ?? 10,
      indexKey: options.indexKey,
      timestampOf: options.timestampOf,
    };
  }

  /**
   * Append `item` to the buffer for `deviceKey`. Creates the buffer on first push;
   * evicts the least-recently-pushed device when `maxDevices` is reached.
   */
  push(deviceKey: string, item: T): void {
    let buf = this.buffers.get(deviceKey);
    if (!buf) {
      if (this.buffers.size >= this.opts.maxDevices) {
        this.evictOldest();
      }
      buf = new RingBuffer<T, K>(
        this.opts.capacityPerDevice,
        this.opts.indexKey ? { indexKey: this.opts.indexKey } : undefined,
      );
      this.buffers.set(deviceKey, buf);
    }
    buf.push(item);
    this.lastPush.set(deviceKey, Date.now());
  }

  /**
   * Get the last `n` items for `deviceKey`, or `'all'` for a chronologically-merged
   * view across every device buffer. Cross-device queries require `timestampOf`
   * (passed at construction) for deterministic ordering; without it, items are
   * returned in per-device insertion order and then concatenated.
   */
  getLast(deviceKey: string | 'all', n: number): T[] {
    if (deviceKey !== 'all') {
      return this.buffers.get(deviceKey)?.getLast(n) ?? [];
    }
    const merged: T[] = [];
    for (const buf of this.buffers.values()) {
      merged.push(...buf.getLast(buf.size));
    }
    if (this.opts.timestampOf) {
      merged.sort((a, b) => this.opts.timestampOf!(a) - this.opts.timestampOf!(b));
    }
    return merged.slice(-n);
  }

  /** Filter items (single device or `'all'`) by `predicate`. */
  filter(deviceKey: string | 'all', predicate: (item: T) => boolean): T[] {
    if (deviceKey !== 'all') {
      return this.buffers.get(deviceKey)?.filter(predicate) ?? [];
    }
    const merged: T[] = [];
    for (const buf of this.buffers.values()) {
      merged.push(...buf.filter(predicate));
    }
    if (this.opts.timestampOf) {
      merged.sort((a, b) => this.opts.timestampOf!(a) - this.opts.timestampOf!(b));
    }
    return merged;
  }

  /**
   * O(1) key lookup. `'all'` scans every device buffer and returns the first hit;
   * since callers use unique ids (e.g. network request IDs) collisions are expected
   * to be extremely rare, but still first-hit wins.
   */
  getByKey(deviceKey: string | 'all', key: K): T | undefined {
    if (deviceKey !== 'all') {
      return this.buffers.get(deviceKey)?.getByKey(key);
    }
    for (const buf of this.buffers.values()) {
      const hit = buf.getByKey(key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /** Clear a single device buffer (or every buffer when called without args). */
  clear(deviceKey?: string): void {
    if (deviceKey === undefined) {
      this.buffers.clear();
      this.lastPush.clear();
      return;
    }
    this.buffers.get(deviceKey)?.clear();
    this.lastPush.delete(deviceKey);
  }

  /** Per-device buffer size. Returns 0 for unknown keys. */
  size(deviceKey: string): number {
    return this.buffers.get(deviceKey)?.size ?? 0;
  }

  /** Total size across every device (useful for health metrics). */
  get totalSize(): number {
    let total = 0;
    for (const buf of this.buffers.values()) total += buf.size;
    return total;
  }

  /** How many device buffers are currently live. */
  get deviceCount(): number {
    return this.buffers.size;
  }

  /** Snapshot of live device keys in last-push order (most recently pushed last). */
  deviceKeys(): string[] {
    return Array.from(this.lastPush.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([key]) => key);
  }

  /**
   * M11 (D665): timestamp (ms since epoch) of the most recent push to `deviceKey`,
   * or undefined if this device has never pushed. Used to gauge idle time for
   * the Metro --clear hint in cdp_network_log.
   */
  getLastPush(deviceKey: string): number | undefined {
    return this.lastPush.get(deviceKey);
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [key, ts] of this.lastPush) {
      if (ts < oldestTs) {
        oldestKey = key;
        oldestTs = ts;
      }
    }
    if (oldestKey !== null) {
      this.buffers.delete(oldestKey);
      this.lastPush.delete(oldestKey);
    }
  }
}
