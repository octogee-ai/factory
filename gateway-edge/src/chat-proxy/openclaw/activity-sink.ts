import { createHash } from "node:crypto";
import {
  AGENT_ACTIVITY_RESERVED_ITEM_IDS,
  agentActivityCanonicalKey,
  type AgentActivityEnvelopeV1,
  type AgentActivityIngressRef,
  type AgentAttention,
  type AgentRunStatus,
} from "@octogee/shared/types/agent-conversation";
import { activityAttentionPolicy } from "./activity-attention-policy.js";
import {
  ActivityReceiptConflictError,
  ActivityReceiptLeaseError,
  type ActivityAttachmentReceiptV1,
  type ActivityWriteReceiptStore,
  type ActivityWriteReceiptV1,
} from "./activity-write-receipts.js";
import type {
  ActivityMattermostClient,
  ActivityMattermostPost,
  MattermostUploadSession,
} from "./mm-client.js";
import { redactSecrets } from "@octogee/shared/types/secret-redaction";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;
const DEFAULT_HISTORY_PAGE_SIZE = 100;
const CONCURRENT_REPLAY_POLLS = 100;
const ATTACHMENT_SCAN_CHUNK_BYTES = 256 * 1024;
const ATTACHMENT_SCAN_OVERLAP_CHARS = 8 * 1024;
const ITEM_COMPLETED = "item.completed" as const;
const TURN_STARTED = "turn.started" as const;
const ACTIVITY_RUN_ROOT_KIND = "activity.run-root" as const;
const ACTIVITY_RUN_COMPLETE_KIND = "activity.run-complete" as const;
const ACTIVITY_RUN_COMPLETE_ITEM_ID = "activity.run-complete" as const;
const ACTIVITY_ITEM_KIND_PREFIX = "activity." as const;
const UPLOAD_RESULT_UNKNOWN = "upload-result-unknown" as const;

export interface ActivitySinkBinding {
  mainChannelId: string;
  channelCreateAt: number;
  coachMmUserId: string;
  attentionMention: string;
}

export interface ActivitySinkAppendInput {
  envelope: AgentActivityEnvelopeV1;
  binding: ActivitySinkBinding;
  attachment?: Uint8Array | ActivityAttachmentSource;
}

export interface ActivityAttachmentSource {
  readonly byteLength: number;
  readonly sha256: string;
  read(offset: number, length: number): Promise<Uint8Array>;
  dispose?(): Promise<void>;
}

interface NormalizedActivitySinkAppendInput extends Omit<ActivitySinkAppendInput, "attachment"> {
  attachment?: ActivityAttachmentSource;
}

export interface ActivitySinkResult {
  outcome: "persisted" | "duplicate";
  postIds: string[];
  receipt: {
    eventKey: string;
    postId?: string;
    activityRootPostId: string;
  };
}

type ActivitySinkBareResult = Pick<ActivitySinkResult, "outcome" | "postIds">;
type ActivitySinkClaimResult =
  | Awaited<ReturnType<ActivityWriteReceiptStore["claim"]>>
  | ActivitySinkBareResult;

export interface ActivitySinkAlerts {
  attachmentUnknown(input: { eventKey: string; uploadId: string }): void;
  integrityFailure(input: { eventKey: string; reason: string }): void;
}

export interface ActivitySink {
  append(input: ActivitySinkAppendInput): Promise<ActivitySinkResult>;
}

export interface ActivitySinkDeps {
  mm: ActivityMattermostClient;
  receipts: ActivityWriteReceiptStore;
  leaseOwner: string;
  now?: () => number;
  leaseMs?: number;
  uploadChunkBytes?: number;
  historyPageSize?: number;
  alerts?: ActivitySinkAlerts;
}

export class ActivitySinkConflictError extends Error {
  override readonly name = "ActivitySinkConflictError";
}

export class ActivitySinkUnavailableError extends Error {
  override readonly name = "ActivitySinkUnavailableError";
}

export class ActivitySinkIntegrityError extends Error {
  override readonly name = "ActivitySinkIntegrityError";
}

export class ActivitySinkInvalidAttachmentError extends Error {
  override readonly name = "ActivitySinkInvalidAttachmentError";
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function activityPayloadDigest(
  envelope: AgentActivityEnvelopeV1,
  attachment?: Uint8Array,
): string {
  const hash = createHash("sha256").update(canonicalJson(envelope), "utf8");
  if (attachment) hash.update(attachment);
  return hash.digest("hex");
}

function memoryAttachmentSource(bytes: Uint8Array): ActivityAttachmentSource {
  const value = Uint8Array.from(bytes);
  return {
    byteLength: value.byteLength,
    sha256: createHash("sha256").update(value).digest("hex"),
    async read(offset, length) {
      return value.slice(offset, Math.min(offset + length, value.byteLength));
    },
  };
}

function normalizeAttachment(
  attachment: ActivitySinkAppendInput['attachment'],
): ActivityAttachmentSource | undefined {
  if (!attachment) return undefined;
  return attachment instanceof Uint8Array ? memoryAttachmentSource(attachment) : attachment;
}

async function activityPayloadDigestFromSource(
  envelope: AgentActivityEnvelopeV1,
  attachment?: ActivityAttachmentSource,
): Promise<string> {
  const hash = createHash("sha256").update(canonicalJson(envelope), "utf8");
  if (attachment) {
    for (let offset = 0; offset < attachment.byteLength;) {
      const chunk = await attachment.read(offset, DEFAULT_UPLOAD_CHUNK_BYTES);
      if (chunk.byteLength === 0) {
        throw new ActivitySinkIntegrityError("attachment source ended before its declared length");
      }
      hash.update(chunk);
      offset += chunk.byteLength;
    }
  }
  return hash.digest("hex");
}

function eventKeyFor(ref: AgentActivityIngressRef): string {
  return createHash("sha256").update(agentActivityCanonicalKey(ref), "utf8").digest("hex");
}

function runRootEventKey(ref: AgentActivityIngressRef): string {
  return eventKeyFor({
    ...ref,
    itemId: AGENT_ACTIVITY_RESERVED_ITEM_IDS.runRoot,
    ordinal: 0,
    semanticVersion: 1,
  });
}

function projectedRunStatus(envelope: AgentActivityEnvelopeV1): AgentRunStatus {
  if (envelope.type !== ITEM_COMPLETED) return "running";
  if (envelope.ref.itemId === ACTIVITY_RUN_COMPLETE_ITEM_ID) {
    if (envelope.item.summary.startsWith("🛑")) return "stopped";
    return envelope.item.status === "completed" ? "completed" : "failed";
  }
  if (envelope.item.status === "waiting") return "waiting";
  return envelope.item.status === "failed" ? "failed" : "running";
}

function projectedActivityKind(envelope: AgentActivityEnvelopeV1): string {
  if (envelope.type === TURN_STARTED) return ACTIVITY_RUN_ROOT_KIND;
  if (envelope.type === ITEM_COMPLETED && envelope.ref.itemId === ACTIVITY_RUN_COMPLETE_ITEM_ID) {
    return ACTIVITY_RUN_COMPLETE_KIND;
  }
  if (envelope.type === ITEM_COMPLETED) return `${ACTIVITY_ITEM_KIND_PREFIX}${envelope.item.kind}`;
  throw new ActivitySinkIntegrityError("turn finalization cannot create Activity posts");
}

function activityPostHasExactProps(
  props: Record<string, unknown>,
  envelope: AgentActivityEnvelopeV1,
  expectedEventKey: string,
): boolean {
  const expected: Record<string, unknown> = {
    eventKey: expectedEventKey,
    schemaVersion: 3,
    projectionKind: "run",
    conversationId: envelope.ref.conversationId,
    turnId: envelope.ref.turnId,
    runId: envelope.ref.runId,
    parentRunId: envelope.ref.parentRunId,
    retryOfRunId: envelope.ref.retryOfRunId,
    agentId: envelope.ref.agentId,
    sessionKey: envelope.ref.sessionKey,
    origin: envelope.ref.origin,
    status: projectedRunStatus(envelope),
    mainChannelId: envelope.ref.mainChannelId,
    mainRootPostId: envelope.ref.mainRootPostId,
    inputPostId: envelope.ref.inputPostId,
    itemId: envelope.ref.itemId,
    ordinal: envelope.ref.ordinal,
    semanticVersion: envelope.ref.semanticVersion,
    kind: projectedActivityKind(envelope),
  };
  return Object.entries(expected).every(([key, value]) => props[key] === value);
}

function activityRootPostIdMatches(
  post: ActivityMattermostPost,
  props: Record<string, unknown>,
  envelope: AgentActivityEnvelopeV1,
  expectedActivityRootPostId: string,
): boolean {
  if (envelope.type === TURN_STARTED) {
    return props.activityRootPostId === undefined || props.activityRootPostId === post.id;
  }
  return props.activityRootPostId === expectedActivityRootPostId;
}

function octogeeProps(
  envelope: AgentActivityEnvelopeV1,
  activityRootPostId: string | undefined,
  attention: AgentAttention,
): Record<string, unknown> {
  const status = projectedRunStatus(envelope);
  const kind = projectedActivityKind(envelope);
  return {
    schemaVersion: 3,
    projectionKind: "run",
    conversationId: envelope.ref.conversationId,
    turnId: envelope.ref.turnId,
    runId: envelope.ref.runId,
    agentId: envelope.ref.agentId,
    sessionKey: envelope.ref.sessionKey,
    ...(envelope.ref.parentRunId ? { parentRunId: envelope.ref.parentRunId } : {}),
    ...(envelope.ref.retryOfRunId ? { retryOfRunId: envelope.ref.retryOfRunId } : {}),
    origin: envelope.ref.origin,
    status,
    mainChannelId: envelope.ref.mainChannelId,
    mainRootPostId: envelope.ref.mainRootPostId,
    ...(envelope.ref.inputPostId ? { inputPostId: envelope.ref.inputPostId } : {}),
    ...(activityRootPostId ? { activityRootPostId } : {}),
    itemId: envelope.ref.itemId,
    ordinal: envelope.ref.ordinal,
    semanticVersion: envelope.ref.semanticVersion,
    attention,
    kind,
    eventKey: envelope.eventKey,
  };
}

function messageFor(
  envelope: AgentActivityEnvelopeV1,
  binding: ActivitySinkBinding,
): string {
  if (envelope.type === TURN_STARTED) return "▶️ Agent run started";
  if (envelope.type !== ITEM_COMPLETED) return "";
  if (envelope.ref.itemId === ACTIVITY_RUN_COMPLETE_ITEM_ID) return envelope.item.summary;
  const detail = envelope.item.detail?.text;
  const summary =
    envelope.item.kind === "approval" && envelope.item.status === "waiting"
      ? `${binding.attentionMention} ${envelope.item.summary}`
      : envelope.item.summary;
  return detail ? `${summary}\n\n${detail}` : summary;
}

function decodeAttachmentText(
  decoder: TextDecoder,
  bytes?: Uint8Array,
  stream = false,
): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw new ActivitySinkInvalidAttachmentError("attachment detail is not valid UTF-8");
  }
}

async function attachmentContainsSecret(source: ActivityAttachmentSource): Promise<boolean> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let overlap = "";
  let containsSecret = false;
  for (let offset = 0; offset < source.byteLength;) {
    const chunk = await source.read(offset, ATTACHMENT_SCAN_CHUNK_BYTES);
    if (chunk.byteLength === 0) {
      throw new ActivitySinkIntegrityError("attachment source ended during redaction scan");
    }
    offset += chunk.byteLength;
    const text = decodeAttachmentText(decoder, chunk, offset < source.byteLength);
    const window = overlap + text;
    if (
      window.includes("PRIVATE KEY-----") ||
      redactSecrets(window) !== window
    ) {
      containsSecret = true;
    }
    overlap = window.slice(-ATTACHMENT_SCAN_OVERLAP_CHARS);
  }
  decodeAttachmentText(decoder);
  return containsSecret;
}

async function sanitizeInput(
  input: NormalizedActivitySinkAppendInput,
): Promise<NormalizedActivitySinkAppendInput> {
  const envelope = structuredClone(input.envelope);
  let attachment = input.attachment;
  if (envelope.type === ITEM_COMPLETED) {
    envelope.item.summary = redactSecrets(envelope.item.summary);
    if (envelope.item.detail) {
      envelope.item.detail.text = redactSecrets(envelope.item.detail.text);
    }
    if (envelope.item.attachment && attachment) {
      if (await attachmentContainsSecret(attachment)) {
        attachment = memoryAttachmentSource(
          new TextEncoder().encode("[redacted: attachment contained secret material]"),
        );
      }
      envelope.item.attachment.byteLength = attachment.byteLength;
      envelope.item.attachment.sha256 = attachment.sha256;
    }
  }
  return { ...input, envelope, attachment };
}

function expectedAttachment(envelope: AgentActivityEnvelopeV1) {
  return envelope.type === ITEM_COMPLETED ? envelope.item.attachment : undefined;
}

function assertAttachmentPayload(input: NormalizedActivitySinkAppendInput): void {
  const expected = expectedAttachment(input.envelope);
  if (!expected && input.attachment) {
    throw new ActivitySinkConflictError("unexpected attachment payload");
  }
  if (expected && !input.attachment) {
    throw new ActivitySinkConflictError("declared attachment payload is missing");
  }
  if (!expected || !input.attachment) return;
  if (input.attachment.byteLength !== expected.byteLength) {
    throw new ActivitySinkConflictError("attachment byte length mismatch");
  }
  if (input.attachment.sha256 !== expected.sha256) {
    throw new ActivitySinkConflictError("attachment sha256 mismatch");
  }
}

function postEventKey(post: ActivityMattermostPost): string | null {
  const octogee = post.props.octogee;
  if (!octogee || typeof octogee !== "object") return null;
  const eventKey = (octogee as Record<string, unknown>).eventKey;
  return typeof eventKey === "string" ? eventKey : null;
}

function emptyAnchor(binding: ActivitySinkBinding): string {
  return `empty:${binding.mainChannelId}:${binding.channelCreateAt}`;
}

function isEmptyAnchor(anchor: string): boolean {
  return anchor.startsWith("empty:");
}

type ProgressReceipt = Extract<
  ActivityAttachmentReceiptV1,
  { state: "session-created" | "uploading" }
>;
type ResolvedAttachment = { fileId?: string; attachment: ActivityAttachmentReceiptV1 };

interface ActivitySinkRuntime {
  deps: ActivitySinkDeps;
  now: () => number;
  leaseMs: number;
  uploadChunkBytes: number;
  historyPageSize: number;
}

class ActivitySinkWriter implements ActivitySink {
  constructor(private readonly runtime: ActivitySinkRuntime) {}

  private async historyAnchor(binding: ActivitySinkBinding): Promise<string> {
    const { deps } = this.runtime;
    const page = await deps.mm.listChannelPosts(binding.mainChannelId, undefined, 1);
    return page.posts[0]?.id ?? emptyAnchor(binding);
  }

  private async waitForConcurrentReplay(
    eventKey: string,
    payloadDigest: string,
  ): Promise<Pick<ActivitySinkResult, "outcome" | "postIds"> | null> {
    const { deps } = this.runtime;
    for (let attempt = 0; attempt < CONCURRENT_REPLAY_POLLS; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const receipt = await deps.receipts.read(eventKey);
      if (!receipt) return null;
      if (receipt.payloadDigest !== payloadDigest) {
        throw new ActivitySinkConflictError("event-key payload digest conflict");
      }
      if (receipt.state === "committed") {
        return {
          outcome: "duplicate",
          postIds: receipt.postId ? [receipt.postId] : [],
        };
      }
    }
    return null;
  }

  private async scanUncertainSuffix(
    eventKey: string,
    binding: ActivitySinkBinding,
    anchor: string,
  ): Promise<ActivityMattermostPost | null> {
    const { deps, historyPageSize } = this.runtime;
    let before: string | undefined;
    const visited = new Set<string>();
    while (true) {
      const page = await deps.mm.listChannelPosts(
        binding.mainChannelId,
        before,
        historyPageSize,
      );
      for (const post of page.posts) {
        if (postEventKey(post) === eventKey) {
          return post;
        }
        if (post.id === anchor) return null;
      }
      if (page.reachedEnd) {
        if (isEmptyAnchor(anchor)) return null;
        deps.alerts?.integrityFailure({ eventKey, reason: "history-anchor-missing" });
        throw new ActivitySinkIntegrityError("stored Activity history anchor is missing");
      }
      if (!page.nextBefore || visited.has(page.nextBefore)) {
        deps.alerts?.integrityFailure({ eventKey, reason: "history-pagination-stalled" });
        throw new ActivitySinkIntegrityError("Activity history pagination stalled");
      }
      visited.add(page.nextBefore);
      before = page.nextBefore;
    }
  }

  private assertMainRootPost(
    post: ActivityMattermostPost | null,
    envelope: AgentActivityEnvelopeV1,
    binding: ActivitySinkBinding,
  ): asserts post is ActivityMattermostPost {
    if (
      !post ||
      post.id !== envelope.ref.mainRootPostId ||
      post.channelId !== binding.mainChannelId ||
      post.rootId !== "" ||
      !post.userId ||
      post.userId === binding.coachMmUserId
    ) {
      throw new ActivitySinkIntegrityError("main thread root failed exact Mattermost verification");
    }
  }

  private async assertMainRoot(
    envelope: AgentActivityEnvelopeV1,
    binding: ActivitySinkBinding,
  ): Promise<void> {
    const post = await this.runtime.deps.mm.getPost(envelope.ref.mainRootPostId);
    this.assertMainRootPost(post, envelope, binding);
  }

  private async rootPostId(
    envelope: AgentActivityEnvelopeV1,
  ): Promise<string> {
    const expectedEventKey = runRootEventKey(envelope.ref);
    const root = await this.runtime.deps.receipts.read(expectedEventKey);
    if (
      !root ||
      root.eventKey !== expectedEventKey ||
      root.state !== "committed" ||
      !root.postId ||
      root.postId === envelope.ref.mainRootPostId
    ) {
      throw new ActivitySinkUnavailableError("structured Activity run root is not committed");
    }
    return root.postId;
  }

  private activityPostProps(post: ActivityMattermostPost): Record<string, unknown> {
    const value = post.props.octogee;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ActivitySinkIntegrityError("Activity post is missing exact Octogee props");
    }
    return value as Record<string, unknown>;
  }

  private async assertActivityPostTarget(
    post: ActivityMattermostPost,
    envelope: AgentActivityEnvelopeV1,
    binding: ActivitySinkBinding,
    expectedEventKey: string,
  ): Promise<Record<string, unknown>> {
    const props = this.activityPostProps(post);
    const expectedActivityRootPostId = envelope.type === TURN_STARTED
      ? post.id
      : await this.rootPostId(envelope);
    if (
      post.channelId !== binding.mainChannelId ||
      post.rootId !== envelope.ref.mainRootPostId ||
      !activityPostHasExactProps(props, envelope, expectedEventKey) ||
      !activityRootPostIdMatches(post, props, envelope, expectedActivityRootPostId)
    ) {
      throw new ActivitySinkIntegrityError("Activity post failed exact channel/run/item/root verification");
    }
    return props;
  }

  private async assertRecoveredPostTarget(
    post: ActivityMattermostPost,
    envelope: AgentActivityEnvelopeV1,
    binding: ActivitySinkBinding,
  ): Promise<void> {
    if (envelope.type === "turn.finalized") {
      throw new ActivitySinkIntegrityError("turn finalization cannot own a Mattermost post");
    }
    await this.assertActivityPostTarget(post, envelope, binding, envelope.eventKey);
  }

  private async recordUnknownUpload(
    envelope: AgentActivityEnvelopeV1,
    leaseToken: string,
    progress: ProgressReceipt,
    reason: string,
  ): Promise<ResolvedAttachment> {
    const { deps, now } = this.runtime;
    const unknown: ActivityAttachmentReceiptV1 = {
      state: UPLOAD_RESULT_UNKNOWN,
      uploadId: progress.uploadId,
      filename: progress.filename,
      sha256: progress.sha256,
      byteLength: progress.byteLength,
      reason: reason.slice(0, 200),
    };
    await deps.receipts.updateAttachment(envelope.eventKey, leaseToken, unknown, now());
    deps.alerts?.attachmentUnknown({ eventKey: envelope.eventKey, uploadId: progress.uploadId });
    return { attachment: unknown };
  }

  private async verifyUploadedAttachment(
    state: Extract<ActivityAttachmentReceiptV1, { state: "uploaded" }>,
  ): Promise<ResolvedAttachment> {
    const { deps } = this.runtime;
    const info = await deps.mm.getFileInfo(state.fileId);
    if (!info || info.size !== state.byteLength) {
      throw new ActivitySinkIntegrityError("uploaded Mattermost file failed verification");
    }
    return { fileId: state.fileId, attachment: state };
  }

  private async uploadOneChunk(params: {
    envelope: Extract<AgentActivityEnvelopeV1, { type: "item.completed" }>;
    attachment: ActivityAttachmentSource;
    leaseToken: string;
    session: MattermostUploadSession;
  }): Promise<ResolvedAttachment | MattermostUploadSession> {
    const { deps, now, uploadChunkBytes } = this.runtime;
    const expected = params.envelope.item.attachment!;
    const { session } = params;
    if (session.fileOffset < 0 || session.fileOffset > params.attachment.byteLength) {
      throw new ActivitySinkIntegrityError("Mattermost upload offset is outside the attachment");
    }
    const progress: ProgressReceipt = {
      state: "uploading",
      uploadId: session.id,
      fileOffset: session.fileOffset,
      filename: expected.filename,
      sha256: expected.sha256,
      byteLength: expected.byteLength,
    };
    await deps.receipts.updateAttachment(
      params.envelope.eventKey,
      params.leaseToken,
      progress,
      now(),
    );
    const chunk = await params.attachment.read(session.fileOffset, uploadChunkBytes);
    if (chunk.byteLength === 0) {
      throw new ActivitySinkIntegrityError("attachment source ended during upload");
    }
    let result;
    try {
      result = await deps.mm.uploadData(session.id, chunk);
    } catch (error) {
      const observed = await deps.mm.getUploadSession(session.id);
      if (observed) return observed;
      const reason = error instanceof Error ? error.message : "upload result unknown";
      return this.recordUnknownUpload(params.envelope, params.leaseToken, progress, reason);
    }
    if (result.outcome === "complete") {
      const uploaded: Extract<ActivityAttachmentReceiptV1, { state: "uploaded" }> = {
        state: "uploaded",
        uploadId: session.id,
        fileId: result.fileId,
        filename: expected.filename,
        sha256: expected.sha256,
        byteLength: expected.byteLength,
      };
      await deps.receipts.updateAttachment(
        params.envelope.eventKey,
        params.leaseToken,
        uploaded,
        now(),
      );
      return this.verifyUploadedAttachment(uploaded);
    }
    const observed = await deps.mm.getUploadSession(session.id);
    if (!observed) {
      return this.recordUnknownUpload(
        params.envelope,
        params.leaseToken,
        progress,
        "incomplete upload response had no resumable session",
      );
    }
    if (observed.fileOffset <= session.fileOffset) {
      throw new ActivitySinkUnavailableError("Mattermost upload made no progress");
    }
    return observed;
  }

  private isResolvedAttachment(
    value: ResolvedAttachment | MattermostUploadSession,
  ): value is ResolvedAttachment {
    return "attachment" in value;
  }

  private async continueUpload(params: {
    envelope: Extract<AgentActivityEnvelopeV1, { type: "item.completed" }>;
    attachment: ActivityAttachmentSource;
    leaseToken: string;
    session: MattermostUploadSession;
  }): Promise<ResolvedAttachment> {
    let session = params.session;
    while (session.fileOffset < params.attachment.byteLength) {
      const result = await this.uploadOneChunk({ ...params, session });
      if (this.isResolvedAttachment(result)) return result;
      session = result;
    }
    throw new ActivitySinkIntegrityError("Mattermost upload completed without a file id");
  }

  private async resolveUploadedFile(
    envelope: Extract<AgentActivityEnvelopeV1, { type: "item.completed" }>,
    attachment: ActivityAttachmentSource,
    receipt: ActivityWriteReceiptV1,
    binding: ActivitySinkBinding,
  ): Promise<ResolvedAttachment> {
    const { deps, now } = this.runtime;
    const expected = envelope.item.attachment;
    if (!expected) return { attachment: { state: "none" } };
    const token = receipt.leaseToken;
    let state = receipt.attachment;
    let session: MattermostUploadSession | null | undefined;
    if (state.state === "none") {
      session = await deps.mm.createUploadSession(
        binding.mainChannelId,
        expected.filename,
        expected.byteLength,
      );
      state = {
        state: "session-created",
        uploadId: session.id,
        fileOffset: session.fileOffset,
        filename: expected.filename,
        sha256: expected.sha256,
        byteLength: expected.byteLength,
      };
      await deps.receipts.updateAttachment(envelope.eventKey, token, state, now());
    }
    if (state.state === UPLOAD_RESULT_UNKNOWN) return { attachment: state };
    if (state.state === "attached") return { fileId: state.fileId, attachment: state };
    if (state.state === "uploaded") return this.verifyUploadedAttachment(state);
    session ??= await deps.mm.getUploadSession(state.uploadId);
    if (!session) {
      return this.recordUnknownUpload(
        envelope,
        token,
        state,
        "upload session disappeared before a durable file id was observed",
      );
    }
    return this.continueUpload({ envelope, attachment, leaseToken: token, session });
  }

  private async recoverExistingPost(
    envelope: AgentActivityEnvelopeV1,
    receipt: ActivityWriteReceiptV1,
    binding: ActivitySinkBinding,
  ): Promise<ActivityMattermostPost | null> {
    const { deps } = this.runtime;
    let post: ActivityMattermostPost | null;
    if (receipt.postId) {
      post = await deps.mm.getPost(receipt.postId);
      if (!post) throw new ActivitySinkIntegrityError("receipt post is missing");
      if (post.id !== receipt.postId) {
        throw new ActivitySinkIntegrityError("receipt post id does not match Mattermost");
      }
    } else {
      post = await this.scanUncertainSuffix(
        envelope.eventKey,
        binding,
        receipt.historyAnchorPostId,
      );
    }
    if (post) await this.assertRecoveredPostTarget(post, envelope, binding);
    return post;
  }

  private async commitRecovered(
    envelope: AgentActivityEnvelopeV1,
    receipt: ActivityWriteReceiptV1,
    post: ActivityMattermostPost,
  ): Promise<Pick<ActivitySinkResult, "outcome" | "postIds">> {
    const { deps, now } = this.runtime;
    if (!receipt.postId) {
      await deps.receipts.markPosted(envelope.eventKey, receipt.leaseToken, post.id, now());
    }
    if (receipt.attachment.state === "uploaded") {
      const files = await deps.mm.getPostFiles(post.id);
      if (files.length !== 1 || files[0].id !== receipt.attachment.fileId) {
        throw new ActivitySinkIntegrityError("recovered post attachment failed verification");
      }
      await deps.receipts.updateAttachment(
        envelope.eventKey,
        receipt.leaseToken,
        {
          state: "attached",
          fileId: receipt.attachment.fileId,
          sha256: receipt.attachment.sha256,
          byteLength: receipt.attachment.byteLength,
        },
        now(),
      );
    }
    await deps.receipts.commit(envelope.eventKey, receipt.leaseToken, now());
    return {
      outcome: "duplicate",
      postIds: [post.id],
    };
  }

  private async claimEvent(
    envelope: AgentActivityEnvelopeV1,
    binding: ActivitySinkBinding,
    digest: string,
  ) {
    const { deps, now, leaseMs } = this.runtime;
    const existing = await deps.receipts.read(envelope.eventKey);
    try {
      return await deps.receipts.claim({
        eventKey: envelope.eventKey,
        payloadDigest: digest,
        historyAnchorPostId: existing?.historyAnchorPostId ?? (
          envelope.type === TURN_STARTED
            ? envelope.ref.mainRootPostId
            : await this.historyAnchor(binding)
        ),
        leaseOwner: deps.leaseOwner,
        now: now(),
        leaseMs,
      });
    } catch (error) {
      if (error instanceof ActivityReceiptConflictError) {
        throw new ActivitySinkConflictError(error.message);
      }
      if (!(error instanceof ActivityReceiptLeaseError)) throw error;
      const replay = await this.waitForConcurrentReplay(envelope.eventKey, digest);
      if (replay) return replay;
      throw new ActivitySinkUnavailableError(error.message);
    }
  }

  private async attachCreatedFile(
    envelope: AgentActivityEnvelopeV1,
    receipt: ActivityWriteReceiptV1,
    postId: string,
    fileId: string | undefined,
    attachment: ActivityAttachmentReceiptV1,
  ): Promise<void> {
    const { deps, now } = this.runtime;
    if (!fileId || attachment.state !== "uploaded") return;
    const files = await deps.mm.getPostFiles(postId);
    if (files.length !== 1 || files[0].id !== fileId || files[0].size !== attachment.byteLength) {
      throw new ActivitySinkIntegrityError("attached Mattermost file failed verification");
    }
    await deps.receipts.updateAttachment(
      envelope.eventKey,
      receipt.leaseToken,
      {
        state: "attached",
        fileId,
        sha256: attachment.sha256,
        byteLength: attachment.byteLength,
      },
      now(),
    );
  }

  private async createJournalPost(
    input: NormalizedActivitySinkAppendInput,
    receipt: ActivityWriteReceiptV1,
    activityRootPostId: string | undefined,
  ): Promise<Pick<ActivitySinkResult, "outcome" | "postIds">> {
    const { deps, now } = this.runtime;
    const { envelope, binding, attachment } = input;
    const rootId = envelope.ref.mainRootPostId;
    const policy = activityAttentionPolicy(envelope);
    let fileId: string | undefined;
    let attachmentState = receipt.attachment;
    if (envelope.type === ITEM_COMPLETED && envelope.item.attachment && attachment) {
      const uploaded = await this.resolveUploadedFile(envelope, attachment, receipt, binding);
      fileId = uploaded.fileId;
      attachmentState = uploaded.attachment;
    }
    let message = messageFor(envelope, binding);
    if (attachmentState.state === UPLOAD_RESULT_UNKNOWN) {
      message += `\n\n_attachment unavailable: expected ${attachmentState.sha256} (${attachmentState.byteLength} bytes)_`;
    }
    const baseOctogee = octogeeProps(envelope, activityRootPostId, policy.attention);
    const props = { octogee: baseOctogee };
    const created = await deps.mm.createActivityPost({
      channelId: binding.mainChannelId,
      rootId,
      message,
      props,
      pendingPostId: envelope.eventKey,
      fileIds: fileId ? [fileId] : undefined,
      silent: policy.silent ?? false,
    });
    await deps.receipts.markPosted(envelope.eventKey, receipt.leaseToken, created.id, now());
    await this.attachCreatedFile(envelope, receipt, created.id, fileId, attachmentState);
    await deps.receipts.commit(envelope.eventKey, receipt.leaseToken, now());
    return { outcome: "persisted", postIds: [created.id] };
  }

  private async appendClaimed(
    input: NormalizedActivitySinkAppendInput,
    receipt: ActivityWriteReceiptV1,
    recoveredClaim: boolean,
    activityRootPostId: string | undefined,
  ): Promise<Pick<ActivitySinkResult, "outcome" | "postIds">> {
    const { envelope, binding } = input;
    if (envelope.type === "turn.finalized") {
      await this.runtime.deps.receipts.commit(
        envelope.eventKey,
        receipt.leaseToken,
        this.runtime.now(),
      );
      return { outcome: "persisted", postIds: [] };
    }
    if (recoveredClaim) {
      const recovered = await this.recoverExistingPost(envelope, receipt, binding);
      if (recovered) return this.commitRecovered(envelope, receipt, recovered);
    }
    return this.createJournalPost(input, receipt, activityRootPostId);
  }

  private async resolveActivityRootPostId(
    envelope: AgentActivityEnvelopeV1,
    binding: ActivitySinkBinding,
  ): Promise<string | undefined> {
    if (envelope.type === TURN_STARTED) {
      await this.assertMainRoot(envelope, binding);
      return undefined;
    }
    return this.rootPostId(envelope);
  }

  private async resolveClaimResult(input: {
    claim: ActivitySinkClaimResult;
    appendInput: NormalizedActivitySinkAppendInput;
    activityRootPostId: string | undefined;
  }): Promise<ActivitySinkBareResult> {
    const { claim, appendInput, activityRootPostId } = input;
    const { envelope } = appendInput;
    if ("postIds" in claim) {
      return claim;
    }
    if (claim.outcome === "duplicate") {
      if (!claim.receipt.postId) return { outcome: "duplicate", postIds: [] };
      const post = await this.runtime.deps.mm.getPost(claim.receipt.postId);
      if (!post || post.id !== claim.receipt.postId) {
        throw new ActivitySinkIntegrityError("receipt post is missing or mismatched");
      }
      await this.assertRecoveredPostTarget(post, envelope, appendInput.binding);
      return { outcome: "duplicate", postIds: [post.id] };
    }
    return this.appendClaimed(
      appendInput,
      claim.receipt,
      claim.recovered,
      activityRootPostId,
    );
  }

  private acknowledgementReceipt(input: {
    envelope: AgentActivityEnvelopeV1;
    resolvedRootPostId: string;
    bare: ActivitySinkBareResult;
  }): ActivitySinkResult["receipt"] {
    const { envelope, resolvedRootPostId, bare } = input;
    const postId = bare.postIds[0];
    return {
      eventKey: envelope.eventKey,
      ...(postId ? { postId } : {}),
      activityRootPostId: resolvedRootPostId,
    };
  }

  async append(rawInput: ActivitySinkAppendInput): Promise<ActivitySinkResult> {
    const normalized: NormalizedActivitySinkAppendInput = {
      ...rawInput,
      attachment: normalizeAttachment(rawInput.attachment),
    };
    assertAttachmentPayload(normalized);
    const input = await sanitizeInput(normalized);
    const { envelope, binding, attachment } = input;
    if (binding.mainChannelId !== envelope.ref.mainChannelId) {
      throw new ActivitySinkIntegrityError("Activity binding does not match the main channel");
    }
    const activityRootPostId = await this.resolveActivityRootPostId(envelope, binding);
    const digest = await activityPayloadDigestFromSource(envelope, attachment);
    const claim = await this.claimEvent(envelope, binding, digest);
    const bare = await this.resolveClaimResult({
      claim,
      appendInput: input,
      activityRootPostId,
    });
    const resolvedRootPostId = envelope.type === TURN_STARTED
      ? bare.postIds[0]
      : activityRootPostId;
    if (!resolvedRootPostId) {
      throw new ActivitySinkIntegrityError("Activity acknowledgement has no unique run root");
    }
    const receipt = this.acknowledgementReceipt({
      envelope,
      resolvedRootPostId,
      bare,
    });
    return { ...bare, receipt };
  }

}

export function createActivitySink(deps: ActivitySinkDeps): ActivitySink {
  return new ActivitySinkWriter({
    deps,
    now: deps.now ?? Date.now,
    leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS,
    uploadChunkBytes: deps.uploadChunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES,
    historyPageSize: deps.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE,
  });
}
