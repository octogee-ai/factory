import { type AssignmentDoc, type GatewayDoc } from "@octogee/shared/types/gateway-releases";
interface AssignmentDocRef {
    get: () => Promise<{
        exists: boolean;
        data: () => Record<string, unknown> | undefined;
    }>;
    set: (data: Record<string, unknown>, options?: {
        merge?: boolean;
    }) => Promise<unknown>;
    delete: () => Promise<unknown>;
}
interface AssignmentCollectionRef {
    doc: (id: string) => AssignmentDocRef;
    get: () => Promise<{
        docs: Array<{
            id: string;
            data: () => Record<string, unknown> | undefined;
        }>;
    }>;
}
export interface AssignmentFirestore {
    collection: (name: string) => {
        doc: (id: string) => {
            collection: (name: string) => AssignmentCollectionRef;
        };
    };
}
export declare function parseAssignmentDoc(uid: string, data: Record<string, unknown> | undefined): AssignmentDoc | null;
export declare function readAssignmentDocsForGateway(db: AssignmentFirestore, gatewayId: string): Promise<AssignmentDoc[]>;
export declare function readAssignmentDoc(db: AssignmentFirestore, gatewayId: string, uid: string): Promise<AssignmentDoc | null>;
export declare function deleteAssignmentDoc(db: AssignmentFirestore, gatewayId: string, uid: string): Promise<void>;
interface GatewayDocReader {
    collection: (name: string) => {
        doc: (id: string) => AssignmentDocRef;
    };
}
export declare function readLiveRevisionId(db: GatewayDocReader, gatewayId: string): Promise<string | null>;
export declare function mountsOnRevision(input: {
    podRevisionId: string;
    liveRevisionId: string | null;
    assignmentRevisionId: string | null;
}): boolean;
export type PlacementRejectReason = "no-live-revision" | "revision-not-ready";
export type PlacementResolution = {
    ok: true;
    revisionId: string;
    release: number | null;
} | {
    ok: false;
    reason: PlacementRejectReason;
};
export declare function resolvePlacementRevision(input: {
    gateway: Pick<GatewayDoc, "roll" | "liveRevisionId" | "liveRelease">;
    isRevisionReady: (revisionId: string) => boolean;
}): PlacementResolution;
export {};
