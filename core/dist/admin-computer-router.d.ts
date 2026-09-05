import type { Request, Router } from "express";
import type { Firestore } from "firebase-admin/firestore";
interface ComputerReplacementMutation {
    req: Request;
    what: string;
    why: string;
    target: Record<string, unknown>;
    preActionStatus: Record<string, unknown>;
    mutation: Record<string, unknown>;
    action: () => Promise<string>;
}
interface ComputerRouterDeps {
    db: Firestore;
    journal: (input: ComputerReplacementMutation) => Promise<string>;
}
export declare function addAdminComputerRoutes(router: Router, deps: ComputerRouterDeps): void;
export {};
