/**
 * Expected Mattermost post shapes the activity bridge produces for each
 * agent-event kind. These are the assertion targets for T1-4 (per-event-kind
 * markdown shape table). Real bridge output should match these byte-for-byte
 * in the markdown body and structurally in props.attachments + props.octogee.
 */

export interface ExpectedMmPostShape {
  /** Channel the post lands in. Tests pass an expected `activityChannelId`. */
  channelId: string;
  /** The `root_id` field — empty for the run's root post, set for replies. */
  rootId?: string;
  /** Markdown body. Compared as exact-string match unless `bodyMatch` is regex. */
  message: string;
  /** Optional regex for posts with timestamps / dynamic content. */
  bodyMatch?: RegExp;
  /** props.octogee.kind tag used by the PWA's row renderers. */
  kindTag: string;
  /** props.attachments[] — present only for color band or action buttons. */
  attachments?: ReadonlyArray<{
    color?: string;
    actions?: ReadonlyArray<{
      id: string;
      name: string;
      style?: 'default' | 'primary' | 'danger';
      integration?: { url: string; context?: Record<string, unknown> };
    }>;
  }>;
}

// ── Run root post (lifecycle.start) ───────────────────────────────────────────

export const expectedRunRootPost = (params: {
  channelId: string;
  agentSlug: string;
  runIntent?: string;
}): ExpectedMmPostShape => ({
  channelId: params.channelId,
  // No rootId — this IS the root.
  message: `▶️ ${params.agentSlug} · ${params.runIntent ?? 'working...'}`,
  bodyMatch: /^▶️ /,
  kindTag: 'activity.run-root',
  attachments: [{ color: '#3b82f6' }], // blue running pill
});

// Run root edit on lifecycle.end (completed).
export const expectedRunRootEditCompleted = (params: {
  agentSlug: string;
  runIntent?: string;
  durationMs: number;
}): Pick<ExpectedMmPostShape, 'message' | 'kindTag' | 'attachments' | 'bodyMatch'> => ({
  message: `✅ ${params.agentSlug} · ${params.runIntent ?? 'working...'}\n· ${(params.durationMs / 1000).toFixed(1)}s`,
  bodyMatch: /^✅ /,
  kindTag: 'activity.run-root',
  attachments: [{ color: '#22c55e' }],
});

// ── item (tool/command/search/analysis) ───────────────────────────────────────

export const expectedToolStartReply = (params: {
  channelId: string;
  rootId: string;
  toolName: string;
  args?: string;
}): ExpectedMmPostShape => ({
  channelId: params.channelId,
  rootId: params.rootId,
  message:
    `### 🔧 ${params.toolName}` +
    (params.args ? `\n\n\`\`\`json\n${params.args}\n\`\`\`` : ''),
  kindTag: 'activity.tool',
  attachments: [{ color: '#3b82f6' }],
});

export const expectedToolEndEdit = (params: {
  toolName: string;
  args?: string;
  output?: string;
  durationMs: number;
  status: 'completed' | 'failed';
}): Pick<ExpectedMmPostShape, 'message' | 'kindTag' | 'attachments'> => ({
  message:
    `### 🔧 ${params.toolName}` +
    (params.args ? `\n\n\`\`\`json\n${params.args}\n\`\`\`` : '') +
    (params.output ? `\n\n\`\`\`\n${params.output}\n\`\`\`` : '') +
    `\n\n_${(params.durationMs / 1000).toFixed(2)}s · ${params.status}_`,
  kindTag: 'activity.tool',
  attachments: [{ color: params.status === 'completed' ? '#22c55e' : '#ef4444' }],
});

// ── patch ────────────────────────────────────────────────────────────────────

export const expectedPatchReply = (params: {
  channelId: string;
  rootId: string;
  added: ReadonlyArray<string>;
  modified: ReadonlyArray<string>;
  deleted: ReadonlyArray<string>;
  summary: string;
}): ExpectedMmPostShape => {
  const fileCount = params.added.length + params.modified.length + params.deleted.length;
  const addedBlock = params.added.length > 0 ? `**Added:** ${params.added.join(', ')}\n` : '';
  const modifiedBlock = params.modified.length > 0 ? `**Modified:** ${params.modified.join(', ')}\n` : '';
  const deletedBlock = params.deleted.length > 0 ? `**Deleted:** ${params.deleted.join(', ')}\n` : '';
  return {
    channelId: params.channelId,
    rootId: params.rootId,
    message: `### 📝 patch · ${fileCount} files\n${addedBlock}${modifiedBlock}${deletedBlock}\n${params.summary}`,
    kindTag: 'activity.patch',
    attachments: [{ color: '#22c55e' }],
  };
};

// ── plan ─────────────────────────────────────────────────────────────────────

export const expectedPlanReply = (params: {
  channelId: string;
  rootId: string;
  title: string;
  steps: ReadonlyArray<string>;
}): ExpectedMmPostShape => ({
  channelId: params.channelId,
  rootId: params.rootId,
  message:
    `### 📋 ${params.title}\n` +
    params.steps.map((step, i) => `${i + 1}. ${step}`).join('\n'),
  kindTag: 'activity.plan',
  attachments: [{ color: '#3b82f6' }],
});

// ── command_output ───────────────────────────────────────────────────────────

export const expectedCommandReply = (params: {
  channelId: string;
  rootId: string;
  command: string;
  output: string;
  exitCode?: number;
  durationMs?: number;
  status: 'running' | 'completed' | 'failed';
}): ExpectedMmPostShape => ({
  channelId: params.channelId,
  rootId: params.rootId,
  message:
    `### $ ${params.command}\n\n\`\`\`\n${params.output}\n\`\`\`` +
    (params.exitCode != null ? `\n\nexit: ${params.exitCode} · ${((params.durationMs ?? 0) / 1000).toFixed(2)}s` : ''),
  kindTag: 'activity.command',
  attachments: [{ color: params.status === 'completed' ? '#22c55e' : params.status === 'failed' ? '#ef4444' : '#3b82f6' }],
});

// ── thinking ─────────────────────────────────────────────────────────────────

export const expectedThinkingReply = (params: {
  channelId: string;
  rootId: string;
  text: string;
}): ExpectedMmPostShape => ({
  channelId: params.channelId,
  rootId: params.rootId,
  message: `### 🧠 reasoning\n<details><summary>show</summary>\n\n${params.text}\n\n</details>`,
  kindTag: 'activity.thinking',
  attachments: [{ color: '#a3a3a3' }],
});

// ── approval ─────────────────────────────────────────────────────────────────

export const expectedApprovalReply = (params: {
  channelId: string;
  rootId: string;
  command: string;
  host: string;
  scope: 'turn' | 'session';
  approvalId: string;
  callbackUrl: string;
  hmacToken: string;
}): ExpectedMmPostShape => ({
  channelId: params.channelId,
  rootId: params.rootId,
  message:
    `### ⏸ approval requested\n` +
    `**Command:** \`${params.command}\`\n**Host:** ${params.host}\n**Scope:** ${params.scope}`,
  kindTag: 'activity.approval',
  attachments: [
    {
      color: '#f97316',
      actions: [
        {
          id: 'approve',
          name: 'Approve',
          style: 'primary',
          integration: {
            url: params.callbackUrl,
            context: {
              approvalId: params.approvalId,
              decision: 'approved',
              hmac: params.hmacToken,
            },
          },
        },
        {
          id: 'deny',
          name: 'Deny',
          style: 'danger',
          integration: {
            url: params.callbackUrl,
            context: {
              approvalId: params.approvalId,
              decision: 'denied',
              hmac: params.hmacToken,
            },
          },
        },
      ],
    },
  ],
});

export const expectedApprovalResolvedEdit = (params: {
  command: string;
  host: string;
  scope: 'turn' | 'session';
  decision: 'approved' | 'denied';
  resolvedBy: string;
}): Pick<ExpectedMmPostShape, 'message' | 'kindTag' | 'attachments'> => ({
  message:
    `### ${params.decision === 'approved' ? '✅' : '❌'} ${params.decision} by ${params.resolvedBy}\n` +
    `**Command:** \`${params.command}\`\n**Host:** ${params.host}\n**Scope:** ${params.scope}`,
  kindTag: 'activity.approval',
  // Buttons removed.
  attachments: [{ color: params.decision === 'approved' ? '#22c55e' : '#ef4444' }],
});

// ── compaction ───────────────────────────────────────────────────────────────

export const expectedCompactionReply = (params: {
  channelId: string;
  rootId: string;
  beforeTokens: number;
  afterTokens: number;
}): ExpectedMmPostShape => ({
  channelId: params.channelId,
  rootId: params.rootId,
  message: `### 🗜 context compacted\nbefore: ${params.beforeTokens.toLocaleString()} → after: ${params.afterTokens.toLocaleString()} tokens`,
  kindTag: 'activity.compaction',
  attachments: [{ color: '#a3a3a3' }],
});
