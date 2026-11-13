export interface AvatarBucket {
  deleteFiles(opts: { prefix: string }): Promise<unknown>;
}

export interface StorageInspectionBucket {
  getFiles(opts: { prefix: string; maxResults: number }): Promise<[Array<{ name: string }>, ...unknown[]]>;
}

function userStoragePrefixes(
  uid: string,
  slug: string,
  chatArtifactIds: string[],
  agentImportIds: string[],
): string[] {
  return [
    `avatars/${uid}/`,
    `post-covers/${uid}/`,
    `agent-imports/${uid}/`,
    ...(slug ? [`customers/${slug}/`] : []),
    ...chatArtifactIds.map((artifactId) => `chat-artifacts/${artifactId}/`),
    ...agentImportIds.map((importId) => `agent-imports/${importId}/`),
  ];
}

// gateway-edge writes avatars as avatars/{uid}/{user|octo}.jpg — delete the
// whole prefix, not a single object.
export async function deleteAvatarObjects(bucket: AvatarBucket, uid: string): Promise<void> {
  await bucket.deleteFiles({ prefix: `avatars/${uid}/` });
}

export async function deleteUserStorageObjects(
  bucket: AvatarBucket,
  uid: string,
  slug: string,
  chatArtifactIds: string[],
  agentImportIds: string[],
): Promise<void> {
  for (const prefix of userStoragePrefixes(uid, slug, chatArtifactIds, agentImportIds)) {
    await bucket.deleteFiles({ prefix });
  }
}

export async function verifyUserStorageErasure(
  bucket: StorageInspectionBucket,
  uid: string,
  slug: string,
  chatArtifactIds: string[],
  agentImportIds: string[],
): Promise<string[]> {
  const remaining: string[] = [];
  for (const prefix of userStoragePrefixes(uid, slug, chatArtifactIds, agentImportIds)) {
    const [files] = await bucket.getFiles({ prefix, maxResults: 1 });
    if (files[0]) remaining.push(`gcs/${files[0].name}`);
  }
  return remaining;
}
