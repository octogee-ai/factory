import { isReleasePayload } from "@octogee/shared/types/gateway-releases";
import { GoogleAuth } from "google-auth-library";
import { gunzipSync } from "node:zlib";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";
import { deploymentSettingsForRuntime, requireHostedDeploymentSettings } from "./deployment-environment.js";
function registryCoordinates(overrides) {
    if (overrides.project && overrides.location && overrides.repository) {
        return {
            project: overrides.project,
            location: overrides.location,
            repository: overrides.repository,
        };
    }
    const namespace = process.env.K8S_NAMESPACE;
    if (!namespace) {
        throw new Error("K8S_NAMESPACE is required when Artifact Registry coordinates are incomplete");
    }
    const runtime = requireHostedDeploymentSettings(deploymentSettingsForRuntime({
        namespace,
        targetId: process.env.DEPLOYMENT_TARGET_ID,
    }));
    return {
        project: overrides.project ?? runtime.artifactRegistryProjectId,
        location: overrides.location ?? runtime.artifactRegistryLocation,
        repository: overrides.repository ?? runtime.artifactRegistryName,
    };
}
const DEFAULT_LIMIT = 30;
const PAGE_SIZE = 200;
let cachedAuth = null;
function getAuth() {
    if (!cachedAuth) {
        cachedAuth = new GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
        });
    }
    return cachedAuth;
}
async function getAccessToken() {
    const client = await getAuth().getClient();
    const result = await client.getAccessToken();
    const token = typeof result === "string" ? result : result?.token;
    if (!token)
        throw new Error("artifact-registry: failed to obtain access token");
    return token;
}
function extractBuildsForService(items, service) {
    const servicePrefix = `/dockerImages/${service}@`;
    const seen = new Map();
    for (const item of items) {
        if (!item.name.includes(servicePrefix))
            continue;
        const digest = item.name.split(servicePrefix)[1];
        if (!digest)
            continue;
        const pushedAt = item.uploadTime ?? "";
        for (const tag of item.tags ?? []) {
            if (!IMAGE_TAG_PATTERN.test(tag))
                continue;
            const existing = seen.get(tag);
            if (!existing || existing.pushedAt < pushedAt) {
                seen.set(tag, { tag, pushedAt, digest });
            }
        }
    }
    return seen;
}
const MAX_PAGES = 10;
async function fetchDockerImagesPage(project, location, repository, token, pageToken) {
    const params = new URLSearchParams({
        pageSize: String(PAGE_SIZE),
        orderBy: "update_time desc",
    });
    if (pageToken)
        params.set("pageToken", pageToken);
    const url = `https://artifactregistry.googleapis.com/v1` +
        `/projects/${project}/locations/${location}/repositories/${repository}/dockerImages` +
        `?${params.toString()}`;
    const resp = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        const suffix = detail ? ` — ${detail.slice(0, 200)}` : "";
        throw new Error(`artifact-registry list failed: ${resp.status} ${resp.statusText}${suffix}`);
    }
    return (await resp.json());
}
function mergeNewerBuilds(accumulated, pageMap) {
    for (const [tag, build] of pageMap) {
        const existing = accumulated.get(tag);
        if (!existing || existing.pushedAt < build.pushedAt) {
            accumulated.set(tag, build);
        }
    }
}
export async function listGatewayBuilds(opts) {
    const { project, location, repository } = registryCoordinates(opts);
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const enoughDeduped = limit * 3;
    const token = await getAccessToken();
    const accumulated = new Map();
    let pageToken = null;
    for (let page = 0; page < MAX_PAGES; page++) {
        const result = await fetchDockerImagesPage(project, location, repository, token, pageToken);
        mergeNewerBuilds(accumulated, extractBuildsForService(result.dockerImages ?? [], opts.service));
        pageToken = result.nextPageToken ?? null;
        if (!pageToken)
            break;
        if (accumulated.size >= enoughDeduped)
            break;
    }
    return [...accumulated.values()]
        .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
        .slice(0, limit);
}
let cachedWriteAuth = null;
function getWriteAuth() {
    if (!cachedWriteAuth) {
        cachedWriteAuth = new GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        });
    }
    return cachedWriteAuth;
}
async function getWriteToken() {
    const client = await getWriteAuth().getClient();
    const result = await client.getAccessToken();
    const token = typeof result === "string" ? result : result?.token;
    if (!token)
        throw new Error("artifact-registry: failed to obtain write access token");
    return token;
}
function packagesBase(c) {
    const { project, location, repository } = registryCoordinates(c);
    return (`https://artifactregistry.googleapis.com/v1` +
        `/projects/${project}/locations/${location}/repositories/${repository}/packages`);
}
function arFetch(url, method, token, body) {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined)
        headers["Content-Type"] = "application/json";
    return fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
export async function ensureKeepTag(opts) {
    const digest = assertDigest(opts.digest, "retention pin digest");
    const base = `${packagesBase(opts)}/${opts.service}`;
    const keepTag = `keep-${opts.env}-${digest.replace(":", "-")}`;
    const token = await getWriteToken();
    const postResp = await arFetch(`${base}/tags?tagId=${encodeURIComponent(keepTag)}`, "POST", token, { version: versionResource(registryCoordinates(opts), opts.service, digest) });
    if (!postResp.ok && postResp.status !== 409) {
        const detail = await postResp.text().catch(() => "");
        throw new Error(`artifact-registry: pin ${keepTag} failed: ${postResp.status} ${detail.slice(0, 200)}`);
    }
}
/** Release a `keep-<env>-<tag>` pin (image becomes eligible for the time-based
 *  cleanup once no env still pins it). Idempotent — 404 is already-gone. */
export async function removeKeepTag(opts) {
    const base = `${packagesBase(opts)}/${opts.service}`;
    const keepTag = `keep-${opts.env}-${opts.tag}`;
    const token = await getWriteToken();
    const resp = await arFetch(`${base}/tags/${encodeURIComponent(keepTag)}`, "DELETE", token);
    if (!resp.ok && resp.status !== 404) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`artifact-registry: unpin ${keepTag} failed: ${resp.status} ${detail.slice(0, 200)}`);
    }
}
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OPENCLAW_VERSION_PATTERN = /^\d{4}\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
// The manifest is a lookup for release invariant 1 — the bytes are already
// built — not an approval system. A schema version or an unfamiliar surface key
// says nothing about whether those bytes exist, so gating on either blocks a
// promotion the images would have satisfied. Read the manifest for what it
// carries. The one refusal that earns its place is a digest the gateway release
// genuinely needs and the manifest does not have, named so the operator knows
// which image to build.
const RELEASE_GATEWAY_IMAGES_REQUIRED = [
    "gateway-edge",
    "octogee-gateway",
    "octogee-gateway-builder",
];
export function centralGatewayReleasePayload(manifest) {
    const shortSha = manifest.sourceSha.slice(0, 7);
    const tag = `${shortSha}-oc${manifest.openclawVersion}`;
    const payload = {
        imageRepository: `${manifest.repository}/octogee-gateway`,
        imageTag: `${tag}@${manifest.surfaces.gateway["octogee-gateway"]}`,
        ...(manifest.openclawSourceSha
            ? { openclawSourceSha: manifest.openclawSourceSha }
            : {}),
        profileImages: {
            builder: {
                imageRepository: `${manifest.repository}/octogee-gateway-builder`,
                imageTag: `${tag}@${manifest.surfaces.gateway["octogee-gateway-builder"]}`,
            },
        },
        gatewayEdgeImage: {
            imageRepository: `${manifest.repository}/gateway-edge`,
            imageTag: `${tag}@${manifest.surfaces.gateway["gateway-edge"]}`,
        },
    };
    if (!isReleasePayload(payload)) {
        throw new Error("CENTRAL release manifest cannot produce a valid gateway release payload");
    }
    return payload;
}
export class ReleaseDigestAliasError extends Error {
    aliasOutcomes;
    constructor(aliasOutcomes, cause) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.aliasOutcomes = aliasOutcomes;
        this.name = "ReleaseDigestAliasError";
    }
}
export class ReleaseDigestManifestNotFoundError extends Error {
    sourceSha;
    constructor(sourceSha) {
        super(`release digest manifest ${sourceSha} does not exist`);
        this.sourceSha = sourceSha;
        this.name = "ReleaseDigestManifestNotFoundError";
    }
}
function assertSourceSha(value) {
    if (!SOURCE_SHA_PATTERN.test(value)) {
        throw new Error("release source SHA must be a full lowercase commit SHA");
    }
    return value;
}
function assertDigest(value, description) {
    if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
        throw new Error(`${description} must be an immutable sha256 digest`);
    }
    return value;
}
function plainRecord(value, description) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${description} must be an object`);
    }
    return value;
}
function exactObjectKeys(value, expected, description) {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    if (actual.length !== sortedExpected.length ||
        actual.some((key, index) => key !== sortedExpected[index])) {
        throw new Error(`${description} must contain exactly: ${sortedExpected.join(", ")}`);
    }
}
function requiredObjectKeys(value, expected, description) {
    const missing = expected.filter((key) => value[key] === undefined);
    if (missing.length > 0) {
        throw new Error(`${description} is missing: ${missing.join(", ")}`);
    }
}
function validateReleaseDigestManifest(input, manifestDigest, expectedRepository) {
    const manifest = plainRecord(input, "release digest manifest");
    requiredObjectKeys(manifest, ["sourceSha", "openclawVersion", "repository", "surfaces"], "release digest manifest");
    const sourceSha = typeof manifest.sourceSha === "string"
        ? assertSourceSha(manifest.sourceSha)
        : assertSourceSha("");
    if (typeof manifest.openclawVersion !== "string" || !OPENCLAW_VERSION_PATTERN.test(manifest.openclawVersion)) {
        throw new Error("release digest manifest openclawVersion is invalid");
    }
    if (manifest.openclawSourceSha !== undefined &&
        (typeof manifest.openclawSourceSha !== "string" ||
            !SOURCE_SHA_PATTERN.test(manifest.openclawSourceSha))) {
        throw new Error("release digest manifest openclawSourceSha is invalid");
    }
    if (manifest.repository !== expectedRepository) {
        throw new Error("release digest manifest repository does not match CENTRAL Artifact Registry");
    }
    const surfaces = plainRecord(manifest.surfaces, "release digest manifest surfaces");
    exactObjectKeys(surfaces, ["gateway", "platform"], "release digest manifest surfaces");
    const parseSurface = (surface) => {
        const entries = plainRecord(surfaces[surface], `release digest manifest ${surface} surface`);
        return Object.fromEntries(Object.keys(entries).map((image) => [
            image,
            assertDigest(entries[image], `release digest manifest ${image}`),
        ]));
    };
    const gateway = parseSurface("gateway");
    const missing = RELEASE_GATEWAY_IMAGES_REQUIRED.filter((image) => gateway[image] === undefined);
    if (missing.length > 0) {
        throw new Error(`release digest manifest is missing the gateway release images: ${missing.join(", ")}`);
    }
    return {
        sourceSha,
        manifestDigest: assertDigest(manifestDigest, "release digest manifest"),
        openclawVersion: manifest.openclawVersion,
        ...(typeof manifest.openclawSourceSha === "string"
            ? { openclawSourceSha: manifest.openclawSourceSha }
            : {}),
        repository: expectedRepository,
        surfaces: { gateway, platform: parseSurface("platform") },
        ...(manifest.desktopImage === undefined ? {} : { desktopImage: manifest.desktopImage }),
    };
}
function validateResolvedReleaseDigestManifest(manifest, expectedRepository) {
    return validateReleaseDigestManifest({
        sourceSha: manifest.sourceSha,
        openclawVersion: manifest.openclawVersion,
        ...(manifest.openclawSourceSha
            ? { openclawSourceSha: manifest.openclawSourceSha }
            : {}),
        repository: manifest.repository,
        surfaces: manifest.surfaces,
    }, manifest.manifestDigest, expectedRepository);
}
function dockerRepository(coordinates) {
    return `${coordinates.location}-docker.pkg.dev/${coordinates.project}/${coordinates.repository}`;
}
function packagesBaseForCoordinates(coordinates) {
    return (`https://artifactregistry.googleapis.com/v1/projects/${coordinates.project}` +
        `/locations/${coordinates.location}/repositories/${coordinates.repository}/packages`);
}
function versionResource(coordinates, packageName, digest) {
    return `projects/${coordinates.project}/locations/${coordinates.location}` +
        `/repositories/${coordinates.repository}/packages/${packageName}/versions/${digest}`;
}
function digestFromVersion(value, description) {
    if (typeof value !== "string")
        throw new Error(`${description} has no version`);
    const marker = "/versions/";
    const index = value.lastIndexOf(marker);
    if (index === -1)
        throw new Error(`${description} version is malformed`);
    return assertDigest(value.slice(index + marker.length), `${description} version`);
}
async function requireJson(response, description) {
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`${description} failed: ${response.status} ${detail.slice(0, 200)}`);
    }
    return plainRecord(await response.json(), description);
}
function tarHeaderField(header, start, end, encoding) {
    const field = header.subarray(start, end);
    const terminator = field.indexOf(0);
    return Buffer.from(terminator === -1 ? field : field.subarray(0, terminator)).toString(encoding);
}
function tarFileContents(archive, requestedName) {
    let offset = 0;
    while (offset + 512 <= archive.length) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every((value) => value === 0))
            break;
        const name = tarHeaderField(header, 0, 100, "utf8");
        const prefix = tarHeaderField(header, 345, 500, "utf8");
        const fullName = prefix ? `${prefix}/${name}` : name;
        const sizeOctal = tarHeaderField(header, 124, 136, "ascii").trim();
        const size = Number.parseInt(sizeOctal || "0", 8);
        if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) {
            throw new Error("release digest manifest archive is malformed");
        }
        if (fullName === requestedName) {
            return Buffer.from(archive.subarray(offset + 512, offset + 512 + size)).toString("utf8");
        }
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    throw new Error(`release digest manifest archive is missing ${requestedName}`);
}
function parseReleaseAlias(alias, expectedRepository) {
    const prefix = `${expectedRepository}/`;
    if (!alias.startsWith(prefix))
        throw new Error("release alias is outside CENTRAL Artifact Registry");
    const reference = alias.slice(prefix.length);
    const colon = reference.lastIndexOf(":");
    if (colon <= 0 || colon === reference.length - 1 || reference.includes("@")) {
        throw new Error("release alias must be a tagged image reference");
    }
    return { packageName: reference.slice(0, colon), tag: reference.slice(colon + 1) };
}
function digestFromImageReference(reference, expectedRepository) {
    if (!reference.startsWith(`${expectedRepository}/`)) {
        throw new Error("release alias target is outside CENTRAL Artifact Registry");
    }
    const at = reference.lastIndexOf("@");
    if (at === -1)
        throw new Error("release alias target must be digest-bound");
    return assertDigest(reference.slice(at + 1), "release alias target");
}
export function createCentralReleaseAuthority(coordinates, deps = {}) {
    const repository = dockerRepository(coordinates);
    const packages = packagesBaseForCoordinates(coordinates);
    const accessToken = deps.getAccessToken ?? getAccessToken;
    async function resolveTagDigest(packageName, tag, token) {
        const response = await arFetch(`${packages}/${packageName}/tags/${encodeURIComponent(tag)}`, "GET", token);
        if (response.status === 404)
            return null;
        const tagBody = await requireJson(response, `artifact-registry resolve ${packageName}:${tag}`);
        return digestFromVersion(tagBody.version, `artifact-registry ${packageName}:${tag}`);
    }
    async function resolveManifestFromDigest(manifestDigest, token) {
        const manifestResponse = await fetch(`https://${coordinates.location}-docker.pkg.dev/v2/${coordinates.project}/${coordinates.repository}` +
            `/release-digest-manifest/manifests/${manifestDigest}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: [
                    "application/vnd.oci.image.manifest.v1+json",
                    "application/vnd.docker.distribution.manifest.v2+json",
                ].join(", "),
            },
        });
        const ociManifest = await requireJson(manifestResponse, "release digest manifest OCI lookup");
        const layers = ociManifest.layers;
        if (!Array.isArray(layers) || layers.length !== 1) {
            throw new Error("release digest manifest OCI image must contain exactly one layer");
        }
        const layer = plainRecord(layers[0], "release digest manifest OCI layer");
        const layerDigest = assertDigest(layer.digest, "release digest manifest OCI layer");
        const blobResponse = await fetch(`https://${coordinates.location}-docker.pkg.dev/v2/${coordinates.project}/${coordinates.repository}` +
            `/release-digest-manifest/blobs/${layerDigest}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!blobResponse.ok) {
            const detail = await blobResponse.text().catch(() => "");
            throw new Error(`release digest manifest blob lookup failed: ${blobResponse.status} ${detail.slice(0, 200)}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(tarFileContents(gunzipSync(Buffer.from(await blobResponse.arrayBuffer())), "release-digest-manifest.json"));
        }
        catch (error) {
            throw new Error(`release digest manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`);
        }
        return validateReleaseDigestManifest(parsed, manifestDigest, repository);
    }
    async function resolveManifestFromTag(tag) {
        const token = await accessToken();
        const manifestDigest = await resolveTagDigest("release-digest-manifest", tag, token);
        if (!manifestDigest)
            throw new ReleaseDigestManifestNotFoundError(tag);
        return resolveManifestFromDigest(manifestDigest, token);
    }
    return {
        async resolveManifest(sourceSha) {
            const expectedSourceSha = assertSourceSha(sourceSha);
            const manifest = await resolveManifestFromTag(expectedSourceSha);
            if (manifest.sourceSha !== expectedSourceSha) {
                throw new Error("release digest manifest sourceSha does not match the requested SHA");
            }
            return manifest;
        },
        aliasesFor(manifest) {
            const sourceSha = assertSourceSha(manifest.sourceSha);
            const validated = validateResolvedReleaseDigestManifest(manifest, repository);
            const shortSha = sourceSha.slice(0, 7);
            const aliases = [];
            for (const surface of ["gateway", "platform"]) {
                for (const [image, digest] of Object.entries(validated.surfaces[surface])) {
                    const target = `${repository}/${image}@${digest}`;
                    aliases.push({ alias: `${repository}/${image}:${shortSha}`, intendedTarget: target });
                    if (surface === "gateway") {
                        aliases.push({
                            alias: `${repository}/${image}:${shortSha}-oc${validated.openclawVersion}`,
                            intendedTarget: target,
                        });
                    }
                }
            }
            return aliases;
        },
        keepTagsFor(environment, manifest) {
            const sourceSha = assertSourceSha(manifest.sourceSha);
            const validated = validateResolvedReleaseDigestManifest(manifest, repository);
            const shortSha = sourceSha.slice(0, 7);
            const tagFor = (surface) => surface === "gateway"
                ? `${shortSha}-oc${validated.openclawVersion}`
                : shortSha;
            const aliases = [];
            for (const surface of ["gateway", "platform"]) {
                for (const [image, digest] of Object.entries(validated.surfaces[surface])) {
                    aliases.push({
                        alias: `${repository}/${image}:keep-release-${environment}-${tagFor(surface)}`,
                        intendedTarget: `${repository}/${image}@${digest}`,
                    });
                }
            }
            return aliases;
        },
        async ensureAliases(aliases) {
            const token = await getWriteToken();
            const outcomes = [];
            for (const alias of aliases) {
                try {
                    const parsed = parseReleaseAlias(alias.alias, repository);
                    const intendedDigest = digestFromImageReference(alias.intendedTarget, repository);
                    const existing = await resolveTagDigest(parsed.packageName, parsed.tag, token);
                    if (existing !== null) {
                        if (existing !== intendedDigest) {
                            throw new Error(`${alias.alias} already points at a different digest`);
                        }
                        outcomes.push({ alias: alias.alias, status: "already-applied", observedTarget: alias.intendedTarget });
                        continue;
                    }
                    const createResponse = await arFetch(`${packages}/${parsed.packageName}/tags?tagId=${encodeURIComponent(parsed.tag)}`, "POST", token, { version: versionResource(coordinates, parsed.packageName, intendedDigest) });
                    if (!createResponse.ok && createResponse.status !== 409) {
                        const detail = await createResponse.text().catch(() => "");
                        throw new Error(`artifact-registry create ${alias.alias} failed: ${createResponse.status} ${detail.slice(0, 200)}`);
                    }
                    const observed = await resolveTagDigest(parsed.packageName, parsed.tag, token);
                    if (observed !== intendedDigest) {
                        throw new Error(`${alias.alias} already points at a different digest`);
                    }
                    outcomes.push({
                        alias: alias.alias,
                        status: createResponse.status === 409 ? "already-applied" : "applied",
                        observedTarget: alias.intendedTarget,
                    });
                }
                catch (error) {
                    outcomes.push({
                        alias: alias.alias,
                        status: "failed",
                        error: error instanceof Error ? error.message : String(error),
                    });
                    throw new ReleaseDigestAliasError(outcomes, error);
                }
            }
            return outcomes;
        },
    };
}
/** The referenced tags this env currently pins for `service` (keep-<env>- stripped). */
export async function listKeepTags(opts) {
    const base = `${packagesBase(opts)}/${opts.service}`;
    const prefix = `keep-${opts.env}-`;
    const token = await getWriteToken();
    const out = [];
    let pageToken = null;
    for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
        if (pageToken)
            params.set("pageToken", pageToken);
        const resp = await arFetch(`${base}/tags?${params.toString()}`, "GET", token);
        if (!resp.ok) {
            const detail = await resp.text().catch(() => "");
            throw new Error(`artifact-registry: list tags failed: ${resp.status} ${detail.slice(0, 200)}`);
        }
        const data = (await resp.json());
        for (const t of data.tags ?? []) {
            const tagId = t.name.split("/tags/")[1];
            if (tagId && tagId.startsWith(prefix))
                out.push(tagId.slice(prefix.length));
        }
        pageToken = data.nextPageToken ?? null;
        if (!pageToken)
            break;
    }
    return out;
}
