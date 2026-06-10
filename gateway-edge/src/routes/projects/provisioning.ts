import { createProjectGiteaRepo, giteaWriteFile } from "../../lib/gitea.js";
import { workspaceGiteaOrg, projectRepoName } from "../../lib/gitea-naming.js";
import { renderReadmeTemplate } from "@shared/templates/project-readmes/index.js";

export async function ensureProjectGiteaRepo(input: {
  workspaceId: string;
  slug: string;
  name: string;
  tagline: string;
  projectType: string | null;
  visibility: string;
}): Promise<void> {
  const org = workspaceGiteaOrg(input.workspaceId);
  const repoName = projectRepoName(input.slug);
  await createProjectGiteaRepo(
    org,
    repoName,
    input.tagline || `Octogee project: ${input.name}`,
    input.visibility !== "public",
  );
  const body = renderReadmeTemplate(input.projectType, {
    name: input.name,
    tagline: input.tagline,
    owner: input.workspaceId,
    workspaceSlug: input.workspaceId,
    projectSlug: input.slug,
  });
  await giteaWriteFile(org, repoName, "README.md", body, "auto: seed project README");
}

export async function provisionProjectRepo(
  input: Parameters<typeof ensureProjectGiteaRepo>[0],
): Promise<string | null> {
  try {
    await ensureProjectGiteaRepo(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
