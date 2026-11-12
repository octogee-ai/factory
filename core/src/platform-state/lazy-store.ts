import type { PlatformStateStore } from "./store.js";

export function lazyPlatformStateStore(create: () => PlatformStateStore): PlatformStateStore {
  let built: PlatformStateStore | undefined;
  const store = () => (built ??= create());
  return new Proxy({} as PlatformStateStore, {
    get: (_target, property) => Reflect.get(store(), property),
    set: (_target, property, value) => Reflect.set(store(), property, value),
    has: (_target, property) => Reflect.has(store(), property),
    ownKeys: () => Reflect.ownKeys(store()),
    getOwnPropertyDescriptor: (_target, property) => Reflect.getOwnPropertyDescriptor(store(), property),
    defineProperty: (_target, property, descriptor) => Reflect.defineProperty(store(), property, descriptor),
    deleteProperty: (_target, property) => Reflect.deleteProperty(store(), property),
  });
}
