export interface ReadmeTemplateVars {
    name: string;
    tagline: string;
    owner: string;
    workspaceSlug: string;
    projectSlug: string;
    date?: string;
}
export declare function renderReadmeTemplate(projectType: string | null | undefined, vars: ReadmeTemplateVars): string;
export declare function substitute(template: string, vars: Record<string, string>): string;
