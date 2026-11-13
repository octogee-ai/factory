import type { DocumentSnapshot } from "firebase-admin/firestore";
import { PLATFORM_RELEASE_RECORD_DOC_PATH, parsePlatformReleaseRecord } from "@octogee/shared/types/gateway-releases";
import type { ControllerStateRepositories, SharedPoolScalerFence, SharedPoolScalerState } from "../../platform-state/controller-state.js";
import { MalformedRecordError, MissingRecordError, type RecordKey } from "../../platform-state/errors.js";
import type { Stored } from "../../platform-state/store.js";
import { assertAbsentFence, assertFenceEquals } from "../../platform-state/documents/fences.js";
import { assertRevisionFence } from "./fences.js";
import { applyRecordPatch } from "./fleet-registry.js";
import type { FirestoreSession } from "./session.js";
import { STORED_AS_NUMBERS, decodeDocumentData, encodeDocument, encodePatch, revisionOf } from "./values.js";
import { SCALER_KEY, parseSharedPoolScalerState } from "../../platform-state/documents/controller-state.js";

const SHARED_POOL_SCALER_STATE_PATH = "glmControllerState/sharedPoolScaler";

const PLATFORM_RELEASE_KEY: RecordKey = { aggregate: "platform-release", key: "platformRelease" };

function decodeScalerState(snapshot: DocumentSnapshot): Stored<SharedPoolScalerState> | null {
  if (!snapshot.exists) return null;
  return { ...parseSharedPoolScalerState(decodeDocumentData(snapshot)), revision: revisionOf(snapshot) };
}

function assertScalerFence(fence: SharedPoolScalerFence, current: Stored<SharedPoolScalerState>): void {
  assertRevisionFence(SCALER_KEY, fence.revision, current.revision);
  assertFenceEquals(SCALER_KEY, "actionSequence", fence.actionSequence, current.actionSequence);
}

function encodeScalerState(state: SharedPoolScalerState) {
  return encodeDocument(parseSharedPoolScalerState({ ...state }), STORED_AS_NUMBERS, ["revision"]);
}

function decodePlatformRelease(snapshot: DocumentSnapshot) {
  if (!snapshot.exists) return null;
  const record = parsePlatformReleaseRecord(decodeDocumentData(snapshot));
  if (record === null) throw new MalformedRecordError(PLATFORM_RELEASE_KEY, "is not a platform release record");
  return { ...record, revision: revisionOf(snapshot) };
}

export function createFirestoreControllerStateRepositories(session: FirestoreSession): ControllerStateRepositories {
  const scalerRef = () => session.db.doc(SHARED_POOL_SCALER_STATE_PATH);
  const platformReleaseRef = () => session.db.doc(PLATFORM_RELEASE_RECORD_DOC_PATH);

  return {
    sharedPoolScaler: {
      async get() {
        return decodeScalerState(await session.read("controllerState.sharedPoolScaler.get", scalerRef()));
      },

      async put(state, fence) {
        const name = "controllerState.sharedPoolScaler.put";
        const document = encodeScalerState(state);
        await session.atomically(name, async (fenced) => {
          const snapshot = await fenced.readForFence(name, scalerRef());
          if (fence === "absent") {
            assertAbsentFence(SCALER_KEY, snapshot.exists ? revisionOf(snapshot) : null);
          } else {
            const current = decodeScalerState(snapshot);
            if (current === null) throw new MissingRecordError(SCALER_KEY);
            assertScalerFence(fence, current);
          }
          await fenced.set(name, SCALER_KEY, scalerRef(), document);
        });
      },

      async patch(patch, fence) {
        const name = "controllerState.sharedPoolScaler.patch";
        await session.atomically(name, async (fenced) => {
          const current = decodeScalerState(await fenced.readForFence(name, scalerRef()));
          if (current === null) throw new MissingRecordError(SCALER_KEY);
          if (fence !== undefined) assertScalerFence(fence, current);
          parseSharedPoolScalerState(applyRecordPatch<Record<string, unknown>>({ ...current }, patch));
          await fenced.update(name, SCALER_KEY, scalerRef(), encodePatch(patch, STORED_AS_NUMBERS));
        });
      },
    },

    platformRelease: {
      async get() {
        return decodePlatformRelease(await session.read("controllerState.platformRelease.get", platformReleaseRef()));
      },

      async put(record) {
        const parsed = parsePlatformReleaseRecord({ ...record });
        if (parsed === null) throw new MalformedRecordError(PLATFORM_RELEASE_KEY, "is not a platform release record");
        await session.set(
          "controllerState.platformRelease.put",
          PLATFORM_RELEASE_KEY,
          platformReleaseRef(),
          encodeDocument(parsed, STORED_AS_NUMBERS),
        );
      },
    },
  };
}
