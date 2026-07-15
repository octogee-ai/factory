import { DocumentData } from "firebase-admin/firestore";
export declare const CREW_ROLES: readonly ["coach"];
export type CrewRole = typeof CREW_ROLES[number];
export declare const CREW_IDENTITY: Record<CrewRole, {
    name: string;
    emoji: string;
    model: string;
}>;
export declare const TIERS: readonly ["trial", "free", "hobby", "pro", "max"];
export type Tier = typeof TIERS[number];
export declare const TIER_CREW_ACCESS: Record<string, CrewRole[]>;
export declare const TIER_COLLABORATOR_LIMITS: Record<string, number>;
export interface CustomerProvisioning {
    slug: string;
    status: string;
    customerDir: string;
    agentIds: string[];
    activatedAgents: string[];
}
export declare function getProvisioning(data: DocumentData): CustomerProvisioning | null;
