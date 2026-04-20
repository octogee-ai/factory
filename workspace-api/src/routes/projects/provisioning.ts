/**
 * Idempotent Gitea reconciler — create the project repo if missing + seed
 * README if missing. Shared by POST /api/projects (first create) and the
 * retry-provisioning endpoint (repair). Both `createProjectGiteaRepo` and
 * `giteaWriteFile` no-op when the target already exists.
 */
import { createProjectGiteaRepo, giteaWriteFile } from "../../lib/gitea";
import { renderReadmeTemplate } from "@shared/templates/project-readmes";

export async function ensureProjectGiteaRepo(input: {
  workspaceId: string;
  slug: string;
  name: string;
  tagline: string;
  projectType: string | null;
  visibility: string;
}): Promise<void> {
  const repoName = `${input.workspaceId}-proj-${input.slug}`;
  await createProjectGiteaRepo(
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
  await giteaWriteFile(repoName, "README.md", body, "auto: seed project README");
}
