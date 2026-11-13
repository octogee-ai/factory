import { openNativeUserClient } from '../openclaw-control/native-user-client.js';

export interface NativeVoiceRun {
  uid: string;
  gatewayId: string;
  agentId: string;
  sessionKey: string;
  runId: string;
}

export interface VoiceRunInterruption {
  status: 'aborted' | 'no-active-run';
  runId: string;
}

export async function interruptNativeVoiceRun(
  target: NativeVoiceRun,
  deps: { open?: typeof openNativeUserClient } = {},
): Promise<VoiceRunInterruption> {
  const client = await (deps.open ?? openNativeUserClient)(target.uid, target.gatewayId);
  try {
    const response = await client.call('sessions.abort', {
      key: target.sessionKey,
      agentId: target.agentId,
      runId: target.runId,
      clearQueued: true,
    });
    if (!response.ok) throw new Error(`The agent could not be stopped: ${response.reason}`);
    const result = response.result as { ok?: unknown; status?: unknown; abortedRunId?: unknown } | null;
    const stopped = result?.ok === true && (
      (result.status === 'aborted' && result.abortedRunId === target.runId)
      || (result.status === 'no-active-run' && result.abortedRunId === null)
    );
    if (!stopped) throw new Error('The gateway did not confirm that this agent run stopped.');
    return { status: result.status as VoiceRunInterruption['status'], runId: target.runId };
  } finally {
    client.close();
  }
}
