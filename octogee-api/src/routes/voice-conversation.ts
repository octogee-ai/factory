import { Router, type Request } from 'express';
import { isValidGatewayId } from '@octogee/shared/types/glm';
import { isVoiceTurnRequest } from '@octogee/core/voice-conversation';
import { postWorkspaceVoiceTurn, resolveWorkspaceConversation, VoiceTurnPostError, type WorkspaceConversationDeps } from '../lib/workspace-conversation.js';

interface VoiceConversationRequest {
  gatewayId: string;
  uid: string;
  channelId: string;
}

function boundToGateway(req: Request, gatewayId: unknown): gatewayId is string {
  return req.boundTenant?.kind === 'gateway' && req.boundTenant.gatewayId === gatewayId && isValidGatewayId(gatewayId);
}

function isVoiceConversationRequest(req: Request, body: VoiceConversationRequest): boolean {
  return boundToGateway(req, body.gatewayId) &&
    typeof body.uid === 'string' && Boolean(body.uid) && body.uid.length <= 128 && !body.uid.includes('/') &&
    typeof body.channelId === 'string' && /^[a-z0-9]{26}$/u.test(body.channelId) &&
    Object.keys(body).every(key => ['gatewayId', 'uid', 'channelId'].includes(key));
}

export function createVoiceConversationRoutes(deps: WorkspaceConversationDeps): Router {
  const router = Router();
  router.post('/conversation', async (req: Request, res, next) => {
    try {
      const body = req.body ?? {};
      if (!isVoiceConversationRequest(req, body)) { res.status(403).json({ error: 'forbidden' }); return; }
      const resolved = await resolveWorkspaceConversation(deps, body);
      if (!resolved) { res.status(403).json({ error: 'forbidden' }); return; }
      const { scope, context } = resolved;
      res.set('cache-control', 'no-store').json({
        ...context,
        nativeInterrupt: scope.gatewayClass === 'builder' && scope.nativeAccess && scope.auth.config.builderAccess?.controlUiEnabled === true,
      });
    } catch (error) { next(error); }
  });
  router.post('/turn', async (req: Request, res, next) => {
    try {
      const body: unknown = req.body ?? {};
      if (!isVoiceTurnRequest(body) || !boundToGateway(req, body.gatewayId)) { res.status(403).json({ error: 'forbidden' }); return; }
      const post = await postWorkspaceVoiceTurn(deps, body);
      if (!post) { res.status(403).json({ error: 'forbidden' }); return; }
      res.set('cache-control', 'no-store').json(post);
    } catch (error) {
      if (error instanceof VoiceTurnPostError) { res.status(502).json({ error: 'voice_turn_unverified' }); return; }
      next(error);
    }
  });
  return router;
}
