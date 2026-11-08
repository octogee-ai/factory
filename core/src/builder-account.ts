import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";

export interface BuilderAccount {
  readonly uid: string;
  readonly username: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly lastActive: number | null;
  readonly planInputs: Readonly<Record<string, unknown>>;
  readonly byotActive: boolean;
  readonly usage: Readonly<Record<string, unknown>>;
  readonly mattermostUsername: string | null;
  readonly onboardingStep: string | null;
  readonly onboardingComplete: boolean;
  readonly stripeCustomerIds: readonly string[];
  readonly stripeSubscriptionIds: readonly string[];
}

export interface BuilderAccountReader {
  get(uid: string): Promise<BuilderAccount | null>;
  getMany(uids: readonly string[]): Promise<ReadonlyMap<string, BuilderAccount>>;
  list(): Promise<ReadonlyMap<string, BuilderAccount>>;
}

type Data = Record<string, unknown>;

function map(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function millis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  const timestamp = value as { toMillis?: () => number } | null | undefined;
  return typeof timestamp?.toMillis === "function" ? timestamp.toMillis() : null;
}

function distinct(values: ReadonlyArray<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

export function builderAccountFromData(uid: string, data: Data): BuilderAccount {
  const subscription = map(data.subscription);
  const builderSubscription = map(data.builderSubscription);
  const billing = map(data.billing);
  const mattermostUsername = map(data.mattermost).username;
  return {
    uid,
    username: nonEmptyString(data.username),
    email: nonEmptyString(data.email),
    displayName: nonEmptyString(data.displayName),
    lastActive: millis(data.lastActive),
    planInputs: { ...userEntitlements().pickInputs(data), ...(data.tier === undefined ? {} : { tier: data.tier }) },
    byotActive: data.byotActive === true,
    usage: map(data.usage),
    mattermostUsername: typeof mattermostUsername === "string" ? mattermostUsername : null,
    onboardingStep: nonEmptyString(data.onboardingStep),
    onboardingComplete: data.onboardingComplete === true,
    stripeCustomerIds: distinct([
      nonEmptyString(subscription.stripeCustomerId),
      nonEmptyString(data.stripeCustomerId),
      nonEmptyString(billing.stripeCustomerId),
    ]),
    stripeSubscriptionIds: distinct([
      nonEmptyString(subscription.stripeSubscriptionId) ??
        nonEmptyString(subscription.id) ??
        nonEmptyString(billing.subscriptionId),
      nonEmptyString(builderSubscription.stripeSubscriptionId) ?? nonEmptyString(builderSubscription.id),
    ]),
  };
}

function accountOf(snapshot: DocumentSnapshot): BuilderAccount | null {
  return snapshot.exists ? builderAccountFromData(snapshot.id, snapshot.data() ?? {}) : null;
}

export function firestoreBuilderAccountReader(db: Pick<Firestore, "collection" | "getAll">): BuilderAccountReader {
  const users = () => db.collection("users");
  return {
    get: async (uid) => accountOf(await users().doc(uid).get()),
    getMany: async (uids) => {
      const unique = [...new Set(uids)];
      if (unique.length === 0) return new Map();
      const snapshots = await db.getAll(...unique.map((uid) => users().doc(uid)));
      return new Map(snapshots.flatMap((snapshot) => {
        const account = accountOf(snapshot);
        return account === null ? [] : [[snapshot.id, account] as const];
      }));
    },
    list: async () => {
      const snapshot = await users().get();
      return new Map(snapshot.docs.map((doc) => [doc.id, builderAccountFromData(doc.id, doc.data())]));
    },
  };
}
