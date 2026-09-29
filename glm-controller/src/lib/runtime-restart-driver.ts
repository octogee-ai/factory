type DeviceIdentity = import('@octogee/shared/types/device-identity').DeviceIdentity;
interface RestartConnection {
  bootId: string;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  alive(): boolean;
  close(): void;
}
interface RestartDriverDeps {
  connect(): Promise<RestartConnection>;
  ready(): Promise<boolean>;
  now(): number;
  wait(): Promise<void>;
}
export interface RuntimeRestartReceipt {
  version: 1;
  attemptId: string;
  beforeBootId: string;
  afterBootId: string;
  ready: true;
}
export async function proveRuntimeRestart(attemptId: string, deps: RestartDriverDeps, timeoutMs = 180000): Promise<RuntimeRestartReceipt> {
  const acknowledged = (response: {ok?:unknown;status?:unknown;restart?:{ok?:unknown}} | null): boolean => response?.ok === true && ['scheduled','deferred','coalesced'].includes(String(response.status)) && response.restart?.ok === true;
  const deadline = deps.now() + timeoutMs;
  const before = await deps.connect();
  let beforeBootId: string;
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(before.bootId)) throw new Error('restart boot identity unavailable');
    beforeBootId = before.bootId;
    const response = await before.request('gateway.restart.request', { reason: 'octogee.runtime-restart', skipDeferral: true }) as {ok?:unknown;status?:unknown;restart?:{ok?:unknown}} | null;
    if (!acknowledged(response)) throw new Error('restart acknowledgement invalid');
  } finally { before.close(); }
  while (deps.now() < deadline) {
    let after: RestartConnection | undefined;
    try {
      after = await deps.connect();
      if (/^[A-Za-z0-9_-]{1,128}$/.test(after.bootId) && after.bootId !== beforeBootId && await deps.ready()) {
        await after.request('health', {});
        if (after.alive() && deps.now() < deadline) return { version:1, attemptId, beforeBootId, afterBootId:after.bootId, ready:true };
      }
    } catch (error) {
      if (deps.now() >= deadline) throw error;
    } finally { after?.close(); }
    await deps.wait();
  }
  throw new Error('runtime restart completion deadline');
}

export async function createRestartDriverDeps(packagePath = '/octogee/scripts/package.json'): Promise<RestartDriverDeps> {
  const {createRequire} = await import('node:module');
  const {readFileSync,statSync} = await import('node:fs');
  const {homedir,networkInterfaces} = await import('node:os');
  const {join} = await import('node:path');
  const {randomUUID} = await import('node:crypto');
  const {get} = await import('node:http');
  const localRequire = createRequire(packagePath);
  const {WebSocket} = localRequire('ws') as {WebSocket:{new(url:string,options?:{headers:Record<string,string>}):import('@octogee/shared/types/openclaw-wire-core').WireSocket & {readyState:number};OPEN:number}};
  const wire = await import(localRequire.resolve('@octogee/shared/types/openclaw-wire-core')) as typeof import('@octogee/shared/types/openclaw-wire-core');
  const proxy = await import(localRequire.resolve('@octogee/shared/types/openclaw-proxy-identity')) as typeof import('@octogee/shared/types/openclaw-proxy-identity');
  const {signConnectDevice} = await import(localRequire.resolve('@octogee/shared/types/device-identity')) as typeof import('@octogee/shared/types/device-identity');
  const {OPENCLAW_PROTOCOL_VERSION} = await import(localRequire.resolve('@octogee/shared/types/openclaw-wire')) as typeof import('@octogee/shared/types/openclaw-wire');
  const readJson = (file: string): unknown => {
    if (statSync(file).size > 1048576) throw new Error('restart configuration too large');
    return JSON.parse(readFileSync(file,'utf8'));
  };
  const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || join(homedir(),'.openclaw','openclaw.json');
  const config = readJson(configPath) as {gateway?:{port?:unknown;tls?:{enabled?:unknown};auth?:{token?:unknown}}};
  const port = config.gateway?.port ?? 18789;
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535 || config.gateway?.tls?.enabled === true) throw new Error('unsupported local restart endpoint');
  function authentication() {
  const perUser = proxy.isPerUserControlIdentity();
  let headers: Record<string,string> | undefined;
  let identity: DeviceIdentity | undefined;
  let token: string | undefined;
  if (perUser) {
    const address = Object.values(networkInterfaces()).flatMap(v=>v??[]).find(v=>!v.internal && v.family==='IPv4')?.address;
    if (!address) throw new Error('restart service address unavailable');
    headers = {...proxy.openClawProxyIdentityHeaders({user:proxy.OPENCLAW_PROVISIONER_SERVICE_IDENTITY,clientAddress:address}),origin:proxy.openClawProxyOrigin()};
  } else {
    const value = process.env.OPENCLAW_GATEWAY_TOKEN || config.gateway?.auth?.token;
    if (typeof value !== 'string' || value.length === 0) throw new Error('restart authentication unavailable');
    token = value;
    const stored = readJson(process.env.OCTOGEE_PROVISIONER_IDENTITY_PATH?.trim() || join(homedir(),'.octogee','provisioner','device.json')) as Partial<DeviceIdentity>;
    if (![stored.deviceId,stored.publicKeyPem,stored.privateKeyPem].every(v=>typeof v==='string' && v.length>0)) throw new Error('restart identity unavailable');
    identity = stored as DeviceIdentity;
  }
    return {perUser,headers,identity,token};
  }
  const {perUser,headers,identity,token}=authentication();
  function probe(pathname: string): Promise<number> {
    return new Promise((resolve,reject)=>{
      const request=get(`http://127.0.0.1:${port}${pathname}`,{timeout:10000},response=>{response.resume();resolve(response.statusCode ?? 0);});
      request.on('timeout',()=>request.destroy(new Error('readiness deadline')));
      request.on('error',reject);
    });
  }
  return {
    now:Date.now,
    wait:()=>new Promise(resolve=>setTimeout(resolve,1000)),
    ready:async()=>{
      const statuses = await Promise.all(['/healthz','/readyz'].map(probe));
      return statuses.every(status=>status===200);
    },
    connect:async()=>{
      const ws=new WebSocket(`ws://127.0.0.1:${port}`,headers ? {headers} : undefined);
      ws.on('error',()=>{});
      const challenge=wire.startConnectChallengeTracker(ws);
      try {
        await wire.waitForWsOpen(ws,10000);
        const nonce=await challenge.wait(10000);
        const client={id:perUser?proxy.OPENCLAW_CONTROL_UI_CLIENT_ID:'gateway-client',displayName:'octogee-provisioner',version:'1.0.0',platform:process.platform,mode:'backend'};
        const scopes=['operator.admin'];
        const params={minProtocol:OPENCLAW_PROTOCOL_VERSION,maxProtocol:OPENCLAW_PROTOCOL_VERSION,client,role:'operator',...(!perUser?{scopes,device:signConnectDevice({identity:identity!,clientId:client.id,clientMode:client.mode,role:'operator',scopes,nonce,token:token!,platform:client.platform}),auth:{token}}:{})};
        const hello=await wire.sendWsRequest({ws,id:randomUUID(),method:'connect',params,timeoutMs:10000,mapConnectErrors:true}) as {server?:{bootId?:unknown}};
        if (typeof hello?.server?.bootId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(hello.server.bootId)) throw new Error('restart boot identity unavailable');
        return {bootId:hello.server.bootId,request:(method,params)=>wire.sendWsRequest({ws,id:randomUUID(),method,params,timeoutMs:10000}),alive:()=>ws.readyState===WebSocket.OPEN,close:()=>ws.terminate()};
      } catch(error) {ws.terminate();throw error;}
    },
  };
}
export function runtimeRestartDriverSource(attemptId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId)) throw new Error('invalid runtime restart attempt');
  return `const deadline=setTimeout(()=>{process.stderr.write('runtime restart unconfirmed\\n');process.exit(1)},180000);const prove=${proveRuntimeRestart.toString()};const dependencies=${createRestartDriverDeps.toString()};dependencies().then(d=>prove(${JSON.stringify(attemptId)},d)).then(r=>{clearTimeout(deadline);process.stdout.write(JSON.stringify(r)+'\\n')}).catch(()=>{process.stderr.write('runtime restart unconfirmed\\n');process.exit(1)});`;
}
