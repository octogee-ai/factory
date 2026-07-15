export interface ProvisionMattermostUserInput {
    uid: string;
    slug: string;
    firstName: string;
    email: string;
    vibe?: string | null;
    lastName?: string;
    photoURL?: string;
}
export declare function provisionMattermostUser(input: ProvisionMattermostUserInput): Promise<Record<string, unknown>>;
