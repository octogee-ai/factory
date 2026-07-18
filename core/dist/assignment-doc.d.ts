import { type AssignmentDoc } from "@octogee/shared/types/gateway-releases";
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
export {};
