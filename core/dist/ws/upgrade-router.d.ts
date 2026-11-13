import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
export interface WsUpgradeContext {
    ws: WebSocket;
    req: IncomingMessage;
    ticket?: string;
}
export type PathMatcher = string | ((pathname: string) => boolean);
export declare class WsUpgradeAuthorizationError extends Error {
    readonly statusCode: 401 | 503 | 504;
    readonly errorCode: string;
    constructor(statusCode: 401 | 503 | 504, errorCode: string);
}
export interface WsUpgradeRoute {
    match: PathMatcher;
    extractTicket?: (pathname: string) => string | null;
    allowedOrigins: Set<string> | ((origin: string | undefined) => boolean) | "check-in-handler";
    requireHeaderKey?: {
        header: string;
        expected: string;
    };
    maxPayloadBytes?: number;
    authorize?: (req: IncomingMessage) => boolean | Promise<boolean>;
    onUpgrade: (ctx: WsUpgradeContext) => void;
}
export declare class WsUpgradeRouter {
    private readonly routes;
    private attached;
    add(route: WsUpgradeRoute): this;
    attach(server: Server): void;
    dispatch(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    private handleRoute;
}
