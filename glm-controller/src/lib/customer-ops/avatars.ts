export interface AvatarBucket {
  deleteFiles(opts: { prefix: string }): Promise<unknown>;
}

// gateway-edge writes avatars as avatars/{uid}/{user|octo}.jpg — delete the
// whole prefix, not a single object.
export async function deleteAvatarObjects(bucket: AvatarBucket, uid: string): Promise<void> {
  await bucket.deleteFiles({ prefix: `avatars/${uid}/` });
}
