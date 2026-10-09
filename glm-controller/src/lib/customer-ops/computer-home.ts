export interface ComputerHomeObject {
  name: string;
  delete(opts: { ignoreNotFound: true }): Promise<unknown>;
}

export interface ComputerHomeBucket {
  getFiles(opts: {
    prefix: string;
    autoPaginate: false;
    pageToken?: string;
  }): Promise<readonly [readonly ComputerHomeObject[], { pageToken?: string } | null | undefined, ...unknown[]]>;
}

export function computerHomePrefix(slug: string): string {
  return `customers/${slug}/computer-home/`;
}

export async function deleteComputerHomeObjects(
  bucket: ComputerHomeBucket,
  slug: string,
): Promise<{ deleted: number }> {
  if (!slug) throw new Error("computer-home erase requires the Builder slug; refusing to sweep customers/");
  const prefix = computerHomePrefix(slug);
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

export async function deleteBuilderComputerHome(input: {
  bucket: ComputerHomeBucket;
  slug: string;
  deleteHobbyHome: (slug: string) => Promise<void>;
}): Promise<{ deleted: number }> {
  if (!input.slug) throw new Error("computer-home erase requires the Builder slug");
  await input.deleteHobbyHome(input.slug);
  return deleteComputerHomeObjects(input.bucket, input.slug);
}
