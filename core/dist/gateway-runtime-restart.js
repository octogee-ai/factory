import { isDeepStrictEqual } from "node:util";
export async function updateRuntimeRestart(store, current, next, validate) {
    await store.transaction({ label: "gateway-runtime-restart.update" }, async (transaction) => {
        const root = await transaction.gateways.roots.get(current.gatewayId);
        if (!root || !isDeepStrictEqual(root.runtimeRestartFence, current))
            throw new Error("gateway runtime restart fence changed");
        await validate?.(transaction, root);
        await transaction.gateways.roots.compareAndSetRuntimeRestartFence(current.gatewayId, current, next);
    });
}
