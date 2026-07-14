import { createProjectGiteaRepo, giteaWriteFile } from "../../lib/gitea.js";
import { workspaceGiteaOrg, projectRepoName } from "../../lib/gitea-naming.js";
import { renderReadmeTemplate } from "@octogee/core/templates/project-readmes";

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

  const hostingSiteId = `octogee-${input.workspaceId}-${input.slug}`;
  const projectJson = {
    version: 1,
    name: input.name,
    slug: input.slug,
    ownerSlug: input.workspaceId,
    status: "active",
    visibility: input.visibility,
    hosting: {
      enabled: true,
      siteId: hostingSiteId,
      url: `https://${hostingSiteId}.web.app`,
    },
    runtime: { recipe: "astro-static" },
    collaborators: [],
    createdAt: new Date().toISOString(),
  };
  await giteaWriteFile(
    org,
    repoName,
    "project.json",
    `${JSON.stringify(projectJson, null, 2)}\n`,
    "auto: seed project metadata",
  );
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
