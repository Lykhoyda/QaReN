// Mirrors RN's deepFreezeAndThrowOnMutationInDev, applied by the dev Fabric renderer to host prop values.
export function devFreeze<T extends object>(object: T, onRead: () => void = () => {}): T {
  function identity(value: unknown) {
    onRead();
    return value;
  }
  function throwOnImmutableMutation(key: string) {
    throw new Error(`immutable ${key}`);
  }
  for (const key of Object.keys(object)) {
    Object.defineProperty(object, key, {
      get: identity.bind(null, (object as Record<string, unknown>)[key]),
    });
    Object.defineProperty(object, key, { set: throwOnImmutableMutation.bind(null, key) });
  }
  return Object.seal(Object.freeze(object));
}
