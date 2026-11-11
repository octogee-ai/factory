import type { Firestore } from "firebase-admin/firestore";
import type { OpaqueMap, PlatformStateStore } from "@octogee/core/platform-state";
import type { UserErasureCollectionPolicy } from "./user-firestore-erasure.js";

export type ProductContext = OpaqueMap;

export interface UserLifecycleJob {
  uid: string;
  deletionId: string;
  productContext: ProductContext;
}

export interface SuspensionStepRunner {
  run(name: string, action: () => Promise<unknown>): Promise<void>;
  skip(name: string): Promise<void>;
}

export type SuspensionPhase = (job: UserLifecycleJob, steps: SuspensionStepRunner) => Promise<void>;

export interface ProductUserSuspension {
  afterGatewayRetirement: SuspensionPhase;
  afterModelBrokerRevocation: SuspensionPhase;
}

export interface ErasureStep {
  name: string;
  run(job: UserLifecycleJob): Promise<"done" | "skipped">;
}

export interface ErasureVerification {
  name: string;
  confirm(job: UserLifecycleJob): Promise<"verified" | "skipped" | "pending">;
  pending(job: UserLifecycleJob): { error: string; output: Record<string, unknown>; retryAfterMs: number };
}

export interface ProductUserErasure {
  steps: readonly ErasureStep[];
  verification: ErasureVerification;
}

export interface ProductUserLifecycle {
  discover(uid: string): Promise<ProductContext>;
  suspension: ProductUserSuspension;
  erasure: ProductUserErasure;
  verificationContext(productContext: ProductContext): ProductContext | null;
  archiveFields(user: Record<string, unknown> | undefined): Record<string, unknown>;
  firestoreCollections: Readonly<Record<string, UserErasureCollectionPolicy>>;
}

export type ProductUserLifecycleFactory = (deps: {
  db: Firestore;
  store: PlatformStateStore;
  log: (message: string) => void;
}) => ProductUserLifecycle;

export class UserErasureRetryLaterError extends Error {
  override readonly name: string = "UserErasureRetryLaterError";

  constructor(message: string, readonly retryAfterMs: number | null) {
    super(message);
  }
}
