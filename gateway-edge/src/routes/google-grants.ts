import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { parseGooglePickedFiles } from "@octogee/shared/types/connectors";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { isCanonicalWorkspaceMembership } from "@octogee/core/gateway-principal-access";
import {
  googleGrantEpoch,
  parseGoogleGrantPermissions,
} from "../lib/google-collaborator-grants.js";

function audienceChannel(doc: {
  id: string;
  data(): {
    archivedAt?: unknown;
    status?: unknown;
    commercialLifecycle?: { status?: unknown };
  };
}): boolean {
  const data = doc.data();
  return (
    !["coach-dm", "admin"].includes(doc.id) &&
    !data.archivedAt &&
    data.status !== "archived" &&
    data.commercialLifecycle?.status !== "archived"
  );
}

const identifier = /^[a-zA-Z0-9_-]{1,128}$/;

async function ownerContext(db: Firestore, uid: string) {
  const user = await db.doc(`users/${uid}`).get();
  const data = user.data();
  const workspaceId = data?.username;
  if (
    !accountAllowsInteractiveAccess(data) ||
    typeof workspaceId !== "string" ||
    !identifier.test(workspaceId)
  )
    return null;
  const workspace = await db.doc(`workspaces/${workspaceId}`).get();
  if (
    workspace.data()?.ownerUid !== uid ||
    workspace.data()?.ownerActive !== true
  )
    return null;
  return { workspaceId };
}

export function createGoogleGrantRoutes(db: Firestore): Router {
  const router = Router();
  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.uid!;
      const context = await ownerContext(db, uid);
      if (!context) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const [members, channels, grants, connection] = await Promise.all([
        db
          .collection(`workspaces/${context.workspaceId}/members`)
          .limit(101)
          .get(),
        db
          .collection(`workspaces/${context.workspaceId}/channels`)
          .limit(101)
          .get(),
        db.collection(`users/${uid}/googleGrants`).limit(101).get(),
        db.doc(`users/${uid}/integrations/google`).get(),
      ]);
      if (members.size > 100 || channels.size > 100 || grants.size > 100) {
        res.status(422).json({ error: "grant_directory_limit" });
        return;
      }
      const activeMembers = members.docs.filter(
        (doc) => doc.id !== uid && isCanonicalWorkspaceMembership(doc.data()),
      );
      const memberNames = await Promise.all(
        activeMembers.map(async (doc) => {
          const profile = await db.doc(`users/${doc.id}`).get();
          return { uid: doc.id, name: profile.data()?.username ?? doc.id };
        }),
      );
      res.json({
        workspaceId: context.workspaceId,
        connected: connection.data()?.status === "connected",
        accountLabel: connection.data()?.accountLabel ?? null,
        members: memberNames,
        channels: channels.docs
          .filter(audienceChannel)
          .map((doc) => ({
            id: doc.data().mattermost?.channelId,
            name: doc.id,
          }))
          .filter((channel) => typeof channel.id === "string"),
        pickedFiles: parseGooglePickedFiles(connection.data()?.pickedFiles).map(
          (file: { id: string; name: string }) => ({
            id: file.id,
            name: file.name,
          }),
        ),
        grants: grants.docs.map((doc) => {
          const data = doc.data();
          const permissions = parseGoogleGrantPermissions(data.permissions);
          if (!permissions) throw new Error("Invalid stored Google grant");
          const member = activeMembers.find(
            (candidate) => candidate.id === doc.id,
          );
          const active =
            data.state === "active" &&
            connection.data()?.status === "connected" &&
            data.connectionEpoch ===
              googleGrantEpoch(connection.data()?.connectedAt) &&
            member &&
            data.membershipEpoch === googleGrantEpoch(member.createTime);
          const inactiveState = data.state === "revoked" ? "revoked" : "inactive";
          return {
            memberUid: doc.id,
            state: active ? "active" : inactiveState,
            permissions,
          };
        }),
      });
    } catch (error) {
      next(error);
    }
  });
  router.post(
    "/:memberUid",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.uid!;
        const memberUid = String(req.params.memberUid);
        const permissions = parseGoogleGrantPermissions(req.body?.permissions);
        if (
          !identifier.test(memberUid) ||
          memberUid === uid ||
          !permissions ||
          Object.keys(req.body ?? {}).some((key) => key !== "permissions")
        ) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        const context = await ownerContext(db, uid);
        if (!context) {
          res.status(403).json({ error: "forbidden" });
          return;
        }
        const channels = await db
          .collection(`workspaces/${context.workspaceId}/channels`)
          .get();
        const audiences = new Set(
          channels.docs
            .filter(audienceChannel)
            .map((doc) => doc.data().mattermost?.channelId),
        );
        if (
          permissions.some((permission) =>
            permission.channelIds.some((id) => !audiences.has(id)),
          )
        ) {
          res.status(400).json({ error: "invalid_audience" });
          return;
        }
        const outcome = await db.runTransaction(async (tx) => {
          const [member, connection, owner, workspace] = await Promise.all([
            tx.get(
              db.doc(`workspaces/${context.workspaceId}/members/${memberUid}`),
            ),
            tx.get(db.doc(`users/${uid}/integrations/google`)),
            tx.get(db.doc(`users/${uid}`)),
            tx.get(db.doc(`workspaces/${context.workspaceId}`)),
          ]);
          if (
            !accountAllowsInteractiveAccess(owner.data()) ||
            workspace.data()?.ownerUid !== uid ||
            workspace.data()?.ownerActive !== true
          )
            return false;
          if (!permissions.length) {
            tx.set(db.doc(`users/${uid}/googleGrants/${memberUid}`), {
              schemaVersion: 1,
              ownerUid: uid,
              memberUid,
              workspaceId: context.workspaceId,
              state: "revoked",
              permissions: [],
              approvedBy: uid,
              updatedAt: FieldValue.serverTimestamp(),
            });
            return true;
          }
          if (
            !isCanonicalWorkspaceMembership(member.data()) ||
            connection.data()?.status !== "connected"
          )
            return false;
          const connectionEpoch = googleGrantEpoch(
            connection.data()?.connectedAt,
          );
          const membershipEpoch = googleGrantEpoch(member.createTime);
          if (!connectionEpoch || !membershipEpoch) return false;
          tx.set(db.doc(`users/${uid}/googleGrants/${memberUid}`), {
            schemaVersion: 1,
            ownerUid: uid,
            memberUid,
            workspaceId: context.workspaceId,
            state: permissions.length ? "active" : "revoked",
            connectionEpoch,
            membershipEpoch,
            permissions,
            approvedBy: uid,
            updatedAt: FieldValue.serverTimestamp(),
          });
          return true;
        });
        if (!outcome) {
          res.status(409).json({ error: "grant_context_changed" });
          return;
        }
        res.json({
          ok: true,
          state: permissions.length ? "active" : "revoked",
        });
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}
