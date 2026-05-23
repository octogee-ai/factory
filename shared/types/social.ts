export interface StarTargetBuilder {
  type: 'builder';
  
  ownerUid: string;
  
  username: string;
}

export interface StarTargetProject {
  type: 'project';
  
  workspaceSlug: string;
  
  projectSlug: string;
  
  ownerUid: string;
}

export interface StarTargetPost {
  type: 'post';
  
  postId: string;
  
  ownerUid: string;
}

export type StarTarget = StarTargetBuilder | StarTargetProject | StarTargetPost;

export type FollowTarget = StarTargetBuilder | StarTargetProject;

export function starDocId(actorUid: string, target: StarTarget): string {
  switch (target.type) {
    case 'builder':
      return `${actorUid}_b_${target.ownerUid}`;
    case 'project':
      return `${actorUid}_p_${target.workspaceSlug}_${target.projectSlug}`;
    case 'post':
      return `${actorUid}_post_${target.postId}`;
  }
}

export function followDocId(actorUid: string, target: FollowTarget): string {
  switch (target.type) {
    case 'builder':
      return `${actorUid}_b_${target.ownerUid}`;
    case 'project':
      return `${actorUid}_p_${target.workspaceSlug}_${target.projectSlug}`;
  }
}

export function isStarTarget(v: unknown): v is StarTarget {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: unknown }).type;
  if (t === 'builder') {
    const b = v as Partial<StarTargetBuilder>;
    return typeof b.ownerUid === 'string' && typeof b.username === 'string';
  }
  if (t === 'project') {
    const p = v as Partial<StarTargetProject>;
    return typeof p.workspaceSlug === 'string'
      && typeof p.projectSlug === 'string'
      && typeof p.ownerUid === 'string';
  }
  if (t === 'post') {
    const p = v as Partial<StarTargetPost>;
    return typeof p.postId === 'string' && typeof p.ownerUid === 'string';
  }
  return false;
}

export function isFollowTarget(v: unknown): v is FollowTarget {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: unknown }).type;
  if (t === 'post') return false;
  return isStarTarget(v);
}

