export interface VmHomeObject {
  name: string;
  delete(opts: { ignoreNotFound: true }): Promise<unknown>;
}

export interface VmHomeBucket {
  getFiles(opts: {
    prefix: string;
    autoPaginate: false;
    pageToken?: string;
  }): Promise<readonly [readonly VmHomeObject[], { pageToken?: string } | null | undefined, ...unknown[]]>;
}

export function vmHomePrefix(slug: string): string {
  return `customers/${slug}/computer-home/`;
}

export async function deleteVmHomeObjects(
  bucket: VmHomeBucket,
  slug: string,
): Promise<{ deleted: number }> {
  if (!slug) throw new Error("computer-home erase requires the user slug; refusing to sweep customers/");
  const prefix = vmHomePrefix(slug);
  let deleted = 0;
  let pageToken: string | undefined;
  do {
    const [files, nextQuery] = await bucket.getFiles({
      prefix,
      autoPaginate: false,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const file of files) {
      await file.delete({ ignoreNotFound: true });
      deleted += 1;
    }
    pageToken = nextQuery?.pageToken;
  } while (pageToken);
  return { deleted };
}
