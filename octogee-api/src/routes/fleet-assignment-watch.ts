import type { Request, Response } from "express";
import type { Firestore } from "firebase-admin/firestore";

export function streamAssignmentChanges(
  req: Request,
  res: Response,
  db: Firestore,
  gatewayId: string,
  log: (message: string) => void,
): void {
  const unsubscribes: Array<() => void> = [];
  let closed = false;
  let pending = false;
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const flush = () => {
    if (closed || !pending || res.writableNeedDrain) return;
    pending = false;
    res.write("data: changed\n\n");
  };
  const notify = () => {
    pending = true;
    flush();
  };
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableNeedDrain) res.write(": keepalive\n\n");
  }, 15_000);
  const expiry = setTimeout(() => { stop(); res.end(); }, 5 * 60_000);
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    res.off("drain", flush);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
  const failed = (error: Error) => {
    log(`[fleet-broker] assignment watch ${gatewayId} failed: ${error.message}`);
    stop();
    res.end();
  };
  res.once("close", stop);
  res.on("drain", flush);
  req.once("aborted", stop);
  try {
    for (const query of [
      db.collection("gateways").doc(gatewayId).collection("assignments"),
      db.collection("users").where("provisioning.openclaw.gatewayId", "==", gatewayId),
    ]) {
      const unsubscribe = query.onSnapshot(notify, failed);
      if (closed) unsubscribe();
      else unsubscribes.push(unsubscribe);
    }
  } catch (error) {
    failed(error instanceof Error ? error : new Error(String(error)));
  }
}
