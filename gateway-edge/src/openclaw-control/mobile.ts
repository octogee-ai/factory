import type { WsUpgradeRouter } from '@octogee/core/ws/upgrade-router';
import { OpenClawControlResourceLimiter } from './limits.js';
import { MobileGatewayAuthority, type MobileOptions } from './mobile-authority.js';
import { createMobileHttpRouter } from './mobile-http.js';
import { attachMobileWs } from './mobile-ws.js';

export function createMobileGateway(options: MobileOptions = {}) {
  const authority = new MobileGatewayAuthority(options);
  const limiter = new OpenClawControlResourceLimiter({ maxSockets: 6, maxInFlight: 8 });
  return {
    router: createMobileHttpRouter(authority, limiter),
    attach: (upgrades: WsUpgradeRouter) => attachMobileWs(upgrades, authority, limiter),
  };
}
