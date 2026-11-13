import type { ManagedChannelHost } from "../channel-host/types.js";
export interface StoredMattermostNames {
    readonly username: string | null;
    readonly coachChannelName: string | null;
}
export type ReadStoredMattermostNames = (uid: string, slug: string) => Promise<StoredMattermostNames>;
export interface ProvisionMattermostUserInput {
    uid: string;
    slug: string;
    firstName: string;
    email: string;
    vibe?: string | null;
    lastName?: string;
    photoURL?: string;
}
export declare function provisionMattermostUser(input: ProvisionMattermostUserInput, host: ManagedChannelHost, readStoredNames: ReadStoredMattermostNames): Promise<Record<string, unknown>>;
