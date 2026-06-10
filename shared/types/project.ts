export type ProjectVisibility = 'private' | 'public' | 'unlisted';
export type ProjectStatus = 'idea' | 'building' | 'launched' | 'paused' | 'archived';
export type ProjectProvisioningState = 'provisioning' | 'active' | 'failed';
export type ProjectType = 'game' | 'social' | 'planner' | 'trip' | 'other';

export interface ProjectRepoSource {
  provider: 'github';
  owner: string;
  repo: string;
}

export interface Project {
  
  id: string;
  ownerUid: string;
  
  workspaceId: string;
  
  slug: string;
  
  name: string;
  tagline: string;
  description: string;
  category: string;
  projectType: ProjectType | null;
  status: ProjectStatus;
  visibility: ProjectVisibility;
  provisioningState: ProjectProvisioningState;

provisioningError?: string | null;

pendingVisibility?: ProjectVisibility | null;
  giteaRepoName: string | null;
  repoSource?: ProjectRepoSource | null;

canvasFile: string;
  previewUrl: string | null;
  starCount: number;
  memberCount: number;
  createdAt: unknown; 
  updatedAt: unknown; 
}
