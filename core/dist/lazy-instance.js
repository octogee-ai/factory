export function lazyInstance(create) {
    let built;
    const instance = () => (built ??= create());
    return new Proxy({}, {
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
