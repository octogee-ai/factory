import { createHash } from "node:crypto";
import {
  artifactJobId,
  completeArtifactJob,
  parseArtifactRequest,
  type ArtifactCompletion,
  type ArtifactJob,
  type ArtifactMarkdownObject,
  type ArtifactOutputObject,
  type ArtifactPageObject,
  type ArtifactRequest,
} from "./chat-artifacts.js";
import type { Transaction } from "firebase-admin/firestore";
import {
  platformStateReadsInFirestoreTransaction,
  type PlatformStateRepositories,
  type PlatformStateStore,
} from "@octogee/core/platform-state";
import { builderAllowsInteractiveAccess } from "./assigned-builder.js";

interface FirestoreArtifactSnapshot {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface FirestoreArtifactRef {
  path: string;
  get(): Promise<FirestoreArtifactSnapshot>;
}

interface FirestoreArtifactQuerySnapshot {
  docs: Array<{ id?: string; data(): Record<string, unknown> }>;
}

interface FirestoreArtifactQuery {
  where(field: string, op: "==" | "<=", value: unknown): FirestoreArtifactQuery;
  limit(count: number): { get(): Promise<FirestoreArtifactQuerySnapshot> };
}

interface FirestoreArtifactDb {
  doc(path: string): FirestoreArtifactRef;
  collection(path: string): FirestoreArtifactQuery;
  runTransaction<T>(run: (tx: {
    get(ref: FirestoreArtifactRef): Promise<FirestoreArtifactSnapshot>;
    set(ref: FirestoreArtifactRef, value: Record<string, unknown>): void;
  }) => Promise<T>): Promise<T>;
}

export interface ArtifactJobStore {
  createIfAbsent(job: ArtifactJob): Promise<ArtifactJob>;
  get(artifactId: string): Promise<ArtifactJob | null>;
  findClaimable(now: string, limit: number): Promise<string[]>;
  transact(
    artifactId: string,
    update: (job: ArtifactJob | null) => ArtifactJob,
  ): Promise<ArtifactJob>;
}

export interface ArtifactClaim {
  job: ArtifactJob;
  leaseToken: string;
}

type RegistryCompletion =
  | Omit<Extract<ArtifactCompletion, { outcome: "ready" }>, "completedAt">
  | Omit<Extract<ArtifactCompletion, { outcome: "unsupported" | "failed" }>, "completedAt">;

export interface ArtifactRegistryOptions {
  now?: () => Date;
  leaseToken?: () => string;
  leaseMs?: number;
  maxAttempts?: number;
}

export interface ArtifactOwnership {
  ownerUid: string;
  workspaceSlug: string;
  workspaceOwnerUid: string;
}

interface VerifiedArtifactSource {
  sha256: string;
  byteLength: number;
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const INVALID_LEASE = "artifact lease is invalid or expired";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function leaseIsActive(job: ArtifactJob, workerId: string, token: string, now: Date): boolean {
  return (
    job.status === "processing" &&
    job.lease?.workerId === workerId &&
    job.lease.tokenHash === tokenHash(token) &&
    Date.parse(job.lease.expiresAt) > now.getTime()
  );
}

function matchesAttemptPath(
  objectPath: string,
  artifactId: string,
  suffix: string,
): boolean {
  const prefix = `chat-artifacts/${artifactId}/attempts/`;
  if (!objectPath.startsWith(prefix)) return false;
  const remainder = objectPath.slice(prefix.length);
  const separator = remainder.indexOf("/");
  if (separator < 1 || remainder.slice(separator) !== suffix) return false;
  const attempt = remainder.slice(0, separator);
  return /^[1-9]\d*$/.test(attempt) && Number.isSafeInteger(Number(attempt));
}

function assertOutput(artifactId: string, output: ArtifactOutputObject): void {
  if (!/^[a-f0-9]{64}$/.test(output.sha256) || !Number.isSafeInteger(output.byteLength)) {
    throw new Error("invalid artifact output metadata");
  }
  if (output.kind === "markdown") {
    if (
      !matchesAttemptPath(output.objectPath, artifactId, "/markdown.md") ||
      output.mediaType !== "text/markdown; charset=utf-8" ||
      output.byteLength < 1 ||
      output.byteLength > 8 * 1024 * 1024
    ) {
      throw new Error("invalid artifact Markdown output");
    }
    return;
  }
  if (
    !Number.isSafeInteger(output.pageNumber) ||
    output.pageNumber < 1 ||
    output.pageNumber > 500 ||
    !matchesAttemptPath(output.objectPath, artifactId, `/pages/${output.pageNumber}.webp`) ||
    output.mediaType !== "image/webp" ||
    output.byteLength < 1 ||
    output.byteLength > 4 * 1024 * 1024
  ) {
    throw new Error("invalid artifact page output");
  }
}

export class ArtifactRegistry {
  private readonly now: () => Date;
  private readonly leaseToken: () => string;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly store: ArtifactJobStore,
    options: ArtifactRegistryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseToken = options.leaseToken ?? (() => crypto.randomUUID());
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1_000 || this.leaseMs > 30 * 60 * 1000) {
      throw new Error("invalid artifact lease duration");
    }
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 10) {
      throw new Error("invalid artifact maximum attempts");
    }
  }

  async enqueue(
    request: ArtifactRequest,
    ownership: ArtifactOwnership,
  ): Promise<ArtifactJob> {
    if (typeof ownership.ownerUid !== "string" || ownership.ownerUid.length === 0) {
      throw new Error("invalid artifact owner uid");
    }
    if (typeof ownership.workspaceSlug !== "string" || ownership.workspaceSlug.length === 0) {
      throw new Error("invalid artifact workspace slug");
    }
    if (typeof ownership.workspaceOwnerUid !== "string" || ownership.workspaceOwnerUid.length === 0) {
      throw new Error("invalid artifact workspace owner uid");
    }
    const now = this.now().toISOString();
    return this.store.createIfAbsent({
      schemaVersion: 1,
      artifactId: artifactJobId(request),
      ownerUid: ownership.ownerUid,
      workspaceSlug: ownership.workspaceSlug,
      workspaceOwnerUid: ownership.workspaceOwnerUid,
      request,
      status: "queued",
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  get(artifactId: string): Promise<ArtifactJob | null> {
    return this.store.get(artifactId);
  }

  async claimNext(workerId: string): Promise<ArtifactClaim | null> {
    if (typeof workerId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/.test(workerId)) {
      throw new Error("invalid artifact worker id");
    }
    const now = this.now();
    const ids = await this.store.findClaimable(now.toISOString(), 20);
    for (const artifactId of ids) {
      const token = this.leaseToken();
      if (token.length < 32 || token.length > 256) throw new Error("invalid artifact lease token");
      try {
        const job = await this.store.transact(artifactId, (current) => {
          if (!current) throw new Error("artifact job disappeared");
          const expired =
            current.status === "processing" &&
            current.lease !== undefined &&
            Date.parse(current.lease.expiresAt) <= now.getTime();
          if (current.status !== "queued" && !expired) throw new Error("artifact job is not claimable");
          if (expired && current.attempt >= this.maxAttempts) {
            return {
              ...current,
              status: "failed",
              updatedAt: now.toISOString(),
              lease: undefined,
              staged: undefined,
              result: undefined,
              failure: {
                code: "attempts_exhausted",
                message: `Artifact processing exhausted ${this.maxAttempts} attempts`,
                completedAt: now.toISOString(),
              },
            };
          }
          return {
            ...current,
            status: "processing",
            attempt: current.attempt + 1,
            updatedAt: now.toISOString(),
            lease: {
              workerId,
              tokenHash: tokenHash(token),
              expiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
            },
            staged: { pages: [] },
            result: undefined,
            failure: undefined,
          };
        });
        if (job.status !== "processing") continue;
        return { job, leaseToken: token };
      } catch (error) {
        if (error instanceof Error && error.message === "artifact job is not claimable") continue;
        throw error;
      }
    }
    return null;
  }

  async assertLease(artifactId: string, workerId: string, token: string): Promise<ArtifactJob> {
    const job = await this.store.get(artifactId);
    if (!job || !leaseIsActive(job, workerId, token, this.now())) {
      throw new Error(INVALID_LEASE);
    }
    return job;
  }

  async renewLease(artifactId: string, workerId: string, token: string): Promise<ArtifactJob> {
    const now = this.now();
    return this.store.transact(artifactId, (current) => {
      if (!current || !leaseIsActive(current, workerId, token, now) || !current.lease) {
        throw new Error(INVALID_LEASE);
      }
      return {
        ...current,
        updatedAt: now.toISOString(),
        lease: {
          ...current.lease,
          expiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
        },
      };
    });
  }

  async stageOutput(
    artifactId: string,
    workerId: string,
    token: string,
    output: ArtifactOutputObject,
  ): Promise<ArtifactJob> {
    assertOutput(artifactId, output);
    const now = this.now();
    return this.store.transact(artifactId, (current) => {
      if (!current || !leaseIsActive(current, workerId, token, now)) {
        throw new Error(INVALID_LEASE);
      }
      const staged = current.staged ?? { pages: [] };
      const expectedPath = output.kind === "markdown"
        ? `chat-artifacts/${artifactId}/attempts/${current.attempt}/markdown.md`
        : `chat-artifacts/${artifactId}/attempts/${current.attempt}/pages/${output.pageNumber}.webp`;
      if (output.objectPath !== expectedPath) throw new Error("artifact output attempt fence mismatch");
      if (output.kind === "markdown") {
        if (staged.markdown && staged.markdown.sha256 !== output.sha256) {
          throw new Error("artifact Markdown output changed during one lease");
        }
        return { ...current, updatedAt: now.toISOString(), staged: { ...staged, markdown: output } };
      }
      const existing = staged.pages.find((page) => page.pageNumber === output.pageNumber);
      if (existing && existing.sha256 !== output.sha256) {
        throw new Error("artifact page output changed during one lease");
      }
      const pages = existing
        ? staged.pages
        : [...staged.pages, output].sort((left, right) => left.pageNumber - right.pageNumber);
      return { ...current, updatedAt: now.toISOString(), staged: { ...staged, pages } };
    });
  }

  async verifySource(
    artifactId: string,
    workerId: string,
    token: string,
    source: VerifiedArtifactSource,
  ): Promise<ArtifactJob> {
    if (!/^[a-f0-9]{64}$/.test(source.sha256)) {
      throw new Error("artifact source checksum is invalid");
    }
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 1) {
      throw new Error("artifact source length is invalid");
    }
    const now = this.now();
    return this.store.transact(artifactId, (current) => {
      if (!current || !leaseIsActive(current, workerId, token, now)) {
        throw new Error(INVALID_LEASE);
      }
      if (source.byteLength !== current.request.byteLength) {
        throw new Error("artifact source length does not match Mattermost metadata");
      }
      if (current.source && current.source.sha256 !== source.sha256) {
        throw new Error("artifact source checksum changed across attempts");
      }
      return {
        ...current,
        updatedAt: now.toISOString(),
        source: {
          sha256: source.sha256,
          byteLength: source.byteLength,
          verifiedAt: now.toISOString(),
        },
      };
    });
  }

  async complete(
    artifactId: string,
    workerId: string,
    token: string,
    completion: RegistryCompletion,
  ): Promise<ArtifactJob> {
    const now = this.now();
    return this.store.transact(artifactId, (current) => {
      if (!current || !leaseIsActive(current, workerId, token, now)) {
        throw new Error(INVALID_LEASE);
      }
      return completeArtifactJob(current, { ...completion, completedAt: now.toISOString() } as ArtifactCompletion);
    });
  }
}

const ARTIFACT_COLLECTION = "chatArtifactJobs";
const ARTIFACT_STATUSES = new Set(["queued", "processing", "ready", "unsupported", "failed"]);

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parsedOutput(artifactId: string, value: unknown): ArtifactOutputObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid artifact output record");
  }
  const output = structuredClone(value) as ArtifactOutputObject;
  assertOutput(artifactId, output);
  return output;
}

function parseJobEnvelope(data: Record<string, unknown>): ArtifactJob {
  const request = parseArtifactRequest(data.request);
  const artifactId = data.artifactId;
  if (typeof artifactId !== "string" || artifactId !== artifactJobId(request)) {
    throw new Error("invalid artifact job idempotency key");
  }
  if (
    data.schemaVersion !== 1 ||
    !nonEmptyString(data.ownerUid) ||
    !nonEmptyString(data.workspaceSlug) ||
    !nonEmptyString(data.workspaceOwnerUid) ||
    typeof data.status !== "string" ||
    !ARTIFACT_STATUSES.has(data.status) ||
    !Number.isSafeInteger(data.attempt) ||
    (data.attempt as number) < 0 ||
    !validIso(data.createdAt) ||
    !validIso(data.updatedAt)
  ) {
    throw new Error("invalid artifact job record");
  }
  const job = structuredClone(data) as unknown as ArtifactJob;
  job.request = request;
  return job;
}

function validateProcessingJob(job: ArtifactJob): void {
  if (job.status !== "processing") return;
  if (
    !job.lease ||
    typeof job.lease.workerId !== "string" ||
    !/^[a-f0-9]{64}$/.test(job.lease.tokenHash) ||
    !validIso(job.lease.expiresAt)
  ) {
    throw new Error("invalid artifact processing lease");
  }
  if (!job.staged || !Array.isArray(job.staged.pages)) {
    throw new Error("invalid artifact staged outputs");
  }
  if (job.staged.markdown) {
    const markdown = parsedOutput(job.artifactId, job.staged.markdown);
    if (markdown.kind !== "markdown") throw new Error("invalid staged Markdown output");
    job.staged.markdown = markdown as ArtifactMarkdownObject;
  }
  job.staged.pages = job.staged.pages.map((page) => parsedOutput(job.artifactId, page)).filter(
    (output): output is Extract<ArtifactOutputObject, { kind: "page" }> => output.kind === "page",
  );
}

function validateSource(job: ArtifactJob): void {
  if (!job.source) return;
  if (
    !/^[a-f0-9]{64}$/.test(job.source.sha256) ||
    !Number.isSafeInteger(job.source.byteLength) ||
    job.source.byteLength !== job.request.byteLength ||
    !validIso(job.source.verifiedAt)
  ) {
    throw new Error("invalid artifact source verification");
  }
}

function validateResult(job: ArtifactJob): void {
  if (job.status !== "ready") return;
  if (!job.source || !job.result || !Array.isArray(job.result.pages)) {
    throw new Error("invalid artifact result");
  }
  const markdown = parsedOutput(job.artifactId, job.result.markdown);
  if (markdown.kind !== "markdown") throw new Error("invalid artifact Markdown result");
  const pages = job.result.pages.map((page) => parsedOutput(job.artifactId, page));
  if (pages.some((page) => page.kind !== "page")) throw new Error("invalid artifact page result");
  job.result.markdown = markdown;
  job.result.pages = pages as ArtifactPageObject[];
}

function validateFailure(job: ArtifactJob): void {
  if ((job.status === "unsupported" || job.status === "failed") && !job.failure) {
    throw new Error("invalid artifact terminal failure");
  }
}

function firestoreJob(snapshot: FirestoreArtifactSnapshot): ArtifactJob | null {
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (!data) throw new Error("invalid artifact job: Firestore document has no data");
  const job = parseJobEnvelope(data);
  validateProcessingJob(job);
  validateSource(job);
  validateResult(job);
  validateFailure(job);
  return job;
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, withoutUndefined(entry)]),
  );
}

function firestoreWrite(job: ArtifactJob): Record<string, unknown> {
  return withoutUndefined(structuredClone(job)) as Record<string, unknown>;
}

async function workspaceOwnerActive(state: Pick<PlatformStateRepositories, "builders">, ownerUid: string): Promise<boolean> {
  const owner = await state.builders.records.get(ownerUid);
  return owner !== null && builderAllowsInteractiveAccess(owner);
}

export function createFirestoreArtifactJobStore(db: FirestoreArtifactDb, platformState: PlatformStateStore): ArtifactJobStore {
  const ref = (artifactId: string): FirestoreArtifactRef => db.doc(`${ARTIFACT_COLLECTION}/${artifactId}`);
  const ownerStateIn = (transaction: unknown) =>
    platformStateReadsInFirestoreTransaction(platformState, transaction as Transaction, "chat-artifact.owner");
  return {
    createIfAbsent(job) {
      return db.runTransaction(async (transaction) => {
        const jobRef = ref(job.artifactId);
        const [existing, ownerActive] = await Promise.all([
          transaction.get(jobRef).then(firestoreJob),
          workspaceOwnerActive(ownerStateIn(transaction), job.workspaceOwnerUid),
        ]);
        if (!ownerActive) {
          throw new Error("artifact workspace owner is not active");
        }
        if (existing) return existing;
        transaction.set(jobRef, firestoreWrite(job));
        return job;
      });
    },
    async get(artifactId) {
      const job = firestoreJob(await ref(artifactId).get());
      if (!job) return null;
      return (await workspaceOwnerActive(platformState, job.workspaceOwnerUid)) ? job : null;
    },
    async findClaimable(now, limit) {
      const collection = db.collection(ARTIFACT_COLLECTION);
      const [queued, expired] = await Promise.all([
        collection.where("status", "==", "queued").limit(limit).get(),
        collection
          .where("status", "==", "processing")
          .where("lease.expiresAt", "<=", now)
          .limit(limit)
          .get(),
      ]);
      const ids = [...queued.docs, ...expired.docs].map((doc) => {
        const job = firestoreJob({ exists: true, data: () => doc.data() });
        if (!job) throw new Error("artifact query returned an empty document");
        return job.artifactId;
      });
      return [...new Set(ids)].slice(0, limit);
    },
    transact(artifactId, update) {
      return db.runTransaction(async (transaction) => {
        const jobRef = ref(artifactId);
        const current = firestoreJob(await transaction.get(jobRef));
        if (!current) return update(null);
        if (!(await workspaceOwnerActive(ownerStateIn(transaction), current.workspaceOwnerUid))) {
          throw new Error("artifact workspace owner is not active");
        }
        const next = update(current);
        transaction.set(jobRef, firestoreWrite(next));
        return next;
      });
    },
  };
}
