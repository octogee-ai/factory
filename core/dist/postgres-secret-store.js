import { createHash } from "node:crypto";
import pg from "pg";
import { createRootKeyEncryptor } from "./encryptor.js";
import { DEFAULT_PLATFORM_STATE_SCHEMA } from "./platform-state/postgres/migrate.js";
import { SecretNotFoundError, } from "./secret-store-types.js";
function keyId(encodedKey) {
    return createHash("sha256").update(Buffer.from(encodedKey, "base64")).digest("hex");
}
export function createSecretStoreKeyRing(encodedKey, previousKey) {
    const current = createRootKeyEncryptor(encodedKey);
    const targetKeyId = keyId(encodedKey);
    const keys = new Map([[targetKeyId, current]]);
    if (previousKey !== undefined)
        keys.set(keyId(previousKey), createRootKeyEncryptor(previousKey));
    return {
        targetKeyId,
        encryptor(id) {
            const encryptor = keys.get(id);
            if (!encryptor)
                throw new Error(`secret store references unavailable key ${id}`);
            return encryptor;
        },
    };
}
const MAX_SECRET_VERSIONS = 5;
async function transaction(pool, body) {
    const client = await pool.connect();
    let discard;
    const onError = (error) => { discard = error; };
    client.on("error", onError);
    try {
        await client.query("BEGIN");
        const value = await body(client);
        await client.query("COMMIT");
        return value;
    }
    catch (error) {
        try {
            await client.query("ROLLBACK");
        }
        catch (rollbackError) {
            discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
            throw new AggregateError([error, rollbackError], "secret store transaction and rollback failed");
        }
        throw error;
    }
    finally {
        client.off("error", onError);
        client.release(discard);
    }
}
function secretName(name) {
    if (!/^[A-Za-z0-9_-]{1,255}$/u.test(name))
        throw new Error("invalid secret name");
    return name;
}
function versionNumber(version) {
    if (version === "latest")
        return null;
    if (!/^[1-9]\d{0,9}$/u.test(version) || Number(version) > 2_147_483_647) {
        throw new Error("invalid secret version");
    }
    return Number(version);
}
function seal(encryptor, name, version, value) {
    return encryptor.encrypt(JSON.stringify({ name, version, value }));
}
async function open(keys, row) {
    const parsed = JSON.parse(await keys.encryptor(row.key_id).decrypt(row.ciphertext));
    if (parsed.name !== row.name || parsed.version !== row.version || typeof parsed.value !== "string") {
        throw new Error("secret ciphertext does not match its row");
    }
    return parsed.value;
}
export function createPostgresSecretStore(pool, keys, schema = DEFAULT_PLATFORM_STATE_SCHEMA) {
    const identifier = pg.escapeIdentifier(schema);
    const table = `${identifier}.runtime_secrets`;
    const versions = `${identifier}.runtime_secret_versions`;
    const activeKey = `${identifier}.runtime_secret_key`;
    async function ensure(client, name) {
        const result = await client.query(`INSERT INTO ${table} (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
        return result.rowCount === 1;
    }
    async function lockKey(client, lock) {
        await client.query(`INSERT INTO ${activeKey} (key_id) VALUES ($1) ON CONFLICT DO NOTHING`, [keys.targetKeyId]);
        const result = await client.query(`SELECT key_id FROM ${activeKey} WHERE singleton FOR ${lock}`);
        const key = result.rows[0]?.key_id;
        if (!key)
            throw new Error("secret store active key is missing");
        return key;
    }
    async function lockSecret(client, name) {
        const result = await client.query(`SELECT last_version FROM ${table} WHERE name = $1 FOR UPDATE`, [name]);
        return result.rows[0];
    }
    async function append(client, input, key) {
        const { name, labels, value } = input;
        const updated = await client.query(`UPDATE ${table} SET last_version = last_version + 1, labels = COALESCE($2::jsonb, labels)
       WHERE name = $1 RETURNING last_version`, [name, labels ?? null]);
        const version = updated.rows[0]?.last_version;
        if (version === undefined)
            throw new SecretNotFoundError(`secret ${name} does not exist`);
        const ciphertext = await seal(keys.encryptor(key), name, version, value);
        await client.query(`INSERT INTO ${versions} (name, version, key_id, ciphertext) VALUES ($1, $2, $3, $4)`, [name, version, key, ciphertext]);
        return { version, versionName: `secrets/${name}/versions/${version}` };
    }
    async function read(name, version) {
        const result = await pool.query(`SELECT v.*, s.labels FROM ${table} s JOIN ${versions} v ON v.name = s.name
       AND v.version = COALESCE($2::integer, s.last_version) WHERE s.name = $1`, [secretName(name), versionNumber(version)]);
        const row = result.rows[0];
        if (!row)
            throw new SecretNotFoundError(`secret ${name} version ${version} does not exist`);
        if (!row.enabled)
            throw new Error(`secret ${name} version ${version} is disabled`);
        return { value: await open(keys, row), labels: row.labels };
    }
    async function latestEnabled(client, name, version) {
        const result = await client.query(`SELECT * FROM ${versions} WHERE name = $1 AND version = $2 AND enabled`, [name, version]);
        return result.rows[0];
    }
    async function writeBoundedVersion(client, input, key, current) {
        const { name, labels, value } = input;
        keys.encryptor(key);
        const latest = await latestEnabled(client, name, current.last_version);
        const duplicate = latest && await open(keys, latest) === value;
        const version = duplicate ? current.last_version : (await append(client, input, key)).version;
        if (duplicate && labels)
            await client.query(`UPDATE ${table} SET labels = $2::jsonb WHERE name = $1`, [name, labels]);
        await client.query(`DELETE FROM ${versions} WHERE name = $1 AND version <= $2`, [name, version - MAX_SECRET_VERSIONS]);
        return { versionName: `secrets/${name}/versions/${version}` };
    }
    async function addSecretVersionIfExists(name, value) {
        return transaction(pool, async (client) => {
            const key = await lockKey(client, "SHARE");
            const current = await lockSecret(client, secretName(name));
            if (!current)
                return { ok: false, reason: "not_found" };
            const { versionName } = await writeBoundedVersion(client, { name, value }, key, current);
            return { ok: true, versionName };
        });
    }
    async function addSecretVersionKeepingLatest(name, value) {
        return transaction(pool, async (client) => {
            const key = await lockKey(client, "SHARE");
            const current = await lockSecret(client, secretName(name));
            if (!current)
                return { ok: false, reason: "not_found" };
            keys.encryptor(key);
            const latest = await latestEnabled(client, name, current.last_version);
            const changed = !latest || await open(keys, latest) !== value;
            const added = changed ? await append(client, { name, value }, key) : null;
            const destroyed = await client.query(`DELETE FROM ${versions} WHERE name = $1 AND version < $2`, [name, added?.version ?? current.last_version]);
            return added
                ? { ok: true, changed: true, versionName: added.versionName, destroyed: destroyed.rowCount ?? 0 }
                : { ok: true, changed: false, destroyed: destroyed.rowCount ?? 0 };
        });
    }
    return {
        async writeSecret(input) {
            return transaction(pool, async (client) => {
                const key = await lockKey(client, "SHARE");
                const name = secretName(input.name);
                await ensure(client, name);
                const current = await lockSecret(client, name);
                if (!current)
                    throw new SecretNotFoundError(`secret ${name} does not exist`);
                return writeBoundedVersion(client, input, key, current);
            });
        },
        addSecretVersionIfExists,
        addSecretVersionKeepingLatest,
        async readSecret(name, version = "latest") {
            return (await read(name, version)).value;
        },
        readSecretWithLabels(name, version = "latest") {
            return read(name, version);
        },
        async archiveSecret(name) {
            return transaction(pool, async (client) => {
                if (!await lockSecret(client, secretName(name)))
                    return { disabledCount: 0 };
                const result = await client.query(`UPDATE ${versions} SET enabled = false WHERE name = $1 AND enabled`, [name]);
                return { disabledCount: result.rowCount ?? 0 };
            });
        },
        async deleteSecret(name) {
            const result = await pool.query(`DELETE FROM ${table} WHERE name = $1`, [secretName(name)]);
            return { deleted: result.rowCount === 1 };
        },
        async provisionGatewayAuthSecret({ gatewayId }) {
            const name = secretName(`gateway-auth-token-${gatewayId}`);
            return { secretName: `secrets/${name}`, created: await ensure(pool, name) };
        },
        async rotate() {
            return transaction(pool, async (client) => {
                await lockKey(client, "UPDATE");
                const result = await client.query(`SELECT * FROM ${versions} WHERE key_id <> $1 FOR UPDATE`, [keys.targetKeyId]);
                const encryptor = keys.encryptor(keys.targetKeyId);
                for (const row of result.rows) {
                    const ciphertext = await seal(encryptor, row.name, row.version, await open(keys, row));
                    await client.query(`UPDATE ${versions} SET key_id = $1, ciphertext = $2 WHERE name = $3 AND version = $4`, [keys.targetKeyId, ciphertext, row.name, row.version]);
                }
                await client.query(`UPDATE ${activeKey} SET key_id = $1 WHERE singleton`, [keys.targetKeyId]);
                return { rotated: result.rows.length };
            });
        },
    };
}
