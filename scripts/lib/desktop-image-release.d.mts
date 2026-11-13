import type { DesktopImageArtifact } from './desktop-image.mjs';

export interface MainBuild {
  manifest: { sourceSha: string; desktopImage?: unknown; surfaces: { gateway: Record<string, string> } };
  digest: string;
}
export interface DesktopRelease {
  schemaVersion?: number;
  sourceSha?: string;
  manifestDigest?: string;
  gatewayDigest?: string;
  desktopImage: DesktopImageArtifact;
  digest: string;
}
export interface DesktopCompanion {
  schemaVersion: 1;
  sourceSha: string;
  manifestDigest: string;
  gatewayDigest: string;
  desktopImage: DesktopImageArtifact;
}
export function validateDesktopRelease(value: unknown, build: MainBuild): DesktopCompanion;
export function resolveRegistryArtifact(packageName: string, sha: string, filename: string, request: (url: string, options?: RequestInit) => Promise<Response>, missing?: boolean): Promise<{ value: unknown; digest: string } | null>;
export function resolveDesktopRelease(build: MainBuild, request: (url: string, options?: RequestInit) => Promise<Response>): Promise<DesktopRelease | null>;
