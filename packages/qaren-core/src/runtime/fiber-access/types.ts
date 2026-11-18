// React internals reach the injected program as untrusted app objects: every
// field is unknown until a descriptor-safe read or a type check narrows it.
export interface FiberLike {
  readonly tag?: unknown;
  readonly type?: unknown;
  readonly stateNode?: unknown;
}

export type PropsBag = object;
