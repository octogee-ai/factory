import { MANAGED_CHANNEL_INSTALLATION, } from "../channel-identities.js";
import { DuplicateRecordError } from "../errors.js";
import { column, decodeStored } from "./values.js";
const CHANNEL_IDENTITIES_TABLE = {
    table: "channel_identities",
    aggregate: "channel-identity",
    keyColumns: ["channel_provider", "channel_installation", "external_user_id"],
    columns: [
        column("provider", "text", { column: "channel_provider" }),
        column("installation", "text", { column: "channel_installation" }),
        column("externalUserId", "text"),
        column("ownerKind", "text"),
        column("ownerId", "text"),
    ],
};
export function managedExternalUserIdOf(ownerKind, ownerColumn) {
    return `(SELECT i.external_user_id FROM $schema.channel_identities i
    WHERE i.owner_kind = '${ownerKind}' AND i.owner_id = ${ownerColumn}
      AND i.channel_provider = '${MANAGED_CHANNEL_INSTALLATION.provider}'
      AND i.channel_installation = '${MANAGED_CHANNEL_INSTALLATION.installation}')`;
}
export function managedOwnerIdOf(ownerKind, externalUserIdSql) {
    return `(SELECT i.owner_id FROM $schema.channel_identities i
    WHERE i.owner_kind = '${ownerKind}' AND i.external_user_id = ${externalUserIdSql}
      AND i.channel_provider = '${MANAGED_CHANNEL_INSTALLATION.provider}'
      AND i.channel_installation = '${MANAGED_CHANNEL_INSTALLATION.installation}')`;
}
function keyOf(installation, externalUserId) {
    return { aggregate: "channel-identity", key: `${installation.provider}/${installation.installation}/${externalUserId}` };
}
function decode(row) {
    return decodeStored(CHANNEL_IDENTITIES_TABLE, row);
}
export async function linkChannelIdentity(session, operation, record, identity, duplicate) {
    const { provider, installation, externalUserId, ownerKind, ownerId } = identity;
    await session.atomically(operation, async (transaction) => {
        await transaction.write(operation, record, `DELETE FROM $schema.channel_identities
       WHERE owner_kind = $1::text AND owner_id = $2::text AND channel_provider = $3::text
         AND channel_installation = $4::text AND external_user_id <> $5::text`, [ownerKind, ownerId, provider, installation, externalUserId]);
        const linked = await transaction.write(operation, record, `INSERT INTO $schema.channel_identities AS held
         (channel_provider, channel_installation, external_user_id, owner_kind, owner_id)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text)
       ON CONFLICT (channel_provider, channel_installation, external_user_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
       WHERE held.owner_kind = EXCLUDED.owner_kind AND held.owner_id = EXCLUDED.owner_id
       RETURNING held.revision`, [provider, installation, externalUserId, ownerKind, ownerId]);
        if (linked.length > 0)
            return;
        const holders = await transaction.execute(`SELECT owner_id FROM $schema.channel_identities
       WHERE channel_provider = $1::text AND channel_installation = $2::text AND external_user_id = $3::text`, [provider, installation, externalUserId]);
        throw new DuplicateRecordError(duplicate.aggregate, duplicate.lookup, externalUserId, holders.map((holder) => String(holder.owner_id)));
    });
}
export async function clearManagedChannelIdentity(session, operation, record, ownerKind, ownerId) {
    await session.write(operation, record, `DELETE FROM $schema.channel_identities
     WHERE owner_kind = $1::text AND owner_id = $2::text AND channel_provider = $3::text AND channel_installation = $4::text`, [ownerKind, ownerId, MANAGED_CHANNEL_INSTALLATION.provider, MANAGED_CHANNEL_INSTALLATION.installation]);
}
export function createPostgresChannelIdentitiesRepository(session) {
    return {
        async find(installation, externalUserId) {
            const rows = await session.read("channelIdentities.find", `SELECT * FROM $schema.channel_identities
         WHERE channel_provider = $1::text AND channel_installation = $2::text AND external_user_id = $3::text`, [installation.provider, installation.installation, externalUserId]);
            return rows.length === 0 ? null : decode(rows[0]);
        },
        async listForOwner(ownerId) {
            const rows = await session.read("channelIdentities.listForOwner", `SELECT * FROM $schema.channel_identities WHERE owner_id = $1::text
         ORDER BY channel_provider, channel_installation, external_user_id`, [ownerId]);
            return rows.map(decode);
        },
        async link(identity) {
            await linkChannelIdentity(session, "channelIdentities.link", keyOf(identity, identity.externalUserId), identity, { aggregate: "channel-identity", lookup: "externalUserId" });
        },
        async unlink(installation, externalUserId) {
            await session.write("channelIdentities.unlink", keyOf(installation, externalUserId), `DELETE FROM $schema.channel_identities
         WHERE channel_provider = $1::text AND channel_installation = $2::text AND external_user_id = $3::text`, [installation.provider, installation.installation, externalUserId]);
        },
    };
}
