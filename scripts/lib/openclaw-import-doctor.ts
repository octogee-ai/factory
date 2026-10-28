import { MIGRATION_IMPORT_DOCTOR_PHASE_TIMEOUT_MS } from "@octogee/shared/types/fleet-controller";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { queryAgentStore, readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { installedAgentSchemaVersion, postgresSourceMetadataMatches } from "./openclaw-source-doctor.js";
import { runOpenClaw, type OpenClawCommand } from "./openclaw-cli.js";

export interface ImportedAgentStore {
  agentId: string;
  anchorPath: string;
  storeId: string;
  schema: string;
}

export async function upgradeImportedAgentStores(input: {
  stores: readonly ImportedAgentStore[];
  assertCurrent: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
  run?: OpenClawCommand;
  signal?: AbortSignal;
  query?: typeof queryAgentStore;
}): Promise<void> {
  const env = input.env ?? process.env;
  if (!env.OPENCLAW_AGENT_STORE_DSN?.trim()) throw new Error("import Doctor requires a PostgreSQL DSN");
  if (!input.stores.length || new Set(input.stores.map(store => store.agentId)).size !== input.stores.length ||
      new Set(input.stores.map(store => store.storeId)).size !== input.stores.length ||
      new Set(input.stores.map(store => store.schema)).size !== input.stores.length ||
      input.stores.some(store => !/^[a-z0-9][a-z0-9_-]*$/u.test(store.agentId))) {
    throw new Error("import Doctor requires a unique valid agent roster");
  }
  const captured = await Promise.all(input.stores.map(async store => {
    const stat = await fs.lstat(store.anchorPath);
    if (!path.isAbsolute(store.anchorPath) || !stat.isFile() || stat.nlink !== 1 ||
        await fs.realpath(store.anchorPath) !== path.resolve(store.anchorPath)) throw new Error(`import Doctor anchor is not canonical: ${store.agentId}`);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = await fs.lstat(store.anchorPath + suffix).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (sidecar) throw new Error(`import Doctor anchor is not closed: ${store.agentId}`);
    }
    const anchor = readPostgresAgentAnchor(store.anchorPath);
    if (!anchor || anchor.storeId !== store.storeId || anchor.schema !== store.schema) throw new Error(`import Doctor anchor identity mismatch: ${store.agentId}`);
    return { ...store, bytes: await fs.readFile(store.anchorPath) };
  }));
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    await input.assertCurrent();
    for (const store of captured) {
      const stat = await fs.lstat(store.anchorPath);
      if (!stat.isFile() || stat.nlink !== 1 || await fs.realpath(store.anchorPath) !== store.anchorPath ||
          !(await fs.readFile(store.anchorPath)).equals(store.bytes)) throw new Error(`import Doctor anchor changed: ${store.agentId}`);
    }
    input.signal?.throwIfAborted();
  };
  await assertCurrent();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "import-doctor-")));
  try {
    const configPath = path.join(root, "openclaw.json");
    const expectedSchemaVersion = await installedAgentSchemaVersion(root, captured[0]!.agentId, {
      assertCurrent, run: input.run, env,
    });
    const verifyMetadata = async (exact: boolean) => {
      let needsUpgrade = false;
      for (const store of captured) {
        await assertCurrent();
        const rows = await (input.query ?? queryAgentStore)({ storeId: store.storeId, schema: store.schema },
          `SELECT physical.store_id, physical.version, owner.role, owner.agent_id, owner.schema_version
           FROM $schema.openclaw_schema_meta physical CROSS JOIN $schema.schema_meta owner
           WHERE physical.store = 'agent' AND owner.meta_key = 'primary'`);
        const metadataStore = { ...store, anchor: { storeId: store.storeId, schema: store.schema }, file: store.anchorPath };
        if (!postgresSourceMetadataMatches({ rows, store: metadataStore, expectedVersion: expectedSchemaVersion, exact })) {
          throw new Error(`import Doctor PostgreSQL identity/version metadata mismatch: ${store.agentId}`);
        }
        if (Number(rows[0]!.version) < expectedSchemaVersion) needsUpgrade = true;
        await assertCurrent();
      }
      return needsUpgrade;
    };
    if (!await verifyMetadata(false)) return;
    const options = { env: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1", HOME: root,
      OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_AGENT_STORE_DSN: env.OPENCLAW_AGENT_STORE_DSN },
      signal: input.signal, timeoutMs: MIGRATION_IMPORT_DOCTOR_PHASE_TIMEOUT_MS };
    await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false },
      agents: { ownership: "explicit", entries: { "octogee-import-doctor-bootstrap": { workspace: path.join(root, "bootstrap-workspace") } } },
      database: { engine: "sqlite" } }), { mode: 0o600 });
    const run = input.run ?? runOpenClaw;
    const runPrivate = async (args: string[], phase: string) => {
      await assertCurrent();
      let result;
      try { result = await run(args, options); }
      finally { await assertCurrent(); }
      if (result.code !== 0) throw new Error(`import ${phase} failed (exit ${result.code})`);
    };
    await runPrivate(["setup", "--baseline", "--skip-bootstrap", "--json"], "bootstrap setup");
    const initialized = JSON.parse(await fs.readFile(configPath, "utf8"));
    await fs.rm(path.join(root, "agents"), { recursive: true, force: true });
    const entries: Record<string, { workspace: string }> = {};
    for (const store of captured) {
      const file = path.join(root, "agents", store.agentId, "agent", "openclaw-agent.sqlite");
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, store.bytes, { mode: 0o600, flag: "wx" });
      entries[store.agentId] = { workspace: path.join(root, "workspaces", store.agentId) };
    }
    await fs.writeFile(configPath, JSON.stringify({ ...initialized, gateway: { mode: "local" }, plugins: { enabled: false },
      agents: { ownership: "explicit", entries }, database: { engine: "sqlite", families: { agent: { engine: "postgres" } },
        postgres: { connection: { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" }, schemaPrefix: "octogee" } } }), { mode: 0o600 });
    await runPrivate(["doctor", "--fix", "--non-interactive"], "PostgreSQL upgrade");
    await verifyMetadata(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
