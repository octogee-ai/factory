export async function createRestartDriverDeps(packagePath = '/octogee/scripts/package.json') {
    const { createRequire } = await import('node:module');
    const { closeSync, constants, fstatSync, openSync, readSync } = await import('node:fs');
    const { homedir, networkInterfaces } = await import('node:os');
    const { join } = await import('node:path');
    const { randomUUID } = await import('node:crypto');
    const { get } = await import('node:http');
    const localRequire = createRequire(packagePath);
    const { WebSocket } = localRequire('ws');
    const wire = await import(localRequire.resolve('@octogee/shared/types/openclaw-wire-core'));
    const proxy = await import(localRequire.resolve('@octogee/shared/types/openclaw-proxy-identity'));
    const { signConnectDevice } = await import(localRequire.resolve('@octogee/shared/types/device-identity'));
    const { OPENCLAW_PROTOCOL_VERSION } = await import(localRequire.resolve('@octogee/shared/types/openclaw-wire'));
    const readJson = (file) => {
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const maxBytes = 1048576;
            const stat = fstatSync(fd);
            if (!stat.isFile())
                throw new Error('restart configuration must be a regular file');
            if (stat.size > maxBytes)
                throw new Error('restart configuration too large');
            const contents = Buffer.alloc(maxBytes + 1);
            let size = 0;
            while (size < contents.length) {
                const read = readSync(fd, contents, size, contents.length - size, null);
                if (read === 0)
                    break;
                size += read;
            }
            if (size > maxBytes)
                throw new Error('restart configuration too large');
            return JSON.parse(contents.toString('utf8', 0, size));
        }
        finally {
            closeSync(fd);
        }
    };
    const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || join(homedir(), '.openclaw', 'openclaw.json');
    const config = readJson(configPath);
    const port = config.gateway?.port ?? 18789;
    if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535 || config.gateway?.tls?.enabled === true)
        throw new Error('unsupported local restart endpoint');
    function authentication() {
        const perUser = proxy.isPerUserControlIdentity();
        let headers;
        let identity;
        let token;
        if (perUser) {
            const address = Object.values(networkInterfaces()).flatMap(v => v ?? []).find(v => !v.internal && v.family === 'IPv4')?.address;
            if (!address)
                throw new Error('restart service address unavailable');
            headers = { ...proxy.openClawProxyIdentityHeaders({ user: proxy.OPENCLAW_PROVISIONER_SERVICE_IDENTITY, clientAddress: address }), origin: proxy.openClawProxyOrigin() };
        }
        else {
            const value = process.env.OPENCLAW_GATEWAY_TOKEN || config.gateway?.auth?.token;
            if (typeof value !== 'string' || value.length === 0)
                throw new Error('restart authentication unavailable');
            token = value;
            const stored = readJson(process.env.OCTOGEE_PROVISIONER_IDENTITY_PATH?.trim() || join(homedir(), '.octogee', 'provisioner', 'device.json'));
            if (![stored.deviceId, stored.publicKeyPem, stored.privateKeyPem].every(v => typeof v === 'string' && v.length > 0))
                throw new Error('restart identity unavailable');
            identity = stored;
        }
        return { perUser, headers, identity, token };
    }
    const { perUser, headers, identity, token } = authentication();
    function probe(pathname) {
        return new Promise((resolve, reject) => {
            const request = get(`http://127.0.0.1:${port}${pathname}`, { timeout: 10000 }, response => { response.resume(); resolve(response.statusCode ?? 0); });
            request.on('timeout', () => request.destroy(new Error('readiness deadline')));
            request.on('error', reject);
        });
    }
    return {
        now: Date.now,
        wait: () => new Promise(resolve => setTimeout(resolve, 1000)),
        ready: async () => {
            const statuses = await Promise.all(['/healthz', '/readyz'].map(probe));
            return statuses.every(status => status === 200);
        },
        connect: async () => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : undefined);
            ws.on('error', () => { });
            const challenge = wire.startConnectChallengeTracker(ws);
            try {
                await wire.waitForWsOpen(ws, 10000);
                const nonce = await challenge.wait(10000);
                const client = { id: perUser ? proxy.OPENCLAW_CONTROL_UI_CLIENT_ID : 'gateway-client', displayName: 'octogee-provisioner', version: '1.0.0', platform: process.platform, mode: 'backend' };
                const scopes = ['operator.admin'];
                const params = { minProtocol: OPENCLAW_PROTOCOL_VERSION, maxProtocol: OPENCLAW_PROTOCOL_VERSION, client, role: 'operator', ...(!perUser ? { scopes, device: signConnectDevice({ identity: identity, clientId: client.id, clientMode: client.mode, role: 'operator', scopes, nonce, token: token, platform: client.platform }), auth: { token } } : {}) };
                const hello = await wire.sendWsRequest({ ws, id: randomUUID(), method: 'connect', params, timeoutMs: 10000, mapConnectErrors: true });
                if (typeof hello?.server?.bootId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(hello.server.bootId))
                    throw new Error('restart boot identity unavailable');
                return { bootId: hello.server.bootId, request: (method, params) => wire.sendWsRequest({ ws, id: randomUUID(), method, params, timeoutMs: 10000 }), alive: () => ws.readyState === WebSocket.OPEN, close: () => ws.terminate() };
            }
            catch (error) {
                ws.terminate();
                throw error;
            }
        },
    };
}
