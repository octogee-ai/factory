export declare function notifyNewSignup(data: {
    name: string;
    email: string;
    tier: string;
    slug: string;
    uid: string;
}): Promise<void>;
export declare function notifyProvisioningError(slug: string, error: string): Promise<void>;
