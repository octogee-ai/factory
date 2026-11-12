export declare const CREW_ROLES: readonly ["coach"];
export type CrewRole = typeof CREW_ROLES[number];
export declare const CREW_IDENTITY: Record<CrewRole, {
    name: string;
    emoji: string;
    model: string;
}>;
