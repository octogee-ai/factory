export interface DesktopImageArtifact {
  project: string;
  name: string;
  id: string;
  sourceSha: string;
  inputFingerprint: string;
  acceptance: 'boot-smoke-v1' | 'resize-reboot-v1';
}
export function validateDesktopImage(value: unknown): DesktopImageArtifact;
export function assertDesktopImageIdentity(artifact: unknown, image: unknown): DesktopImageArtifact;
