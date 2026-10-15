import { isDeepStrictEqual } from "node:util";
import { FieldValue } from "firebase-admin/firestore";
export async function updateRuntimeRestart(db, current, next, validate) {
    await db.runTransaction(async (transaction) => {
        const ref = db.doc(`gateways/${current.gatewayId}`);
        const root = await transaction.get(ref);
        const data = root.data();
        if (!data || !isDeepStrictEqual(data.runtimeRestartFence, current))
            throw new Error("gateway runtime restart fence changed");
        await validate?.(transaction, data);
        transaction.update(ref, { runtimeRestartFence: next ?? FieldValue.delete() });
    });
}
