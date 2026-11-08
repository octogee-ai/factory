import type { Request, Router } from "express";
import type { PlatformStateStore } from "./platform-state/store.js";
interface ComputerReplacementMutation {
    req: Request;
    what: string;
    why: string;
    target: Record<string, unknown>;
    preActionStatus: Record<string, unknown>;
    mutation: Record<string, unknown>;
    forced?: boolean;
    action: () => Promise<string>;
}
interface ComputerRouterDeps {
    replacementEnabled?: boolean;
    store: PlatformStateStore;
    journal: (input: ComputerReplacementMutation) => Promise<string>;
}
export declare function addAdminComputerRoutes(router: Router, deps: ComputerRouterDeps): void;
export {};
