import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { manifestObjectPath, parseManifest, serializeManifest } from "./workspace-manifest.js";
async function projectFile(root, directory, name, use, createDirectory = true) {
    const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const fdRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    let handle;
    try {
        const dir = `${fdRoot}/${parent.fd}/${directory}`;
        if (createDirectory)
            await mkdir(dir).catch(error => { if (error.code !== "EEXIST")
                throw error; });
        try {
            handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        }
        catch (error) {
            if (!createDirectory && error.code === "ENOENT")
                return use({
                    read: async () => null,
                    write: async () => { throw new Error("project state directory is absent"); },
                });
            throw error;
        }
        const location = `${fdRoot}/${handle.fd}/${name}`;
        return await use({
            read: async () => {
                let file;
                try {
                    file = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
                    const stat = await file.stat();
                    if (!stat.isFile() || stat.size > 10 * 1024 * 1024)
                        throw new Error("invalid project asset state file");
                    return await file.readFile("utf8");
                }
                catch (error) {
                    if (error.code === "ENOENT") {
                        return null;
                    }
                    throw error;
                }
                finally {
                    await file?.close();
                }
            },
            write: async (contents, exclusive = false) => {
                const temporary = `${fdRoot}/${handle.fd}/.asset-state-${randomUUID()}`;
                const file = await open(temporary, "wx", 0o600);
                try {
                    await file.writeFile(contents);
                    await file.sync();
                }
                finally {
                    await file.close();
                }
                try {
                    if (exclusive)
                        await link(temporary, location);
                    else
                        await rename(temporary, location);
                    await handle.sync();
                }
                finally {
                    await unlink(temporary).catch(error => { if (error.code !== "ENOENT")
                        throw error; });
                }
            },
        });
    }
    finally {
        await handle?.close();
        await parent.close();
    }
}
export async function readProjectAssetManifest(root, prefix) {
    return projectFile(root, ".files", "manifest.json", async (file) => {
        const contents = await file.read();
        return contents === null ? null : parseManifest(manifestObjectPath(prefix), contents);
    });
}
export async function initializeProjectAssetManifest(root, prefix, manifest) {
    const contents = serializeManifest(manifest);
    parseManifest(manifestObjectPath(prefix), contents);
    await projectFile(root, ".files", "manifest.json", file => file.write(contents, true));
}
export async function withProjectAssetManifest(root, prefix, use) {
    return projectFile(root, ".files", "manifest.json", async (file) => {
        const contents = await file.read();
        const manifest = contents === null ? {} : parseManifest(manifestObjectPath(prefix), contents);
        const before = serializeManifest(manifest);
        const result = await use(manifest);
        const after = serializeManifest(manifest);
        if (before !== after) {
            parseManifest(manifestObjectPath(prefix), after);
            await file.write(after);
        }
        return result;
    });
}
export async function withMaterializedProjectAssets(root, prefix, use) {
    const identity = await projectCheckoutIdentity(root, true);
    return projectFile(path.dirname(root), ".octogee-state", `${path.basename(root)}.assets.json`, async (file) => {
        const contents = await file.read();
        const state = contents === null ? { version: 1, prefix, files: {} } : JSON.parse(contents);
        if (state.version !== 1 || state.prefix !== prefix)
            throw new Error("project asset materialization owner differs");
        const current = state.identity === identity;
        const files = parseManifest(manifestObjectPath(prefix), JSON.stringify(current ? state.files : {}));
        const before = serializeManifest(files);
        const result = await use(files);
        if (!current || serializeManifest(files) !== before) {
            parseManifest(manifestObjectPath(prefix), serializeManifest(files));
            await file.write(JSON.stringify({ version: 1, prefix, identity, files }));
        }
        return result;
    });
}
export async function writeProjectRestoreReady(root, slug, project) {
    const identity = await projectCheckoutIdentity(root, true);
    await projectFile(path.dirname(root), ".octogee-state", `${path.basename(root)}.json`, file => file.write(JSON.stringify({ version: 1, slug, project, identity })));
}
export async function readProjectRestoreReady(root, slug, project) {
    const identity = await projectCheckoutIdentity(root, false);
    if (identity === null)
        return false;
    return projectFile(path.dirname(root), ".octogee-state", `${path.basename(root)}.json`, async (file) => {
        const contents = await file.read();
        if (contents === null)
            return false;
        const state = JSON.parse(contents);
        if (state.version !== 1 || state.slug !== slug || state.project !== project)
            throw new Error("project restore owner differs");
        return state.identity === identity;
    }, false);
}
async function projectCheckoutIdentity(root, create) {
    const stat = await lstat(root);
    if (!stat.isDirectory())
        throw new Error("project working set is not a directory");
    const gitfile = await projectGitfileIdentity(root);
    if (gitfile !== null)
        return gitfile;
    return projectFile(root, ".git", "octogee-checkout.json", async (file) => {
        let contents = await file.read();
        if (contents === null && create) {
            try {
                await file.write(JSON.stringify({ version: 1, id: randomUUID() }), true);
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
            }
            contents = await file.read();
            if (contents === null)
                throw new Error("project checkout identity disappeared");
        }
        if (contents === null)
            return null;
        const identity = JSON.parse(contents);
        if (identity.version !== 1 || typeof identity.id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(identity.id))
            throw new Error("invalid project checkout identity");
        return identity.id;
    }, create);
}
async function projectGitfileIdentity(root) {
    const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const fdRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    let file;
    try {
        try {
            file = await open(`${fdRoot}/${parent.fd}/.git`, constants.O_RDONLY | constants.O_NOFOLLOW);
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return null;
            }
            throw error;
        }
        const stat = await file.stat({ bigint: true });
        if (stat.isDirectory())
            return null;
        if (!stat.isFile() || stat.size > 8192n || stat.birthtimeNs <= 0n)
            throw new Error("invalid project Git pointer identity");
        const pointer = await file.readFile("utf8");
        if (!/^gitdir: [^\n]+\n?$/u.test(pointer))
            throw new Error("invalid project Git pointer");
        return createHash("sha256").update(`${stat.birthtimeNs}:`).update(pointer).digest("hex");
    }
    finally {
        await file?.close();
        await parent.close();
    }
}
