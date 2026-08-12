import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { slugFromAssignedUser } from "@octogee/core/assigned-roster";

export const FLEET_INFORMER_REATTACH_MS_DEFAULT = 60_000;

export interface MirrorDocChange {
  type: string;
  doc: QueryDocumentSnapshot;
}

export interface FleetInformer {
  gateways(): QueryDocumentSnapshot[] | null;
  glmGateways(): QueryDocumentSnapshot[] | null;
  users(): QueryDocumentSnapshot[] | null;
  assignments(): QueryDocumentSnapshot[] | null;
  ingestGateways(changes: readonly MirrorDocChange[], options?: { reset?: boolean }): void;
  ingestGlmGateways(changes: readonly MirrorDocChange[], options?: { reset?: boolean }): void;
  markGatewaysStale(reason: string): void;
  markGlmGatewaysStale(reason: string): void;
  stop(): void;
}

export interface FleetInformerDeps {
  db: Firestore;
  log: (message: string) => void;
  reattachMs?: number;
}

class CollectionMirror {
  private readonly docs = new Map<string, QueryDocumentSnapshot>();
  private fresh = false;

  constructor(
    private readonly name: string,
    private readonly log: (message: string) => void,
  ) {}

  read(): QueryDocumentSnapshot[] | null {
    if (!this.fresh) return null;
    return [...this.docs.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  replace(docs: readonly QueryDocumentSnapshot[]): void {
    this.docs.clear();
    for (const doc of docs) this.docs.set(doc.id, doc);
    this.fresh = true;
  }

  apply(changes: readonly MirrorDocChange[], reset: boolean): void {
    if (reset) {
      this.docs.clear();
      this.fresh = true;
    }
    // A delta against a set this mirror cannot vouch for would produce a
    // plausible-looking but incomplete collection — drop it and wait for a reset.
    if (!this.fresh) return;
    for (const change of changes) {
      if (change.type === "removed") this.docs.delete(change.doc.id);
      else this.docs.set(change.doc.id, change.doc);
    }
  }

  markStale(reason: string): void {
    if (!this.fresh) return;
    this.fresh = false;
    this.docs.clear();
    this.log(`[fleet-informer] ⚠ ${this.name} mirror stale — ${reason}; readers fall back to a direct scan`);
  }
}

/** A mirrored collection, or one direct scan while that mirror is stale. The
 *  informer logs the staleness transition, so a null mirror degrades to the old
 *  read cost instead of silently reconciling against an empty fleet. */
export async function mirroredOrScan(
  mirrored: QueryDocumentSnapshot[] | null,
  scan: () => Promise<{ docs: QueryDocumentSnapshot[] }>,
): Promise<QueryDocumentSnapshot[]> {
  return mirrored ?? (await scan()).docs;
}

/** The assigned-roster slugs for a gateway, resolved from mirrored user documents.
 *  Must agree with `readAssignedSlugsForGateway`'s query — both resolve the slug
 *  through `slugFromAssignedUser` so the reported mounted set cannot drift. */
export function assignedSlugsFromUserMirror(
  users: ReadonlyArray<{ id: string; data(): Record<string, unknown> }>,
  gatewayId: string,
): string[] {
  const slugByUid = new Map<string, string>();
  for (const doc of users) {
    const data = doc.data();
    const provisioning = data.provisioning as Record<string, unknown> | undefined;
    const openclaw = provisioning?.openclaw as Record<string, unknown> | undefined;
    if (openclaw?.gatewayId !== gatewayId) continue;
    const slug = slugFromAssignedUser(data);
    if (slug) slugByUid.set(doc.id, slug);
  }
  return [...slugByUid.values()];
}

export function createFleetInformer(deps: FleetInformerDeps): FleetInformer {
  const { db, log } = deps;
  const reattachMs = deps.reattachMs ?? FLEET_INFORMER_REATTACH_MS_DEFAULT;
  const gateways = new CollectionMirror("gateways", log);
  const glmGateways = new CollectionMirror("glmGateways", log);
  const users = new CollectionMirror("users", log);
  const assignments = new CollectionMirror("assignments", log);

  let stopped = false;
  const unsubscribes = new Map<string, () => void>();
  const reattachTimers = new Map<string, NodeJS.Timeout>();

  const attach = (
    name: string,
    mirror: CollectionMirror,
    subscribe: (
      onNext: (snapshot: { docs: QueryDocumentSnapshot[] }) => void,
      onError: (error: Error) => void,
    ) => () => void,
  ): void => {
    if (stopped) return;
    const unsubscribe = subscribe(
      (snapshot) => {
        if (stopped) return;
        mirror.replace(snapshot.docs);
      },
      (error) => {
        if (stopped) return;
        mirror.markStale(error.message);
        // One pending re-attach per collection. A listener that has reported an
        // error is already dead and already scheduled; a second report must not
        // buy a second listener.
        if (reattachTimers.has(name)) return;
        const timer = setTimeout(() => {
          reattachTimers.delete(name);
          log(`[fleet-informer] re-attaching the ${name} listener after error: ${error.message}`);
          attach(name, mirror, subscribe);
        }, reattachMs);
        reattachTimers.set(name, timer);
      },
    );
    unsubscribes.set(name, unsubscribe);
  };

  attach("users", users, (onNext, onError) =>
    db.collection("users").onSnapshot(onNext, onError));
  attach("assignments", assignments, (onNext, onError) =>
    db.collectionGroup("assignments").onSnapshot(onNext, onError));

  return {
    gateways: () => gateways.read(),
    glmGateways: () => glmGateways.read(),
    users: () => users.read(),
    assignments: () => assignments.read(),
    ingestGateways: (changes, options) => gateways.apply(changes, options?.reset ?? false),
    ingestGlmGateways: (changes, options) => glmGateways.apply(changes, options?.reset ?? false),
    markGatewaysStale: (reason) => gateways.markStale(reason),
    markGlmGatewaysStale: (reason) => glmGateways.markStale(reason),
    stop: () => {
      stopped = true;
      for (const timer of reattachTimers.values()) clearTimeout(timer);
      reattachTimers.clear();
      for (const unsubscribe of unsubscribes.values()) unsubscribe();
      unsubscribes.clear();
    },
  };
}
