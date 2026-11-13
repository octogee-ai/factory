export function starDocId(actorUid, target) {
    switch (target.type) {
        case 'builder':
            return `${actorUid}_b_${target.ownerUid}`;
        case 'project':
            return `${actorUid}_p_${target.workspaceSlug}_${target.projectSlug}`;
        case 'post':
            return `${actorUid}_post_${target.postId}`;
    }
}
export function followDocId(actorUid, target) {
    switch (target.type) {
        case 'builder':
            return `${actorUid}_b_${target.ownerUid}`;
        case 'project':
            return `${actorUid}_p_${target.workspaceSlug}_${target.projectSlug}`;
    }
}
export function isStarTarget(v) {
    if (!v || typeof v !== 'object')
        return false;
    const t = v.type;
    if (t === 'builder') {
        const b = v;
        return typeof b.ownerUid === 'string' && typeof b.username === 'string';
    }
    if (t === 'project') {
        const p = v;
        return typeof p.workspaceSlug === 'string'
            && typeof p.projectSlug === 'string'
            && typeof p.ownerUid === 'string';
    }
    if (t === 'post') {
        const p = v;
        return typeof p.postId === 'string' && typeof p.ownerUid === 'string';
    }
    return false;
}
export function isFollowTarget(v) {
    if (!v || typeof v !== 'object')
        return false;
    const t = v.type;
    if (t === 'post')
        return false;
    return isStarTarget(v);
}
