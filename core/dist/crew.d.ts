import { DocumentData } from "firebase-admin/firestore";
export declare const CREW_ROLES: readonly ["coach"];
export type CrewRole = typeof CREW_ROLES[number];
export declare const CREW_IDENTITY: Record<CrewRole, {
    name: string;
    emoji: string;
    model: string;
}>;
export interface UserProvisioning {
    slug: string;
    status: string;
    customerDir: string;
    agentIds: string[];
    activatedAgents: string[];
}
export declare function getProvisioning(data: DocumentData): UserProvisioning | null;
