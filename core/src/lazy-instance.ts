export function lazyInstance<T extends object>(create: () => T): T {
  let built: T | undefined;
  const instance = () => (built ??= create());
  return new Proxy({} as T, {
    get: (_target, property) => Reflect.get(instance(), property),
    set: (_target, property, value) => Reflect.set(instance(), property, value),
    has: (_target, property) => Reflect.has(instance(), property),
    ownKeys: () => Reflect.ownKeys(instance()),
    getOwnPropertyDescriptor: (_target, property) => Reflect.getOwnPropertyDescriptor(instance(), property),
    defineProperty: (_target, property, descriptor) => Reflect.defineProperty(instance(), property, descriptor),
    deleteProperty: (_target, property) => Reflect.deleteProperty(instance(), property),
    getPrototypeOf: () => Reflect.getPrototypeOf(instance()),
  });
}
