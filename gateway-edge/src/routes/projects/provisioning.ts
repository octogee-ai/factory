import { createProjectGiteaRepo, giteaWriteFile, giteaWriteFiles } from "../../lib/gitea.js";
import { workspaceGiteaOrg, projectRepoName } from "../../lib/gitea-naming.js";
import { renderReadmeTemplate } from "@octogee/core/templates/project-readmes";
import { notesWelcomeSeed, projectPlaybookSeeds } from "@octogee/core/templates/project-seeds";

export interface ProjectRepoProvisioningResult {
  created: boolean;
  error: string | null;
}

class ProjectRepoProvisioningError extends Error {
  constructor(
    message: string,
    readonly created: boolean,
  ) {
    super(message);
    this.name = "ProjectRepoProvisioningError";
  }
}

export async function ensureProjectGiteaRepo(input: {
  workspaceId: string;
  slug: string;
  name: string;
  tagline: string;
  projectType: string | null;
  visibility: string;
}): Promise<{ created: boolean }> {
  const org = workspaceGiteaOrg(input.workspaceId);
  const repoName = projectRepoName(input.slug);
  const created = await createProjectGiteaRepo(
    org,
    repoName,
    input.tagline || `Octogee project: ${input.name}`,
    input.visibility !== "public",
  );
  try {
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

    const today = new Date().toISOString().slice(0, 10);
    const seeds = [...projectPlaybookSeeds(input.name, today), notesWelcomeSeed(input.name)];
    await giteaWriteFiles(
      org,
      repoName,
      seeds.map((seed) => ({ path: seed.relPath, content: seed.content })),
      "auto: seed project playbook",
    );
  } catch (error) {
    throw new ProjectRepoProvisioningError(errorMessage(error), created);
  }
  return { created };
}

export async function provisionProjectRepoResult(
  input: Parameters<typeof ensureProjectGiteaRepo>[0],
): Promise<ProjectRepoProvisioningResult> {
  try {
    const { created } = await ensureProjectGiteaRepo(input);
    return { created, error: null };
  } catch (error) {
    return {
      created: error instanceof ProjectRepoProvisioningError && error.created,
      error: errorMessage(error),
    };
  }
}

export async function provisionProjectRepo(
  input: Parameters<typeof ensureProjectGiteaRepo>[0],
): Promise<string | null> {
  return (await provisionProjectRepoResult(input)).error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
