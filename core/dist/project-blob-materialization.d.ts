import type { FleetBrokerBlobSignedUrl } from "@octogee/shared/types/fleet-broker";
interface BlobMaterialization {
    download: FleetBrokerBlobSignedUrl;
    generation: string;
    size: number;
    md5Hash: string;
}
export interface ProjectBlobHydrationClient {
    workspaceManifestReadUrl(input: {
        slug: string;
        projectSlug?: string;
    }): Promise<FleetBrokerBlobSignedUrl>;
    blobMaterializationReadUrl(input: {
        slug: string;
        path: string;
        size: number;
        sha256?: string;
    }): Promise<BlobMaterialization>;
}
export interface ProjectBlobHydration {
    bytes: number;
    files: number;
    generation: string | null;
    deferred?: number;
}
export type ProjectBlobHydrator = (input: {
    slug: string;
    project: string;
    destination: string;
    maxBytes: number;
    preserveExisting?: boolean;
    allowDeferred?: boolean;
    paths?: string[];
    markRestoreReady?: boolean;
    requireRestoredCheckout?: boolean;
}) => Promise<ProjectBlobHydration>;
export declare function createBrokeredProjectBlobHydrator(client: ProjectBlobHydrationClient, usersRoot?: string): ProjectBlobHydrator;
export declare function prepareUserProjectAssets(input: {
    projects: string;
    slug: string;
    project: string;
    hydrate: ProjectBlobHydrator;
    log?: (message: string) => void;
    requireRestoredCheckout?: boolean;
}): Promise<void>;
export {};
