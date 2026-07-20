import type { AgentImportRecord, StoredAgentImportPlan } from "./agent-import-service.js";

const IMPORT_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;

interface DocumentSnapshotLike {
  exists: boolean;
  data(): unknown;
}

interface StoreDeps {
  db: {
    doc(path: string): {
      set(value: unknown): Promise<unknown>;
      get(): Promise<DocumentSnapshotLike>;
    };
  };
  bucket: {
    file(path: string): {
      save(value: Buffer | string, options?: unknown): Promise<unknown>;
      download(): Promise<[Buffer]>;
    };
    deleteFiles(options: { prefix: string }): Promise<unknown>;
  };
}

function requireId(id: string): string {
  if (!IMPORT_ID_RE.test(id)) throw new Error("invalid agent import id");
  return id;
}

function recordPath(id: string): string {
  return `agentImports/${requireId(id)}`;
}

function stagingPath(id: string, name: string): string {
  return `agent-imports/${requireId(id)}/${name}`;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validRecord(value: unknown, id: string): AgentImportRecord | null {
  const data = object(value);
  return data?.id === id && typeof data.uid === "string" && typeof data.status === "string"
    ? data as unknown as AgentImportRecord
    : null;
}

function validPlan(value: unknown): StoredAgentImportPlan | null {
  const data = object(value);
  return typeof data?.uid === "string" && typeof data.slug === "string" &&
    typeof data.gatewayId === "string" && typeof data.approvalHash === "string"
    ? data as unknown as StoredAgentImportPlan
    : null;
}

function missingObject(error: unknown): boolean {
  const code = object(error)?.code;
  return code === 404 || code === "404";
}

export function createAgentImportStore(deps: StoreDeps) {
  return {
    async putRecord(record: AgentImportRecord): Promise<void> {
      await deps.db.doc(recordPath(record.id)).set(record);
    },

    async getRecord(id: string): Promise<AgentImportRecord | null> {
      const snapshot = await deps.db.doc(recordPath(id)).get();
      return snapshot.exists ? validRecord(snapshot.data(), id) : null;
    },

    async putPlan(id: string, plan: StoredAgentImportPlan): Promise<void> {
      await deps.bucket.file(stagingPath(id, "plan.json")).save(JSON.stringify(plan), {
        contentType: "application/json",
        resumable: false,
      });
    },

    async getPlan(id: string): Promise<StoredAgentImportPlan | null> {
      try {
        const [contents] = await deps.bucket.file(stagingPath(id, "plan.json")).download();
        return validPlan(JSON.parse(contents.toString("utf8")));
      } catch (error) {
        if (missingObject(error)) return null;
        throw error;
      }
    },

    async putArchive(id: string, archive: Buffer): Promise<void> {
      await deps.bucket.file(stagingPath(id, "source.zip")).save(archive, {
        contentType: "application/zip",
        resumable: true,
      });
    },

    async getArchive(id: string): Promise<Buffer | null> {
      try {
        const [contents] = await deps.bucket.file(stagingPath(id, "source.zip")).download();
        return contents;
      } catch (error) {
        if (missingObject(error)) return null;
        throw error;
      }
    },

    async deleteStaging(id: string): Promise<void> {
      await deps.bucket.deleteFiles({ prefix: stagingPath(id, "") });
    },
  };
}
