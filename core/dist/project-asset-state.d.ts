import { type Manifest } from "./workspace-manifest.js";
export declare function readProjectAssetManifest(root: string, prefix: string): Promise<Manifest | null>;
export declare function initializeProjectAssetManifest(root: string, prefix: string, manifest: Manifest): Promise<void>;
export declare function withProjectAssetManifest<T>(root: string, prefix: string, use: (manifest: Manifest) => Promise<T>): Promise<T>;
export declare function withMaterializedProjectAssets<T>(root: string, prefix: string, use: (manifest: Manifest) => Promise<T>): Promise<T>;
export declare function writeProjectRestoreReady(root: string, slug: string, project: string): Promise<void>;
export declare function readProjectRestoreReady(root: string, slug: string, project: string): Promise<boolean>;
export declare function readProjectRestoreState(root: string, slug: string, project: string): Promise<"ready" | "manifest-changed" | "unrestored">;
