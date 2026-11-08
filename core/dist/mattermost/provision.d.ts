import type { ManagedChannelHost } from "../channel-host/types.js";
export interface ProvisionMattermostUserInput {
    uid: string;
    slug: string;
    firstName: string;
    email: string;
    vibe?: string | null;
    lastName?: string;
    photoURL?: string;
}
export declare function provisionMattermostUser(input: ProvisionMattermostUserInput, host: ManagedChannelHost): Promise<Record<string, unknown>>;
