import { randomBytes } from "node:crypto";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { usernameValidationError } from "@octogee/shared/types/identity";
import { reserveWorkspace } from "./workspace-reservation.js";
const MAX_EMAIL_LENGTH = 254;
const ONE_TIME_PASSWORD_BYTES = 18;
const USER_ID_BYTES = 14;
const UNAVAILABLE = "this platform has no user account backend configured";
function isEmailAddress(value) {
    const at = value.indexOf("@");
    return (at > 0 &&
        at === value.lastIndexOf("@") &&
        value.length <= MAX_EMAIL_LENGTH &&
        !/\s/.test(value) &&
        value.indexOf(".", at + 2) > at + 1 &&
        !value.endsWith("."));
}
function parseNewAccount(body) {
    const { name, email } = (body ?? {});
    const nameError = usernameValidationError(name);
    if (nameError !== null)
        return { error: `invalid name: ${nameError}` };
    if (typeof email !== "string" || !isEmailAddress(email.trim()))
        return { error: "invalid email address" };
    return { name: name, email: email.trim().toLowerCase() };
}
async function nameIsTaken(store, name) {
    const [workspace, builder] = await Promise.all([
        store.workspaces.records.get(name),
        store.builders.records.findBySlug(name),
    ]);
    return workspace !== null || builder !== null;
}
async function createWithReservedName(store, accounts, account) {
    const userId = randomBytes(USER_ID_BYTES).toString("hex");
    if ((await reserveWorkspace(store, account.name, userId)) !== "created")
        return { kind: "taken", field: "name" };
    let creation;
    try {
        creation = await accounts.create({ ...account, userId });
        return creation;
    }
    finally {
        if (creation?.kind !== "created")
            await store.workspaces.records.delete(account.name);
    }
}
function newOneTimePassword() {
    return randomBytes(ONE_TIME_PASSWORD_BYTES).toString("base64url");
}
export function addAdminUserRoutes(router, deps) {
    const { store, journal } = deps;
    router.post("/users", async (req, res, next) => {
        try {
            const account = parseNewAccount(req.body);
            if ("error" in account) {
                res.status(400).json({ error: account.error });
                return;
            }
            const { accounts } = deps;
            if (!accounts) {
                res.status(501).json({ error: UNAVAILABLE });
                return;
            }
            if (await nameIsTaken(store, account.name)) {
                res.status(409).json({ error: `the name ${account.name} is already taken` });
                return;
            }
            const { creation, operationId } = await journal({
                req,
                what: "add user",
                why: "operator added a user",
                target: { name: account.name },
                preActionStatus: {},
                mutation: { kind: "add-user", name: account.name },
                action: async (claim) => ({
                    creation: await createWithReservedName(store, accounts, account),
                    operationId: claim.auditId,
                }),
                classifyResult: (result) => result.creation.kind === "created"
                    ? { outcome: "completed" }
                    : { outcome: "failed", error: `the ${result.creation.field} is already taken` },
            });
            if (creation.kind === "taken") {
                res.status(409).json({ error: `the ${creation.field} is already taken` });
                return;
            }
            res.status(201).json({ userId: creation.userId, operationId });
        }
        catch (error) {
            next(error);
        }
    });
    router.post("/users/:uid/one-time-passwords", async (req, res, next) => {
        res.set("Cache-Control", "no-store");
        try {
            const uid = req.params.uid;
            const { signIn } = deps;
            if (!signIn) {
                res.status(501).json({ error: UNAVAILABLE });
                return;
            }
            const user = await store.builders.records.get(uid);
            if (!user) {
                res.status(404).json({ error: "user not found", uid });
                return;
            }
            const { slug } = user;
            if (slug === null || (user.provisioning.status ?? user.openclaw.status) !== "complete") {
                res.status(409).json({ error: "the user has not finished provisioning", uid });
                return;
            }
            if (!accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle })) {
                res.status(409).json({ error: "the user's account is not active", uid });
                return;
            }
            const issued = await journal({
                req,
                what: "issue one-time passwords",
                why: "operator issued sign-in passwords",
                target: { uid, slug },
                preActionStatus: { provisioningStatus: "complete" },
                mutation: { kind: "issue-one-time-passwords", systems: ["chat", "git"] },
                action: async (claim) => {
                    const chatPassword = newOneTimePassword();
                    const gitPassword = newOneTimePassword();
                    await signIn.channels.setUserPassword(slug, chatPassword);
                    const gitUsername = await signIn.git.setUserPassword(slug, gitPassword);
                    return {
                        operationId: claim.auditId,
                        chat: { username: slug, password: chatPassword },
                        git: { username: gitUsername, password: gitPassword },
                    };
                },
            });
            res.json(issued);
        }
        catch (error) {
            next(error);
        }
    });
}
